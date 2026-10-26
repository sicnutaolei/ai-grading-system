//! 批量批改编排：并发控制 + 逐张推进度。
//!
//! 事件契约（前端 `src/lib/bridge.ts` 一一对应）：
//! - `grading:progress`   ProgressPayload  —— 阶段推进（reading/uploading/parsing/failed）
//! - `grading:item`       GradingResult    —— 单张成功
//! - `grading:item-failed` FailedPayload   —— 单张失败
//! - `grading:done`       DonePayload      —— 全部结束
//! - `grading:fatal`      String           —— 整体不可继续（如 Key 空、客户端构建失败）

use crate::models::{
    ApiConfig, DonePayload, FailedPayload, GradeRequest, GradingResult, ProgressPayload,
};
use crate::{api, parser, prompt};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::Semaphore;

pub async fn run_batch(app: AppHandle, req: GradeRequest) {
    let started = Instant::now();
    let total = req.files.len();

    let client = match api::build_client(&req.config) {
        Ok(c) => Arc::new(c),
        Err(e) => {
            let _ = app.emit("grading:fatal", format!("初始化网络客户端失败：{e}"));
            return;
        }
    };
    if req.config.api_key.trim().is_empty() {
        let _ = app.emit("grading:fatal", "API Key 为空，无法批改");
        return;
    }

    let cfg: Arc<ApiConfig> = Arc::new(req.config.clone());
    let system_prompt: Arc<String> = Arc::new(prompt::build_system_prompt(&req.prompt));
    let sem = Arc::new(Semaphore::new(req.concurrency.clamp(1, 8)));

    let mut set = tokio::task::JoinSet::new();

    for (idx, path) in req.files.into_iter().enumerate() {
        let permit = match sem.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break,
        };

        let app2 = app.clone();
        let client2 = client.clone();
        let cfg2 = cfg.clone();
        let sys2 = system_prompt.clone();
        let index = idx + 1;

        set.spawn(async move {
            // permit 持有到本张结束，实现"同时在飞不超过 N 张"
            let _permit = permit;
            let file_name = Path::new(&path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());

            let _ = app2.emit(
                "grading:progress",
                ProgressPayload {
                    index,
                    total,
                    file: file_name.clone(),
                    stage: "reading".into(),
                    message: "读取答题卡".into(),
                },
            );

            match grade_one(&app2, &client2, &cfg2, &sys2, &path, index, total, &file_name).await {
                Ok(result) => {
                    let _ = app2.emit("grading:item", result);
                    true
                }
                Err(e) => {
                    let message = format!("{e}");
                    let _ = app2.emit(
                        "grading:progress",
                        ProgressPayload {
                            index,
                            total,
                            file: file_name.clone(),
                            stage: "failed".into(),
                            message: message.clone(),
                        },
                    );
                    let _ = app2.emit(
                        "grading:item-failed",
                        FailedPayload {
                            index,
                            file: file_name,
                            message,
                        },
                    );
                    false
                }
            }
        });
    }

    let mut ok = 0usize;
    let mut failed = 0usize;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(true) => ok += 1,
            _ => failed += 1,
        }
    }

    let _ = app.emit(
        "grading:done",
        DonePayload {
            total,
            ok,
            failed,
            elapsed_ms: started.elapsed().as_millis() as u64,
        },
    );
}

/// 批改单张。`grade_single` command 复用它（重新批改单张时走这里）。
#[allow(clippy::too_many_arguments)]
pub async fn grade_one(
    app: &AppHandle,
    client: &reqwest::Client,
    cfg: &ApiConfig,
    system_prompt: &str,
    path: &str,
    index: usize,
    total: usize,
    file_name: &str,
) -> anyhow::Result<GradingResult> {
    let t0 = Instant::now();
    let p = Path::new(path);

    // 大图先提示一下：不拦截，但日志里留痕，方便老师判断是不是扫描分辨率过高
    if let Ok(meta) = std::fs::metadata(p) {
        if meta.len() > api::BIG_IMAGE_BYTES {
            let _ = app.emit(
                "grading:progress",
                ProgressPayload {
                    index,
                    total,
                    file: file_name.to_string(),
                    stage: "reading".into(),
                    message: format!("图片较大（{:.1} MB），上传会比较慢", meta.len() as f64 / 1048576.0),
                },
            );
        }
    }

    let data_url = api::read_as_data_url(p)?;

    let _ = app.emit(
        "grading:progress",
        ProgressPayload {
            index,
            total,
            file: file_name.to_string(),
            stage: "uploading".into(),
            message: "调用 deepseek-flash 批改".into(),
        },
    );

    let raw = api::grade_image(client, cfg, system_prompt, &data_url).await?;

    let _ = app.emit(
        "grading:progress",
        ProgressPayload {
            index,
            total,
            file: file_name.to_string(),
            stage: "parsing".into(),
            message: "解析评分结果".into(),
        },
    );

    let ai = parser::parse_ai_result(&raw)?;
    let result = parser::normalize(
        ai,
        path,
        file_name,
        &cfg.model,
        t0.elapsed().as_millis() as u64,
        &raw,
    );

    let _ = app.emit(
        "grading:progress",
        ProgressPayload {
            index,
            total,
            file: file_name.to_string(),
            stage: "done".into(),
            message: format!("{} 分", result.total_ai),
        },
    );

    Ok(result)
}
