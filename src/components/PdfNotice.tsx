import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApp } from "@/store";

/**
 * 首次导入 PDF 时的一次性说明。
 *
 * 这几个规则一旦理解错，整批成绩都会错（比如把全班扫描件合成一个 PDF，
 * 或者以为每页会单独算一份卷子），所以必须在动手之前讲清楚，而不是藏在 README 里。
 * 点"知道了"后写 localStorage，之后不再打扰。
 */
export function PdfNotice() {
  const open = useApp((s) => s.pdfTipOpen);
  const config = useApp((s) => s.config);
  const dismiss = useApp((s) => s.dismissPdfTip);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdf-notice-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={dismiss}
    >
      <div
        className="w-full max-w-[460px] rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
            <FileText className="size-4" />
          </div>
          <div className="min-w-0">
            <h2 id="pdf-notice-title" className="text-sm font-semibold">
              这次导入里有 PDF，先确认三件事
            </h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              只会在第一次导入时提示，之后不再打扰
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-2.5 text-[12px] leading-relaxed text-foreground/85">
          <li className="flex gap-2">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-sky-500" />
            <span>
              <b>一份 PDF 就是一位考生。</b>
              PDF 里的所有页都算同一份卷子，会一起提交给模型 ——
              跨页的题目因此能被完整看到，不会被拆成两份卷子。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-sky-500" />
            <span>
              每页会渲染成<b>长边 {config.image_long_edge} 像素</b>
              {config.image_grayscale ? "的黑白图片" : "的彩色图片"}再上传
              （可在「批改设置」里调；模型本来也只吃这么大）。
              页数多时第一次打开要几秒，之后走本地缓存。
            </span>
          </li>
          <li className="flex gap-2">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-sky-500" />
            <span>
              加密 PDF 读不了，会标成失败，请先另存为不加密的 PDF；
              单个文件超过 40 页也请先拆分。
            </span>
          </li>
        </ul>

        <div className="mt-5 flex justify-end">
          <Button className="h-8 px-4" onClick={dismiss}>
            知道了
          </Button>
        </div>
      </div>
    </div>
  );
}
