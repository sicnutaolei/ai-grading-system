//! 考生名单解析。
//!
//! 老师手上的名单通常两种来源：
//! - 记事本 / WPS 另存的 txt（UTF-8，可能带 BOM）
//! - Excel 另存的 csv（中文 Windows 默认 GB18030，不是 UTF-8）
//!
//! 所以解码要能退回 GB18030，否则中文姓名全变乱码，而乱码的名单比没有名单更危险
//! （模型会拿乱码去"纠正"学生的名字）。

use anyhow::{bail, Context, Result};
use std::path::Path;

pub fn load(path: &Path) -> Result<Vec<String>> {
    if !path.is_file() {
        bail!("文件不存在：{}", path.display());
    }
    let bytes = std::fs::read(path).with_context(|| format!("读取失败：{}", path.display()))?;
    let text = decode(&bytes);
    let names = parse(&text);
    if names.is_empty() {
        bail!("没能从 {} 里解析出姓名，请确认每行一个名字", path.display());
    }
    Ok(names)
}

fn decode(bytes: &[u8]) -> String {
    // UTF-8 BOM
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    // Excel 导出的 CSV 在中文环境下基本都是 GB18030
    let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
    cow.to_string()
}

/// 表头里常见的列名。整行只要有一格等于其中某个词，就当成表头跳过。
///
/// 用「整格相等」而不是「包含」，避免把「李姓名」这类真实姓名误杀。
const HEADER_WORDS: [&str; 6] = ["序号", "姓名", "名字", "学号", "班级", "编号"];

/// 按行解析，容忍「序号,姓名」、带表头、带引号、逗号/制表符/分号分隔
pub fn parse(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    for line in text.lines() {
        let line = line.trim().trim_matches('\u{feff}').trim();
        if line.is_empty() {
            continue;
        }

        let cells: Vec<&str> = line
            .split(|c| c == ',' || c == '\t' || c == ';' || c == '，')
            .map(|s| s.trim().trim_matches('"').trim())
            .filter(|s| !s.is_empty())
            .collect();

        // 整行是表头（如 `序号,姓名`）就跳过
        if cells.iter().any(|c| HEADER_WORDS.contains(c)) {
            continue;
        }

        // 跳过纯数字列（序号），取第一个非数字的
        let Some(name) = cells.iter().find(|s| !s.chars().all(|c| c.is_ascii_digit())) else {
            continue;
        };
        let name = name.trim();

        // 姓名不该很长；偶尔有人把整行备注写进来，过滤掉避免污染名单
        let char_count = name.chars().count();
        if char_count == 0 || char_count > 16 {
            continue;
        }

        if !out.iter().any(|existing| existing == name) {
            out.push(name.to_string());
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_lines_and_dedups() {
        let names = parse("张三\n李四\n\n  王五  \n张三\n");
        assert_eq!(names, vec!["张三", "李四", "王五"]);
    }

    #[test]
    fn skips_header_and_index_column() {
        let csv = "序号,姓名\n1,张三\n2,李四\n";
        assert_eq!(parse(csv), vec!["张三", "李四"]);
    }

    #[test]
    fn survives_quoted_and_tab_separated() {
        let text = "\"张三\"\t13800000000\n李四\t13800000001\n";
        assert_eq!(parse(text), vec!["张三", "李四"]);
    }

    #[test]
    fn decodes_utf8_and_strips_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("张三\n李四".as_bytes());
        assert_eq!(parse(&decode(&bytes)), vec!["张三", "李四"]);
    }

    #[test]
    fn decodes_gb18030() {
        // "张三" 的 GB18030 编码
        let gbk: Vec<u8> = vec![0xD5, 0xC5, 0xC8, 0xFD];
        assert_eq!(parse(&decode(&gbk)), vec!["张三"]);
    }
}
