//! 前后端共享的数据结构。
//!
//! 约定：所有 `Serialize` 出去的字段都用 snake_case，前端 `src/types.ts` 一一对应。
//! 任何新增字段都要同步改前端类型，否则 TS 编译期发现不了（invoke 的返回值是 any）。

use serde::{Deserialize, Serialize};

/// 扫描到的一张答题卡（一份 PDF 也算"一张"，它的所有页属于同一位考生）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanFile {
    /// 原始文件绝对路径（图片就是图片本身，PDF 就是 PDF 本身）
    pub path: String,
    pub file_name: String,
    pub size: u64,
    /// 页数：图片恒为 1，PDF 是实际页数（解析失败时为 0）。
    /// PDF 的图片由 `render_pdf` 按需渲染，扫描阶段不做（40 份 PDF 一起渲染会卡一分钟）。
    pub page_count: u32,
}

/// 接口协议族。决定 endpoint、鉴权头、请求体与响应解析，四者必须成套切换。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ApiProtocol {
    /// OpenAI 兼容：`POST {base}/chat/completions` + `Authorization: Bearer`
    #[serde(rename = "openai")]
    OpenAi,
    /// Anthropic 兼容：`POST {base}/v1/messages` + `x-api-key` / `anthropic-version`
    #[serde(rename = "anthropic")]
    Anthropic,
}

impl Default for ApiProtocol {
    fn default() -> Self {
        Self::OpenAi
    }
}

/// OpenAI 协议下「思考模式」用哪套字段传。
///
/// 各家不统一，传错会被官方接口当**未知参数**直接 400（OpenAI 尤其严格），
/// 所以这里做成显式选项，`Auto` 只按 base_url 判断几个已知域名，其余一律不传。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThinkingStyle {
    /// 按 base_url 自动判断
    #[serde(rename = "auto")]
    Auto,
    /// `thinking: {"type": "enabled"|"disabled"}`（DeepSeek 官方）
    #[serde(rename = "deepseek")]
    Deepseek,
    /// `reasoning_effort: "high"`（OpenAI o 系列 / GPT-5；关掉时只能省略该字段）
    #[serde(rename = "reasoning_effort")]
    ReasoningEffort,
    /// 一个思考参数都不发（普通视觉模型、不认识这些字段的网关）
    #[serde(rename = "off")]
    Off,
}

impl Default for ThinkingStyle {
    fn default() -> Self {
        Self::Auto
    }
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
    /// 接口协议族。旧 settings.json 里没这个字段，默认按 OpenAI 兼容处理（不破坏老配置）
    #[serde(default)]
    pub protocol: ApiProtocol,
    /// 仅 OpenAI 协议使用：思考参数写哪一套字段
    #[serde(default)]
    pub thinking_style: ThinkingStyle,
    /// 上传前把图片/PDF 页缩到长边不超过这么多像素（0 表示不缩放）。
    /// 视觉模型自己也有上限（Claude 4.6 长边 1568、OpenAI high 档 2048），
    /// 传更大的图只是白占带宽。默认 2048。
    #[serde(default = "default_long_edge")]
    pub image_long_edge: u32,
    /// 黑白（灰度）上传。答题卡是黑白扫描件，三通道完全冗余，转灰度能省 2/3 原始数据。
    /// 默认开；如果卷面有红笔批注等彩色信息，关掉。
    #[serde(default = "default_true")]
    pub image_grayscale: bool,
    /// 原图直传：不缩放、不转灰度、不重编码（只对图片生效；PDF 页本来就是渲染产物）。
    /// 给"极端怀疑压缩影响识别"的场景留的逃生门。
    #[serde(default)]
    pub image_passthrough: bool,
}

fn default_model() -> String {
    "deepseek-flash".to_string()
}
fn default_timeout() -> u64 {
    180
}
fn default_long_edge() -> u32 {
    crate::imaging::DEFAULT_LONG_EDGE
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
            protocol: ApiProtocol::default(),
            thinking_style: ThinkingStyle::default(),
            image_long_edge: default_long_edge(),
            image_grayscale: true,
            image_passthrough: false,
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
    /// 提前导入的考生名单。非空时会写进 prompt，要求模型只能从名单里挑名字，
    /// 这是「精准识别姓名」的核心手段 —— 手写体靠视觉猜名字不可靠，靠名单收敛才可靠。
    #[serde(default)]
    pub roster: Vec<String>,
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
