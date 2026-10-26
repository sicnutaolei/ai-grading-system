/**
 * 与 Rust 端 (`src-tauri/src/models.rs`) 一一对应的类型。
 * invoke 的返回值是 any，所以这里的字段名必须手写对齐 —— 改名时两边一起改。
 */

export interface ScanFile {
  path: string;
  file_name: string;
  size: number;
}

export interface ApiConfig {
  api_key: string;
  base_url: string;
  model: string;
  timeout_secs: number;
  json_mode: boolean;
  /** 思考模式。默认 true：关掉快 4 倍，但实测阅卷会多算 5-7 分 */
  thinking: boolean;
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
