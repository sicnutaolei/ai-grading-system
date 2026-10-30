/**
 * 浏览器预览用的**虚构**示例数据（`npm run dev` 直接开浏览器时生效）。
 *
 * ⚠️ 这里没有任何真实学生信息：姓名是「张三」，图片是 public/sample 下用代码画的
 * 示意答题卡（SVG），分数结构来自一次真实批改的输出但已脱敏。
 *
 * 用途只有一个：在没有 Rust 后端时把 UI 点一遍。
 */

import { DEFAULT_RUBRIC } from "@/lib/rubric";
import type { GradingResult, QuestionScore, ScanFile } from "@/types";

import sampleGraded from "@/fixtures/sample-graded.json";

interface RawQuestion {
  question_id: string;
  label: string;
  section: string;
  max_score: number;
  score: number;
  reason: string;
  student_answer: string;
  standard_answer: string;
  review_needed: boolean;
  review_note: string;
}

const raw = sampleGraded as unknown as {
  student_name: string;
  is_abnormal: boolean;
  abnormal_reason: string;
  total_score: number;
  full_score: number;
  overall_comment: string;
  questions: RawQuestion[];
};

/** 模型字段名 → 前端字段名（Rust 端 normalize 做的是同一件事） */
const questionsA: QuestionScore[] = raw.questions.map((q) => ({
  id: q.question_id,
  label: q.label,
  section: q.section,
  max_score: q.max_score,
  ai_score: q.score,
  reason: q.reason,
  student_answer: q.student_answer,
  standard_answer: q.standard_answer,
  review_needed: q.review_needed,
  review_note: q.review_note,
}));

const totalA = questionsA.reduce((sum, item) => sum + item.ai_score, 0);

/** C 卷：虚构的高分卷，用来看「按分数降序」的排序效果 */
const questionsC: QuestionScore[] = questionsA.map((q) => ({
  ...q,
  ai_score: Math.min(q.max_score, Math.round(q.ai_score * 1.6)),
  reason: q.ai_score === q.max_score ? q.reason : "按细则给分，详见原始返回",
}));
const totalC = questionsC.reduce((sum, item) => sum + item.ai_score, 0);

/** B 卷：没写名字 + 大面积涂改，用来演示异常拦截 */
const questionsB: QuestionScore[] = questionsA.map((item, i) => {
  const visible = i < 10;
  return {
    ...item,
    ai_score: visible && (i === 0 || i === 5) ? 6 : 0,
    reason: visible
      ? "涂改严重，字符勉强可辨，按最可能的选项给分"
      : "涂改/潦草到无法判读，按规则不给分，需人工复核",
    student_answer: visible ? item.student_answer : "无法辨认",
    review_needed: true,
    review_note: "字迹不清",
  };
});

const totalB = questionsB.reduce((sum, item) => sum + item.ai_score, 0);

const NAME_A = "示例答题卡-A.svg";
const NAME_B = "示例答题卡-B.svg";
const NAME_C = "示例答题卡-C.svg";

export const MOCK_FILES: ScanFile[] = [
  { path: "/sample/card-a.svg", file_name: NAME_A, size: 4428, page_count: 1 },
  { path: "/sample/card-b.svg", file_name: NAME_B, size: 4317, page_count: 1 },
  { path: "/sample/card-c.svg", file_name: NAME_C, size: 4428, page_count: 1 },
];

export const MOCK_RESULTS: Record<string, GradingResult> = {
  "/sample/card-a.svg": {
    file_path: "/sample/card-a.svg",
    file_name: NAME_A,
    student_name: raw.student_name,
    is_abnormal: false,
    abnormal_reason: "",
    total_ai: totalA,
    total_ai_reported: raw.total_score,
    total_full: raw.full_score || 100,
    questions: questionsA,
    overall_comment: raw.overall_comment,
    model: "deepseek-flash",
    graded_at: "2026-10-26 19:22:41",
    duration_ms: 27600,
    raw_json: JSON.stringify(raw, null, 2),
  },
  "/sample/card-b.svg": {
    file_path: "/sample/card-b.svg",
    file_name: NAME_B,
    student_name: "未知",
    is_abnormal: true,
    abnormal_reason: "没写名字且字迹不清",
    total_ai: totalB,
    total_ai_reported: totalB,
    total_full: 100,
    questions: questionsB,
    overall_comment: "卷面无法识别姓名，主观题大面积涂改，建议人工复核。",
    model: "deepseek-flash",
    graded_at: "2026-10-26 19:23:08",
    duration_ms: 9500,
    raw_json: `{
  "student_name": "未知",
  "is_abnormal": true,
  "abnormal_reason": "没写名字且字迹不清",
  "total_score": ${totalB},
  "questions": [ ... 共 28 个得分点 ... ]
}`,
  },
  "/sample/card-c.svg": {
    file_path: "/sample/card-c.svg",
    file_name: NAME_C,
    student_name: "王五",
    is_abnormal: false,
    abnormal_reason: "",
    total_ai: totalC,
    total_ai_reported: totalC,
    total_full: 100,
    questions: questionsC,
    overall_comment: "选择题全对，主观题要点基本齐，方程式书写规范。",
    model: "deepseek-flash",
    graded_at: "2026-10-26 19:24:02",
    duration_ms: 26100,
    raw_json: `{ "student_name": "王五", "total_score": ${totalC} }`,
  },
};

export const mockRubric: string = DEFAULT_RUBRIC;

export function mockDelay<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}
