//! 模型调用层，支持两套接口协议：
//!
//! - **OpenAI 兼容**（默认）：`POST {base}/chat/completions`，`Authorization: Bearer`，
//!   `messages[].content` 用 `image_url` 传图。DeepSeek / 百炼兼容模式 / 硅基流动 / vLLM 都走这套。
//! - **Anthropic 兼容**：`POST {base}/v1/messages`，`x-api-key` + `anthropic-version`，
//!   `system` 是顶层字段（不在 messages 里），图片用 `{type:"image", source:{type:"base64"}}`。
//!
//! 两套协议的 endpoint / 鉴权 / 请求体 / 响应结构必须成套切换，缺一处就会 400 或解析失败。
//!
//! DeepSeek 侧的经验（照官方文档 + 真实请求打出来的，不是猜的
//! https://api-docs.deepseek.com/zh-cn/guides/thinking_mode）：
//!
//! - 思考模式开关是**顶层 `thinking: {"type": "enabled"|"disabled"}`**。
//!   `enable_thinking` 是通义/百炼那套字段，DeepSeek 官方 API 会**静默忽略**它 ——
//!   实测传了 `enable_thinking:false` 依然返回 3526 个 reasoning token。
//! - 思考强度用 `reasoning_effort: low|high|max`，默认 high。
//! - 思考模式下 `temperature` / `top_p` 不生效（传了不报错，但被忽略），
//!   所以只在关闭思考时才设 temperature=0 来求确定性。
//! - 思维链走 `reasoning_content`，正文仍在 `content`，两者同级。
//! - 一次整卷批改实测：开思考 5744 completion tokens（其中 3526 是思考），
//!   关思考 1978。**所以 max_tokens 必须给足，4096 会直接截断 JSON。**

use crate::imaging::{self, ImageOptions};
use crate::models::{ApiConfig, ApiProtocol, ThinkingStyle};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// 输出配额。整卷 28 个得分点的 JSON 约 2200 tokens，思考约 3500，
/// 留足余量取 16384（模型上限 393216）。
const MAX_OUTPUT_TOKENS: u32 = 16384;

/// Anthropic 扩展思考的预算上限。必须小于 max_tokens，否则官方接口直接 400。
const ANTHROPIC_THINKING_BUDGET: u32 = 4096;

/// Anthropic 必需的版本头。换版本只改这里。
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub fn build_client(cfg: &ApiConfig) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_secs.clamp(30, 600)))
        .connect_timeout(Duration::from_secs(20))
        .user_agent("ai-grading-system/0.1")
        .build()
        .context("创建 HTTP 客户端失败")
}

fn openai_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn anthropic_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    // 官方文档给的 base 是 https://api.anthropic.com，路径要补 /v1/messages；
    // 但很多人习惯把 /v1 也填进来（和 OpenAI 那边一致），所以两种情况都要能吃下。
    if base.ends_with("/messages") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

pub fn endpoint(cfg: &ApiConfig) -> String {
    match cfg.protocol {
        ApiProtocol::OpenAi => openai_endpoint(&cfg.base_url),
        ApiProtocol::Anthropic => anthropic_endpoint(&cfg.base_url),
    }
}

pub fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

/// 原始字节 → data URL，不做任何处理。
/// 用于 PDF 页：那些图是 `pdf::render_pages` 按目标档位刚渲染出来的，再压一次纯属浪费。
pub fn read_raw_data_url(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("读取图片失败：{}", path.display()))?;
    if bytes.is_empty() {
        bail!("图片是空文件：{}", path.display());
    }
    Ok(format!(
        "data:{};base64,{}",
        mime_of(path),
        STANDARD.encode(&bytes)
    ))
}

/// 普通图片 → data URL：先按档位瘦身（灰度 / 长边 / JPEG q82），再 base64。
/// 返回 (data URL, 实际上传字节数)，字节数用于给老师看"这张卷子到底多大"。
pub fn read_image_data_url(path: &Path, opts: &ImageOptions) -> Result<(String, u64)> {
    let bytes = std::fs::read(path).with_context(|| format!("读取图片失败：{}", path.display()))?;
    if bytes.is_empty() {
        bail!("图片是空文件：{}", path.display());
    }

    let prepared = imaging::normalize(&bytes, opts)?;
    let mime = if prepared.is_passthrough() {
        mime_of(path)
    } else {
        "image/jpeg"
    };
    let data = prepared.data();
    Ok((
        format!("data:{mime};base64,{}", STANDARD.encode(data)),
        data.len() as u64,
    ))
}

