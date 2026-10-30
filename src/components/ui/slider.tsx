import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * 原生 `<input type="range">` + 自定义样式。
 *
 * 没引 `@radix-ui/react-slider`：这里只需要一个单值滑块（并发 1–100），
 * 原生控件自带键盘、无障碍和 `:disabled` 行为，省一个依赖也少一处升级负担。
 * 填充比例通过 CSS 变量 `--pct` 传给样式（WebKit 的 track 渐变要靠它）。
 */
export interface SliderProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
}

const Slider = React.forwardRef<HTMLInputElement, SliderProps>(
  ({ className, value, min = 1, max = 100, step = 1, onValueChange, ...props }, ref) => {
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return (
      <input
        ref={ref}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onValueChange(Number(e.target.value))}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        className={cn("range-slider w-full", className)}
        {...props}
      />
    );
  }
);
Slider.displayName = "Slider";

export { Slider };
