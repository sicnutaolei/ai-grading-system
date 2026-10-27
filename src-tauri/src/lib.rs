//! Tauri 入口：注册 command、挂插件。

mod api;
mod exporter;
mod grading;
mod models;
mod parser;
mod prompt;
mod roster;
mod scanner;
mod settings;

use models::{ApiConfig, ExportRequest, GradeRequest, GradingResult, ScanFile};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// 扫描文件夹，同时把该目录授权给 asset 协议。
///
/// ⚠️ `allow_directory` 是必须的：tauri.conf.json 里 assetProtocol.scope 是空数组，
/// 只有老师真正选中的目录会在运行时被放行。少了这一步，前端 `<img src=convertFileSrc(path)>`
/// 会稳定拿到 403（且控制台只报一句 Failed to load resource，很难查）。
#[tauri::command]
async fn scan_folder(app: AppHandle, directory: String) -> Result<Vec<ScanFile>, String> {
    let dir = PathBuf::from(directory.trim());
    if !dir.is_dir() {
        return Err(format!("不是有效文件夹：{}", dir.display()));
    }

    app.asset_protocol_scope()
        .allow_directory(&dir, true)
        .map_err(|e| format!("授权图片目录失败（asset 协议将无法读取）：{e}"))?;

    tokio::task::spawn_blocking(move || scanner::scan_folder(&dir))
        .await
        .map_err(|e| format!("扫描任务失败：{e}"))
}

/// 启动批量批改。立刻返回，进度与结果全部走事件。
#[tauri::command]
async fn start_grading(app: AppHandle, mut req: GradeRequest) -> Result<(), String> {
    if req.config.api_key.trim().is_empty() {
        return Err("请先填写 API Key".into());
    }
    if req.directory.trim().is_empty() {
        return Err("请先导入文件夹".into());
    }

    if req.files.is_empty() {
        let dir = PathBuf::from(&req.directory);
        req.files = scanner::scan_folder(&dir)
            .into_iter()
            .map(|f| f.path)
            .collect();
    }
    if req.files.is_empty() {
        return Err("该文件夹里没有可批改的图片".into());
    }

    if req.prompt.trim().is_empty() {
        req.prompt = prompt::DEFAULT_RUBRIC.to_string();
    }

    tauri::async_runtime::spawn(async move {
        grading::run_batch(app, req).await;
    });

    Ok(())
}

/// 重新批改单张（老师改了 prompt 后想重跑某一张时用）
#[tauri::command]
async fn grade_single(
    app: AppHandle,
    file_path: String,
    config: ApiConfig,
    prompt_text: String,
    #[allow(non_snake_case)] roster: Option<Vec<String>>,
) -> Result<GradingResult, String> {
    if config.api_key.trim().is_empty() {
        return Err("请先填写 API Key".into());
    }
    let p = PathBuf::from(&file_path);
    if !p.is_file() {
        return Err(format!("文件不存在：{file_path}"));
    }

    let client = api::build_client(&config).map_err(|e| e.to_string())?;
    let system_prompt = prompt::build_system_prompt(&prompt_text, &roster.unwrap_or_default());
    let file_name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file_path.clone());

    grading::grade_one(
        &app,
        &client,
        &config,
        &system_prompt,
        &file_path,
        1,
        1,
        &file_name,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 连通性自检，返回模型回话（截断 40 字）
#[tauri::command]
async fn test_connection(config: ApiConfig) -> Result<String, String> {
    let client = api::build_client(&config).map_err(|e| e.to_string())?;
    api::ping(&client, &config).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Option<ApiConfig> {
    settings::load(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, config: ApiConfig) -> Result<(), String> {
    settings::save(&app, &config).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_results(req: ExportRequest) -> Result<String, String> {
    exporter::run(&req)
}

/// 让前端能拿到「内置细则」原样文本（也用于编辑器里的"恢复默认"）
#[tauri::command]
fn default_rubric() -> String {
    prompt::DEFAULT_RUBRIC.to_string()
}

/// 读取考生名单文件（txt / csv），返回姓名数组。
/// 支持 UTF-8（含 BOM）和 GB18030（Excel 另存的 csv）。
#[tauri::command]
fn load_roster(path: String) -> Result<Vec<String>, String> {
    roster::load(&PathBuf::from(path.trim())).map_err(|e| e.to_string())
}

/// 在文件管理器里定位某张卷子（老师复核异常卷时很方便）
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    let target = if p.is_file() {
        p.parent().map(Path::to_path_buf).unwrap_or(p.clone())
    } else {
        p
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| format!("打开 Finder 失败：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(target.as_os_str())
            .spawn()
            .map_err(|e| format!("打开文件管理器失败：{e}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            start_grading,
            grade_single,
            test_connection,
            load_settings,
            save_settings,
            export_results,
            default_rubric,
            load_roster,
            reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