/// `data:image/png;base64,xxx` → `("image/png", "xxx")`。
/// Anthropic 的图片块要 media_type 和裸 base64 分开给，不能带 data URL 前缀。
fn split_data_url(data_url: &str) -> Result<(String, String)> {
    let rest = match data_url.strip_prefix("data:") {
        Some(r) => r,
        None => bail!("图片不是 data URL 格式"),
    };
    let (meta, data) = rest
        .split_once(',')
        .ok_or_else(|| anyhow!("图片 data URL 缺少逗号分隔"))?;
    let media_type = meta.split(';').next().unwrap_or("image/jpeg").to_string();
    if !meta.contains("base64") {
        bail!("图片 data URL 不是 base64 编码：{meta}");
    }
    if data.trim().is_empty() {
        bail!("图片 data URL 内容为空");
    }
    Ok((media_type, data.to_string()))
}

/// `Auto` 只认几个已知域名，其余一律不传思考参数 ——
/// 猜错字段名的代价是 400，比"少传一个优化参数"严重得多。
fn effective_style(cfg: &ApiConfig) -> ThinkingStyle {
    match cfg.thinking_style {
        ThinkingStyle::Auto => {
            let base = cfg.base_url.to_lowercase();
            if base.contains("deepseek") {
                ThinkingStyle::Deepseek
            } else if base.contains("api.openai.com") {
                ThinkingStyle::ReasoningEffort
            } else {
                ThinkingStyle::Off
            }
        }
        other => other,
    }
}

fn build_openai_payload(
    cfg: &ApiConfig,
    system_prompt: &str,
    user_text: &str,
    image_data_urls: &[String],
    json_mode: bool,
    thinking: bool,
) -> Value {
    // 一份 PDF 可能有多页，全部按顺序放进同一个 user 消息里，
    // 模型看到的顺序就是页序（第 1 页在最前），跨页题才不会被拆开批。
    let user_content = if image_data_urls.is_empty() {
        json!(user_text)
    } else {
        let mut blocks = vec![json!({ "type": "text", "text": user_text })];
        for url in image_data_urls {
            blocks.push(json!({ "type": "image_url", "image_url": { "url": url } }));
        }
        json!(blocks)
    };

    let mut body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_content }
        ],
        "stream": false,
        "max_tokens": MAX_OUTPUT_TOKENS
    });

    match effective_style(cfg) {
        // DeepSeek 官方：开关走顶层 thinking，强度走 reasoning_effort
        ThinkingStyle::Deepseek => {
            body["thinking"] = json!({
                "type": if thinking { "enabled" } else { "disabled" }
            });
            // 联网搜索：DeepSeek 官方 API 没有这个能力，显式置 false 是幂等的
            // （未知字段被忽略）。保留是为了守住"绝不引入卷面以外信息"这条硬要求。
            // 注意只对 DeepSeek 发 —— OpenAI 官方会把未知参数当错误 400 掉。
            body["web_search"] = json!(false);
        }
        // OpenAI o 系列 / GPT-5：只有 intensity，没有开关；关掉时只能省略字段
        ThinkingStyle::ReasoningEffort => {
            if thinking {
                body["reasoning_effort"] = json!("high");
            }
        }
        // 普通视觉模型 / 不认识这些字段的网关：只发通用参数
        ThinkingStyle::Off | ThinkingStyle::Auto => {}
    }

    // 思考模式下 temperature 会被忽略（DeepSeek 文档明说，OpenAI 推理模型直接不支持），
    // 只在「不要思考」的普通模型上设 0 来求确定性。
    let style = effective_style(cfg);
    let temp_matters = !thinking && !matches!(style, ThinkingStyle::ReasoningEffort);
    if temp_matters {
        body["temperature"] = json!(0.0);
    }

    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    body
}

