import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  FileImage,
  Loader2,
  Maximize,
  Minus,
  Plus,
  ScanSearch,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { isPdfPath, toAssetUrl } from "@/lib/bridge";
import { orderedPaths } from "@/lib/order";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * 图片查看器。
 *
 * 自适应交给 CSS：图片用 max-h-full / max-w-full，所以 scale=1 就是「刚好放下」。
 * 这里算过的教训：用 JS 读 clientWidth 去算 fit，首帧布局没落定时会算出一个
 * 荒谬的比例（实测只有 22%），而且窗口 DPI 缩放还会再坑一次。让浏览器自己排版最省心。
 */
export function ImageViewer() {
  const files = useApp((s) => s.files);
  const results = useApp((s) => s.results);
  const failed = useApp((s) => s.failed);
  const currentPath = useApp((s) => s.currentPath);
  const step = useApp((s) => s.step);
  const pdfPages = useApp((s) => s.pdfPages);
  const pdfRendering = useApp((s) => s.pdfRendering);
  const config = useApp((s) => s.config);
  const loadPdfPages = useApp((s) => s.loadPdfPages);
  const importFolder = useApp((s) => s.importFolder);
  const excludedPaths = useApp((s) => s.excludedPaths);

  const order = useMemo(
    () => orderedPaths(
      files.filter((file) => !excludedPaths.includes(file.path)),
      results,
      failed
    ),
    [files, results, failed, excludedPaths]
  );
  const index = currentPath ? order.indexOf(currentPath) : -1;
  const file = files.find((f) => f.path === currentPath) ?? null;
  const result = currentPath ? results[currentPath] : undefined;

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  const isPdf = file ? isPdfPath(file.path) : false;
  // 一份 PDF 可能有好几页；图片就是它自己那一页
  const pages = useMemo(() => {
    if (!file) return [] as string[];
    return isPdf ? pdfPages[file.path] ?? [] : [file.path];
  }, [file, isPdf, pdfPages]);
  const rendering = file ? !!pdfRendering[file.path] : false;

  // 选中 PDF 时按需渲染（后端有磁盘缓存，来回切不会重复渲染）
  useEffect(() => {
    if (!file || !isPdf) return;
    if (pdfPages[file.path]?.length) return;
    void loadPdfPages(file.path);
  }, [file, isPdf, pdfPages, loadPdfPages]);



  const scaleRef = useRef(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, x: 0, y: 0 });

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const resetView = useCallback(() => {
    scaleRef.current = 1;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    const prev = scaleRef.current;
    const next = clamp(prev * factor, MIN_SCALE, MAX_SCALE);
    if (Math.abs(next - prev) < 0.0001) return;
    scaleRef.current = next;
    // 缩放锚点固定在指针位置：内容坐标不变，屏幕坐标随之平移
    setOffset((o) => ({
      x: cx - (cx - o.x) * (next / prev),
      y: cy - (cy - o.y) * (next / prev),
    }));
    setScale(next);
  }, []);

  const zoomByButton = useCallback(
    (dir: 1 | -1) => {
      // 锚点 (0,0) = 容器中心 = 图片中心（图片由 flex 居中）
      zoomAt(dir > 0 ? 1.2 : 1 / 1.2, 0, 0);
    },
    [zoomAt]
  );

  // 换图时复位缩放，并回到 PDF 的第 1 页（换卷不必记住上一张看到第几页）
  useEffect(() => {
    setLoaded(false);
    setFailedToLoad(false);
    setPageIndex(0);
    scaleRef.current = 1;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [currentPath]);

  // 翻页同样要重新触发加载态
  useEffect(() => {
    setLoaded(false);
    setFailedToLoad(false);
  }, [pageIndex]);

  // 滚轮缩放：必须用原生监听 + passive:false，React 的 onWheel 拦不住默认滚动
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !file) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      zoomAt(Math.exp(-e.deltaY * 0.0018), cx, cy);
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [file, zoomAt]);

  // 拖拽平移
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.active) return;
      const dx = e.clientX - dragRef.current.x;
      const dy = e.clientY - dragRef.current.y;
      dragRef.current.x = e.clientX;
      dragRef.current.y = e.clientY;
      setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
    };
    const onUp = () => {
      dragRef.current.active = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // 键盘：翻页 / 缩放 / 复位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      switch (e.key) {
        case "ArrowLeft":
        case "PageUp":
          step(-1);
          break;
        case "ArrowRight":
        case "PageDown":
          step(1);
          break;
        // 一份 PDF 有多页时，上下键翻页；左右键仍然是换卷子
        case "ArrowUp":
          setPageIndex((i) => Math.max(i - 1, 0));
          break;
        case "ArrowDown":
          setPageIndex((i) => Math.min(i + 1, Math.max(pages.length - 1, 0)));
          break;
        case "+":
        case "=":
          zoomByButton(1);
          break;
        case "-":
          zoomByButton(-1);
          break;
        case "0":
          resetView();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, zoomByButton, resetView, pages.length]);

  const pageCount = pages.length;
  const safePage = Math.min(pageIndex, Math.max(pageCount - 1, 0));
  const src = pages[safePage] ? toAssetUrl(pages[safePage]) : "";

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white" aria-label="答题卡卷面">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border/70 bg-white px-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold" title={file?.file_name}>
              {file?.file_name ?? "卷面预览"}
            </h1>
            {result?.is_abnormal && (
              <Badge variant="danger" className="shrink-0 gap-1">
                <AlertTriangle className="size-3" />异常卷
              </Badge>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {file ? `第 ${index + 1} 份，共 ${order.length} 份` : "查看原始作答，与右侧评分逐项对照"}
          </p>
        </div>
        <nav className="flex shrink-0 items-center gap-1" aria-label="切换试卷">
          <Button
            variant="outline"
            size="icon"
            onClick={() => step(-1)}
            disabled={index <= 0}
            title="上一份试卷 (←)"
            aria-label="上一份试卷"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-14 text-center text-xs font-medium tabular-nums text-muted-foreground">
            {index >= 0 ? index + 1 : 0} / {order.length}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => step(1)}
            disabled={index < 0 || index >= order.length - 1}
            title="下一份试卷 (→)"
            aria-label="下一份试卷"
          >
            <ChevronRight className="size-4" />
          </Button>
        </nav>
      </header>

      {/* 画布 */}
      <div
        ref={containerRef}
        onMouseDown={(e) => {
          if (e.button !== 0 || !file) return;
          dragRef.current = { active: true, x: e.clientX, y: e.clientY };
        }}
        onDoubleClick={resetView}
        className={cn(
          "canvas-surface relative min-h-0 flex-1 select-none overflow-hidden",
          file ? "cursor-grab active:cursor-grabbing" : "cursor-default"
        )}
      >
        {file ? (
          <>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-7">
              {rendering && (
                <div className="flex flex-col items-center gap-2 text-center">
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  <p className="text-xs text-muted-foreground">
                    正在渲染 PDF（长边 {config.image_long_edge} ·{" "}
                    {config.image_grayscale ? "黑白" : "彩色"}）…
                    <br />
                    <span className="text-[11px]">页数多时需要几秒，渲染结果会缓存</span>
                  </p>
                </div>
              )}
              {!rendering && !loaded && !failedToLoad && (
                <span className="text-xs text-muted-foreground">加载图片…</span>
              )}
              {failedToLoad && (
                <div className="flex flex-col items-center gap-2 text-center">
                  <FileImage className="size-8 text-muted-foreground" />
                  <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
                    图片加载失败
                    <br />
                    <span className="text-[11px]">
                      asset 协议未授权该目录，或文件已被移动
                    </span>
                  </p>
                  <p className="max-w-sm break-all font-mono text-[10px] text-muted-foreground/70">
                    {file.path}
                  </p>
                </div>
              )}

              {src && (
                <img
                  src={src}
                  alt={file.file_name}
                  draggable={false}
                  onLoad={() => setLoaded(true)}
                  onError={() => setFailedToLoad(true)}
                  style={{
                    // 自适应由 max-h-full / max-w-full 负责，transform 只承载用户缩放与平移，
                    // 二者不冲突（scale 不改变布局尺寸，所以 max-h 依然按 100% 算）
                    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                    transformOrigin: "center center",
                  }}
                  className={cn(
                    "max-h-full max-w-full bg-white object-contain shadow-[0_1px_4px_rgba(16,24,40,0.14)] transition-opacity duration-150",
                    loaded ? "opacity-100" : "opacity-0"
                  )}
                />
              )}
            </div>
          </>
        ) : (
          <EmptyCanvas onImport={importFolder} />
        )}
      </div>

      <footer className="flex h-14 shrink-0 items-center border-t border-border/70 bg-white px-3">
        <div className="hidden flex-1 text-[11px] text-muted-foreground 2xl:block">
          滚轮缩放 · 拖拽平移
        </div>
        <div className="mx-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => zoomByButton(-1)}
            disabled={!file}
            title="缩小 (-)"
            aria-label="缩小卷面"
          >
            <Minus className="size-4" />
          </Button>
          <button
            className="h-8 min-w-14 rounded-md px-2 text-center text-xs font-medium tabular-nums text-muted-foreground hover:bg-accent disabled:opacity-50"
            onClick={resetView}
            disabled={!file}
            title="恢复适应窗口 (0)"
            aria-label={`当前缩放 ${Math.round(scale * 100)}%，点击恢复适应窗口`}
          >
            {Math.round(scale * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => zoomByButton(1)}
            disabled={!file}
            title="放大 (+)"
            aria-label="放大卷面"
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={resetView}
            disabled={!file}
            title="适应窗口 (0)"
            aria-label="卷面适应窗口"
          >
            <Maximize className="size-4" />
          </Button>

          {pageCount > 1 && (
            <>
              <div className="mx-2 h-5 w-px bg-border" />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPageIndex((i) => Math.max(i - 1, 0))}
                disabled={safePage <= 0}
                title="上一页 (↑)"
                aria-label="上一页"
              >
                <ArrowUp className="size-4" />
              </Button>
              <span className="min-w-[76px] text-center text-xs tabular-nums text-muted-foreground">
                第 {safePage + 1} / {pageCount} 页
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setPageIndex((i) => Math.min(i + 1, pageCount - 1))}
                disabled={safePage >= pageCount - 1}
                title="下一页 (↓)"
                aria-label="下一页"
              >
                <ArrowDown className="size-4" />
              </Button>
            </>
          )}
        </div>
        <div className="hidden flex-1 text-right text-[11px] text-muted-foreground 2xl:block">
          双击卷面恢复适应
        </div>
      </footer>
    </main>
  );
}

function EmptyCanvas({ onImport }: { onImport: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl border border-primary/10 bg-primary/[0.06]">
        <ScanSearch className="size-7 text-primary" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold">从一份答题卡开始</h2>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          导入包含图片或 PDF 的文件夹，即可在这里对照卷面进行复核
        </p>
      </div>
      <Button onClick={onImport} className="mt-1 gap-2">导入答题卡</Button>
      <p className="text-[10px] text-muted-foreground">支持 PNG、JPG、WebP、BMP 与 PDF</p>
    </div>
  );
}
