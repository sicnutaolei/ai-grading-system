//! 配置持久化。
//!
//! 查找顺序：
//! 1. `app_config_dir/settings.json` —— 用户自己填的，优先
//! 2. `src-tauri/dev-settings.json` —— 仅 debug 构建生效，放测试 Key，已被 .gitignore 排除
//!
//! 注意：API Key 明文存盘。桌面端本地单人使用可以接受，
//! 但不要把这个文件同步到网盘/仓库。

use crate::models::ApiConfig;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

fn settings_file(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .context("无法定位应用配置目录")?;
    std::fs::create_dir_all(&dir).context("创建配置目录失败")?;
    Ok(dir.join("settings.json"))
}

fn read_config(path: &Path) -> Option<ApiConfig> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<ApiConfig>(&text).ok()
}

pub fn load(app: &AppHandle) -> Option<ApiConfig> {
    if let Ok(path) = settings_file(app) {
        if let Some(cfg) = read_config(&path) {
            return Some(cfg);
        }
    }

    // dev 兜底：让 `npm run tauri:dev` 一启动就带好测试 Key，省得每次粘贴。
    // release 构建 debug_assertions=false，这段不会执行；文件内容是运行时读取的，
    // 从不会被打进二进制。
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dev-settings.json");
        if let Some(cfg) = read_config(&dev) {
            return Some(cfg);
        }
    }

    None
}

pub fn save(app: &AppHandle, cfg: &ApiConfig) -> Result<()> {
    let path = settings_file(app)?;
    let text = serde_json::to_string_pretty(cfg).context("序列化配置失败")?;
    std::fs::write(&path, text).with_context(|| format!("写入失败：{}", path.display()))?;
    Ok(())
}
