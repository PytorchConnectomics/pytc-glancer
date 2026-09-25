/* Small, self-contained descriptions travel with every restore point. Bodies
 * stay on the server; the confirmation never reconstructs state from a page. */
import type { ErrorReport } from "./report";
import { reviewIsEmpty, type GlanceReview } from "./review";

export interface ReportSummary {
  classes: { id: string; labels: number | null; voxels: number }[];
  total_voxels: number;
  segmentation: string | null;
}
export interface ReviewSummary { class_verdicts: number; moves: number; qc_calls: number; hand_ids: number; empty: boolean; }
export interface UnreadableSummary { unreadable: true; }
export interface HistoryState {
  report_version: number | null; report: ReportSummary | UnreadableSummary | null;
  review_version: number | null; review: ReviewSummary | UnreadableSummary;
}
export interface HistoryEntry {
  point: number; operation: string; source: string; author: string;
  started_at: number; ended_at: number; kinds: string[];
  restored_from: number | null; restored_from_at: number | null;
  state: HistoryState; current: boolean;
}
export interface HistoryPage { entries: HistoryEntry[]; next_before: number | null; }

export function summarizeReport(report: ErrorReport): ReportSummary {
  return { classes: report.classes.slice(0, 32).map(({ id, labels, voxels }) => ({ id, labels, voxels })), total_voxels: report.total_voxels, segmentation: report.segmentation?.slice(0, 128) ?? null };
}
export function summarizeReview(review: GlanceReview): ReviewSummary {
  const verdicts = Object.values(review.class_review);
  return { class_verdicts: verdicts.length, moves: verdicts.filter((entry) => entry.verdict === "reassign").length,
    qc_calls: Object.values(review.cell_review).reduce((sum, entries) => sum + Object.keys(entries).length, 0),
    hand_ids: Object.values(review.cell_members).reduce((sum, members) => sum + members.ids.length, 0), empty: reviewIsEmpty(review) };
}
export function summaryJson(summary: ReportSummary | ReviewSummary | UnreadableSummary | null) {
  const body = JSON.stringify(summary);
  if (new TextEncoder().encode(body).length > 4096) throw new Error("History summary exceeds 4 KB.");
  return body;
}
