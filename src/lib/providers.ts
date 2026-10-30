/**
 * 服务商预设。
 *
 * 选一个服务商 = 一次性把「协议 + Base URL + 模型 + 思考参数」四件套都填对。
 * 这四项必须成套，错一项就会 400 或解析失败（比如把 Anthropic 的地址配成 OpenAI 协议，
 * 或者给 OpenAI 官方发 DeepSeek 的 `thinking` 字段）。
 *
 * 模型名只是候选，输入框仍可自由改（新模型不用等我改代码）。
 */

import type { ApiConfig, ApiProtocol, ThinkingStyle } from "@/types";

export interface ProviderPreset {
  id: string;
  label: string;
  /** 一句话说明，展开时才显示，避免左栏太挤 */
  hint: string;
  protocol: ApiProtocol;
  base_url: string;
  model: string;
  thinking_style: ThinkingStyle;
  /** 选中预设时是否同时切换思考开关；不填则保留用户当前选择 */
  thinking?: boolean;
  /** 模型候选（datalist） */
  models: { value: string; label: string }[];
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek（官方）",
    hint: "OpenAI 兼容 + DeepSeek 专属 thinking 字段",
    protocol: "openai",
    base_url: "https://api.deepseek.com",
    model: "deepseek-flash",
    thinking_style: "deepseek",
    models: [
      { value: "deepseek-flash", label: "DeepSeek-V4.1-Flash（支持图像）" },
      { value: "deepseek-v4-pro", label: "DeepSeek-V4-Pro（纯文本）" },
    ],
  },
  {
    id: "tokenrhythm",
    label: "基元律动（TokenRhythm）",
    hint: "OpenAI 兼容，默认关闭思考；实测 DeepSeek-V4.1-Flash 可读答题卡",
    protocol: "openai",
    base_url: "https://tokenrhythm.studio/v1",
    model: "deepseek-v4.1-flash-1017",
    thinking_style: "off",
    thinking: false,
    models: [
      { value: "deepseek-v4.1-flash-1017", label: "DeepSeek-V4.1-Flash（本次实测）" },
      { value: "deepseek-flash", label: "DeepSeek-Flash" },
      { value: "qwen3.8-max", label: "Qwen3.8-Max" },
      { value: "glm-5.3", label: "GLM-5.3" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI（官方）",
    hint: "标准 OpenAI 协议，推理模型用 reasoning_effort",
    protocol: "openai",
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o",
    thinking_style: "reasoning_effort",
    models: [
      { value: "gpt-4o", label: "GPT-4o（视觉）" },
      { value: "gpt-4.1", label: "GPT-4.1（视觉）" },
      { value: "gpt-5", label: "GPT-5（视觉 + 推理）" },
      { value: "o4-mini", label: "o4-mini（视觉 + 推理）" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude（官方）",
    hint: "x-api-key 鉴权，system 走顶层字段，支持扩展思考",
    protocol: "anthropic",
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    thinking_style: "auto",
    models: [
      { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5（视觉）" },
      { value: "claude-opus-4-1", label: "Claude Opus 4.1（视觉）" },
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5（快）" },
    ],
  },
  {
    id: "dashscope",
    label: "阿里百炼（兼容模式）",
    hint: "OpenAI 兼容；国内网络直连，不认 DeepSeek 的 thinking 字段",
    protocol: "openai",
    base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-vl-max",
    thinking_style: "off",
    models: [
      { value: "qwen-vl-max", label: "qwen-vl-max（视觉）" },
      { value: "qwen-vl-plus", label: "qwen-vl-plus（视觉，便宜）" },
    ],
  },
  {
    id: "siliconflow",
    label: "硅基流动（兼容模式）",
    hint: "OpenAI 兼容，聚合各家视觉模型",
    protocol: "openai",
    base_url: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-VL-72B-Instruct",
    thinking_style: "off",
    models: [
      { value: "Qwen/Qwen2.5-VL-72B-Instruct", label: "Qwen2.5-VL-72B" },
      { value: "deepseek-ai/deepseek-vl2", label: "DeepSeek-VL2" },
    ],
  },
  {
    id: "custom",
    label: "自定义 / 其他网关",
    hint: "手动填地址与模型，协议和思考参数按网关文档选",
    protocol: "openai",
    base_url: "",
    model: "",
    thinking_style: "auto",
    models: [],
  },
];

export const CUSTOM_PROVIDER_ID = "custom";

/** 按 base_url + 协议反查当前配置属于哪个预设 */
export function matchProvider(config: ApiConfig): string {
  const norm = (s: string) => s.trim().replace(/\/+$/, "").toLowerCase();
  const base = norm(config.base_url);
  const hit = PROVIDERS.find(
    (p) => p.id !== CUSTOM_PROVIDER_ID && norm(p.base_url) === base && p.protocol === config.protocol
  );
  return hit?.id ?? CUSTOM_PROVIDER_ID;
}

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** 把预设套到现有配置上，只覆盖四件套，Key / 超时 / 思考开关保持不动 */
export function applyPreset(preset: ProviderPreset): Partial<ApiConfig> {
  const patch: Partial<ApiConfig> = {
    protocol: preset.protocol,
    thinking_style: preset.thinking_style,
  };
  if (preset.base_url) patch.base_url = preset.base_url;
  if (preset.model) patch.model = preset.model;
  if (typeof preset.thinking === "boolean") patch.thinking = preset.thinking;
  return patch;
}

/** 当前协议下该填什么形状的 Key，只用于 placeholder */
export function keyPlaceholder(protocol: ApiProtocol): string {
  return protocol === "anthropic" ? "sk-ant-..." : "sk-...";
}
