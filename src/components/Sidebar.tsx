import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Link2,
  Loader2,
  Play,
  RotateCcw,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IS_TAURI } from "@/lib/bridge";
import { buildRows } from "@/lib/order";
import { fmtScore, fmtSize } from "@/lib/score";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";

export function Sidebar() {
  const files = useApp((s) => s.files);
  const results = useApp((s) => s.results);
  const failed = useApp((s) => s.failed);
  const currentPath = useApp((s) => s.currentPath);
  const running = useApp((s) => s.running);
  const progress = useApp((s) => s.progress);
  const importFolder = useApp((s) => s.importFolder);
  const startGrading = useApp((s) => s.startGrading);
  const select = useApp((s) => s.select);

  const rows = useMemo(
    () => buildRows(files, results, failed),
    [files, results, failed]
  );

  const gradedCount = rows.filter((r) => r.result).length;
  const abnormalCount = rows.filter((r) => r.abnormal).length;
  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <aside className="flex h-full w-[304px] shrink-0 flex-col border-r bg-white">
      {/* 品牌区 */}
      <div className="flex items-center gap-2.5 px-4 py-3.5">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <CheckCircle2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-tight">AI 自动化阅卷</div>
          <div className="text-[11px] leading-tight text-muted-foreground">
            化学答题卡 · 批改工作台
          </div>
        </div>
        {!IS_TAURI && (
          <Badge variant="info" title="当前是浏览器预览模式，数据为模拟内容">
            预览
          </Badge>
        )}
      </div>

      <ApiSection />

      {/* 导入 */}
      <div className="px-3 pb-2">
        <Button
          variant="outline"
          className="h-9 w-full justify-start gap-2"
          onClick={importFolder}
        >
          <FolderOpen className="size-4 text-muted-foreground" />
          导入 PNG 文件夹
        </Button>
      </div>

      {/* 列表表头 */}
      <div className="flex items-center justify-between px-4 pb-1.5 pt-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          答题卡 {rows.length > 0 && `· ${rows.length}`}
        </span>
        {abnormalCount > 0 && (
          <span className="flex items-center gap-1 text-[11px] font-medium text-rose-600">
            <AlertTriangle className="size-3" />
            {abnormalCount} 张异常
          </span>
        )}
      </div>

      {/* 文件列表 */}
      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.length === 0 && <EmptyList />}

        {rows.map((row, index) => {
          const active = row.file.path === currentPath;
          const total = row.result
            ? row.result.questions.reduce((sum, q) => sum + q.ai_score, 0)
            : null;

          return (
            <button
              key={row.file.path}
              onClick={() => select(row.file.path)}
              className={cn(
                "group mb-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                active ? "bg-accent" : "hover:bg-accent/60"
              )}
            >
              <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>

              {row.abnormal ? (
                <AlertTriangle className="size-3.5 shrink-0 text-rose-500" />
              ) : row.error ? (
                <XCircle className="size-3.5 shrink-0 text-rose-400" />
              ) : row.result ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
              ) : (
                <div className="size-3.5 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
              )}

              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[12px] leading-tight",
                  active ? "font-medium text-foreground" : "text-foreground/80"
                )}
                title={`${row.file.file_name}（${fmtSize(row.file.size)}）`}
              >
                {row.file.file_name}
              </span>

              {row.abnormal && (
                <Badge variant="danger" className="shrink-0 px-1">
                  异常
                </Badge>
              )}
              {row.error && (
                <Badge variant="danger" className="shrink-0 px-1">
                  失败
                </Badge>
              )}
              {total !== null && !row.error && (
                <span
                  className={cn(
                    "shrink-0 text-[11px] font-semibold tabular-nums",
                    row.abnormal ? "text-rose-600" : "text-foreground/70"
                  )}
                >
                  {fmtScore(total)}
                </span>
              )}
              {row.pending && (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  待批
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* 底部操作 */}
      <div className="space-y-2 border-t bg-white p-3">
        <Button
          className="h-10 w-full gap-2"
          onClick={startGrading}
          disabled={running || rows.length === 0}
        >
          {running ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              批改中 {progress?.done ?? 0}/{progress?.total ?? rows.length}
            </>
          ) : (
            <>
              <Play className="size-4" />
              开始批量批改
            </>
          )}
        </Button>

        {(running || gradedCount > 0) && (
          <div className="space-y-1">
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span className="truncate">
                {progress?.currentStage ?? `已完成 ${gradedCount} 张`}
              </span>
              <span className="shrink-0 tabular-nums">{pct}%</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

/** API 配置折叠面板 */
function ApiSection() {
  const config = useApp((s) => s.config);
  const setConfig = useApp((s) => s.setConfig);
  const testConn = useApp((s) => s.testConn);
  const [open, setOpen] = useState(true);
  const [showKey, setShowKey] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-3 pb-2">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground">
        <ChevronDown
          className={cn("size-3 transition-transform", !open && "-rotate-90")}
        />
        接口配置
        <span className="ml-auto normal-case tracking-normal text-[10px] font-normal">
          {open ? "收起" : "展开"}
        </span>
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-2 pt-1">
        <div className="space-y-1">
          <Label htmlFor="api-key" className="flex items-center gap-1">
            <KeyRound className="size-3" />
            API Key
          </Label>
          <div className="relative">
            <Input
              id="api-key"
              type={showKey ? "text" : "password"}
              value={config.api_key}
              placeholder="sk-..."
              autoComplete="off"
              spellCheck={false}
              className="h-8 pr-8 font-mono text-xs"
              onChange={(e) => setConfig({ api_key: e.target.value })}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent"
              title={showKey ? "隐藏" : "显示"}
            >
              {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor="base-url" className="flex items-center gap-1">
            <Link2 className="size-3" />
            Base URL
          </Label>
          <Input
            id="base-url"
            value={config.base_url}
            spellCheck={false}
            className="h-8 font-mono text-[11px]"
            onChange={(e) => setConfig({ base_url: e.target.value })}
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="model" className="flex items-center gap-1">
            <Cpu className="size-3" />
            模型
          </Label>
          <Input
            id="model"
            list="model-candidates"
            value={config.model}
            spellCheck={false}
            className="h-8 font-mono text-xs"
            onChange={(e) => setConfig({ model: e.target.value })}
          />
          <datalist id="model-candidates">
            <option value="deepseek-flash">DeepSeek-V4.1-Flash（支持图像）</option>
            <option value="deepseek-v4-pro">DeepSeek-V4-Pro（纯文本）</option>
          </datalist>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={config.thinking}
          onClick={() => setConfig({ thinking: !config.thinking })}
          className="flex w-full items-center gap-2 rounded-md py-1 text-left"
          title="思考模式：模型先推理再作答。关闭更快，但评分会变马虎"
        >
          <span
            className={cn(
              "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
              config.thinking ? "bg-primary" : "bg-input"
            )}
          >
            <span
              className={cn(
                "absolute size-3 rounded-full bg-white shadow transition-all",
                config.thinking ? "left-3.5" : "left-0.5"
              )}
            />
          </span>
          <span className="text-[11px]">思考模式</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {config.thinking ? "开 · 更准" : "关 · 快 4 倍"}
          </span>
        </button>
        {!config.thinking && (
          <p className="-mt-1 text-[10px] leading-snug text-amber-600">
            实测关掉后每张会多算 5~7 分，只在赶时间时用
          </p>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-center gap-1.5 text-[11px] text-muted-foreground"
          onClick={testConn}
        >
          <RotateCcw className="size-3" />
          测试连接
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

function EmptyList() {
  return (
    <div className="mt-8 flex flex-col items-center gap-2 px-4 text-center">
      <div className="flex size-10 items-center justify-center rounded-lg border border-dashed">
        <FolderOpen className="size-4 text-muted-foreground" />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        还没有导入答题卡
        <br />
        点上方「导入 PNG 文件夹」
      </p>
    </div>
  );
}
