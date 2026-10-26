import raw from "../../rubric.md?raw";

/**
 * 内置评分细则。
 *
 * 正文来自仓库根的 `rubric.md` —— 与 Rust 端 `include_str!` 读的是同一个文件，
 * 所以「恢复默认」拿到的内容和后端真正发给模型的细则永远一致。
 */
export const DEFAULT_RUBRIC: string = raw;