fn build_anthropic_payload(
    cfg: &ApiConfig,
    system_prompt: &str,
    user_text: &str,
    image_data_urls: &[String],
    thinking: bool,
) -> Result<Value> {
    let mut content: Vec<Value> = Vec::new();
    // 多页卷子：按页序连续给 image 块（Anthropic 一个 content 数组可以有多个 image）
    for url in image_data_urls {
        let (media_type, data) = split_data_url(url)?;
        content.push(json!({
            "type": "image",
            "source": { "type": "base64", "media_type": media_type, "data": data }
        }));
    }
    content.push(json!({ "type": "text", "text": user_text }));

    let mut body = json!({
        "model": cfg.model,
        // Anthropic 的 system 是顶层字段，塞进 messages 会被拒
        "system": system_prompt,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "messages": [{ "role": "user", "content": content }]
    });

    if thinking {
        // 扩展思考：预算必须小于 max_tokens；开着的时候 temperature 只能取默认值
        body["thinking"] = json!({
            "type": "enabled",
            "budget_tokens": ANTHROPIC_THINKING_BUDGET
        });
    } else {
        body["temperature"] = json!(0.0);
    }

    // Anthropic 没有 response_format=json_object，parsing 全靠 prompt 里的强约束，
    // 所以 json_mode 在这条链路上被忽略（不报错、不降级）。
    Ok(body)
}

fn build_payload(
    cfg: &ApiConfig,
    system_prompt: &str,
    user_text: &str,
    image_data_urls: &[String],
    json_mode: bool,
    thinking: bool,
) -> Result<Value> {
    match cfg.protocol {
        ApiProtocol::OpenAi => Ok(build_openai_payload(
            cfg,
            system_prompt,
            user_text,
            image_data_urls,
            json_mode,
            thinking,
        )),
        ApiProtocol::Anthropic => {
            build_anthropic_payload(cfg, system_prompt, user_text, image_data_urls, thinking)
        }
    }
}

async fn post(client: &reqwest::Client, cfg: &ApiConfig, body: &Value) -> Result<(u16, String)> {
    let key = cfg.api_key.trim();
    let mut req = client
        .post(endpoint(cfg))
        .header("Content-Type", "application/json");

    req = match cfg.protocol {
        ApiProtocol::OpenAi => req.bearer_auth(key),
        ApiProtocol::Anthropic => req
            .header("x-api-key", key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            // 部分 Anthropic 兼容网关只认 Bearer，官方会忽略这个头，两边都带上更省事
            .bearer_auth(key),
    };

    let resp = req
        .json(body)
        .send()
        .await
        .context("请求发送失败：检查 Base URL 是否可达、本机网络/代理是否放行")?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, text))
}

