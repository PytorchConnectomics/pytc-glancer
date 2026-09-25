"use client";
import { useState } from "react";
import { summarizeEdits, usePipeline, type MergeOutcome } from "../../../../../lib/edits";
import type { GlanceReview } from "../../../../../lib/review";

/** Every inactive edit remains reachable, even on reports with many missing ids. */
export default function EditStatusLine({ merged, review, onChange, readOnly }: {
  merged: MergeOutcome; review: GlanceReview; onChange: (review: GlanceReview) => void; readOnly: boolean;
}) {
  const [shown, setShown] = useState(50);
  const summary = summarizeEdits(merged);
  const parts = [summary.applied ? `${summary.applied} applied` : "", summary.agrees ? `${summary.agrees} the pipeline now agrees with` : "", summary.inactive.length ? `${summary.inactive.length} inactive` : ""].filter(Boolean);
  const reasons = { pending: "no target chosen", no_segment: "no longer in this report", no_class: "class not in this report", applied: "", agrees: "" };
  return <div className="edit-status">
    <p className="panel-note">{parts.length ? `Your edits: ${parts.join(" · ")}` : "No edits yet"}{summary.uncounted ? `; totals approximate for ${summary.uncounted} segments without a voxel count` : ""}</p>
    {!!summary.inactive.length && <details><summary>Inactive edits ({summary.inactive.length})</summary>
      <ul>{summary.inactive.slice(0, shown).map((id) => <li key={id}>{id} — {reasons[merged.status[id]]} <button type="button" className="text-button" disabled={readOnly} onClick={() => onChange(usePipeline(review, [id]))}>Remove</button></li>)}</ul>
      {shown < summary.inactive.length && <button type="button" className="secondary" onClick={() => setShown(shown + 50)}>Show more</button>}
    </details>}
  </div>;
}
