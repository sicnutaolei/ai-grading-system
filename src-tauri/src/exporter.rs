//! 成绩导出：CSV（给 Excel）与 JSON（给二次处理）。
//!
//! CSV 必须带 UTF-8 BOM，否则 Windows 版 Excel 打开中文全是乱码。

use crate::models::ExportRequest;
use std::path::PathBuf;

pub fn run(req: &ExportRequest) -> Result<String, String> {
    let dir = PathBuf::from(req.directory.trim());
    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", dir.display()));
    }
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");

    match req.format.as_str() {
        "json" => {
            let path = dir.join(format!("阅卷结果-{ts}.json"));
            let text = serde_json::to_string_pretty(&req.rows).map_err(|e| e.to_string())?;
            std::fs::write(&path, text).map_err(|e| format!("写入失败：{e}"))?;
            Ok(path.to_string_lossy().to_string())
        }
        _ => {
            let path = dir.join(format!("阅卷结果-{ts}.csv"));
            let mut out = String::from("\u{feff}");
            out.push_str("文件名,姓名,异常,异常原因,AI总分,最终总分,满分,人工修改,得分明细\r\n");
            for r in &req.rows {
                let cells = [
                    csv_escape(&r.file_name),
                    csv_escape(&r.student_name),
                    if r.is_abnormal { "是".to_string() } else { "否".to_string() },
                    csv_escape(&r.abnormal_reason),
                    fmt_num(r.total_ai),
                    fmt_num(r.total_final),
                    fmt_num(r.total_full),
                    if r.modified { "是".to_string() } else { "否".to_string() },
                    csv_escape(&r.breakdown),
                ];
                out.push_str(&cells.join(","));
                out.push_str("\r\n");
            }
            std::fs::write(&path, out).map_err(|e| format!("写入失败：{e}"))?;
            Ok(path.to_string_lossy().to_string())
        }
    }
}

fn fmt_num(v: f32) -> String {
    if (v.fract()).abs() < f32::EPSILON {
        format!("{}", v as i64)
    } else {
        format!("{v:.1}")
    }
}

fn csv_escape(s: &str) -> String {
    let needs_quote = s
        .chars()
        .any(|c| c == ',' || c == '"' || c == '\n' || c == '\r');
    if needs_quote {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_commas_and_quotes() {
        assert_eq!(csv_escape("张三"), "张三");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("他说\"好\""), "\"他说\"\"好\"\"\"");
    }
}
