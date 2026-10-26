//! 模型返回的 JSON 提取与归一化。
//!
//! 大模型的 JSON 输出永远不会 100% 干净，所以这里做三件事：
//! 1. 从可能带 ```json 围栏 / 前后废话的文本里抠出第一个**括号配平**的对象；
//! 2. 用极度宽容的 serde 定义（数字可能是字符串、字段可能叫 alias、questions 可能是 null）；
//! 3. 归一化 —— 用**内置的分值表**纠正模型乱报的 max_score，clamp 分数，补全 label/section。

use crate::models::{GradingResult, QuestionScore};
use anyhow::{anyhow, Result};
use chrono::Local;
use serde::Deserialize;
use serde_json::Value;

// ───────────────────────── 宽容的反序列化定义 ─────────────────────────

#[derive(Debug, Default, Deserialize)]
pub struct AiQuestion {
    #[serde(default, alias = "id", alias = "no", alias = "number", deserialize_with = "opt_string")]
    pub question_id: Option<String>,
    #[serde(default, alias = "title", alias = "name", deserialize_with = "opt_string")]
    pub label: Option<String>,
    #[serde(default, alias = "part", alias = "group", deserialize_with = "opt_string")]
    pub section: Option<String>,
    #[serde(default, alias = "full_score", alias = "max", deserialize_with = "opt_f32")]
    pub max_score: Option<f32>,
    #[serde(default, alias = "score", alias = "points", alias = "got", deserialize_with = "opt_f32")]
    pub ai_score: Option<f32>,
    #[serde(default, alias = "comment", alias = "explanation", alias = "reasoning", deserialize_with = "opt_string")]
    pub reason: Option<String>,
    #[serde(default, alias = "answer", alias = "student_answer_text", deserialize_with = "opt_string")]
    pub student_answer: Option<String>,
    #[serde(default, alias = "correct_answer", alias = "standard", deserialize_with = "opt_string")]
    pub standard_answer: Option<String>,
    #[serde(default, alias = "needs_review", deserialize_with = "opt_bool")]
    pub review_needed: Option<bool>,
    #[serde(default, alias = "review_reason", alias = "note", deserialize_with = "opt_string")]
    pub review_note: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct AiRaw {
    #[serde(default, alias = "name", alias = "student", deserialize_with = "opt_string")]
    pub student_name: Option<String>,
    #[serde(default, alias = "abnormal", deserialize_with = "opt_bool")]
    pub is_abnormal: Option<bool>,
    #[serde(default, alias = "abnormal_note", deserialize_with = "opt_string")]
    pub abnormal_reason: Option<String>,
    #[serde(default, alias = "score", deserialize_with = "opt_f32")]
    pub total_score: Option<f32>,
    #[serde(default, alias = "max_score", alias = "total", deserialize_with = "opt_f32")]
    pub full_score: Option<f32>,
    #[serde(default, alias = "comment", alias = "summary", deserialize_with = "opt_string")]
    pub overall_comment: Option<String>,
    #[serde(default, deserialize_with = "null_as_empty")]
    pub questions: Vec<AiQuestion>,
}

fn opt_string<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s),
        Some(other) => Some(other.to_string()),
    })
}

fn opt_f32<'de, D>(d: D) -> Result<Option<f32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        Some(Value::Number(n)) => n.as_f64().map(|f| f as f32),
        Some(Value::String(s)) => {
            let cleaned = s.trim().trim_end_matches('分').trim();
            cleaned.parse::<f32>().ok()
        }
        _ => None,
    })
}

fn opt_bool<'de, D>(d: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        Some(Value::Bool(b)) => Some(b),
        Some(Value::Number(n)) => Some(n.as_f64().unwrap_or(0.0) != 0.0),
        Some(Value::String(s)) => {
            let t = s.trim().to_ascii_lowercase();
            Some(matches!(t.as_str(), "true" | "yes" | "1" | "是" | "真"))
        }
        _ => None,
    })
}

fn null_as_empty<'de, D>(d: D) -> Result<Vec<AiQuestion>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<Vec<AiQuestion>>::deserialize(d)?.unwrap_or_default())
}

// ───────────────────────── JSON 抠取 ─────────────────────────

