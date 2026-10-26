import { useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Ban,
  ChevronDown,
  Clock,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Undo2,
  UserRound,
} from "lucide-react";

import { PromptEditor } from "@/components/PromptEditor";
import { RevisionLog } from "@/components/RevisionLog";
import { ScoreList } from "@/components/ScoreList";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  finalTotal,
  fmtDuration,
  fmtScore,
  isModified,
} from "@/lib/score";
import { cn } from "@/lib/utils";
import type { GradingResult } from "@/types";
import { useApp } from "@/store";

export function GradePanel() {
  const currentPath = useApp((s) => s.currentPath);
  const results = useApp((s) => s.results);
  const failed = useApp((s) => s.failed);
  const files = useApp((s) => s.files);
  const running = useApp((s) => s.running);
  const retryOne = useApp((s) => s.retryOne);

  const result = currentPath ? results[currentPath] : undefined;
  const error = currentPath ? failed[currentPath] : undefined;
  const file = files.find((f) => f.path === currentPath);

  return (
    <aside className="flex h-full w-[396px] shrink-0 flex-col border-l bg-white">
      <PromptEditor />

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto">
        {!currentPath && <PanelEmpty />}

        {currentPath && !result && !error && (
          <PanelPending
            fileName={file?.file_name ?? ""}
            running={running}
            onRetry={() => retryOne(currentPath)}
          />
        )}

        {currentPath && error && <PanelError message={error} />}

        {currentPath && result && (
          <div className="space-y-3 p-4">
            <AbnormalBanner result={result} />
            <StudentCard result={result} filePath={currentPath} />
            <BlockTitle>得分明细</BlockTitle>
            <ScoreList result={result} filePath={currentPath} />
            <BlockTitle>修改日志</BlockTitle>
            <RevisionLog filePath={currentPath} />
            <Actions result={result} filePath={currentPath} />
            <RawJson result={result} />
          </div>
        )}
      </div>
    </aside>
  );
}

function BlockTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

/** 异常卷警告横幅 */
function AbnormalBanner({ result }: { result: GradingResult }) {
  if (!result.is_abnormal) return null;
  const reason = result.abnormal_reason || "没写名字或字迹不清";

  return (
    <div className="animate-fade-in flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-600" />
      <div className="min-w-0 space-y-1">
        <p className="text-[12px] font-semibold leading-snug text-rose-800">
          该试卷被识别为异常（原因：{reason}）
        </p>
        <p className="text-[11px] leading-relaxed text-rose-700/90">
          请人工复核并手动录入信息。姓名先留「未知」，分数仍按 AI 判别保留，
          可以在下方直接改分。
        </p>
      </div>
    </div>
  );
}

/** 学生信息 + 总分 */
function StudentCard({
  result,
  filePath,
}: {
  result: GradingResult;
  filePath: string;
}) {
  const overrides = useApp((s) => s.overrides);
  const modified = isModified(result, overrides);
  const total = finalTotal(result, overrides);
  const unknown = result.student_name === "未知";

  // 实测模型自报总分和明细求和经常对不上（36 vs 29 / 30 vs 26）。
  // 我们一律以明细求和为准，但要告诉老师这件事发生过。
  const reported = result.total_ai_reported;
  const reportedMismatch =
    reported !== null && Math.abs(reported - result.total_ai) > 0.5;

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        result.is_abnormal ? "border-rose-200 bg-rose-50/40" : "bg-card"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label className="flex items-center gap-1">
            <UserRound className="size-3" />
            学生姓名
            <span className="text-[9px] font-normal text-muted-foreground/60">
              可改
            </span>
          </Label>
          <div className="mt-1 flex items-center gap-1.5">
            <StudentNameField result={result} filePath={filePath} />
            {unknown && (
              <Badge variant="danger" className="shrink-0">
                待录入
              </Badge>
            )}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <Label>总分</Label>
          <div className="mt-1 flex items-baseline justify-end gap-0.5">
            <span
              className={cn(
                "text-3xl font-bold leading-none tabular-nums",
                result.is_abnormal ? "text-rose-700" : "text-foreground"
              )}
            >
              {fmtScore(total)}
            </span>
            <span className="text-xs text-muted-foreground">
              / {fmtScore(result.total_full)}
            </span>
          </div>
          {modified && (
            <p className="mt-1 text-[10px] text-amber-700">
              AI 原始 {fmtScore(result.total_ai)} 分
            </p>
          )}
          {reportedMismatch && (
            <p
              className="mt-0.5 text-[9.5px] leading-snug text-amber-700"
              title="模型自己报的总分和它给的明细对不上，程序一律按明细求和"
            >
              自报 {fmtScore(reported!)} ≠ 明细 {fmtScore(result.total_ai)}
            </p>
          )}
        </div>
      </div>

      {result.overall_comment && (
        <p className="mt-2 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
          {result.overall_comment}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/90">
        <span className="flex items-center gap-0.5">
          <Clock className="size-2.5" />
          {result.graded_at}
        </span>
        <span>·</span>
        <span>{fmtDuration(result.duration_ms)}</span>
        <span>·</span>
        <span className="font-mono">{result.model}</span>
        {modified && (
          <Badge variant="warning" className="ml-auto">
            人工修改过
          </Badge>
        )}
        <span className="sr-only">{filePath}</span>
      </div>
    </div>
  );
}

/** 姓名可直接改：AI 认手写姓名经常读错（形近字常被读串） */
function StudentNameField({
  result,
  filePath,
}: {
  result: GradingResult;
  filePath: string;
}) {
  const setStudentName = useApp((s) => s.setStudentName);
  const [draft, setDraft] = useState(result.student_name);

  useEffect(() => {
    setDraft(result.student_name);
  }, [result.student_name]);

  const commit = () => {
    if (draft.trim() && draft.trim() !== result.student_name) {
      setStudentName(filePath, draft);
    } else {
      setDraft(result.student_name);
    }
  };

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(result.student_name);
          e.currentTarget.blur();
        }
      }}
      spellCheck={false}
      placeholder="点击录入姓名"
      title="AI 识别可能读错，点这里直接改；回车或失焦生效"
      className={cn(
        "-ml-1 w-[164px] max-w-full rounded px-1 py-0.5 text-xl font-semibold leading-tight outline-none transition-colors",
        "hover:bg-accent/60 focus:bg-white focus:ring-1 focus:ring-ring",
        result.student_name === "未知"
          ? "text-muted-foreground"
          : "text-foreground"
      )}
    />
  );
}

