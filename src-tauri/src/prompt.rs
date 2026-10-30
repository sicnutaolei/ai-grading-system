//! 内置评分 Prompt。
//!
//! 细则正文单独放在仓库根的 `rubric.md`，Rust 与前端共用同一份文件
//! （Rust 走 include_str!，前端走 Vite 的 ?raw），避免两边内容漂移。
//! JSON 输出契约固定写在这里，老师编辑细则时改不到它。

/// 老师可编辑的评分细则；编译期嵌进二进制
pub const DEFAULT_RUBRIC: &str = include_str!("../../rubric.md");

/// JSON 输出契约。固定尾随在评分细则之后，前端不可编辑。
pub const JSON_CONTRACT: &str = r##"# 输出格式（强制）
只返回一个严格合法的 JSON 对象，**不要** Markdown 代码块标记，**不要**任何解释性前后缀文字。
顶层结构：

{
  "student_name": "学生姓名，没有写则填 '未知'",
  "is_abnormal": false,
  "abnormal_reason": "",
  "total_score": 0,
  "full_score": 100,
  "overall_comment": "一句话总评，20 字以内",
  "questions": [
    {
      "question_id": "1",
      "label": "第 1 题",
      "section": "一、选择题",
      "max_score": 6,
      "score": 6,
      "reason": "选 C，与标准答案一致",
      "student_answer": "C",
      "standard_answer": "C",
      "review_needed": false,
      "review_note": ""
    }
  ]
}

字段约束：
- `questions` 必须覆盖全部 28 个得分点：选择题 10 条 + 第 11 题 9 条 + 第 12 题 9 条。每个得分点单独一条，不要把「第 11 题」或「第 12 题」合并成一条 20 分。
- `question_id` 用稳定编号：选择题 `1`..`10`；第 11 题 `11-1-1`、`11-1-2`、`11-1-3`、`11-2-1`、`11-3-1`、`11-3-2`、`11-3-3`、`11-4-1`、`11-5-1`；第 12 题 `12-1-1`、`12-1-2`、`12-2-1`、`12-2-2`、`12-3-1`、`12-3-2`、`12-4-1`、`12-4-2`、`12-5-1`。**同一份卷子里 id 不得重复**。
- `section` 只能是 `一、选择题`、`二、第 11 题`、`三、第 12 题` 三者之一。
- `score` 必须是数字，且 0 ≤ score ≤ max_score。
- `student_answer` 填学生实际写的内容（照抄手写内容，看不清就写「无法辨认」）。
- 所有 `score` 之和必须等于 `total_score`。

# 异常判定（必须严格执行）
满足以下任一条件时：`student_name` 填 `"未知"`，`is_abnormal` 填 `true`，`abnormal_reason` 填具体原因：
1. 卷面**没有写名字**（姓名栏为空）。
2. 主观题**字迹严重潦草、涂改**导致根本无法辨认（注意：个别字不认识不算，必须是「大面积无法判读」）。
`abnormal_reason` 用中文简短说明，例如：`没写名字`、`字迹不清`、`没写名字且字迹不清`。
异常卷**仍要照常给分**（基于你能看清的部分），不要因为异常就跳过批改。
"##;

/// 拼装最终发给模型的 system prompt
///
/// `roster` 非空时插入「姓名必须从名单里选」的强约束。实测：不给名单时模型会
/// 把形近的手写姓名读成另一个名字（甚至凭空造一个），给了名单之后再测就稳定了。
pub fn build_system_prompt(rubric: &str, roster: &[String]) -> String {
    let body = if rubric.trim().is_empty() {
        DEFAULT_RUBRIC
    } else {
        rubric.trim()
    };
    format!(
        "你是一位资深的高中化学阅卷老师，正在批改学生手写答题卡的扫描图。\n\
         你的判断必须基于图像本身的视觉信息，不要先做纯文本 OCR 再推理。\n\
         给分要严格对齐下面的细则，理由要具体到「哪一步对了、哪一步错了」。\n\n\
         {body}\n\n{roster_block}{contract}",
        body = body,
        roster_block = roster_block(roster),
        contract = JSON_CONTRACT
    )
}

/// 名单约束段。没有名单时返回空串，行为与之前完全一致。
fn roster_block(roster: &[String]) -> String {
    let names: Vec<&str> = roster
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if names.is_empty() {
        return String::new();
    }

    format!(
        "# 本班考生名单（共 {n} 人，姓名必须从这里选）\n\
         {list}\n\n\
         ## 姓名匹配规则（优先级高于一切视觉猜测）\n\
         1. `student_name` 必须是上面名单中的**某一个完整姓名**，原样照抄，不许改字、不许简写、不许自己编造。\n\
         2. 手写体形近时，从名单里选字形最接近的那一个；同时在 `overall_comment` 末尾加上「姓名按名单匹配，请核对」。\n\
         3. 姓名栏为空，或完全无法与名单中任何一项对应时：`student_name` 填 `未知`，`is_abnormal` 填 `true`，`abnormal_reason` 填 `没写名字或不在名单内`。\n\
         4. 绝不许因为名单里有某个名字，就把一张明显写着别的名字的卷子硬套上去。名单是用来纠错的，不是用来编造的。\n\n",
        n = names.len(),
        list = names.join("、")
    )
}

/// 单张卷子的 user message 文本（图片以 image_url 形式另附）
pub const USER_INSTRUCTION: &str = "这是学生答题卡的扫描图片。请按评分细则批改，\
只输出符合约定的 JSON。若姓名栏为空或主观题大面积无法辨认，请把 is_abnormal 设为 true。";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_prompt_contains_contract_and_rules() {
        let p = build_system_prompt(DEFAULT_RUBRIC, &[]);
        assert!(p.contains("沸石"));
        assert!(p.contains("is_abnormal"));
        assert!(p.contains("升华"));
        // 老师清空细则时应回落到内置版本，而不是发出空 prompt
        let fallback = build_system_prompt("   ", &[]);
        assert!(fallback.contains("选择题"));
    }

    #[test]
    fn roster_only_appears_when_provided() {
        let without = build_system_prompt(DEFAULT_RUBRIC, &[]);
        assert!(!without.contains("考生名单"));

        let with = build_system_prompt(DEFAULT_RUBRIC, &["张三".into(), "李四".into()]);
        assert!(with.contains("共 2 人"));
        assert!(with.contains("张三、李四"));
        assert!(with.contains("不许自己编造"));
        // 名单要排在 JSON 契约之前，别被当成输出示例的一部分
        assert!(with.find("考生名单").unwrap() < with.find("输出格式").unwrap());
    }
}
