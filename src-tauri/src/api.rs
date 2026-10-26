//! deepseek-flash 调用层。
//!
//! 下面这几条都是照着官方文档 + 真实请求打出来的，不是猜的
//! （https://api-docs.deepseek.com/zh-cn/guides/thinking_mode）：
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

use crate::models::ApiConfig;
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// 单图体积提示阈值：超过就警告，但仍发送
pub const BIG_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// 输出配额。整卷 28 个得分点的 JSON 约 2200 tokens，思考约 3500，
/// 留足余量取 16384（模型上限 393216）。
const MAX_OUTPUT_TOKENS: u32 = 16384;

pub fn build_client(cfg: &ApiConfig) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(cfg.timeout_secs.clamp(30, 600)))
        .connect_timeout(Duration::from_secs(20))
        .user_agent("ai-grading-system/0.1")
        .build()
        .context("创建 HTTP 客户端失败")
}

fn endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
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

pub fn read_as_data_url(path: &Path) -> Result<String> {
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

/// 构造请求体。`json_mode=false` 时去掉 response_format（降级路径用）
fn build_payload(
    cfg: &ApiConfig,
    system_prompt: &str,
    user_text: &str,
    image_data_url: &str,
    json_mode: bool,
) -> Value {
    let thinking_type = if cfg.thinking { "enabled" } else { "disabled" };

    let mut body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": system_prompt },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": user_text },
                    { "type": "image_url", "image_url": { "url": image_data_url } }
                ]
            }
        ],
        "stream": false,
        "max_tokens": MAX_OUTPUT_TOKENS,

        // 官方字段：思考模式开关。默认 enabled —— 实测关掉会让阅卷明显变马虎。
        "thinking": { "type": thinking_type },

        // 联网搜索：DeepSeek 官方 API 没有这个能力，显式置 false 是幂等的
        // （未知字段被忽略）。保留是为了守住"绝不引入卷面以外信息"这条硬要求。
        "web_search": false
    });

    // 思考模式下 temperature 会被忽略（文档明说），只在关闭思考时才设，求确定性
    if !cfg.thinking {
        body["temperature"] = json!(0.0);
    }

    if json_mode {
        body["response_format"] = json!({ "type": "json_object" });
    }
    body
}

async fn post(client: &reqwest::Client, cfg: &ApiConfig, body: &Value) -> Result<(u16, String)> {
    let resp = client
        .post(endpoint(&cfg.base_url))
        .bearer_auth(cfg.api_key.trim())
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .context("请求发送失败：检查 Base URL 是否可达、本机网络/代理是否放行")?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    Ok((status, text))
}

/// 从 chat/completions 的返回里取出正文
fn extract_content(body: &str) -> Result<String> {
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

/// 批改一张卷子，返回模型原始文本
pub async fn grade_image(
    client: &reqwest::Client,
    cfg: &ApiConfig,
    system_prompt: &str,
    image_data_url: &str,
) -> Result<String> {
    if cfg.api_key.trim().is_empty() {
        bail!("API Key 为空");
    }

    let body = build_payload(cfg, system_prompt, crate::prompt::USER_INSTRUCTION, image_data_url, cfg.json_mode);
    let (status, text) = post(client, cfg, &body).await?;

    if (200..300).contains(&status) {
        return extract_content(&text);
    }

    // 部分网关不支持 response_format=json_object（返回 400）。降级重试一次，
    // 因为 prompt 里已经强制要求纯 JSON，去掉这个字段通常照样能用。
    let lower = text.to_lowercase();
    if cfg.json_mode && status == 400 && lower.contains("response_format") {
        let body2 = build_payload(
            cfg,
            system_prompt,
            crate::prompt::USER_INSTRUCTION,
            image_data_url,
            false,
        );
        let (status2, text2) = post(client, cfg, &body2).await?;
        if (200..300).contains(&status2) {
            return extract_content(&text2);
        }
        bail!("接口返回 {status2}：{}", humanize_error(&text2));
    }

    bail!("接口返回 {status}：{}", humanize_error(&text))
}

/// 连通性自检：发一条纯文本小请求，验证 Key / Base URL / 模型名
pub async fn ping(client: &reqwest::Client, cfg: &ApiConfig) -> Result<String> {
    if cfg.api_key.trim().is_empty() {
        bail!("请先填写 API Key");
    }
    let body = json!({
        "model": cfg.model,
        "messages": [{ "role": "user", "content": "只回复两个字：可用" }],
        "max_tokens": 512,
        "stream": false,
        "thinking": {
            "type": if cfg.thinking { "enabled" } else { "disabled" }
        },
        "web_search": false
    });

    let (status, text) = post(client, cfg, &body).await?;
    if !(200..300).contains(&status) {
        bail!("接口返回 {status}：{}", humanize_error(&text));
    }
    let content = extract_content(&text)?;
    Ok(clip(content.trim(), 40))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_uses_official_thinking_field() {
        let mut cfg = ApiConfig::default();
        cfg.thinking = false;
        let body = build_payload(&cfg, "rubric", "user", "data:image/jpeg;base64,AAA", true);

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
        let cfg = ApiConfig::default();
        let body = build_payload(&cfg, "r", "u", "data:image/jpeg;base64,AAA", false);
        assert_eq!(body["thinking"]["type"], "enabled");
        // 思考模式下 temperature 会被忽略，设了反而误导
        assert!(body.get("temperature").is_none());
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn truncated_output_is_a_hard_error() {
        let body = r#"{"choices":[{"finish_reason":"length","message":{"content":"{\"a\":1"}}],
                       "usage":{"completion_tokens":4096,
                                "completion_tokens_details":{"reasoning_tokens":3500}}}"#;
        let err = extract_content(body).unwrap_err().to_string();
        assert!(err.contains("截断"), "实际错误：{err}");
        assert!(err.contains("4096"));
    }

    #[test]
    fn json_mode_off_drops_response_format() {
        let cfg = ApiConfig::default();
        let body = build_payload(&cfg, "r", "u", "data:image/png;base64,AAA", false);
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn endpoint_join_is_idempotent() {
        assert_eq!(
            endpoint("https://a.com/v1/"),
            "https://a.com/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://a.com/v1/chat/completions"),
            "https://a.com/v1/chat/completions"
        );
    }

    #[test]
    fn extracts_content_from_openai_shape() {
        let body = r#"{"choices":[{"message":{"role":"assistant","content":"{\"ok\":1}"}}]}"#;
        assert_eq!(extract_content(body).unwrap(), "{\"ok\":1}");
    }
}
