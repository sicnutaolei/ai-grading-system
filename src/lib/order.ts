import type { GradingResult, ScanFile } from "@/types";

export interface FileRow {
  file: ScanFile;
  result?: GradingResult;
  error?: string;
  abnormal: boolean;
  /** 还没批改过 */
  pending: boolean;
}

/**
 * 列表排序规则（老师最需要先看到的排最前）：
 * 1. 异常卷（没写名字 / 字迹不清）—— 红色警告，必须置顶
 * 2. 批改失败 —— 也要人工介入
 * 3. 其余按文件名自然序
 */
export function buildRows(
  files: ScanFile[],
  results: Record<string, GradingResult>,
  failed: Record<string, string>
): FileRow[] {
  const rows: FileRow[] = files.map((file) => {
    const result = results[file.path];
    return {
      file,
      result,
      error: failed[file.path],
      abnormal: result?.is_abnormal ?? false,
      pending: !result && !failed[file.path],
    };
  });

  rows.sort((a, b) => {
    if (a.abnormal !== b.abnormal) return a.abnormal ? -1 : 1;
    const ae = a.error ? 1 : 0;
    const be = b.error ? 1 : 0;
    if (ae !== be) return be - ae;
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
