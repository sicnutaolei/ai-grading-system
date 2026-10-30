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
import { applyPreset, presetById, PROVIDERS } from "@/lib/providers";
import { parseRosterText, rosterToText } from "@/lib/roster";
import { DEFAULT_RUBRIC } from "@/lib/rubric";
import { finalTotal, isModified, scoreOf } from "@/lib/score";
import type {
  ApiConfig,
  ApiProtocol,
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
  protocol: "openai",
  thinking_style: "deepseek",
  image_long_edge: 2048,
  image_grayscale: true,
  image_passthrough: false,
};

const normBase = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();

/** 存量 settings.json 可能缺 protocol / thinking_style / 画质字段，这里补齐并纠正非法值 */
function normalizeConfig(raw: Partial<ApiConfig> | null): ApiConfig {
  const merged: ApiConfig = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  if (!merged.model.trim()) merged.model = DEFAULT_CONFIG.model;
  if (!merged.base_url.trim()) merged.base_url = DEFAULT_CONFIG.base_url;
  if (merged.protocol !== "openai" && merged.protocol !== "anthropic") {
    merged.protocol = DEFAULT_CONFIG.protocol;
  }
  if (!["auto", "deepseek", "reasoning_effort", "off"].includes(merged.thinking_style)) {
    merged.thinking_style = DEFAULT_CONFIG.thinking_style;
  }
  const edge = Number(merged.image_long_edge);
  merged.image_long_edge = Number.isFinite(edge) && edge > 0 ? edge : DEFAULT_CONFIG.image_long_edge;
  merged.image_grayscale = merged.image_grayscale !== false;
  merged.image_passthrough = merged.image_passthrough === true;
  return merged;
}

