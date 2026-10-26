import type { GradingResult, Overrides, QuestionScore } from "@/types";

/** 某题当前生效分数：人工覆盖优先于 AI */
export function scoreOf(
  q: QuestionScore,
  fileOverrides: Record<string, number> | undefined
): number {
  const manual = fileOverrides?.[q.id];
  return typeof manual === "number" ? manual : q.ai_score;
}

export function finalTotal(
  result: GradingResult,
  overrides: Overrides
): number {
  const fileOverrides = overrides[result.file_path];
  const sum = result.questions.reduce(
    (acc, q) => acc + scoreOf(q, fileOverrides),
    0
  );
  return round1(sum);
}

export function isModified(
  result: GradingResult,
  overrides: Overrides
): boolean {
  const fileOverrides = overrides[result.file_path];
  if (!fileOverrides) return false;
  return Object.entries(fileOverrides).some(([qid, value]) => {
    const q = result.questions.find((item) => item.id === qid);
    return q ? Math.abs(q.ai_score - value) > 0.001 : false;
  });
}

/** 按 section 分组，保持后端给的顺序（一、二、三） */
export function groupBySection(
  questions: QuestionScore[]
): { section: string; items: QuestionScore[] }[] {
  const order: string[] = [];
  const bucket = new Map<string, QuestionScore[]>();
  for (const q of questions) {
    if (!bucket.has(q.section)) {
      bucket.set(q.section, []);
      order.push(q.section);
    }
    bucket.get(q.section)!.push(q);
  }
  return order.map((section) => ({ section, items: bucket.get(section)! }));
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 分数展示：整数不带小数点，半分显示 .5 */
export function fmtScore(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 时长展示 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} 分 ${s} 秒`;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 分数对应的语义色（不含红/绿之外的立场，只表达高低） */
export function scoreTone(got: number, max: number): string {
  if (max <= 0) return "text-muted-foreground";
  const ratio = got / max;
  if (ratio >= 0.999) return "text-emerald-600";
  if (ratio <= 0.001) return "text-rose-600";
  return "text-amber-600";
}
