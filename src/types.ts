/**
 * 与 Rust 端 (`src-tauri/src/models.rs`) 一一对应的类型。
 * invoke 的返回值是 any，所以这里的字段名必须手写对齐 —— 改名时两边一起改。
 */

export interface ScanFile {
  /** 原始文件绝对路径（图片是图片本身，PDF 是 PDF 本身）；一份 PDF 算"一张卷" */
  path: string;
  file_name: string;
  size: number;
  /** 页数：图片恒为 1，PDF 是实际页数（解析失败为 0） */
  page_count: number;
}

/**
 * 接口协议族。决定 endpoint、鉴权头、请求体与响应解析，四项必须成套切换：
 * - openai：`{base}/chat/completions` + `Authorization: Bearer`
 * - anthropic：`{base}/v1/messages` + `x-api-key` / `anthropic-version`
 */
export type ApiProtocol = "openai" | "anthropic";

/**
 * OpenAI 协议下思考参数用哪套字段传（各家不统一，传错会被官方接口 400）：
 * - auto：按 base_url 自动判断（deepseek → deepseek，api.openai.com → reasoning_effort，其余不发）
 * - deepseek：`thinking: {type}`
 * - reasoning_effort：`reasoning_effort: "high"`
 * - off：不发任何思考参数
 */
export type ThinkingStyle = "auto" | "deepseek" | "reasoning_effort" | "off";

export interface ApiConfig {
  api_key: string;
  base_url: string;
  model: string;
  timeout_secs: number;
  json_mode: boolean;
  /** 思考模式。默认 true：关掉快 4 倍，但实测阅卷会多算 5-7 分 */
  thinking: boolean;
  /** 接口协议族（OpenAI 兼容 / Anthropic 兼容） */
  protocol: ApiProtocol;
  /** 仅 OpenAI 协议使用：思考参数写哪一套字段 */
  thinking_style: ThinkingStyle;
  /**
   * 上传前把图片/PDF 页缩到长边不超过这么多像素。
   * 视觉模型自己也有上限（Claude 4.6 长边 1568、OpenAI high 档 2048），传更大的图没意义。
   */
  image_long_edge: number;
  /** 黑白（灰度）上传：答题卡三通道冗余，转灰度省 2/3 数据。卷面有红笔批注时可关掉 */
  image_grayscale: boolean;
  /** 原图直传：不缩放、不转灰度、不重编码（仅对图片生效；PDF 页本来就是渲染产物） */
  image_passthrough: boolean;
}

export interface QuestionScore {
  id: string;
  label: string;
  section: string;
  max_score: number;
  ai_score: number;
  reason: string;
  student_answer: string;
  standard_answer: string;
  review_needed: boolean;
  review_note: string;
}

export interface GradingResult {
  file_path: string;
  file_name: string;
  student_name: string;
  is_abnormal: boolean;
  abnormal_reason: string;
  total_ai: number;
  total_ai_reported: number | null;
  total_full: number;
  questions: QuestionScore[];
  overall_comment: string;
  model: string;
  graded_at: string;
  duration_ms: number;
  raw_json: string;
}

export interface GradeRequest {
  directory: string;
  files: string[];
  config: ApiConfig;
  prompt: string;
  concurrency: number;
  /** 提前导入的考生名单，非空时模型只能从名单里挑名字 */
  roster: string[];
}

/** 事件 payload */
export interface ProgressPayload {
  index: number;
  total: number;
  file: string;
  stage: "reading" | "uploading" | "parsing" | "done" | "failed" | string;
  message: string;
}

export interface FailedPayload {
  index: number;
  file: string;
  message: string;
}

export interface DonePayload {
  total: number;
  ok: number;
  failed: number;
  elapsed_ms: number;
}

export interface ExportRow {
  file_name: string;
  student_name: string;
  is_abnormal: boolean;
  abnormal_reason: string;
  total_ai: number;
  total_final: number;
  total_full: number;
  modified: boolean;
  breakdown: string;
}

export interface ExportRequest {
  directory: string;
  rows: ExportRow[];
  format: "csv" | "json";
}

/** ───────── 纯前端结构 ───────── */

/** 人工改分记录：一张卷子一个 qid 一条 */
export type Overrides = Record<string, Record<string, number>>;

export type RevisionEntry =
  | {
      id: string;
      at: string; // HH:MM
      kind: "ai";
      file_path: string;
      file_name: string;
      total: number;
      items: { id: string; label: string; score: number }[];
    }
  | {
      id: string;
      at: string;
      kind: "human";
      file_path: string;
      file_name: string;
      qid: string;
      label: string;
      from: number;
      to: number;
      note?: string;
    }
  | {
      id: string;
      at: string;
      kind: "rename";
      file_path: string;
      file_name: string;
      from: string;
      to: string;
    };

export interface RunProgress {
  done: number;
  total: number;
  currentFile: string;
  currentStage: string;
  startedAt: number;
}
