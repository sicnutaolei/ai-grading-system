import { useState } from "react";
import { ChevronDown, RotateCcw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useApp } from "@/store";

/**
 * 评分细则编辑器。
 *
 * 只编辑「细则正文」——JSON 输出契约由后端 `prompt.rs` 固定拼接，
 * 老师改不到，避免手抖把 is_abnormal / questions 这些字段写没了。
 */
export function PromptEditor() {
  const prompt = useApp((s) => s.prompt);
  const setPrompt = useApp((s) => s.setPrompt);
  const resetPrompt = useApp((s) => s.resetPrompt);
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-accent/50">
        <Sparkles className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">评分细则</span>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {prompt.length} 字
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 text-muted-foreground transition-transform",
            !open && "-rotate-90"
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="space-y-2 px-4 pb-3">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
            className="thin-scrollbar h-[240px] resize-none font-mono text-[11px] leading-relaxed"
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] leading-snug text-muted-foreground">
              改完直接对下一张生效；JSON 输出格式由程序固定
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-[11px]"
              onClick={resetPrompt}
            >
              <RotateCcw className="size-3" />
              恢复默认
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
