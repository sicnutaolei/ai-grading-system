import { useEffect } from "react";

import { GradePanel } from "@/components/GradePanel";
import { ImageViewer } from "@/components/ImageViewer";
import { PdfNotice } from "@/components/PdfNotice";
import { Sidebar } from "@/components/Sidebar";
import { Toaster } from "@/components/Toaster";
import { IS_TAURI } from "@/lib/bridge";
import { useApp } from "@/store";

export default function App() {
  const init = useApp((s) => s.init);
  const subscribe = useApp((s) => s.subscribe);
  const loadDemo = useApp((s) => s.loadDemo);

  useEffect(() => {
    void init();
  }, [init]);

  // 浏览器预览模式：?demo=1 直接装入样例卷（省得每次都点导入）
  useEffect(() => {
    if (import.meta.env.DEV && !IS_TAURI) {
      const param = new URLSearchParams(window.location.search).get("demo");
      if (param) loadDemo(Math.max(Number(param) - 1, 0) || 0);
    }
  }, [loadDemo]);

  useEffect(() => {
    // StrictMode 下 effect 会跑两次：cleanup 可能在 Promise resolve 之前就执行，
    // 所以这里要留一个 cancelled 标记，避免事件监听泄漏成两份。
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void subscribe().then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [subscribe]);

  return (
    <div className="flex h-dvh w-screen overflow-hidden bg-muted/30 text-foreground antialiased">
      <Sidebar />
      <ImageViewer />
      <GradePanel />
      <Toaster />
      <PdfNotice />
    </div>
  );
}
