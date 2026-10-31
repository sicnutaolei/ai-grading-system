import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Flag, RotateCcw } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { groupBySection, fmtScore, scoreOf, scoreTone } from "@/lib/score";
import { cn } from "@/lib/utils";
import type { GradingResult, QuestionScore } from "@/types";
import { useApp } from "@/store";

/** 得分明细：按题型折叠，每行可人工改分 */
export function ScoreList({
  result,
  filePath,
}: {
  result: GradingResult;
  filePath: string;
}) {
  const overrides = useApp((s) => s.overrides[filePath]);
  const [reviewOnly, setReviewOnly] = useState(false);
  const sections = useMemo(
    () => groupBySection(result.questions),
    [result.questions]
  );
  const reviewCount = result.questions.filter((q) => q.review_needed).length;

  useEffect(() => {
    setReviewOnly(false);
  }, [filePath]);

  if (result.questions.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-5 text-center">
        <p className="text-xs font-medium">AI 没有返回得分明细</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          可重新批改这一张，或展开底部「原始返回」排查模型输出。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          共 {result.questions.length} 个得分点，点击分数即可修正
        </span>
        {reviewCount > 0 && (
          <button
            type="button"
            aria-pressed={reviewOnly}
            onClick={() => setReviewOnly((value) => !value)}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-md border px-2 text-[10px] font-medium transition-colors",
              reviewOnly
                ? "border-amber-300 bg-amber-50 text-amber-700"
                : "border-border bg-white text-muted-foreground hover:text-foreground"
            )}
          >
            <Flag className="size-3" />{reviewOnly ? "查看全部" : `仅看待复核 ${reviewCount}`}
          </button>
        )}
      </div>

      {sections.map(({ section, items }) => {
        const visibleItems = reviewOnly ? items.filter((q) => q.review_needed) : items;
        if (visibleItems.length === 0) return null;
        const got = items.reduce((sum, q) => sum + scoreOf(q, overrides), 0);
        const max = items.reduce((sum, q) => sum + q.max_score, 0);
        return (
          <Section
            key={section}
            title={section}
            got={got}
            max={max}
            items={visibleItems}
            filePath={filePath}
            overrides={overrides}
          />
        );
      })}
    </div>
  );
}

function Section({
  title,
  got,
  max,
  items,
  filePath,
  overrides,
}: {
  title: string;
  got: number;
  max: number;
  items: QuestionScore[];
  filePath: string;
  overrides: Record<string, number> | undefined;
}) {
  const [open, setOpen] = useState(true);
  const reviewCount = items.filter((q) => q.review_needed).length;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="overflow-hidden rounded-lg border bg-white"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 bg-muted/40 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/70">
        <ChevronDown
          className={cn(
            "size-3 text-muted-foreground transition-transform",
            !open && "-rotate-90"
          )}
        />
        <span className="text-[11px] font-medium">{title}</span>
        {reviewCount > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-amber-600">
            <Flag className="size-2.5" />
            {reviewCount}
          </span>
        )}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {fmtScore(got)}
          <span className="text-muted-foreground/50"> / {fmtScore(max)}</span>
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="divide-y">
          {items.map((q) => (
            <ScoreRow
              key={q.id}
              q={q}
              filePath={filePath}
              overrideValue={overrides?.[q.id]}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ScoreRow({
  q,
  filePath,
  overrideValue,
}: {
  q: QuestionScore;
  filePath: string;
  overrideValue?: number;
}) {
  const setOverride = useApp((s) => s.setOverride);
  const resetOverride = useApp((s) => s.resetOverride);

  const value = overrideValue ?? q.ai_score;
  const manual = overrideValue !== undefined;
  const [draft, setDraft] = useState(fmtScore(value));

  useEffect(() => {
    setDraft(fmtScore(value));
  }, [value]);

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isNaN(parsed)) {
      setDraft(fmtScore(value));
      return;
    }
    const clamped = Math.min(Math.max(parsed, 0), q.max_score);
    setDraft(fmtScore(clamped));
    setOverride(filePath, q.id, clamped);
  };

  return (
    <div
      className={cn(
        "group px-3 py-2.5 transition-colors",
        manual ? "bg-amber-50/50" : q.review_needed ? "bg-amber-50/20" : "hover:bg-accent/30"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          <span className="truncate">{q.label}</span>
          {q.review_needed && (
            <Flag className="size-3 shrink-0 text-amber-500" aria-label="AI 建议人工复核" />
          )}
          {manual && (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
              已改
            </span>
          )}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Input
            value={draft}
            inputMode="decimal"
            aria-label={`${q.label}得分，满分 ${fmtScore(q.max_score)} 分`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commit();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setDraft(fmtScore(value));
                e.currentTarget.blur();
              }
            }}
            className={cn(
              "h-7 w-14 bg-white px-1 text-center text-xs font-semibold tabular-nums shadow-none",
              scoreTone(value, q.max_score),
              manual && "border-amber-300 bg-amber-50"
            )}
            title={`输入 0–${fmtScore(q.max_score)} 分，回车或失焦生效`}
          />
          <span className="text-[11px] tabular-nums text-muted-foreground">
            / {fmtScore(q.max_score)}
          </span>
        </div>

        <button
          type="button"
          onClick={() => resetOverride(filePath, q.id)}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-accent",
            manual ? "opacity-100" : "opacity-0 group-hover:opacity-40"
          )}
          title={`恢复 AI 分数 ${fmtScore(q.ai_score)} 分`}
          aria-label={`恢复 ${q.label} 的 AI 分数`}
          disabled={!manual}
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>

      {q.reason && (
        <p className="mt-1.5 select-text text-[11px] leading-relaxed text-muted-foreground">
          {q.reason}
        </p>
      )}

      {(q.student_answer || q.standard_answer) && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-muted/50 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          {q.student_answer && (
            <span>学生：<span className="select-text font-mono text-foreground/80">{q.student_answer}</span></span>
          )}
          {q.standard_answer && (
            <span>标准：<span className="select-text font-mono text-foreground/80">{q.standard_answer}</span></span>
          )}
        </div>
      )}

      {q.review_note && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[10px] leading-relaxed text-amber-700">
          <span className="font-medium">复核提示：</span>{q.review_note}
        </p>
      )}
    </div>
  );
}
