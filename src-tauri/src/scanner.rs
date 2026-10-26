//! 文件夹遍历。
//!
//! 只认图片扩展名。虽然是"PNG 阅卷"，但老师手上经常混着 .jpg（扫描仪/夸克扫描王
//! 默认就是 jpg），所以一并支持，避免导入后列表空白。

use crate::models::ScanFile;
use std::path::Path;
use walkdir::WalkDir;

const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 递归扫描目录下的所有图片，按"自然序"排序（2.png 排在 10.png 前面）
pub fn scan_folder(dir: &Path) -> Vec<ScanFile> {
    let mut out: Vec<ScanFile> = Vec::new();
    if !dir.is_dir() {
        return out;
    }

    for entry in WalkDir::new(dir)
        .follow_links(true)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() || !is_image(entry.path()) {
            continue;
        }
        let path = entry.path();
        let size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);
        out.push(ScanFile {
            path: path.to_string_lossy().to_string(),
            file_name: relative_name(dir, path),
            size,
        });
    }

    out.sort_by(|a, b| natural_key(&a.file_name).cmp(&natural_key(&b.file_name)));
    out
}

/// 保留子目录信息的相对路径（统一用 / 分隔，前端展示更稳）
fn relative_name(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 数字补零后做普通字符串比较，等价于自然排序，且实现足够简单
fn natural_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    let mut num = String::new();
    for ch in s.chars() {
        if ch.is_ascii_digit() {
            num.push(ch);
        } else {
            if !num.is_empty() {
                out.push_str(&format!("{:0>10}", num));
                num.clear();
            }
            out.push(ch.to_ascii_lowercase());
        }
    }
    if !num.is_empty() {
        out.push_str(&format!("{:0>10}", num));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order_puts_2_before_10() {
        let mut names = vec!["10.png", "2.png", "1.png"];
        names.sort_by(|a, b| natural_key(a).cmp(&natural_key(b)));
        assert_eq!(names, vec!["1.png", "2.png", "10.png"]);
    }

    #[test]
    fn image_ext_check_is_case_insensitive() {
        assert!(is_image(Path::new("a.PNG")));
        assert!(is_image(Path::new("a.jpeg")));
        assert!(!is_image(Path::new("a.txt")));
    }
}
