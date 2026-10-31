//! Tauri 入口：注册 command、挂插件。

mod api;
mod exporter;
mod grading;
mod imaging;
mod models;
mod parser;
mod pdf;
mod prompt;
mod roster;
mod scanner;
mod settings;

use imaging::ImageOptions;
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
    // PDF 渲染出来的 PNG 在缓存目录里，预览同样要走 asset 协议
    allow_pdf_cache(&app)?;

    tokio::task::spawn_blocking(move || scanner::scan_folder(&dir))
        .await
        .map_err(|e| format!("扫描任务失败：{e}"))
}

/// 把 PDF 缓存目录加进 asset 协议白名单（并确保目录存在）
fn allow_pdf_cache(app: &AppHandle) -> Result<PathBuf, String> {
    let root = grading::cache_root(app);
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("创建 PDF 缓存目录失败：{}：{e}", root.display()))?;
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| format!("授权 PDF 缓存目录失败（预览将 403）：{e}"))?;
    Ok(root)
}

/// 把 PDF 渲染成图片（预览用）。返回页图片的绝对路径，前端可直接丢给 `<img>`。
///
/// 尺寸由「长边上限」决定（默认 2048），和真正上传时用的档位保持一致 ——
/// 预览看到什么，模型看到的就是什么。结果有磁盘缓存，反复调用只渲染第一次。
#[tauri::command]
async fn render_pdf(
    app: AppHandle,
    path: String,
    long_edge: Option<u32>,
    grayscale: Option<bool>,
) -> Result<Vec<String>, String> {
    let file = PathBuf::from(path.trim());
    if !file.is_file() {
        return Err(format!("文件不存在：{}", file.display()));
    }
    if !pdf::is_pdf(&file) {
        return Err("这不是 PDF 文件".into());
    }

    let root = allow_pdf_cache(&app)?;
    let opts = ImageOptions {
        long_edge: long_edge.unwrap_or(imaging::DEFAULT_LONG_EDGE),
        grayscale: grayscale.unwrap_or(true),
        // PDF 页是渲染产物，没有"原图"可直传
        passthrough: false,
    };

    tokio::task::spawn_blocking(move || pdf::render_pages(&file, &opts, &root, &mut |_, _| {}))
        .await
        .map_err(|e| format!("渲染任务失败：{e}"))?
        .map_err(|e| e.to_string())
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
    // 批改过程中会把 PDF 渲染到缓存目录，提前授权，另一边预览就不会 403
    allow_pdf_cache(&app)?;

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
    let root = allow_pdf_cache(&app)?;
    let opts = ImageOptions::from_config(&config);

    grading::grade_one(
        &app,
        &client,
        &config,
        &system_prompt,
        &file_path,
        &root,
        opts,
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
            render_pdf,
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
