/**
 * 全局状态。业务动作都收在这里，组件只负责画。
 *
 * 两条不变量：
 * 1. `ai_score` 永远保持 AI 原始分不被污染 —— 人工改分只写 `overrides`，
 *    这样「撤销修改」不需要重跑模型。
 * 2. 任何分数变化都必须落一条 `revisions`，界面上那条时间轴就是它。
 */

import { create } from "zustand";

import { MOCK_FILES, MOCK_RESULTS } from "@/fixtures/sample";
import * as bridge from "@/lib/bridge";
import { orderedPaths } from "@/lib/order";
import { parseRosterText, rosterToText } from "@/lib/roster";
import { DEFAULT_RUBRIC } from "@/lib/rubric";
import { finalTotal, isModified, scoreOf } from "@/lib/score";
import type {
  ApiConfig,
  DonePayload,
  ExportRow,
  GradingResult,
  Overrides,
  RevisionEntry,
  RunProgress,
  ScanFile,
} from "@/types";

const DEFAULT_CONFIG: ApiConfig = {
  api_key: "",
  base_url: "https://api.deepseek.com",
  model: "deepseek-flash",
  timeout_secs: 180,
  json_mode: true,
  thinking: true,
};

const DEFAULT_CONCURRENCY = 3;
const ROSTER_STORAGE_KEY = "ai-grader:roster";

export type ToastKind = "ok" | "err" | "info";
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface AppStore {
  config: ApiConfig;
  prompt: string;
  /** 并发模式开关。关掉 = 一张一张来（concurrency 恒为 1） */
  concurrentEnabled: boolean;
  concurrency: number;
  /** 考生名单原文（一行一个），提交时再解析成数组 */
  rosterText: string;
  directory: string;
  files: ScanFile[];
  results: Record<string, GradingResult>;
  failed: Record<string, string>;
  overrides: Overrides;
  revisions: RevisionEntry[];
  currentPath: string | null;
  running: boolean;
  progress: RunProgress | null;
  done: DonePayload | null;
  toast: Toast | null;
  booting: boolean;

  init: () => Promise<void>;
  subscribe: () => Promise<() => void>;
  setConfig: (patch: Partial<ApiConfig>) => void;
  setPrompt: (text: string) => void;
  resetPrompt: () => void;
  setConcurrentEnabled: (on: boolean) => void;
  setConcurrency: (n: number) => void;
  setRosterText: (text: string) => void;
  importRoster: () => Promise<void>;
  clearRoster: () => void;
  importFolder: () => Promise<void>;
  startGrading: () => Promise<void>;
  retryOne: (path: string) => Promise<void>;
  select: (path: string) => void;
  step: (delta: number) => void;
  setStudentName: (filePath: string, name: string) => void;
  setOverride: (filePath: string, qid: string, value: number) => void;
  resetOverride: (filePath: string, qid: string) => void;
  resetAllOverrides: (filePath: string) => void;
  testConn: () => Promise<void>;
  exportAs: (format: "csv" | "json") => Promise<void>;
  pushToast: (text: string, kind?: ToastKind) => void;
  dismissToast: () => void;
  /** 仅浏览器预览模式：一键装入样例卷（?demo=1） */
  loadDemo: (index?: number) => void;
}

