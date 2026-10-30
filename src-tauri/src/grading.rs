//! 批量批改编排：并发控制 + 逐张推进度。
//!
//! 事件契约（前端 `src/lib/bridge.ts` 一一对应）：
//! - `grading:progress`   ProgressPayload  —— 阶段推进（reading/uploading/parsing/failed）
//! - `grading:item`       GradingResult    —— 单张成功
//! - `grading:item-failed` FailedPayload   —— 单张失败
//! - `grading:done`       DonePayload      —— 全部结束
//! - `grading:fatal`      String           —— 整体不可继续（如 Key 空、客户端构建失败）

use crate::imaging::ImageOptions;
use crate::models::{
    ApiConfig, DonePayload, FailedPayload, GradeRequest, GradingResult, ProgressPayload,
};
use crate::{api, parser, pdf, prompt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

/// 并发上限。给到 100 是"允许"，不是"建议"：
/// 多数网关的 RPM/TPM 撑不住，默认仍然是 3，界面在 ≥10 时会提示限流风险。
pub const MAX_CONCURRENCY: usize = 100;

/// 收口并发数。前端也会 clamp，但后端必须自己再兜一次 —— invoke 可以被任何东西调用。
pub fn effective_concurrency(n: usize) -> usize {
    n.clamp(1, MAX_CONCURRENCY)
}

/// PDF 渲染缓存根目录：`app_cache_dir/pdf-cache`。
/// 放在 cache 目录而不是应用目录，系统清理缓存时一起带走，不会越攒越大。
pub fn cache_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .map(|p| p.join("pdf-cache"))
        .unwrap_or_else(|_| std::env::temp_dir().join("ai-grading-pdf-cache"))
}

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
    let system_prompt: Arc<String> =
        Arc::new(prompt::build_system_prompt(&req.prompt, &req.roster));
    let sem = Arc::new(Semaphore::new(effective_concurrency(req.concurrency)));
    let cache: Arc<PathBuf> = Arc::new(cache_root(&app));
    let opts = ImageOptions::from_config(&req.config);

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
        let cache2 = cache.clone();
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

            match grade_one(
                &app2,
                &client2,
                &cfg2,
                &sys2,
                &path,
                &cache2,
                opts,
                index,
                total,
                &file_name,
            )
            .await
            {
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

/// 批改单张（一份 PDF 也算一张）。`grade_single` command 复用它。
#[allow(clippy::too_many_arguments)]
pub async fn grade_one(
    app: &AppHandle,
    client: &reqwest::Client,
    cfg: &ApiConfig,
    system_prompt: &str,
    path: &str,
    cache: &Path,
    opts: ImageOptions,
    index: usize,
    total: usize,
    file_name: &str,
) -> anyhow::Result<GradingResult> {
    let t0 = Instant::now();
    let p = Path::new(path);

    // 一份卷子的全部页：图片只有 1 张，PDF 逐页栅格化（带磁盘缓存）
    let page_paths: Vec<PathBuf> = if pdf::is_pdf(p) {
        let mut render_progress = |done: usize, pages: usize| {
            let _ = app.emit(
                "grading:progress",
                ProgressPayload {
                    index,
                    total,
                    file: file_name.to_string(),
                    stage: "reading".into(),
                    message: format!("渲染 PDF {done}/{pages} 页（{}）", opts.describe()),
                },
            );
        };
        pdf::render_pages(p, &opts, cache, &mut render_progress)?
            .into_iter()
            .map(PathBuf::from)
            .collect()
    } else {
        vec![p.to_path_buf()]
    };

    // PDF 页是刚渲染好的，直接 base64；普通图片先按档位瘦身
    let mut uploaded_bytes: u64 = 0;
    let images: Vec<String> = if pdf::is_pdf(p) {
        page_paths
            .iter()
            .map(|pp| {
                let url = api::read_raw_data_url(pp)?;
                Ok(url)
            })
            .collect::<anyhow::Result<Vec<_>>>()?
    } else {
        let (url, bytes) = api::read_image_data_url(p, &opts)?;
        uploaded_bytes += bytes;
        vec![url]
    };

    // 给老师一个"这张卷子到底多大"的实数（压缩后的），比原来只在 8MB 时喊一嗓子有用
    let total_kb = if uploaded_bytes > 0 {
        uploaded_bytes as f64 / 1024.0
    } else {
        page_paths
            .iter()
            .filter_map(|pp| std::fs::metadata(pp).ok())
            .map(|m| m.len() as f64 / 1024.0)
            .sum()
    };
    if total_kb > 0.0 {
        let _ = app.emit(
            "grading:progress",
            ProgressPayload {
                index,
                total,
                file: file_name.to_string(),
                stage: "reading".into(),
                message: format!(
                    "已准备 {} 张图，共 {:.0} KB（{}）",
                    images.len(),
                    total_kb,
                    opts.describe()
                ),
            },
        );
    }

    let _ = app.emit(
        "grading:progress",
        ProgressPayload {
            index,
            total,
            file: file_name.to_string(),
            stage: "uploading".into(),
            message: if images.len() > 1 {
                format!("调用 {} 批改（{} 页）", cfg.model, images.len())
            } else {
                format!("调用 {} 批改", cfg.model)
            },
        },
    );

    let raw = api::grade_images(client, cfg, system_prompt, &images).await?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrency_is_clamped_to_1_100() {
        assert_eq!(effective_concurrency(0), 1);
        assert_eq!(effective_concurrency(1), 1);
        assert_eq!(effective_concurrency(37), 37);
        assert_eq!(effective_concurrency(MAX_CONCURRENCY), MAX_CONCURRENCY);
        assert_eq!(effective_concurrency(MAX_CONCURRENCY + 250), MAX_CONCURRENCY);
    }
}