/// 从任意文本中抠出第一个括号配平的 JSON 对象。
/// 会跳过字符串字面量内部的花括号与转义，避免被答案里的 `{`、`}` 误导。
pub fn extract_json_blob(raw: &str) -> Option<String> {
    let chars: Vec<char> = raw.chars().collect();
    let start = chars.iter().position(|c| *c == '{')?;

    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &c) in chars.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(chars[start..=i].iter().collect());
                }
            }
            _ => {}
        }
    }
    None
}

pub fn parse_ai_result(raw: &str) -> Result<AiRaw> {
    let blob = extract_json_blob(raw).ok_or_else(|| {
        anyhow!(
            "模型没有返回 JSON 对象。原始返回前 200 字：{}",
            preview(raw, 200)
        )
    })?;
    serde_json::from_str::<AiRaw>(&blob)
        .map_err(|e| anyhow!("JSON 结构不符：{e}。片段：{}", preview(&blob, 300)))
}

fn preview(s: &str, n: usize) -> String {
    let cleaned: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{cleaned}…")
    } else {
        cleaned
    }
}

// ───────────────────────── 分值表（权威）─────────────────────────

/// 每个得分点的满分。**内置表优先于模型自报的 max_score**，
/// 因为细则固定，我们比模型更清楚一个空该值几分。
fn expected_max(id: &str) -> Option<f32> {
    const TABLE: [(&str, f32); 15] = [
        ("11-1-1", 2.0),
        ("11-1-2", 2.0),
        ("11-1-3", 2.0),
        ("11-2-1", 2.0),
        ("11-3-1", 3.0), // 离子方程式
        ("11-3-2", 3.0), // 原因叙述
        ("11-3-3", 2.0), // 工序
        ("11-4-1", 2.0),
        ("11-5-1", 2.0),
        ("12-1-1", 2.0),
        ("12-1-2", 2.0),
        ("12-2-1", 2.0),
        ("12-2-2", 2.0),
        ("12-3-1", 2.0), // 优点
        ("12-3-2", 4.0), // 仪器选择
    ];

    if let Ok(n) = id.parse::<u32>() {
        if (1..=10).contains(&n) {
            return Some(6.0);
        }
    }
    // 12-4-1 / 12-4-2 / 12-5-1 与 11 题同构，直接补规则
    if matches!(id, "12-4-1" | "12-4-2" | "12-5-1") {
        return Some(2.0);
    }
    TABLE
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, v)| *v)
}

fn infer_section(id: &str) -> String {
    match id.split('-').next().unwrap_or("") {
        "11" => "二、第 11 题".to_string(),
        "12" => "三、第 12 题".to_string(),
        _ => "一、选择题".to_string(),
    }
}

fn pretty_label(id: &str) -> String {
    let parts: Vec<&str> = id.split('-').collect();
    match parts.len() {
        1 => format!("第 {} 题", parts[0]),
        2 => format!("{}({})", parts[0], parts[1]),
        _ => format!("{}({}) 第 {} 空", parts[0], parts[1], parts[2]),
    }
}

/// 排序用：`(大题号, 小问, 空号)`
fn sort_key(id: &str) -> (u32, u32, u32) {
    let mut nums = id.split('-').filter_map(|s| s.parse::<u32>().ok());
    (
        nums.next().unwrap_or(999),
        nums.next().unwrap_or(0),
        nums.next().unwrap_or(0),
    )
}

// ───────────────────────── 归一化 ─────────────────────────

const NAME_PLACEHOLDERS: [&str; 8] = ["", "未知", "无", "不详", "null", "none", "n/a", "-"];

fn clean_name(raw: Option<String>) -> Option<String> {
    let s = raw.unwrap_or_default();
    let t = s.trim().trim_matches('"').trim();
    if NAME_PLACEHOLDERS
        .iter()
        .any(|p| t.eq_ignore_ascii_case(p))
    {
        None
    } else {
        Some(t.to_string())
    }
}

