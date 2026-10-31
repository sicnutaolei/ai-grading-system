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
  Layers,
  Link2,
  Loader2,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IS_TAURI } from "@/lib/bridge";
import { buildRows } from "@/lib/order";
import { keyPlaceholder, matchProvider, PROVIDERS } from "@/lib/providers";
import { parseRosterText } from "@/lib/roster";
import { finalTotal, fmtScore, fmtSize } from "@/lib/score";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";
import type { ApiConfig } from "@/types";

/**
 * 上传画质三档。数值是「长边像素上限」——视觉模型自己也有上限，
 * Claude 4.6 是 1568、OpenAI high 档是 2048，传更大的图模型也看不到。
 */
const QUALITY_PRESETS = [
  { longEdge: 2048, label: "清晰", hint: "长边 2048：把 OpenAI 的 2048 打满，Claude 会自己再缩一档" },
  { longEdge: 1568, label: "标准", hint: "长边 1568：正好是 Claude 4.6 的上限，体积再小 40%" },
  { longEdge: 1200, label: "省流", hint: "长边 1200：小字略糊，适合网络很差的场景" },
];

export function Sidebar() {
  const files = useApp((s) => s.files);
  const results = useApp((s) => s.results);
  const failed = useApp((s) => s.failed);
  const overrides = useApp((s) => s.overrides);
  const currentPath = useApp((s) => s.currentPath);
  const running = useApp((s) => s.running);
  const progress = useApp((s) => s.progress);
  const hasApiKey = useApp((s) => Boolean(s.config.api_key.trim()));
  const importFolder = useApp((s) => s.importFolder);
  const startGrading = useApp((s) => s.startGrading);
  const select = useApp((s) => s.select);
  const excludedPaths = useApp((s) => s.excludedPaths);
  const setExcludedPaths = useApp((s) => s.setExcludedPaths);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "attention" | "pending">("all");

  const rows = useMemo(
    () => buildRows(files, results, failed),
    [files, results, failed]
  );
  const excludedSet = useMemo(() => new Set(excludedPaths), [excludedPaths]);
  const activeRows = useMemo(
    () => rows.filter((row) => !excludedSet.has(row.file.path)),
    [rows, excludedSet]
  );
  const visibleRows = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (keyword && !`${row.displayName} ${row.file.file_name}`.toLocaleLowerCase().includes(keyword)) {
          return false;
        }
        const excluded = excludedSet.has(row.file.path);
        if (filter === "pending") return !excluded && row.pending;
        if (filter === "attention") {
          return !excluded && Boolean(
            row.error || row.abnormal || row.result?.questions.some((q) => q.review_needed)
          );
        }
        return true;
      });
  }, [rows, query, filter, excludedSet]);

  const gradedCount = activeRows.filter((r) => r.result).length;
  const failedCount = activeRows.filter((r) => r.error).length;
  const pendingCount = activeRows.filter((r) => r.pending).length;
  const attentionCount = activeRows.filter(
    (r) => r.error || r.abnormal || r.result?.questions.some((q) => q.review_needed)
  ).length;
  const isPdfRow = (row: (typeof rows)[number]) => row.file.file_name.toLowerCase().endsWith(".pdf");
  const pdfPaths = rows.filter(isPdfRow).map((row) => row.file.path);
  const imageCount = rows.filter((row) => !isPdfRow(row)).length;
  const allPdfsExcluded = pdfPaths.length > 0 && pdfPaths.every((path) => excludedSet.has(path));
  const hasMixedMaterials = imageCount > 0 && pdfPaths.length > 0;
  const activeCount = activeRows.length;
  const pct = running && progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : activeCount > 0
      ? Math.round((gradedCount / activeCount) * 100)
      : 0;

  return (
    <aside className="flex h-full w-[288px] shrink-0 flex-col border-r border-border/80 bg-[#fcfcfd] xl:w-[304px]">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border/70 px-4">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
          <CheckCircle2 className="size-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold leading-tight tracking-tight">AI 阅卷工作台</div>
          <div className="mt-1 text-[11px] leading-none text-muted-foreground">
            从批量批读到人工复核
          </div>
        </div>
        {!IS_TAURI && (
          <Badge variant="info" title="当前是浏览器预览模式，数据为模拟内容">
            预览
          </Badge>
        )}
      </div>

      <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        <div className="px-3 pb-2 pt-3">
          <Button
            variant={rows.length === 0 ? "default" : "outline"}
            className="h-10 w-full justify-start gap-2 px-3"
            onClick={importFolder}
          >
            <FolderOpen className="size-4" />
            导入答题卡
            <span className="ml-auto text-[10px] font-normal text-muted-foreground">图片 / PDF</span>
          </Button>
        </div>

        <ApiSection />
        <BatchSettings />

        {hasMixedMaterials && (
          <div className="mx-3 mb-2 rounded-lg border border-amber-200 bg-amber-50/80 p-3 text-amber-900">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold">
              <AlertTriangle className="size-3.5 shrink-0" />
              检测到 {pdfPaths.length} 份 PDF 与 {imageCount} 张图片
            </div>
            <p className="mt-1.5 text-[10px] leading-relaxed text-amber-800">
              系统会把一份 PDF 整份当作一位考生。如果它是试卷或参考答案，请先排除，避免误批改和额外费用。
            </p>
            <button
              type="button"
              onClick={() =>
                setExcludedPaths(
                  allPdfsExcluded
                    ? excludedPaths.filter((path) => !pdfPaths.includes(path))
                    : [...excludedPaths, ...pdfPaths]
                )
              }
              className="mt-2 text-[10.5px] font-semibold text-amber-900 underline decoration-amber-400 underline-offset-2 hover:text-amber-700"
            >
              {allPdfsExcluded ? "恢复 PDF 参与批改" : "排除全部 PDF"}
            </button>
          </div>
        )}

        <div className="sticky top-0 z-10 space-y-2 border-y border-border/60 bg-[#fcfcfd]/95 px-3 py-2.5 backdrop-blur">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold">试卷队列</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {gradedCount} / {activeCount} 已批改
              {excludedPaths.length > 0 && ` · ${excludedPaths.length} 已排除`}
            </span>
          </div>
          {rows.length > 0 && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索姓名或文件名"
                  aria-label="搜索姓名或文件名"
                  className="h-8 bg-white pl-8 pr-7 text-xs shadow-none"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="清空搜索"
                  >
                    <XCircle className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/80 p-1" aria-label="筛选试卷">
                {([
                  ["all", `全部 ${rows.length}`],
                  ["attention", `需处理 ${attentionCount}`],
                  ["pending", `待批 ${pendingCount}`],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                    className={cn(
                      "h-7 rounded-md px-1 text-[11px] transition-colors",
                      filter === value
                        ? "bg-white font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="px-2 py-2">
          {rows.length === 0 && <EmptyList />}
          {rows.length > 0 && visibleRows.length === 0 && (
            <div className="px-4 py-8 text-center">
              <p className="text-xs font-medium">没有匹配的试卷</p>
              <button
                type="button"
                className="mt-2 text-[11px] text-primary hover:underline"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                清除搜索与筛选
              </button>
            </div>
          )}

          {visibleRows.map(({ row, index }) => {
            const active = row.file.path === currentPath;
            const excluded = excludedSet.has(row.file.path);
            const total = row.result ? finalTotal(row.result, overrides) : null;
            const reviewNeeded = row.result?.questions.some((q) => q.review_needed) ?? false;

            return (
              <button
                key={row.file.path}
                onClick={() => select(row.file.path)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "group relative mb-1 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-all",
                  excluded
                    ? "border-transparent bg-muted/30 opacity-60 hover:opacity-90"
                    : active
                      ? "border-primary/20 bg-primary/[0.07] shadow-sm"
                      : "border-transparent hover:border-border/70 hover:bg-white"
                )}
              >
                <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                  {index + 1}
                </span>

                {excluded ? (
                  <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-label="已排除" />
                ) : row.abnormal || row.error ? (
                  row.error ? (
                    <XCircle className="size-4 shrink-0 text-rose-500" />
                  ) : (
                    <AlertTriangle className="size-4 shrink-0 text-rose-500" />
                  )
                ) : reviewNeeded ? (
                  <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-label="有题目建议复核" />
                ) : row.result ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                ) : (
                  <div className="size-4 shrink-0 rounded-full border border-dashed border-muted-foreground/40" />
                )}

                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "truncate text-xs leading-5",
                      active ? "font-semibold text-foreground" : "font-medium text-foreground/85",
                      excluded && "line-through decoration-muted-foreground/40"
                    )}
                    title={`${row.displayName}（${fmtSize(row.file.size)}）`}
                  >
                    {row.displayName}
                  </div>
                  <div className="truncate text-[10px] leading-4 text-muted-foreground" title={row.file.file_name}>
                    {excluded
                      ? "已排除，不参与批改与导出"
                      : row.displayName !== row.file.file_name
                        ? row.file.file_name
                        : row.file.page_count > 1
                          ? `PDF · ${row.file.page_count} 页`
                          : row.pending
                            ? "等待批改"
                            : "已生成评分结果"}
                  </div>
                </div>

                {excluded ? (
                  <Badge variant="outline" className="shrink-0 px-1.5">已排除</Badge>
                ) : (
                  <>
                    {row.abnormal && <Badge variant="danger" className="shrink-0 px-1.5">异常</Badge>}
                    {row.error && <Badge variant="danger" className="shrink-0 px-1.5">失败</Badge>}
                    {!row.abnormal && !row.error && reviewNeeded && (
                      <Badge variant="warning" className="shrink-0 px-1.5">复核</Badge>
                    )}
                    {total !== null && !row.error && (
                      <span className={cn("min-w-6 shrink-0 text-right text-xs font-semibold tabular-nums", row.abnormal ? "text-rose-600" : "text-foreground")}>
                        {fmtScore(total)}
                      </span>
                    )}
                    {row.pending && <span className="shrink-0 text-[10px] text-muted-foreground">待批</span>}
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="shrink-0 space-y-2.5 border-t border-border/80 bg-white p-3.5">
        {(running || activeCount > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-[11px]">
              <span className={cn("truncate", failedCount > 0 && !running ? "text-rose-600" : "text-muted-foreground")}>
                {running
                  ? progress?.currentStage ?? "正在准备批改"
                  : failedCount > 0
                    ? `完成 ${gradedCount} 张，失败 ${failedCount} 张`
                    : gradedCount === activeCount
                      ? "全部试卷已批改"
                      : `已完成 ${gradedCount} / ${activeCount} 张`}
              </span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">{pct}%</span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="批改进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        <Button
          className="h-10 w-full gap-2"
          onClick={rows.length === 0 ? importFolder : startGrading}
          disabled={running || (rows.length > 0 && activeCount === 0)}
        >
          {running ? (
            <><Loader2 className="size-4 animate-spin" />批改中 {progress?.done ?? 0}/{progress?.total ?? activeCount}</>
          ) : rows.length === 0 ? (
            <><FolderOpen className="size-4" />先导入答题卡</>
          ) : activeCount === 0 ? (
            "没有可批改的试卷"
          ) : (
            <><Play className="size-4" />{gradedCount > 0 ? "重新批改全部" : `开始批改 ${activeCount} 份`}</>
          )}
        </Button>
        {!hasApiKey && activeCount > 0 && (
          <p className="text-center text-[10px] text-amber-600">开始前请在「接口配置」中填写 API Key</p>
        )}
      </div>
    </aside>
  );
}

/** API 配置折叠面板 */
function ApiSection() {
  const config = useApp((s) => s.config);
  const setConfig = useApp((s) => s.setConfig);
  const setProvider = useApp((s) => s.setProvider);
  const setProtocol = useApp((s) => s.setProtocol);
  const testConn = useApp((s) => s.testConn);
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const providerId = matchProvider(config);
  const preset = PROVIDERS.find((p) => p.id === providerId);
  const models = preset?.models ?? [];
  const isAnthropic = config.protocol === "anthropic";

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-3 pb-2">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-white px-3 py-2.5 text-left text-xs font-medium shadow-sm transition-colors hover:bg-accent/40">
        <Cpu className="size-3.5 text-muted-foreground" />
        接口配置
        <span className={cn("ml-auto max-w-[112px] truncate text-[10px] font-normal", config.api_key ? "text-muted-foreground" : "text-amber-600")}>
          {config.api_key ? preset?.label ?? "已配置" : "待填写 Key"}
        </span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-2 pt-1">
        <div className="space-y-1">
          <Label htmlFor="provider" className="flex items-center gap-1">
            <Cpu className="size-3" />
            服务商
          </Label>
          <select
            id="provider"
            value={providerId}
            onChange={(e) => setProvider(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-[11px] shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {preset && (
            <p className="text-[9.5px] leading-snug text-muted-foreground">
              {preset.hint}
            </p>
          )}
        </div>

        <div className="space-y-1">
          <Label className="flex items-center gap-1">
            <Layers className="size-3" />
            接口类型
          </Label>
          <div className="flex gap-1 rounded-md bg-muted p-0.5">
            {(
              [
                { value: "openai", label: "OpenAI 兼容" },
                { value: "anthropic", label: "Anthropic 兼容" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setProtocol(opt.value)}
                className={cn(
                  "flex-1 rounded px-1 py-1 text-[10.5px] transition-colors",
                  config.protocol === opt.value
                    ? "bg-white font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-[9.5px] leading-snug text-muted-foreground">
            {isAnthropic
              ? "POST {base}/v1/messages · x-api-key 鉴权 · system 走顶层"
              : "POST {base}/chat/completions · Bearer 鉴权 · image_url 传图"}
          </p>
        </div>

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
              placeholder={keyPlaceholder(config.protocol)}
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
            placeholder={isAnthropic ? "https://api.anthropic.com" : "https://api.deepseek.com"}
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
            {models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </datalist>
          <p className="text-[9.5px] leading-snug text-muted-foreground">
            必须支持图像输入；名字可自由改，新模型不用等更新
          </p>
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
          <span className="text-[11px]">{isAnthropic ? "扩展思考" : "思考模式"}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {config.thinking ? "开 · 更准" : "关 · 快 4 倍"}
          </span>
        </button>

        {!isAnthropic && (
          <div className="flex items-center gap-2 pl-0">
            <Label
              htmlFor="thinking-style"
              className="shrink-0 whitespace-nowrap text-[10px]"
            >
              思考参数
            </Label>
            <select
              id="thinking-style"
              value={config.thinking_style}
              onChange={(e) =>
                setConfig({ thinking_style: e.target.value as ApiConfig["thinking_style"] })
              }
              className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-1 text-[10.5px]"
            >
              <option value="auto">自动（按 Base URL 判断）</option>
              <option value="deepseek">DeepSeek（thinking 字段）</option>
              <option value="reasoning_effort">reasoning_effort（o 系列 / GPT-5）</option>
              <option value="off">不发送（普通模型）</option>
            </select>
          </div>
        )}

        <p className="text-[9.5px] leading-snug text-muted-foreground">
          {isAnthropic
            ? "扩展思考预算 4096 tokens；Anthropic 不支持 response_format，靠 prompt 里的 JSON 契约"
            : config.thinking_style === "reasoning_effort"
              ? "推理强度 high；这类模型没有「关闭思考」的开关，只能不传"
              : config.thinking_style === "off"
                ? "该服务商不认思考参数，选了也不会发"
                : "思考参数传错会被官方接口 400，换网关时确认一下"}
        </p>

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

/** 批改设置：并发请求 + 考生名单 */
function BatchSettings() {
  const concurrentEnabled = useApp((s) => s.concurrentEnabled);
  const concurrency = useApp((s) => s.concurrency);
  const rosterText = useApp((s) => s.rosterText);
  const config = useApp((s) => s.config);
  const setConfig = useApp((s) => s.setConfig);
  const setConcurrentEnabled = useApp((s) => s.setConcurrentEnabled);
  const setConcurrency = useApp((s) => s.setConcurrency);
  const setRosterText = useApp((s) => s.setRosterText);
  const importRoster = useApp((s) => s.importRoster);
  const clearRoster = useApp((s) => s.clearRoster);

  const imageLongEdge = config.image_long_edge;
  const imageGrayscale = config.image_grayscale;
  const imagePassthrough = config.image_passthrough;

  const [open, setOpen] = useState(false);
  const rosterCount = parseRosterText(rosterText).length;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-3 pb-2">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
        <SlidersHorizontal className="size-3" />
        批改设置
        <span className="ml-auto flex items-center gap-1.5 text-[10px]">
          <span>并发 {concurrentEnabled ? concurrency : 1}</span>
          <span className="text-muted-foreground/40">·</span>
          <span className={rosterCount > 0 ? "text-emerald-600" : ""}>
            {rosterCount > 0 ? `名单 ${rosterCount} 人` : "无名单"}
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>{imagePassthrough ? "原图" : imageLongEdge}</span>
        </span>
        <ChevronDown
          className={cn(
            "size-3 transition-transform",
            !open && "-rotate-90"
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-3 pt-1.5">
        {/* 并发 */}
        <div className="space-y-1">
          <button
            type="button"
            role="switch"
            aria-checked={concurrentEnabled}
            onClick={() => setConcurrentEnabled(!concurrentEnabled)}
            className="flex w-full items-center gap-2 text-left"
            title="并发可以让整批更快，但太高容易触发网关限流"
          >
            <span
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                concurrentEnabled ? "bg-primary" : "bg-input"
              )}
            >
              <span
                className={cn(
                  "absolute size-3 rounded-full bg-white shadow transition-all",
                  concurrentEnabled ? "left-3.5" : "left-0.5"
                )}
              />
            </span>
            <span className="text-[11px]">并发请求</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {concurrentEnabled ? "开" : "关 · 逐张处理"}
            </span>
          </button>

          {concurrentEnabled && (
            <div className="space-y-1 pl-9">
              <div className="flex items-center gap-2">
                <Label htmlFor="concurrency" className="shrink-0 text-[10px]">
                  同时批改
                </Label>
                <Slider
                  id="concurrency-slider"
                  aria-label="同时批改张数"
                  value={concurrency}
                  min={1}
                  max={100}
                  onValueChange={setConcurrency}
                  className="min-w-0 flex-1"
                />
                <Input
                  id="concurrency"
                  type="number"
                  min={1}
                  max={100}
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  /* 去掉原生上下箭头：滑块就在旁边，留着只会把三位数挤掉 */
                  className="h-7 w-14 shrink-0 px-1 text-center text-[11px] tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="shrink-0 text-[10px] text-muted-foreground">张</span>
              </div>
              <p
                className={cn(
                  "text-[9.5px] leading-snug",
                  concurrency >= 10 ? "text-amber-600" : "text-muted-foreground"
                )}
              >
                {concurrency >= 10
                  ? `1–100 可选，但 ${concurrency} 路并发很容易被网关限流（429），建议先在 3–8 试`
                  : "1–100 可选；并发越高越快，也越容易触发限流"}
              </p>
            </div>
          )}
        </div>

        {/* 上传画质：模型只看得到 1568~2048 的长边，传更大的图纯属浪费带宽 */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-[10px]">上传画质</Label>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {imagePassthrough ? "原图直传" : `长边 ${imageLongEdge}`}
            </span>
          </div>
          <div className="flex gap-1 rounded-md bg-muted p-0.5">
            {QUALITY_PRESETS.map((q) => (
              <button
                key={q.longEdge}
                type="button"
                disabled={imagePassthrough}
                onClick={() => setConfig({ image_long_edge: q.longEdge })}
                title={q.hint}
                className={cn(
                  "flex-1 rounded px-1 py-1 text-[10px] transition-colors",
                  !imagePassthrough && imageLongEdge === q.longEdge
                    ? "bg-white font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                  imagePassthrough && "cursor-not-allowed opacity-40"
                )}
              >
                {q.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={imageGrayscale}
            onClick={() => setConfig({ image_grayscale: !imageGrayscale })}
            className="flex w-full items-center gap-2 rounded-md py-0.5 text-left"
            title="答题卡是黑白扫描件，转灰度能省一半以上体积；卷面有红笔批注时请关掉"
          >
            <span
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                imageGrayscale ? "bg-primary" : "bg-input"
              )}
            >
              <span
                className={cn(
                  "absolute size-3 rounded-full bg-white shadow transition-all",
                  imageGrayscale ? "left-3.5" : "left-0.5"
                )}
              />
            </span>
            <span className="text-[11px]">黑白处理</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {imageGrayscale ? "开 · 省一半" : "关 · 保留彩色"}
            </span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={imagePassthrough}
            onClick={() =>
              setConfig({ image_passthrough: !imagePassthrough })
            }
            className="flex w-full items-center gap-2 rounded-md py-0.5 text-left"
            title="不缩放、不转灰度、不重编码，直接把原图发出去（只对图片生效，PDF 仍需渲染）"
          >
            <span
              className={cn(
                "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                imagePassthrough ? "bg-primary" : "bg-input"
              )}
            >
              <span
                className={cn(
                  "absolute size-3 rounded-full bg-white shadow transition-all",
                  imagePassthrough ? "left-3.5" : "left-0.5"
                )}
              />
            </span>
            <span className="text-[11px]">原图直传</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {imagePassthrough ? "不压缩" : "关 · 已压缩"}
            </span>
          </button>

          <p className="text-[9.5px] leading-snug text-muted-foreground">
            {imagePassthrough
              ? "原图按原样上传，体积和耗时都会变大；PDF 页仍按上档渲染"
              : `模型只看得到长边 ${imageLongEdge} 左右，再大没意义；灰度后每页通常 150~400 KB`}
          </p>
        </div>

        {/* 名单 */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[10px]">考生名单（一行一个）</Label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={importRoster}
                className="text-[10px] text-sky-600 hover:underline"
              >
                导入文件
              </button>
              {rosterCount > 0 && (
                <button
                  type="button"
                  onClick={clearRoster}
                  className="text-[10px] text-muted-foreground hover:underline"
                >
                  清空
                </button>
              )}
            </div>
          </div>
          <Textarea
            value={rosterText}
            onChange={(e) => setRosterText(e.target.value)}
            placeholder={"张三\n李四\n王五"}
            spellCheck={false}
            className="thin-scrollbar h-24 resize-none text-[11px] leading-relaxed"
          />
          <p className="text-[9.5px] leading-snug text-muted-foreground">
            导入后模型只能从名单里挑名字，并对形近字纠错；留空则纯靠视觉识别
          </p>
        </div>
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
        点上方「导入答题卡文件夹」
      </p>
    </div>
  );
}
