//! 前后端共享的数据结构。
//!
//! 约定：所有 `Serialize` 出去的字段都用 snake_case，前端 `src/types.ts` 一一对应。
//! 任何新增字段都要同步改前端类型，否则 TS 编译期发现不了（invoke 的返回值是 any）。

use serde::{Deserialize, Serialize};

/// 扫描到的单张答题卡
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanFile {
    pub path: String,
    pub file_name: String,
    pub size: u64,
}

/// API 配置（由前端传入，可选持久化到 app_config_dir/settings.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiConfig {
    pub api_key: String,
    pub base_url: String,
    /// 模型名由前端可编辑，默认 deepseek-flash
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    /// 是否带 response_format=json_object；部分网关不支持，失败时会自动降级重试
    #[serde(default = "default_true")]
    pub json_mode: bool,
    /// 思考模式。默认开启：实测关闭后阅卷明显变马虎（第 9 题「B 对 B」判 0 分，
    /// 11(1) 两空误给 4 分），一张卷子多算 5-7 分。赶时间可关，但要接受准确率下降。
    #[serde(default = "default_true")]
    pub thinking: bool,
}

fn default_model() -> String {
    "deepseek-flash".to_string()
}
fn default_timeout() -> u64 {
    180
}
fn default_true() -> bool {
    true
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            base_url: "https://api.deepseek.com".to_string(),
            model: default_model(),
            timeout_secs: default_timeout(),
            json_mode: true,
            thinking: default_true(),
        }
    }
}

/// 单个得分点。一个"小题"可能拆成多个得分点（如 11(3) 的方程式/原因/工序）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionScore {
    /// 稳定 id，人工改分以它为主键：`1`..`10`、`11-1-1`、`12-3-2`
    pub id: String,
    /// 展示用题号：`第 3 题`、`11(1) 第一空`
    pub label: String,
    /// 分组名，前端按它折叠：`一、选择题`、`二、第 11 题`
    pub section: String,
    pub max_score: f32,
    pub ai_score: f32,
    /// AI 给的判分依据（前端展示 + 人工复核时参考）
    pub reason: String,
    pub student_answer: String,
    pub standard_answer: String,
    /// AI 认为这一空看不清 / 有涂改歧义，建议人工复核
    pub review_needed: bool,
    pub review_note: String,
}

/// 一张卷子的完整批改结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GradingResult {
    pub file_path: String,
    pub file_name: String,
    pub student_name: String,
    pub is_abnormal: bool,
    pub abnormal_reason: String,
    /// 明细求和得到的 AI 总分（权威值）
    pub total_ai: f32,
    /// AI 自己申报的总分，可能与其明细不一致，仅用于排查
    pub total_ai_reported: Option<f32>,
    pub total_full: f32,
    pub questions: Vec<QuestionScore>,
    pub overall_comment: String,
    pub model: String,
    pub graded_at: String,
    pub duration_ms: u64,
    /// 原始返回，出问题时老师可以直接看模型到底吐了什么
    pub raw_json: String,
}

/// 批改请求
#[derive(Debug, Clone, Deserialize)]
pub struct GradeRequest {
    pub directory: String,
    /// 为空则批改目录下全部图片
    #[serde(default)]
    pub files: Vec<String>,
    pub config: ApiConfig,
    /// 前端可编辑的评分细则；为空则用内置默认
    #[serde(default)]
    pub prompt: String,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
}

fn default_concurrency() -> usize {
    3
}

// ───────────────────────── 事件 payload ─────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ProgressPayload {
    pub index: usize,
    pub total: usize,
    pub file: String,
    /// reading | uploading | parsing | done | failed
    pub stage: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FailedPayload {
    pub index: usize,
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DonePayload {
    pub total: usize,
    pub ok: usize,
    pub failed: usize,
    pub elapsed_ms: u64,
}

// ───────────────────────── 导出 ─────────────────────────

/// 前端把"人工覆盖后"的最终态回传，后端负责落盘（CSV / JSON）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRow {
    pub file_name: String,
    pub student_name: String,
    pub is_abnormal: bool,
    pub abnormal_reason: String,
    pub total_ai: f32,
    pub total_final: f32,
    pub total_full: f32,
    pub modified: bool,
    /// 明细，形如 "1:6/6;2:0/6;11-3-1:1/3"
    pub breakdown: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    pub directory: String,
    pub rows: Vec<ExportRow>,
    /// `csv` | `json`
    pub format: String,
}