/// 从 chat/completions 的返回里取出正文（OpenAI 形状）
fn extract_openai_content(body: &str) -> Result<String> {
    let v: Value =
        serde_json::from_str(body).with_context(|| format!("返回不是 JSON：{}", clip(body, 300)))?;

    let choice = &v["choices"][0];
    let finish = choice["finish_reason"].as_str().unwrap_or_default();
    let completion = v["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    let reasoning_tokens = v["usage"]["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .unwrap_or(0);

    // 截断必须当成硬错误抛出去。否则会拿到半截 JSON，
    // 再被 parser 的容错吞掉，最后给老师一份"看起来很合理"的错误成绩。
    if finish == "length" {
        bail!(
            "输出被截断（finish_reason=length，已用 {completion} tokens，其中思考 {reasoning_tokens}）\
             —— 这份卷子的 JSON 不完整。可在左侧关闭「思考模式」重试，或调小 prompt。"
        );
    }

    let msg = &choice["message"];
    if let Some(s) = msg["content"].as_str() {
        if !s.trim().is_empty() {
            return Ok(s.to_string());
        }
    }
    // 少数网关把 content 返回成 [{type:"text",text:"..."}]
    if let Some(arr) = msg["content"].as_array() {
        let mut buf = String::new();
        for item in arr {
            if let Some(t) = item["text"].as_str() {
                buf.push_str(t);
            }
        }
        if !buf.trim().is_empty() {
            return Ok(buf);
        }
    }
    // 只剩思考内容，说明思考把输出配额吃光了
    if let Some(rc) = msg["reasoning_content"].as_str() {
        if !rc.trim().is_empty() {
            bail!(
                "模型只返回了思考内容、没有正文（思考已用 {reasoning_tokens} tokens，正文为空）：{}",
                clip(rc, 200)
            );
        }
    }
    Err(anyhow!(
        "返回结构异常，没有 choices[0].message.content：{}",
        clip(body, 300)
    ))
}

/// 从 /v1/messages 的返回里取出正文（Anthropic 形状）
fn extract_anthropic_content(body: &str) -> Result<String> {
    let v: Value =
        serde_json::from_str(body).with_context(|| format!("返回不是 JSON：{}", clip(body, 300)))?;

    // 200 但 type=error 的情况（少数网关这么干）
    if v["type"].as_str() == Some("error") {
        bail!("接口返回错误：{}", humanize_error(body));
    }

    let stop = v["stop_reason"].as_str().unwrap_or_default();
    let output_tokens = v["usage"]["output_tokens"].as_u64().unwrap_or(0);
    let budget = v["usage"]["output_tokens_details"]["thinking_tokens"]
        .as_u64()
        .unwrap_or(0);

    // 与 OpenAI 侧同理：截断必须硬报错，不能让半截 JSON 混进 parser
    if stop == "max_tokens" {
        bail!(
            "输出被截断（stop_reason=max_tokens，已用 {output_tokens} tokens，其中思考 {budget}）\
             —— 这份卷子的 JSON 不完整。可在左侧关闭「思考模式」重试，或调小 prompt。"
        );
    }

    let mut buf = String::new();
    if let Some(items) = v["content"].as_array() {
        for item in items {
            if item["type"].as_str() == Some("thinking") {
                continue; // 思考块不算正文
            }
            if let Some(t) = item["text"].as_str() {
                buf.push_str(t);
            }
        }
    }
    if buf.trim().is_empty() {
        bail!(
            "返回结构异常，没有 content[].text（stop_reason={stop}，输出 {output_tokens} tokens）：{}",
            clip(body, 300)
        );
    }
    Ok(buf)
}

fn extract_content(protocol: ApiProtocol, body: &str) -> Result<String> {
    match protocol {
        ApiProtocol::OpenAi => extract_openai_content(body),
        ApiProtocol::Anthropic => extract_anthropic_content(body),
    }
}

fn humanize_error(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(m) = v["error"]["message"].as_str() {
            return m.to_string();
        }
        if let Some(m) = v["message"].as_str() {
            return m.to_string();
        }
    }
    clip(body, 400)
}

fn clip(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        format!("{t}…")
    } else {
        t
    }
}

/// 批改一份卷子，返回模型原始文本。
///
/// `images` 是这份卷子的全部页（图片只有 1 张；PDF 按页序给多张），
/// 一次请求里全部发出去 —— 跨页的题目需要模型看到前后页才能判。
pub async fn grade_images(
    client: &reqwest::Client,
    cfg: &ApiConfig,
    system_prompt: &str,
    images: &[String],
) -> Result<String> {
    if cfg.api_key.trim().is_empty() {
        bail!("API Key 为空");
    }
    if images.is_empty() {
        bail!("没有可提交的卷面图片");
    }

    let body = build_payload(
        cfg,
        system_prompt,
        crate::prompt::USER_INSTRUCTION,
        images,
        cfg.json_mode,
        cfg.thinking,
    )?;
    let (status, text) = post(client, cfg, &body).await?;

    if (200..300).contains(&status) {
        return extract_content(cfg.protocol, &text);
    }

    // 部分网关不支持 response_format=json_object（返回 400）。降级重试一次，
    // 因为 prompt 里已经强制要求纯 JSON，去掉这个字段通常照样能用。
    // Anthropic 协议本来就没有这个字段，不需要降级。
    let lower = text.to_lowercase();
    if cfg.protocol == ApiProtocol::OpenAi
        && cfg.json_mode
        && status == 400
        && lower.contains("response_format")
    {
        let body2 = build_payload(
            cfg,
            system_prompt,
            crate::prompt::USER_INSTRUCTION,
            images,
            false,
            cfg.thinking,
        )?;
        let (status2, text2) = post(client, cfg, &body2).await?;
        if (200..300).contains(&status2) {
            return extract_content(cfg.protocol, &text2);
        }
        bail!("接口返回 {status2}：{}", humanize_error(&text2));
    }

    bail!("接口返回 {status}：{}", humanize_error(&text))
}

