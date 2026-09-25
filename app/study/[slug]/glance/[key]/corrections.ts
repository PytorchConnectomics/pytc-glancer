/** Both panels use the same absolute class operation. Quality calls follow
 * the effective class on read, so moving never rewrites quality history. */
import { mergeEdits, setClass } from "../../../../../lib/edits";
import type { GlanceReview } from "../../../../../lib/review";
import type { ErrorReport } from "../../../../../lib/report";
export interface BatchMove { review: GlanceReview; moved: string[]; already: string[]; unknown: string[]; }
export function reassignIds(review: GlanceReview, report: ErrorReport, ids: string[], to: string): BatchMove {
  return setClass(review, mergeEdits(report, review.class_review), ids, to);
}
