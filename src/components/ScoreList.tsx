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
  const sections = useMemo(
    () => groupBySection(result.questions),
    [result.questions]
  );

  if (result.questions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-4 text-center">
        <p className="text-xs font-medium text-muted-foreground">
          AI 没有返回得分明细
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
          模型可能违约返回了空 questions。点左下「重新批改这一张」，
          或展开「原始返回」看看它到底吐了什么。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {sections.map(({ section, items }) => {
        const got = items.reduce(
          (sum, q) => sum + scoreOf(q, overrides),
          0
        );
        const max = items.reduce((sum, q) => sum + q.max_score, 0);
        return (
          <Section
            key={section}
            title={section}
            got={got}
            max={max}
            items={items}
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
    setOverride(filePath, q.id, parsed);
  };

  return (
    <div
      className={cn(
        "group px-2.5 py-1.5 transition-colors",
        manual ? "bg-amber-50/40" : "hover:bg-accent/30"
      )}
    >
      <div className="flex items-center gap-2">
        <span className="flex min-w-0 items-center gap-1 text-[11px] font-medium">
          <span className="truncate">{q.label}</span>
          {q.review_needed && (
            <Flag
              className="size-2.5 shrink-0 text-amber-500"
              aria-label="AI 建议人工复核"
            />
          )}
          {manual && (
            <span className="shrink-0 rounded bg-amber-100 px-1 text-[9px] font-normal text-amber-700">
              已改
            </span>
          )}
        </span>

        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          <span className={scoreTone(value, q.max_score)}>
            {fmtScore(value)}
          </span>
          <span className="text-muted-foreground/50">/{fmtScore(q.max_score)}</span>
        </span>

        <div className="relative shrink-0">
          <Input
            value={draft}
            inputMode="decimal"
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
              "h-6 w-12 px-1 text-center text-[11px] tabular-nums",
              manual && "border-amber-300 bg-amber-50"
            )}
            title="输入分数后回车/失焦生效"
          />
        </div>

        <button
          type="button"
          onClick={() => resetOverride(filePath, q.id)}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent",
            manual ? "opacity-100" : "opacity-0 group-hover:opacity-40"
          )}
          title="恢复 AI 分数"
          disabled={!manual}
        >
          <RotateCcw className="size-3" />
        </button>
      </div>

      {q.reason && (
        <p className="mt-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
          {q.reason}
        </p>
      )}

      {(q.student_answer || q.standard_answer) && (
        <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] leading-snug text-muted-foreground/80">
          {q.student_answer && (
            <span>
              学生：
              <span className="font-mono text-foreground/70">
                {q.student_answer}
              </span>
            </span>
          )}
          {q.standard_answer && (
            <span>
              标准：
              <span className="font-mono text-foreground/70">
                {q.standard_answer}
              </span>
            </span>
          )}
        </p>
      )}

      {q.review_note && (
        <p className="mt-0.5 text-[10px] text-amber-600">复核提示：{q.review_note}</p>
      )}
    </div>
  );
}
