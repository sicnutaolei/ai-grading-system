import { useMemo, useState } from "react";
import { Bot, ChevronDown, History, PenLine, UserRound } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fmtScore } from "@/lib/score";
import { cn } from "@/lib/utils";
import type { RevisionEntry } from "@/types";
import { useApp } from "@/store";

/**
 * 修改日志（时间轴）。
 *
 * AI 那一步合并成一条（否则一张卷子 26 条 AI 记录会把人工修改淹没），
 * 点开可以看每个得分点的原始分。人工修改一律逐条保留，不可删。
 */
export function RevisionLog({ filePath }: { filePath: string }) {
  const revisions = useApp((s) => s.revisions);
  const list = useMemo(
    () => revisions.filter((r) => r.file_path === filePath),
    [revisions, filePath]
  );

  if (list.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5">
        <History className="size-3.5 text-muted-foreground" />
        <p className="text-[11px] text-muted-foreground">
          这张卷子还没有任何修改记录
        </p>
      </div>
    );
  }

  return (
    <div className="relative pl-4">
      <div className="absolute bottom-2 left-[5px] top-2 w-px bg-border" />
      <div className="space-y-2.5">
        {list.map((entry) => (
          <div key={entry.id} className="relative">
            <span
              className={cn(
                "absolute -left-[11px] top-[5px] size-[7px] rounded-full ring-2 ring-white",
                entry.kind === "ai"
                  ? "bg-sky-500"
                  : entry.kind === "rename"
                    ? "bg-violet-500"
                    : "bg-amber-500"
              )}
            />
            {entry.kind === "ai" ? (
              <AiRow entry={entry} />
            ) : entry.kind === "rename" ? (
              <RenameRow entry={entry} />
            ) : (
              <HumanRow entry={entry} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AiRow({ entry }: { entry: Extract<RevisionEntry, { kind: "ai" }> }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-start gap-1.5 text-left">
        <Bot className="mt-[1px] size-3 shrink-0 text-sky-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] leading-snug text-foreground/90">
            <span className="tabular-nums text-muted-foreground">
              [{entry.at}]
            </span>{" "}
            AI 完成批改 · 合计{" "}
            <span className="font-semibold tabular-nums">{fmtScore(entry.total)}</span>{" "}
            分 · {entry.items.length} 个得分点
          </p>
        </div>
        <ChevronDown
          className={cn(
            "mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform",
            !open && "-rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-md bg-muted/40 p-2">
          {entry.items.map((item) => (
            <div
              key={item.id}
              className="flex items-baseline justify-between gap-1 text-[10px]"
            >
              <span className="truncate text-muted-foreground">
                {item.label}
              </span>
              <span className="shrink-0 tabular-nums text-foreground/70">
                {fmtScore(item.score)}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RenameRow({
  entry,
}: {
  entry: Extract<RevisionEntry, { kind: "rename" }>;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <UserRound className="mt-[1px] size-3 shrink-0 text-violet-600" />
      <p className="text-[11px] leading-snug text-foreground/90">
        <span className="tabular-nums text-muted-foreground">[{entry.at}]</span>{" "}
        姓名{" "}
        <span className="text-muted-foreground line-through">{entry.from}</span>
        <span className="mx-1 text-muted-foreground">→</span>
        <span className="font-semibold">{entry.to}</span>
      </p>
    </div>
  );
}

function HumanRow({
  entry,
}: {
  entry: Extract<RevisionEntry, { kind: "human" }>;
}) {
  return (
    <div className="flex items-start gap-1.5">
      <PenLine className="mt-[1px] size-3 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] leading-snug text-foreground/90">
          <span className="tabular-nums text-muted-foreground">[{entry.at}]</span>{" "}
          <span className="font-medium">{entry.label}</span>{" "}
          {entry.note ? (
            <span className="text-muted-foreground">{entry.note}</span>
          ) : (
            <span>
              人工修改 <span className="tabular-nums">{fmtScore(entry.from)}</span>
              <span className="mx-1 text-muted-foreground">→</span>
              <span className="font-semibold tabular-nums text-amber-700">
                {fmtScore(entry.to)}
              </span>{" "}
              分
            </span>
          )}
        </p>
      </div>
    </div>
  );
}