function nowHM(): string {
  return new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function makeAiRevision(r: GradingResult): RevisionEntry {
  return {
    id: `ai-${r.file_path}-${Date.now()}`,
    at: nowHM(),
    kind: "ai",
    file_path: r.file_path,
    file_name: r.file_name,
    total: r.total_ai,
    items: r.questions.map((q) => ({
      id: q.id,
      label: q.label,
      score: q.ai_score,
    })),
  };
}

/** 失败事件只带文件名，这里找回完整路径 */
function resolvePath(files: ScanFile[], name: string): string {
  const exact = files.find((f) => f.file_name === name);
  if (exact) return exact.path;
  const bySuffix = files.find(
    (f) => f.file_name.endsWith(name) || f.file_name.split("/").pop() === name
  );
  return bySuffix?.path ?? name;
}

export const useApp = create<AppStore>((set, get) => ({
  config: DEFAULT_CONFIG,
  prompt: DEFAULT_RUBRIC,
  concurrentEnabled: true,
  concurrency: DEFAULT_CONCURRENCY,
  rosterText: "",
  directory: "",
  files: [],
  results: {},
  failed: {},
  overrides: {},
  revisions: [],
  currentPath: null,
  running: false,
  progress: null,
  done: null,
  toast: null,
  booting: true,

  init: async () => {
    // 名单不算敏感信息，但要跨会话保留，否则每次开都得重新导入
    try {
      const savedRoster = window.localStorage.getItem(ROSTER_STORAGE_KEY);
      if (savedRoster) set({ rosterText: savedRoster });
    } catch {
      /* localStorage 不可用就用空的 */
    }

    try {
      const saved = await bridge.loadSettings();
      if (saved) {
        // 模型名现在可编辑了，但空值要回落到默认，别把输入框留成空的
        const merged: ApiConfig = { ...DEFAULT_CONFIG, ...saved };
        if (!merged.model.trim()) merged.model = DEFAULT_CONFIG.model;
        if (!merged.base_url.trim()) merged.base_url = DEFAULT_CONFIG.base_url;
        set({ config: merged });
      }
    } catch {
      /* 配置读不出来不影响使用，用默认值 */
    } finally {
      set({ booting: false });
    }
  },

  subscribe: async () => {
    return bridge.subscribeGrading({
      onProgress: (p) =>
        set((s) => ({
          progress: {
            done: s.progress?.done ?? 0,
            total: p.total,
            currentFile: p.file,
            currentStage:
              p.stage === "done"
                ? `已完成 · ${p.message}`
                : p.stage === "failed"
                  ? `失败 · ${p.message}`
                  : `${p.message}`,
            startedAt: s.progress?.startedAt ?? Date.now(),
          },
        })),

      onItem: (r) =>
        set((s) => ({
          results: { ...s.results, [r.file_path]: r },
          failed: Object.fromEntries(
            Object.entries(s.failed).filter(([k]) => k !== r.file_path)
          ),
          revisions: [...s.revisions, makeAiRevision(r)],
          currentPath: s.currentPath ?? r.file_path,
          progress: s.progress
            ? { ...s.progress, done: s.progress.done + 1 }
            : s.progress,
        })),

      onFailed: (f) =>
        set((s) => {
          const path = resolvePath(s.files, f.file);
          return {
            failed: { ...s.failed, [path]: f.message },
            progress: s.progress
              ? { ...s.progress, done: s.progress.done + 1 }
              : s.progress,
          };
        }),

      onDone: (d) => {
        set((s) => ({
          running: false,
          done: d,
          progress: s.progress
            ? { ...s.progress, done: d.ok + d.failed, currentStage: "全部结束" }
            : s.progress,
        }));
        const s = get();
        if (d.failed > 0) {
          s.pushToast(`批改结束：成功 ${d.ok} 张，失败 ${d.failed} 张`, "err");
        } else {
          s.pushToast(`批改完成：共 ${d.ok} 张`, "ok");
          const abnormal = Object.values(s.results).filter(
            (r) => r.is_abnormal
          ).length;
          if (abnormal > 0) {
            s.pushToast(`另有 ${abnormal} 张异常卷待人工复核`, "info");
          }
        }
      },

      onFatal: (message) => {
        set({ running: false });
        get().pushToast(message, "err");
      },
    });
  },

  setConfig: (patch) => set((s) => ({ config: { ...s.config, ...patch } })),

  setPrompt: (text) => set({ prompt: text }),

  resetPrompt: () => set({ prompt: DEFAULT_RUBRIC }),

  setConcurrentEnabled: (on) => set({ concurrentEnabled: on }),

  // 后端上限是 8（Semaphore 里 clamp 1..8），这里同步收口，避免前后端打架
  setConcurrency: (n) =>
    set({ concurrency: Math.min(Math.max(Math.round(n) || 1, 1), 8) }),

  setRosterText: (text) => {
    set({ rosterText: text });
    try {
      window.localStorage.setItem(ROSTER_STORAGE_KEY, text);
    } catch {
      /* 隐私模式下写不进去，不影响本次使用 */
    }
  },

  importRoster: async () => {
    const s = get();
    try {
      const path = await bridge.pickRosterFile();
      if (!path) return;
      const names = await bridge.loadRoster(path);
      if (names.length === 0) {
        s.pushToast("名单里没解析出姓名，请确认每行一个名字", "err");
        return;
      }
      get().setRosterText(rosterToText(names));
      s.pushToast(`已导入 ${names.length} 位考生`, "ok");
    } catch (e) {
      s.pushToast(`导入名单失败：${String(e)}`, "err");
    }
  },

  clearRoster: () => get().setRosterText(""),

  importFolder: async () => {
    try {
      const dir = await bridge.pickFolder();
      if (!dir) return;
      const files = await bridge.scanFolder(dir);
      if (files.length === 0) {
        get().pushToast("该文件夹里没有 png / jpg 图片", "err");
        return;
      }
      set({
        directory: dir,
        files,
        results: {},
        failed: {},
        overrides: {},
        revisions: [],
        currentPath: files[0].path,
        done: null,
        progress: null,
      });
      get().pushToast(`已导入 ${files.length} 张答题卡`, "ok");
    } catch (e) {
      get().pushToast(`导入失败：${String(e)}`, "err");
    }
  },

  startGrading: async () => {
    const s = get();
    if (s.running) return;
    if (s.files.length === 0) {
      s.pushToast("请先导入 PNG 文件夹", "err");
      return;
    }
    if (!s.config.api_key.trim()) {
      s.pushToast("请先填写 API Key", "err");
      return;
    }

    set({
      running: true,
      done: null,
      progress: {
        done: 0,
        total: s.files.length,
        currentFile: "",
        currentStage: "准备中",
        startedAt: Date.now(),
      },
    });

    try {
      await bridge.startGrading({
        directory: s.directory,
        files: s.files.map((f) => f.path),
        config: s.config,
        prompt: s.prompt,
        concurrency: s.concurrentEnabled ? s.concurrency : 1,
        roster: parseRosterText(s.rosterText),
      });
      // Key 只在批改成功后落盘，避免手滑存了半截
      await bridge.saveSettings(s.config).catch(() => undefined);
    } catch (e) {
      set({ running: false });
      s.pushToast(`启动失败：${String(e)}`, "err");
    }
  },

  retryOne: async (path) => {
    const s = get();
    try {
      s.pushToast("正在重新批改这一张…", "info");
      const result = await bridge.gradeSingle(
        path,
        s.config,
        s.prompt,
        parseRosterText(s.rosterText)
      );
      set((prev) => ({
        results: { ...prev.results, [result.file_path]: result },
        failed: Object.fromEntries(
          Object.entries(prev.failed).filter(([k]) => k !== path)
        ),
        overrides: { ...prev.overrides, [path]: {} },
        revisions: [...prev.revisions, makeAiRevision(result)],
        currentPath: path,
      }));
      s.pushToast("重新批改完成", "ok");
    } catch (e) {
      s.pushToast(`重新批改失败：${String(e)}`, "err");
    }
  },

  select: (path) => set({ currentPath: path }),

  step: (delta) => {
    const s = get();
    const order = orderedPaths(s.files, s.results, s.failed);
    if (order.length === 0) return;
    const idx = s.currentPath ? order.indexOf(s.currentPath) : -1;
    const next = order[Math.min(Math.max(idx + delta, 0), order.length - 1)];
    if (next) set({ currentPath: next });
  },

  setStudentName: (filePath, name) => {
    const s = get();
    const result = s.results[filePath];
    if (!result) return;
    const next = name.trim();
    if (!next || next === result.student_name) return;

    // 姓名是模型最容易读错的一项（实测会把形近的手写姓名读串），
    // 所以允许老师直接改，并记进同一条时间轴。
    const nameWasMissing = result.student_name === "未知";
    // 异常原因是「没写名字」这类，老师补上名字后就可以摘掉异常标记；
    // 如果原因是字迹不清，那补名字并不能解决问题，标记保留。
    const abnormalWasAboutName =
      result.is_abnormal && /名字|姓名/.test(result.abnormal_reason);

    set({
      results: {
        ...s.results,
        [filePath]: {
          ...result,
          student_name: next,
          is_abnormal: abnormalWasAboutName ? false : result.is_abnormal,
          abnormal_reason: abnormalWasAboutName ? "" : result.abnormal_reason,
        },
      },
      revisions: [
        ...s.revisions,
        {
          id: `rn-${Date.now()}`,
          at: nowHM(),
          kind: "rename",
          file_path: filePath,
          file_name: result.file_name,
          from: nameWasMissing ? "未知" : result.student_name,
          to: next,
        },
      ],
    });
  },

  setOverride: (filePath, qid, value) => {
    const s = get();
    const result = s.results[filePath];
    if (!result) return;
    const target = result.questions.find((q) => q.id === qid);
    if (!target) return;
    if (Number.isNaN(value)) return;

    const clamped = Math.min(Math.max(value, 0), target.max_score);
    const prevScore = scoreOf(target, s.overrides[filePath]);
    if (Math.abs(prevScore - clamped) < 0.001) return;

    const revision: RevisionEntry = {
      id: `hm-${Date.now()}-${qid}`,
      at: nowHM(),
      kind: "human",
      file_path: filePath,
      file_name: result.file_name,
      qid,
      label: target.label,
      from: prevScore,
      to: clamped,
    };

    set({
      overrides: {
        ...s.overrides,
        [filePath]: { ...(s.overrides[filePath] ?? {}), [qid]: clamped },
      },
      revisions: [...s.revisions, revision],
    });
  },

  resetOverride: (filePath, qid) => {
    const s = get();
    const result = s.results[filePath];
    const target = result?.questions.find((q) => q.id === qid);
    const current = s.overrides[filePath]?.[qid];
    if (!result || !target || current === undefined) return;

    const rest = { ...(s.overrides[filePath] ?? {}) };
    delete rest[qid];

    const revision: RevisionEntry = {
      id: `hm-${Date.now()}-${qid}-undo`,
      at: nowHM(),
      kind: "human",
      file_path: filePath,
      file_name: result.file_name,
      qid,
      label: target.label,
      from: current,
      to: target.ai_score,
      note: "撤销人工修改，恢复 AI 分数",
    };

    set({
      overrides: { ...s.overrides, [filePath]: rest },
      revisions: [...s.revisions, revision],
    });
  },

  resetAllOverrides: (filePath) => {
    const s = get();
    if (!s.overrides[filePath]) return;
    set({
      overrides: { ...s.overrides, [filePath]: {} },
      revisions: [
        ...s.revisions,
        {
          id: `hm-${Date.now()}-reset-all`,
          at: nowHM(),
          kind: "human",
          file_path: filePath,
          file_name: s.results[filePath]?.file_name ?? filePath,
          qid: "__all__",
          label: "全部题目",
          from: 0,
          to: 0,
          note: "撤销本卷全部人工修改",
        },
      ],
    });
  },

  testConn: async () => {
    const s = get();
    if (!s.config.api_key.trim()) {
      s.pushToast("请先填写 API Key", "err");
      return;
    }
    s.pushToast("正在测试连接…", "info");
    try {
      const reply = await bridge.testConnection(s.config);
      s.pushToast(`连接正常，模型回复：${reply}`, "ok");
    } catch (e) {
      s.pushToast(`连接失败：${String(e)}`, "err");
    }
  },

  exportAs: async (format) => {
    const s = get();
    const rows: ExportRow[] = [];
    for (const f of s.files) {
      const r = s.results[f.path];
      if (!r) continue;
      const fileOv = s.overrides[f.path];
      rows.push({
        file_name: r.file_name,
        student_name: r.student_name,
        is_abnormal: r.is_abnormal,
        abnormal_reason: r.abnormal_reason,
        total_ai: r.total_ai,
        total_final: finalTotal(r, s.overrides),
        total_full: r.total_full,
        modified: isModified(r, s.overrides),
        breakdown: r.questions
          .map((q) => `${q.id}:${scoreOf(q, fileOv)}/${q.max_score}`)
          .join("; "),
      });
    }

    if (rows.length === 0) {
      s.pushToast("还没有批改结果可导出", "err");
      return;
    }

    try {
      const path = await bridge.exportResults({
        directory: s.directory,
        rows,
        format,
      });
      s.pushToast(`已导出：${path}`, "ok");
    } catch (e) {
      s.pushToast(`导出失败：${String(e)}`, "err");
    }
  },

  pushToast: (text, kind = "info") =>
    set({ toast: { id: Date.now(), kind, text } }),

  dismissToast: () => set({ toast: null }),

  loadDemo: (index = 0) => {
    const files = [...MOCK_FILES];
    const results: Record<string, GradingResult> = { ...MOCK_RESULTS };
    const picked = files[Math.min(Math.max(index, 0), files.length - 1)];
    set({
      directory: "/mock/答题卡",
      files,
      results,
      failed: {},
      overrides: {},
      revisions: Object.values(results).map(makeAiRevision),
      currentPath: picked.path,
      done: {
        total: files.length,
        ok: files.length,
        failed: 0,
        elapsed_ms: 17530,
      },
      progress: {
        done: files.length,
        total: files.length,
        currentFile: "",
        currentStage: "全部结束",
        startedAt: Date.now(),
      },
    });
  },
}));
