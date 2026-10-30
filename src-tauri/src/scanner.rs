//! 文件夹遍历。
//!
//! 认图片和 PDF。虽然是"PNG 阅卷"，但老师手上经常混着 .jpg（扫描仪/夸克扫描王
//! 默认就是 jpg），现在又多了一种 .pdf（一份 PDF 一位考生，多页属于同一张卷子）。
//!
//! PDF 在这一层只做"数页数"，不渲染 —— 300dpi 渲染一份卷子要几百毫秒，
//! 40 份一起渲染会让导入卡住一分钟。渲染推迟到选中预览或开始批改时再做（有磁盘缓存）。

use crate::models::ScanFile;
use crate::pdf;
use std::path::Path;
use walkdir::WalkDir;

const IMAGE_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 支持导入的扩展名（图片 + PDF）
pub fn is_supported(path: &Path) -> bool {
    is_image(path) || pdf::is_pdf(path)
}

/// 递归扫描目录下的所有答题卡，按"自然序"排序（2.png 排在 10.png 前面）
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
        let path = entry.path();
        if !entry.file_type().is_file() || !is_supported(path) {
            continue;
        }
        let size = entry.metadata().ok().map(|m| m.len()).unwrap_or(0);

        if pdf::is_pdf(path) {
            // 页数解析失败（加密/损坏）不在这里拦，留给批改时给出具体原因，
            // 列表里仍能看到这份文件，不会被"悄悄跳过"。
            let count = pdf::page_count(path).unwrap_or(0) as u32;
            out.push(ScanFile {
                path: path.to_string_lossy().to_string(),
                file_name: relative_name(dir, path),
                size,
                page_count: count,
            });
        } else {
            out.push(ScanFile {
                path: path.to_string_lossy().to_string(),
                file_name: relative_name(dir, path),
                size,
                page_count: 1,
            });
        }
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

    #[test]
    fn pdf_counts_as_supported_but_not_image() {
        assert!(is_supported(Path::new("卷子.PDF")));
        assert!(!is_image(Path::new("卷子.pdf")));
        assert!(!is_supported(Path::new("名单.txt")));
    }

    /// 一份 PDF 在列表里只算一行，页数由扫描阶段解析出来
    #[test]
    fn scan_reports_pdf_page_count() {
        const BLANK_PDF: &str = "%PDF-1.7
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
";
        let dir = std::env::temp_dir().join(format!("aigs-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("2.png"), b"x").unwrap();
        std::fs::write(dir.join("10.png"), b"x").unwrap();
        std::fs::write(dir.join("张三.pdf"), BLANK_PDF.as_bytes()).unwrap();

        let files = scan_folder(&dir);
        let names: Vec<&str> = files.iter().map(|f| f.file_name.as_str()).collect();
        // 自然序：数字在字母/汉字之前，2.png 在 10.png 前
        assert_eq!(names, vec!["2.png", "10.png", "张三.pdf"]);

        // 扫描阶段只数页数，不渲染（渲染推迟到预览/批改）
        let pdf = files.iter().find(|f| f.file_name.ends_with(".pdf")).unwrap();
        assert_eq!(pdf.page_count, 1);

        let png = files.iter().find(|f| f.file_name == "2.png").unwrap();
        assert_eq!(png.page_count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
