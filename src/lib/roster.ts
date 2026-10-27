/**
 * 名单文本 ↔ 数组。
 *
 * 老师可能在文本框里手动粘贴，也可能从文件导入。后端 `roster.rs` 有更强的解析
 * （支持 csv 表头、GBK 编码），这里只做「一行一个名字」的轻量清洗。
 */

const MAX_NAMES = 500;

export function parseRosterText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    // 兼容粘贴进来的 "1. 张三" / "1、张三" / "1,张三"
    const cleaned = raw
      .trim()
      .replace(/^\d+\s*[.、,，:：)）]\s*/, "")
      .replace(/^["'“”]|["'“”]$/g, "")
      .trim();
    if (!cleaned) continue;
    if (cleaned === "姓名" || cleaned === "名字" || cleaned === "序号") continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= MAX_NAMES) break;
  }

  return out;
}

export function rosterToText(names: string[]): string {
  return names.join("\n");
}
