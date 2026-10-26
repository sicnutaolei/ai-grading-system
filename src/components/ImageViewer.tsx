import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileImage,
  Maximize,
  Minus,
  Plus,
  ScanSearch,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toAssetUrl } from "@/lib/bridge";
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

  const order = useMemo(
    () => orderedPaths(files, results, failed),
    [files, results, failed]
  );
  const index = currentPath ? order.indexOf(currentPath) : -1;
  const file = files.find((f) => f.path === currentPath) ?? null;
  const result = currentPath ? results[currentPath] : undefined;

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false);
  const [failedToLoad, setFailedToLoad] = useState(false);

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

  // 换图时复位缩放
  useEffect(() => {
    setLoaded(false);
    setFailedToLoad(false);
    scaleRef.current = 1;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [currentPath]);

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
  }, [step, zoomByButton, resetView]);

  const src = file ? toAssetUrl(file.path) : "";

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-white">
      {/* 工具栏 */}
      <div className="flex h-12 shrink-0 items-center gap-3 border-b px-3">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => step(-1)}
            disabled={index <= 0}
            title="上一张 (←)"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-[64px] text-center text-xs tabular-nums text-muted-foreground">
            {index >= 0 ? index + 1 : 0} / {order.length}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => step(1)}
            disabled={index < 0 || index >= order.length - 1}
            title="下一张 (→)"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="h-4 w-px bg-border" />

        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => zoomByButton(-1)}
            disabled={!file}
            title="缩小 (-)"
          >
            <Minus className="size-4" />
          </Button>
          <button
            className="min-w-[52px] rounded px-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-accent"
            onClick={resetView}
            disabled={!file}
            title="点击恢复自适应 (0)"
          >
            {Math.round(scale * 100)}%
          </button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => zoomByButton(1)}
            disabled={!file}
            title="放大 (+)"
          >
            <Plus className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={resetView}
            disabled={!file}
            title="适应窗口 (0)"
          >
            <Maximize className="size-4" />
          </Button>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          {result?.is_abnormal && (
            <Badge variant="danger" className="shrink-0 gap-1">
              <AlertTriangle className="size-3" />
              异常卷
            </Badge>
          )}
          {file && (
            <span
              className="truncate text-xs text-muted-foreground"
              title={file.file_name}
            >
              {file.file_name}
            </span>
          )}
        </div>
      </div>

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
              {!loaded && !failedToLoad && (
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
            </div>
          </>
        ) : (
          <EmptyCanvas />
        )}
      </div>
    </main>
  );
}

function EmptyCanvas() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-14 items-center justify-center rounded-xl border border-dashed bg-white/60">
        <ScanSearch className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">没有正在查看的答题卡</p>
        <p className="text-xs text-muted-foreground">
          从左侧导入文件夹，然后在列表里点一张
        </p>
      </div>
    </div>
  );
}
