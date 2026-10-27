import type { GradingResult, ScanFile } from "@/types";

export interface FileRow {
  file: ScanFile;
  result?: GradingResult;
  error?: string;
  abnormal: boolean;
  /** 还没批改过 */
  pending: boolean;
  /** 列表里显示的名字：优先考生姓名，拿不到才退回文件名（文件名本身不改） */
  displayName: string;
}

/**
 * 列表排序规则：
 *
 * 1. **异常卷永远置顶** —— 它们的分不可信（整卷可能没识别出来），混在分数排名里
 *    会让老师误判班级情况，必须先处理掉。
 * 2. 其余已批改的**按 AI 原始总分降序**。用 `total_ai` 而不是改分后的分数，
 *    这样老师改分时列表不会突然重排、把正在看的那张顶走。
 * 3. 未批改 / 批改失败的排在最后，按文件名自然序。
 */
export function buildRows(
  files: ScanFile[],
  results: Record<string, GradingResult>,
  failed: Record<string, string>
): FileRow[] {
  const rows: FileRow[] = files.map((file) => {
    const result = results[file.path];
    const knownName =
      result && result.student_name && result.student_name !== "未知"
        ? result.student_name
        : null;
    return {
      file,
      result,
      error: failed[file.path],
      abnormal: result?.is_abnormal ?? false,
      pending: !result && !failed[file.path],
      displayName: knownName ?? file.file_name,
    };
  });

  rows.sort((a, b) => {
    // 1. 异常置顶
    if (a.abnormal !== b.abnormal) return a.abnormal ? -1 : 1;

    // 2. 都批改过 → 按总分降序
    const as = a.result ? a.result.total_ai : null;
    const bs = b.result ? b.result.total_ai : null;
    if (as !== null && bs !== null && as !== bs) return bs - as;

    // 3. 批改过的排在没批改的前面
    if ((as !== null) !== (bs !== null)) return as !== null ? -1 : 1;

    // 4. 其余按文件名自然序
    return a.file.file_name.localeCompare(b.file.file_name, "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base",
    });
  });

  return rows;
}

export function orderedPaths(
  files: ScanFile[],
  results: Record<string, GradingResult>,
  failed: Record<string, string>
): string[] {
  return buildRows(files, results, failed).map((row) => row.file.path);
}