const DEFAULT_CONCURRENCY = 3;
/** 与后端 grading::MAX_CONCURRENCY 对齐 */
const MAX_CONCURRENCY = 100;
const ROSTER_STORAGE_KEY = "ai-grader:roster";
const PDF_TIP_STORAGE_KEY = "ai-grader:pdf-tip-seen";

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
  /** PDF 渲染出来的每页图片路径缓存（key = 原 PDF 路径） */
  pdfPages: Record<string, string[]>;
  /** 正在渲染中的 PDF 路径 */
  pdfRendering: Record<string, boolean>;
  /** 首次导入 PDF 时的说明弹窗 */
  pdfTipOpen: boolean;
  directory: string;
  files: ScanFile[];
  /** 预检中排除、不参与批改与导出的文件（如混在答题卡里的试卷 PDF） */
  excludedPaths: string[];
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
  /** 选服务商预设：一次填对协议 + 地址 + 模型 + 思考参数四件套 */
  setProvider: (id: string) => void;
  /** 切协议族：地址/模型不配套时会跟着换成该协议的默认预设 */
  setProtocol: (protocol: ApiProtocol) => void;
  setPrompt: (text: string) => void;
  resetPrompt: () => void;
  setConcurrentEnabled: (on: boolean) => void;
  setConcurrency: (n: number) => void;
  setRosterText: (text: string) => void;
  importRoster: () => Promise<void>;
  clearRoster: () => void;
  /** 按需渲染 PDF 的每一页（有缓存就直接返回） */
  loadPdfPages: (path: string) => Promise<string[]>;
  dismissPdfTip: () => void;
  importFolder: () => Promise<void>;
  setExcludedPaths: (paths: string[]) => void;
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
  pdfPages: {},
  pdfRendering: {},
  pdfTipOpen: false,
  directory: "",
  files: [],
  excludedPaths: [],
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
      /* localStorage 不可用就用默认值 */
    }

    try {
      const saved = await bridge.loadSettings();
      if (saved) {
        // 模型名现在可编辑了，但空值要回落到默认，别把输入框留成空的；
        // 老配置里没有 protocol / thinking_style，也得补齐才不会发错协议
        set({ config: normalizeConfig(saved) });
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

  setConfig: (patch) =>
    set((s) => {
      const next = { ...s.config, ...patch };
      // 画质档位/黑白开关一变，已经渲染好的 PDF 页就不再代表模型实际看到的图，
      // 必须丢掉前端缓存（后端按档位分目录，下次调用会重新渲染）。
      const qualityChanged =
        next.image_long_edge !== s.config.image_long_edge ||
        next.image_grayscale !== s.config.image_grayscale;
      return {
        config: next,
        ...(qualityChanged ? { pdfPages: {}, pdfRendering: {} } : {}),
      };
    }),

  setProvider: (id) => {
    const preset = presetById(id);
    if (!preset || preset.id === "custom") return;
    set((s) => ({ config: { ...s.config, ...applyPreset(preset) } }));
  },

  setProtocol: (protocol) =>
    set((s) => {
      if (s.config.protocol === protocol) return {};
      // 只是改了协议没改地址的话，请求一定发错地方（Anthropic 的域名配 OpenAI 的路径）。
      // 地址本身已经属于目标协议的预设，就保留；否则整套换成该协议的默认预设。
      const base = normBase(s.config.base_url);
      const fits = PROVIDERS.some(
        (p) => p.id !== "custom" && p.protocol === protocol && normBase(p.base_url) === base
      );
      if (fits) return { config: { ...s.config, protocol } };
      const fallback = presetById(protocol === "anthropic" ? "anthropic" : "deepseek");
      return fallback
        ? { config: { ...s.config, ...applyPreset(fallback) } }
        : { config: { ...s.config, protocol } };
    }),

  setPrompt: (text) => set({ prompt: text }),

  resetPrompt: () => set({ prompt: DEFAULT_RUBRIC }),

  setConcurrentEnabled: (on) => set({ concurrentEnabled: on }),

  // 后端上限是 100（grading::MAX_CONCURRENCY），这里同步收口，避免前后端打架。
  // 数字输入框清空时 Number("") 是 0，靠 `|| 1` 兜住，不会变成 0 路并发。
  setConcurrency: (n) =>
    set({ concurrency: Math.min(Math.max(Math.round(n) || 1, 1), MAX_CONCURRENCY) }),

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

  loadPdfPages: async (path) => {
    const s = get();
    const cached = s.pdfPages[path];
    if (cached?.length) return cached;
    if (s.pdfRendering[path]) return [];

    set((prev) => ({ pdfRendering: { ...prev.pdfRendering, [path]: true } }));
    try {
      const pages = await bridge.renderPdf(
        path,
        s.config.image_long_edge,
        s.config.image_grayscale
      );
      set((prev) => ({
        pdfPages: { ...prev.pdfPages, [path]: pages },
        pdfRendering: { ...prev.pdfRendering, [path]: false },
      }));
      return pages;
    } catch (e) {
      set((prev) => ({ pdfRendering: { ...prev.pdfRendering, [path]: false } }));
      get().pushToast(`PDF 渲染失败：${String(e)}`, "err");
      return [];
    }
  },

  dismissPdfTip: () => {
    set({ pdfTipOpen: false });
    try {
      window.localStorage.setItem(PDF_TIP_STORAGE_KEY, "1");
    } catch {
      /* 存不下就每次导入都提示一次，不致命 */
    }
  },

  importFolder: async () => {
    try {
      const dir = await bridge.pickFolder();
      if (!dir) return;
      const files = await bridge.scanFolder(dir);
      if (files.length === 0) {
        get().pushToast("该文件夹里没有 png / jpg / pdf 文件", "err");
        return;
      }
      set({
        directory: dir,
        files,
        excludedPaths: [],
        results: {},
        failed: {},
        overrides: {},
        revisions: [],
        currentPath: files[0].path,
        pdfPages: {},
        pdfRendering: {},
        done: null,
        progress: null,
      });

      // 第一次导入 PDF 时讲清楚规则：一份 PDF = 一位考生，所有页一起提交
      const hasPdf = files.some((f) => bridge.isPdfPath(f.path));
      if (hasPdf) {
        let seen = false;
        try {
          seen = window.localStorage.getItem(PDF_TIP_STORAGE_KEY) === "1";
        } catch {
          seen = false;
        }
        if (!seen) set({ pdfTipOpen: true });
      }

      const pdfCount = files.filter((f) => bridge.isPdfPath(f.path)).length;
      get().pushToast(
        pdfCount > 0
          ? `已导入 ${files.length} 份答题卡（含 ${pdfCount} 份 PDF）`
          : `已导入 ${files.length} 张答题卡`,
        "ok"
      );
    } catch (e) {
      get().pushToast(`导入失败：${String(e)}`, "err");
    }
  },

  setExcludedPaths: (paths) => {
    const valid = new Set(get().files.map((file) => file.path));
    set({ excludedPaths: [...new Set(paths)].filter((path) => valid.has(path)) });
  },

  startGrading: async () => {
    const s = get();
    if (s.running) return;
    if (s.files.length === 0) {
      s.pushToast("请先导入答题卡文件夹", "err");
      return;
    }
    const activeFiles = s.files.filter((file) => !s.excludedPaths.includes(file.path));
    if (activeFiles.length === 0) {
      s.pushToast("没有参与批改的试卷，请先恢复被排除的文件", "err");
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
        total: activeFiles.length,
        currentFile: "",
        currentStage: "准备中",
        startedAt: Date.now(),
      },
    });

    try {
      await bridge.startGrading({
        directory: s.directory,
        files: activeFiles.map((f) => f.path),
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
    const activeFiles = s.files.filter((file) => !s.excludedPaths.includes(file.path));
    const order = orderedPaths(activeFiles, s.results, s.failed);
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
      if (s.excludedPaths.includes(f.path)) continue;
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
      excludedPaths: [],
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
