import { useEffect } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/utils";
import { useApp } from "@/store";

const ICONS = {
  ok: CheckCircle2,
  err: AlertCircle,
  info: Info,
} as const;

const TONES = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
  err: "border-rose-200 bg-rose-50 text-rose-800",
  info: "border-sky-200 bg-sky-50 text-sky-800",
} as const;

export function Toaster() {
  const toast = useApp((s) => s.toast);
  const dismiss = useApp((s) => s.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismiss, 3600);
    return () => window.clearTimeout(timer);
  }, [toast, dismiss]);

  if (!toast) return null;
  const Icon = ICONS[toast.kind];

  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
      <div
        className={cn(
          "animate-fade-in pointer-events-auto flex max-w-[720px] items-start gap-2 rounded-lg border px-3 py-2 shadow-lg",
          TONES[toast.kind]
        )}
      >
        <Icon className="mt-[1px] size-3.5 shrink-0" />
        <p className="break-all text-[11.5px] leading-relaxed">{toast.text}</p>
      </div>
    </div>
  );
}