/// 连通性自检：发一条纯文本小请求，验证 Key / Base URL / 模型名 / 协议四项是否成套正确。
/// 自检故意不带思考参数 —— 思考预算要小于 max_tokens，小请求里塞不下，也会把耗时拖长。
pub async fn ping(client: &reqwest::Client, cfg: &ApiConfig) -> Result<String> {
    if cfg.api_key.trim().is_empty() {
        bail!("请先填写 API Key");
    }
    let body = build_payload(cfg, "", "只回复两个字：可用", &[], true, false)?;
    // 自检不需要 16k 输出（Anthropic 的 max_tokens 是必填项，这里单独收紧）
    let mut body = body;
    body["max_tokens"] = json!(512);

    let (status, text) = post(client, cfg, &body).await?;
    if !(200..300).contains(&status) {
        bail!("接口返回 {status}：{}", humanize_error(&text));
    }
    let content = extract_content(cfg.protocol, &text)?;
    Ok(clip(content.trim(), 40))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 一页卷面的 data URL 列表（测试里内容无所谓，只看结构）
    fn imgs(url: &str) -> Vec<String> {
        vec![url.to_string()]
    }

    fn openai_cfg() -> ApiConfig {
        let mut cfg = ApiConfig::default();
        cfg.protocol = ApiProtocol::OpenAi;
        cfg.thinking_style = ThinkingStyle::Deepseek;
        cfg
    }

    fn anthropic_cfg() -> ApiConfig {
        let mut cfg = ApiConfig::default();
        cfg.protocol = ApiProtocol::Anthropic;
        cfg.base_url = "https://api.anthropic.com".to_string();
        cfg.model = "claude-sonnet-4-5".to_string();
        cfg
    }

    #[test]
    fn payload_uses_official_thinking_field() {
        let mut cfg = openai_cfg();
        cfg.thinking = false;
        let body = build_payload(&cfg, "rubric", "user", &imgs("data:image/jpeg;base64,AAA"), true, false)
            .unwrap();

        assert_eq!(body["model"], "deepseek-flash");
        // 官方字段，不是 enable_thinking（那个会被静默忽略）
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("enable_thinking").is_none());
        assert_eq!(body["web_search"], false);
        assert_eq!(body["stream"], false);
        assert_eq!(body["max_tokens"], MAX_OUTPUT_TOKENS);
        // 关掉思考才设 temperature
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["response_format"]["type"], "json_object");
        // 图片必须走 image_url 而不是把 base64 塞进 text
        assert_eq!(body["messages"][1]["content"][1]["type"], "image_url");
    }

    #[test]
    fn payload_defaults_to_thinking_enabled_without_temperature() {
        let cfg = openai_cfg();
        let body = build_payload(&cfg, "r", "u", &imgs("data:image/jpeg;base64,AAA"), false, true)
            .unwrap();
        assert_eq!(body["thinking"]["type"], "enabled");
        // 思考模式下 temperature 会被忽略，设了反而误导
        assert!(body.get("temperature").is_none());
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn reasoning_effort_style_never_sends_deepseek_fields() {
        let mut cfg = openai_cfg();
        cfg.api_key = "sk-x".into();
        cfg.base_url = "https://api.openai.com/v1".into();
        cfg.model = "o4-mini".into();
        cfg.thinking_style = ThinkingStyle::ReasoningEffort;

        let on = build_payload(&cfg, "r", "u", &[], true, true).unwrap();
        assert_eq!(on["reasoning_effort"], "high");
        // OpenAI 官方会把未知参数 400 掉，这两个字段一个都不能出现
        assert!(on.get("thinking").is_none());
        assert!(on.get("web_search").is_none());
        assert!(on.get("temperature").is_none());

        // 推理模型没有"关闭"开关，只能整字段省略
        let off = build_payload(&cfg, "r", "u", &[], true, false).unwrap();
        assert!(off.get("reasoning_effort").is_none());
        assert!(off.get("temperature").is_none());
    }

    #[test]
    fn off_style_sends_no_thinking_field_but_keeps_temperature() {
        let mut cfg = openai_cfg();
        cfg.base_url = "https://api.siliconflow.cn/v1".into();
        cfg.thinking_style = ThinkingStyle::Off;

        let thinking_on = build_payload(&cfg, "r", "u", &[], false, true).unwrap();
        assert!(thinking_on.get("thinking").is_none());
        assert!(thinking_on.get("web_search").is_none());

        // 关掉思考才设 temperature=0 求确定性（这套模型本来也没有思考参数，等同普通调用）
        let thinking_off = build_payload(&cfg, "r", "u", &[], false, false).unwrap();
        assert!(thinking_off.get("thinking").is_none());
        assert_eq!(thinking_off["temperature"], 0.0);
    }

    #[test]
    fn auto_style_follows_base_url() {
        let mut cfg = openai_cfg();
        cfg.thinking_style = ThinkingStyle::Auto;

        cfg.base_url = "https://api.deepseek.com".into();
        assert_eq!(effective_style(&cfg), ThinkingStyle::Deepseek);

        cfg.base_url = "https://api.openai.com/v1".into();
        assert_eq!(effective_style(&cfg), ThinkingStyle::ReasoningEffort);

        // 陌生网关不猜，一律不发思考参数
        cfg.base_url = "https://gateway.example.com/v1".into();
        assert_eq!(effective_style(&cfg), ThinkingStyle::Off);
    }

    #[test]
    fn anthropic_payload_uses_system_top_level_and_base64_source() {
        let cfg = anthropic_cfg();
        let body = build_payload(
            &cfg,
            "rubric",
            "user",
            &imgs("data:image/png;base64,QUJD"),
            true,
            true,
        )
        .unwrap();

        // system 必须是顶层，塞进 messages 会被 400
        assert_eq!(body["system"], "rubric");
        assert!(body["messages"][0]["content"][0]["text"].is_null());
        // 图片块：source.type=base64 + media_type + 裸 base64（没有 data: 前缀）
        let img = &body["messages"][0]["content"][0];
        assert_eq!(img["type"], "image");
        assert_eq!(img["source"]["type"], "base64");
        assert_eq!(img["source"]["media_type"], "image/png");
        assert_eq!(img["source"]["data"], "QUJD");
        // 扩展思考：预算必须小于 max_tokens
        assert_eq!(body["thinking"]["type"], "enabled");
        let budget = body["thinking"]["budget_tokens"].as_u64().unwrap();
        assert!(budget < body["max_tokens"].as_u64().unwrap());
        // Anthropic 没有 response_format，思考开着也不能设 temperature
        assert!(body.get("response_format").is_none());
        assert!(body.get("temperature").is_none());
        assert!(body.get("web_search").is_none());
    }

    #[test]
    fn anthropic_payload_without_thinking_sets_temperature() {
        let cfg = anthropic_cfg();
        let body = build_payload(&cfg, "r", "u", &[], false, false).unwrap();
        assert!(body.get("thinking").is_none());
        assert_eq!(body["temperature"], 0.0);
        // 纯文本请求的 content 是单个 text 块
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
    }

    #[test]
    fn anthropic_endpoint_join_is_idempotent() {
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com/"),
            "https://api.anthropic.com/v1/messages"
        );
        // 已经带了 /v1 或完整路径都不能重复拼
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_endpoint("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn truncated_output_is_a_hard_error() {
        let body = r#"{"choices":[{"finish_reason":"length","message":{"content":"{\"a\":1"}}],
                       "usage":{"completion_tokens":4096,
                                "completion_tokens_details":{"reasoning_tokens":3500}}}"#;
        let err = extract_content(ApiProtocol::OpenAi, body).unwrap_err().to_string();
        assert!(err.contains("截断"), "实际错误：{err}");
        assert!(err.contains("4096"));
    }

    #[test]
    fn json_mode_off_drops_response_format() {
        let cfg = openai_cfg();
        let body = build_payload(&cfg, "r", "u", &imgs("data:image/png;base64,AAA"), false, true)
            .unwrap();
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn endpoint_join_is_idempotent() {
        assert_eq!(
            openai_endpoint("https://a.com/v1/"),
            "https://a.com/v1/chat/completions"
        );
        assert_eq!(
            openai_endpoint("https://a.com/v1/chat/completions"),
            "https://a.com/v1/chat/completions"
        );
    }

    #[test]
    fn endpoint_dispatches_by_protocol() {
        let mut cfg = openai_cfg();
        cfg.base_url = "https://api.deepseek.com".into();
        assert_eq!(endpoint(&cfg), "https://api.deepseek.com/chat/completions");

        let mut cfg = anthropic_cfg();
        cfg.base_url = "https://api.anthropic.com".into();
        assert_eq!(endpoint(&cfg), "https://api.anthropic.com/v1/messages");
    }

    /// 普通图片要经过瘦身：mime 统一成 jpeg，字节数明显小于原图
    #[test]
    fn plain_image_is_slimmed_and_sent_as_jpeg() {
        let dir = std::env::temp_dir().join(format!("aigs-api-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("scan.png");

        // 3000×2000 的"扫描件"：白底 + 竖线，保证是彩色 RGB、体积足够大
        let mut img = image::RgbImage::from_pixel(3000, 2000, image::Rgb([250, 250, 250]));
        for x in (0..3000).step_by(37) {
            for y in 0..2000 {
                img.put_pixel(x, y, image::Rgb([30, 30, 30]));
            }
        }
        image::DynamicImage::ImageRgb8(img)
            .save(&p)
            .unwrap();

        let opts = ImageOptions::default();
        let (url, bytes) = read_image_data_url(&p, &opts).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"), "mime 应该是 jpeg");
        assert!(bytes > 0 && bytes < 1024 * 1024, "单页应控制在 1 MB 内：{bytes}");

        // 长边被压到 2048，并且是灰度
        let b64 = url.split_once(',').unwrap().1;
        let decoded = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let img = image::load_from_memory(&decoded).unwrap();
        assert_eq!((img.width(), img.height()), (2048, 1365));
        assert!(matches!(img, image::DynamicImage::ImageLuma8(_)));

        // 原图直传：字节数等于文件大小，mime 保持原样
        let raw_opts = ImageOptions {
            passthrough: true,
            ..ImageOptions::default()
        };
        let (raw_url, raw_bytes) = read_image_data_url(&p, &raw_opts).unwrap();
        assert!(raw_url.starts_with("data:image/png;base64,"));
        assert_eq!(raw_bytes, std::fs::metadata(&p).unwrap().len());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_content_from_openai_shape() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"ok\":1}"}}]}"#;
        assert_eq!(
            extract_content(ApiProtocol::OpenAi, body).unwrap(),
            "{\"ok\":1}"
        );
    }

    #[test]
    fn extracts_text_blocks_and_skips_thinking_from_anthropic_shape() {
        let body = r#"{"type":"message","role":"assistant","stop_reason":"end_turn",
                       "content":[{"type":"thinking","thinking":"先看第一题…"},
                                  {"type":"text","text":"{\"ok\":1}"}],
                       "usage":{"input_tokens":1200,"output_tokens":320}}"#;
        assert_eq!(
            extract_content(ApiProtocol::Anthropic, body).unwrap(),
            "{\"ok\":1}"
        );
    }

    #[test]
    fn anthropic_max_tokens_is_a_hard_error() {
        let body = r#"{"type":"message","stop_reason":"max_tokens",
                       "content":[{"type":"text","text":"{\"a\":1"}],
                       "usage":{"output_tokens":16384}}"#;
        let err = extract_content(ApiProtocol::Anthropic, body).unwrap_err().to_string();
        assert!(err.contains("截断"), "实际错误：{err}");
        assert!(err.contains("16384"));
    }

    #[test]
    fn split_data_url_rejects_malformed_input() {
        assert!(split_data_url("https://example.com/a.png").is_err());
        assert!(split_data_url("data:image/png;base64,").is_err());
        let (mt, data) = split_data_url("data:image/webp;base64,QUJD").unwrap();
        assert_eq!(mt, "image/webp");
        assert_eq!(data, "QUJD");
    }
}