function Actions({
  result,
  filePath,
}: {
  result: GradingResult;
  filePath: string;
}) {
  const retryOne = useApp((s) => s.retryOne);
  const resetAllOverrides = useApp((s) => s.resetAllOverrides);
  const exportAs = useApp((s) => s.exportAs);
  const overrides = useApp((s) => s.overrides[filePath]);
  const hasOverride = !!overrides && Object.keys(overrides).length > 0;

  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="flex-1 gap-1.5"
          onClick={() => retryOne(filePath)}
        >
          <RefreshCw className="size-3.5" />
          重新批改这一张
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => resetAllOverrides(filePath)}
          disabled={!hasOverride}
          title="撤销本卷全部人工修改"
        >
          <Undo2 className="size-3.5" />
          撤销
        </Button>
      </div>

      <div className="flex gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 gap-1.5 text-[11px] text-muted-foreground"
          onClick={() => exportAs("csv")}
        >
          <Download className="size-3.5" />
          导出全部成绩 CSV
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-[11px] text-muted-foreground"
          onClick={() => exportAs("json")}
        >
          JSON
        </Button>
      </div>
      <p className="text-right text-[10px] text-muted-foreground/70">
        {result.questions.length} 个得分点
      </p>
    </div>
  );
}

function RawJson({ result }: { result: GradingResult }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-[10px] text-muted-foreground hover:text-foreground">
        <FileText className="size-3" />
        原始返回（排查用）
        <ChevronDown
          className={cn(
            "ml-auto size-3 transition-transform",
            !open && "-rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="thin-scrollbar mt-1 max-h-56 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-foreground/80">
          {result.raw_json || "（空）"}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PanelEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-dashed">
        <FileText className="size-4 text-muted-foreground" />
      </div>
      <p className="text-xs font-medium">还没有选中答题卡</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        批改完成后，姓名、总分、每题给分理由都会显示在这里
      </p>
    </div>
  );
}

function PanelPending({
  fileName,
  running,
  onRetry,
}: {
  fileName: string;
  running: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3">
        {running ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <AlertCircle className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">{fileName || "未命名"}</p>
          <p className="text-[11px] text-muted-foreground">
            {running ? "正在等待批改结果…" : "这张还没批改"}
          </p>
        </div>
      </div>
      {!running && (
        <Button size="sm" variant="outline" className="w-full gap-1.5" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          单独批改这一张
        </Button>
      )}
    </div>
  );
}

function PanelError({ message }: { message: string }) {
  return (
    <div className="p-4">
      <div className="flex gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
        <Ban className="mt-0.5 size-4 shrink-0 text-rose-600" />
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold text-rose-800">这一张批改失败</p>
          <p className="break-words text-[11px] leading-relaxed text-rose-700/90">
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}
