/**
 * 前端与 Rust 的唯一通道。
 *
 * 两件事在这里被隔离掉，业务代码不用关心：
 * 1. `IS_TAURI` —— 直接 `npm run dev` 在浏览器里打开时走 mock，UI 照样能点，
 *    方便调样式；打包成桌面应用后自动切到真实 invoke。
 * 2. `toAssetUrl` —— 本地路径转 asset:// URL（Tauri）或原样返回（浏览器）。
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import {
  MOCK_FILES,
  MOCK_RESULTS,
  mockDelay,
  mockRubric,
} from "@/fixtures/sample";
import type {
  ApiConfig,
  DonePayload,
  ExportRequest,
  FailedPayload,
  GradeRequest,
  GradingResult,
  ProgressPayload,
  ScanFile,
} from "@/types";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** 本地绝对路径 → 可直接塞进 <img src> 的 URL */
export function toAssetUrl(path: string): string {
  if (!IS_TAURI) return path;
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

export function hasTauriDialog(): boolean {
  return IS_TAURI;
}

// ───────────────────────── 命令 ─────────────────────────

export async function pickFolder(): Promise<string | null> {
  if (!IS_TAURI) return "/mock/答题卡";
  const picked = await openDialog({
    directory: true,
    multiple: false,
    title: "选择答题卡所在文件夹",
  });
  return typeof picked === "string" ? picked : null;
}

export async function scanFolder(directory: string): Promise<ScanFile[]> {
  if (!IS_TAURI) return mockDelay(MOCK_FILES, 260);
  return invoke<ScanFile[]>("scan_folder", { directory });
}

export async function startGrading(req: GradeRequest): Promise<void> {
  if (!IS_TAURI) {
    return mockRunBatch(req);
  }
  return invoke<void>("start_grading", { req });
}

export async function gradeSingle(
  filePath: string,
  config: ApiConfig,
  promptText: string
): Promise<GradingResult> {
  if (!IS_TAURI) {
    const hit = MOCK_RESULTS[filePath];
    if (!hit) throw new Error("预览模式没有这张卷子的模拟数据");
    return mockDelay(hit, 400);
  }
  return invoke<GradingResult>("grade_single", {
    filePath,
    config,
    promptText,
  });
}

export async function testConnection(config: ApiConfig): Promise<string> {
  if (!IS_TAURI) return mockDelay("可用（预览模式，未真实联网）", 500);
  return invoke<string>("test_connection", { config });
}

export async function loadSettings(): Promise<ApiConfig | null> {
  if (!IS_TAURI) {
    const saved = localStorage.getItem("ai-grader:config");
    return saved ? (JSON.parse(saved) as ApiConfig) : null;
  }
  return invoke<ApiConfig | null>("load_settings");
}

export async function saveSettings(config: ApiConfig): Promise<void> {
  if (!IS_TAURI) {
    localStorage.setItem("ai-grader:config", JSON.stringify(config));
    return;
  }
  return invoke<void>("save_settings", { config });
}

export async function exportResults(req: ExportRequest): Promise<string> {
  if (!IS_TAURI) {
    throw new Error("导出需要在桌面应用里使用（预览模式不下发文件）");
  }
  return invoke<string>("export_results", { req });
}

export async function revealInFolder(path: string): Promise<void> {
  if (!IS_TAURI) return;
  return invoke<void>("reveal_in_folder", { path });
}

export async function defaultRubric(): Promise<string> {
  if (!IS_TAURI) return mockRubric;
  return invoke<string>("default_rubric");
}

// ───────────────────────── 事件 ─────────────────────────

export interface GradeEventHandlers {
  onProgress?: (p: ProgressPayload) => void;
  onItem?: (r: GradingResult) => void;
  onFailed?: (f: FailedPayload) => void;
  onDone?: (d: DonePayload) => void;
  onFatal?: (message: string) => void;
}

/** 订阅批改事件，返回取消订阅函数 */
export async function subscribeGrading(
  handlers: GradeEventHandlers
): Promise<() => void> {
  if (!IS_TAURI) {
    mockHandlers = handlers;
    return () => {
      mockHandlers = null;
    };
  }

  const unlisteners: UnlistenFn[] = await Promise.all([
    listen<ProgressPayload>("grading:progress", (e) =>
      handlers.onProgress?.(e.payload)
    ),
    listen<GradingResult>("grading:item", (e) => handlers.onItem?.(e.payload)),
    listen<FailedPayload>("grading:item-failed", (e) =>
      handlers.onFailed?.(e.payload)
    ),
    listen<DonePayload>("grading:done", (e) => handlers.onDone?.(e.payload)),
    listen<string>("grading:fatal", (e) => handlers.onFatal?.(e.payload)),
  ]);

  return () => unlisteners.forEach((fn) => fn());
}

// ───────────────────────── 预览模式（浏览器） ─────────────────────────

let mockHandlers: GradeEventHandlers | null = null;

async function mockRunBatch(req: GradeRequest): Promise<void> {
  const pathList = req.files.length
    ? req.files
    : Object.keys(MOCK_RESULTS);
  const total = pathList.length;
  const started = Date.now();
  let ok = 0;

  for (let i = 0; i < pathList.length; i += 1) {
    const path = pathList[i];
    const name = path.split("/").pop() ?? path;

    mockHandlers?.onProgress?.({
      index: i + 1,
      total,
      file: name,
      stage: "uploading",
      message: "调用 deepseek-flash 批改（预览模式）",
    });

    await mockDelay(null, 900);

    const hit = MOCK_RESULTS[path];
    if (hit) {
      mockHandlers?.onItem?.(hit);
      ok += 1;
    } else {
      mockHandlers?.onFailed?.({
        index: i + 1,
        file: name,
        message: "预览模式没有这张卷子的模拟数据",
      });
    }
  }

  mockHandlers?.onDone?.({
    total,
    ok,
    failed: total - ok,
    elapsed_ms: Date.now() - started,
  });
}