pub fn normalize(
    ai: AiRaw,
    file_path: &str,
    file_name: &str,
    model: &str,
    duration_ms: u64,
    raw_json: &str,
) -> GradingResult {
    let name = clean_name(ai.student_name);
    let name_missing = name.is_none();

    let mut questions: Vec<QuestionScore> = ai
        .questions
        .into_iter()
        .enumerate()
        .map(|(i, q)| {
            // id 缺失时用序号兜底，保证前端改分有稳定主键
            let id = q
                .question_id
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("q{}", i + 1));

            let raw_score = q.ai_score.unwrap_or(0.0);
            let max = expected_max(&id)
                .or(q.max_score.filter(|m| *m > 0.0))
                .unwrap_or_else(|| raw_score.max(0.0));

            let ai_score = raw_score.clamp(0.0, max);

            QuestionScore {
                label: q
                    .label
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| pretty_label(&id)),
                section: q
                    .section
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| infer_section(&id)),
                max_score: max,
                ai_score,
                reason: q.reason.unwrap_or_default().trim().to_string(),
                student_answer: q.student_answer.unwrap_or_default().trim().to_string(),
                standard_answer: q.standard_answer.unwrap_or_default().trim().to_string(),
                review_needed: q.review_needed.unwrap_or(false),
                review_note: q.review_note.unwrap_or_default().trim().to_string(),
                id,
            }
        })
        .collect();

    questions.sort_by_key(|q| sort_key(&q.id));

    let total_ai: f32 = questions.iter().map(|q| q.ai_score).sum();
    let is_abnormal = ai.is_abnormal.unwrap_or(false) || name_missing;

    let reason = ai.abnormal_reason.unwrap_or_default().trim().to_string();
    let abnormal_reason = if !is_abnormal {
        String::new()
    } else if !reason.is_empty() {
        reason
    } else if name_missing {
        "没写名字".to_string()
    } else {
        "字迹不清".to_string()
    };

    GradingResult {
        file_path: file_path.to_string(),
        file_name: file_name.to_string(),
        student_name: name.unwrap_or_else(|| "未知".to_string()),
        is_abnormal,
        abnormal_reason,
        total_ai: round1(total_ai),
        total_ai_reported: ai.total_score,
        total_full: ai.full_score.filter(|v| *v > 0.0).unwrap_or(100.0),
        questions,
        overall_comment: ai.overall_comment.unwrap_or_default().trim().to_string(),
        model: model.to_string(),
        graded_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        duration_ms,
        raw_json: raw_json.to_string(),
    }
}

fn round1(v: f32) -> f32 {
    (v * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"好的，以下是批改结果：
```json
{"student_name":"徐天津","is_abnormal":false,"total_score":24,"full_score":100,
 "overall_comment":"选择题失分较多",
 "questions":[
  {"question_id":"1","max_score":6,"score":6,"reason":"选 C，正确","student_answer":"C","standard_answer":"C"},
  {"question_id":"2","max_score":6,"score":"0","reason":"选 D，应为 B"}
 ]}
```"#;

    #[test]
    fn extracts_json_from_fenced_prose() {
        let blob = extract_json_blob(SAMPLE).expect("应能抠出 JSON");
        assert!(blob.starts_with('{'));
        assert!(blob.ends_with('}'));
        let ai = parse_ai_result(SAMPLE).expect("应能解析");
        assert_eq!(ai.questions.len(), 2);
        // 字符串分数 "0" 也要能读
        assert_eq!(ai.questions[1].ai_score, Some(0.0));
    }

    #[test]
    fn braces_inside_strings_do_not_break_balance() {
        let raw = r#"{"student_name":"李{四}","questions":[]}"#;
        let blob = extract_json_blob(raw).unwrap();
        assert_eq!(blob, raw);
    }

    #[test]
    fn missing_name_forces_abnormal() {
        let ai = AiRaw {
            student_name: Some("未知".into()),
            is_abnormal: None,
            questions: vec![],
            ..Default::default()
        };
        let r = normalize(ai, "a.png", "a.png", "deepseek-flash", 10, "{}");
        assert!(r.is_abnormal);
        assert_eq!(r.abnormal_reason, "没写名字");
        assert_eq!(r.student_name, "未知");
    }

    #[test]
    fn score_is_clamped_to_rubric_max() {
        let raw = r#"{"student_name":"张三","questions":[
            {"question_id":"3","score":99},
            {"question_id":"11-3-1","score":7}
        ]}"#;
        let ai = parse_ai_result(raw).unwrap();
        let r = normalize(ai, "b.png", "b.png", "deepseek-flash", 10, raw);
        assert_eq!(r.questions[0].max_score, 6.0);
        assert_eq!(r.questions[0].ai_score, 6.0);
        assert_eq!(r.questions[1].max_score, 3.0);
        assert_eq!(r.questions[1].ai_score, 3.0);
        // 第 11 题归到"二、第 11 题"
        assert!(r.questions[1].section.contains("11"));
    }
}
