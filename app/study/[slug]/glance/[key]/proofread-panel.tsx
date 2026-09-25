"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { decimals, integers } from "./chart";
import { reassignIds } from "./corrections";
import { mergeEdits, keepClass, reject, setClass, usePipeline, type MergeOutcome } from "../../../../../lib/edits";
import { viewerSegments } from "./ids";
import { MAX_GROUP_SIZE, clampGroupSize } from "./paging";
import type { ClassVerdictId, GlanceReview } from "../../../../../lib/review";
import type { ErrorReport, ReportSegment, Selection } from "./report-panel";

export type Ordering = "margin" | "size" | "length" | "report";
export type Verdict = ClassVerdictId;

const ORDERINGS: Array<{ id: Ordering; label: string; hint: string }> = [
  { id: "margin", label: "Closest to the cutoff", hint: "The segments nearest this class's decision boundary come first: the ones most likely to be filed wrong." },
  { id: "size", label: "Largest first", hint: "Biggest segments first, by voxel count. The ones a mistake costs the most on." },
  { id: "report", label: "Report order", hint: "The order the report lists, untouched." }
];
const VERDICTS: Array<{ id: Verdict; label: string; key: string }> = [
  { id: "keep", label: "Keep", key: "k" },
  { id: "reject", label: "Reject", key: "r" },
  { id: "reassign", label: "Reassign", key: "a" }
];

/** Ordering never mutates the report's own list; it returns a fresh view. */
export function orderSegments(segments: ReportSegment[], ordering: Ordering): ReportSegment[] {
  if (ordering === "report") return segments;
  const ranked = [...segments];
  if (ordering === "size" || ordering === "length") {
    const measure = (segment: ReportSegment) => (ordering === "size" ? segment.voxels : segment.length_um) ?? -Infinity;
    ranked.sort((left, right) => measure(right) - measure(left));
    return ranked;
  }
  // A segment with no margin cannot be ranked against one that has it, so it
  // sinks rather than sorting as if it sat on the boundary.
  ranked.sort((left, right) => {
    if (left.margin === null) return right.margin === null ? 0 : 1;
    if (right.margin === null) return -1;
    return left.margin - right.margin;
  });
  return ranked;
}

function measurement(value: number | null, unit: string, digits = 3) { return value === null ? "—" : `${decimals(value, digits)} ${unit}`; }

export default function ProofreadPanel({ report, classId, onClassChange, onSelect, review, onReviewChange: changeReview, readOnly = false, merged: supplied, saveError }: {
  report: ErrorReport; classId: string | null; onClassChange: (id: string) => void; onSelect: (selection: Selection | null) => void;
  readOnly?: boolean; review: GlanceReview; onReviewChange: (next: GlanceReview) => void;
  merged?: MergeOutcome; saveError: string;
}) {
  const onReviewChange = (next: GlanceReview) => { if (!readOnly) changeReview(next); };
  const verdicts = review.class_review;
  const merged = useMemo(() => supplied ?? mergeEdits(report, verdicts), [supplied, report, verdicts]);
  const shown = merged.report;
  const filed = merged.pipelineClass;
  const reviewable = shown.classes.filter((entry) => entry.segments.length);
  if (merged.rejected.length) reviewable.push({ id: "__rejected", label: "Rejected", voxels: 0, volume_um3: null, labels: null, note: null, margin_label: null, segment_ids: merged.rejected.map((s) => s.id), segments: merged.rejected.map((s) => s.segment) });
  const active = reviewable.find((entry) => entry.id === classId) ?? reviewable[0] ?? null;
  const isRejected = active?.id === "__rejected";
  const targetSelect = useRef<HTMLSelectElement>(null);
  const [ordering, setOrdering] = useState<Ordering>("margin");
  /* A pasted list of segments to send to one class together: bare ids, or a
   * Neuroglancer link or state, whose switched-on segments are the list. */
  const [batchDraft, setBatchDraft] = useState("");
  const [batchTo, setBatchTo] = useState("");
  const [batchNote, setBatchNote] = useState("");
  const [index, setIndex] = useState(0);
  /* How many segments the viewer shows at once. One steps and centres each in
   * turn; more loads a page of them together, and a verdict then applies to
   * the whole page, as quality control's group mode does. */
  const [size, setSize] = useState(1);
  const [page, setPage] = useState(0);
  const stepper = useRef<HTMLDivElement>(null);
  /* A batch move only records verdicts. The reader is usually picking the
   * next ids in the viewer, so the move must not reload it, even when a moved
   * segment was the one on screen; the viewer follows again on the next step. */
  const holdViewer = useRef(false);

  const ordered = useMemo(() => active ? orderSegments(active.segments, ordering) : [], [active, ordering]);
  // A segment moving out shortens the list under the cursor, so the next one
  // slides into place; past the end, the cursor settles on the last.
  const position = Math.min(index, Math.max(ordered.length - 1, 0));
  const current = ordered[position] ?? null;
  const origin = current ? filed.get(current.id) ?? active?.id ?? null : null;


  const grouped = size > 1;
  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const pageIndex = Math.min(page, pages - 1);
  const pageStart = pageIndex * size;
  const groupSegments = useMemo(() => grouped ? ordered.slice(pageStart, pageStart + size) : [], [grouped, ordered, pageStart, size]);
  const groupKey = groupSegments.map((segment) => segment.id).join(",");

  /* One at a time centres the segment being judged; showing the whole class
   * again would put the reader back to hunting for it. A page has no single
   * centre, since its members are scattered, so the frame keeps the glance's
   * own position. The key changes whenever the page's contents do. */
  useEffect(() => {
    if (holdViewer.current) { holdViewer.current = false; return; }
    if (grouped) {
      if (!groupSegments.length) return onSelect(null);
      return onSelect({ id: `review:${active?.id}:page:${pageStart}:${groupKey}`, segments: groupSegments.map((segment) => segment.id), centroid_um: null });
    }
    if (!current) return onSelect(null);
    onSelect({ id: `review:${active?.id}:${current.id}`, segments: [current.id], centroid_um: current.centroid_um });
  }, [grouped, groupKey, pageStart, current?.id, active?.id]);

  useEffect(() => { setIndex(0); setPage(0); }, [active?.id, ordering, size]);

  if (!reviewable.length) return <p className="panel-note">This report lists no per-segment records, so there is nothing to step through. Regenerate it with <code>scripts/make_error_report.py</code>.</p>;

  const step = (delta: number) => setIndex(Math.max(0, Math.min(ordered.length - 1, position + delta)));
  const actionIds = () => grouped ? groupSegments.map((s) => s.id) : current ? [current.id] : [];
  const judge = (verdict: Verdict) => {
    if (verdict === "reassign") { targetSelect.current?.focus(); return; }
    const ids = actionIds();
    if (!ids.length) return;
    const clearing = ids.every((id) => verdicts[id]?.verdict === verdict);
    onReviewChange(clearing ? usePipeline(review, ids) : verdict === "keep" ? keepClass(review, merged, ids).review : reject(review, merged, ids).review);
  };
  const retarget = (to: string) => {
    if (!to) return;
    onReviewChange(setClass(review, merged, actionIds(), to).review);
    stepper.current?.focus();
  };
  const batchIds = viewerSegments(batchDraft) ?? [];
  const moveBatch = () => {
    if (!batchIds.length || !batchTo) return;
    const result = reassignIds(review, report, batchIds, batchTo);
    holdViewer.current = true;
    onReviewChange(result.review);
    const target = report.classes.find((entry) => entry.id === batchTo)?.label ?? batchTo;
    setBatchNote([
      `${integers.format(result.moved.length)} moved to ${target}`,
      result.already.length ? `${integers.format(result.already.length)} already there` : "",
      result.unknown.length ? `${integers.format(result.unknown.length)} not in this report and left alone (${result.unknown.slice(0, 5).join(", ")}${result.unknown.length > 5 ? ", …" : ""})` : ""
    ].filter(Boolean).join("; ") + ".");
    setBatchDraft("");
  };
  const decided = ordered.filter((segment) => verdicts[segment.id]).length;
  const label = (id: string | null) => report.classes.find((entry) => entry.id === id)?.label ?? id;
  function download() {
    const body = JSON.stringify({
      dataset: report.dataset, class: active?.id, ordering,
      verdicts: ordered.filter((segment) => verdicts[segment.id]).map((segment) => ({ id: segment.id, ...verdicts[segment.id] }))
    }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.dataset}_${active?.id}_verdicts.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return <fieldset className="review-controls" disabled={readOnly}><div className="proofread" ref={stepper}
    onKeyDown={(event) => {
      if (event.target !== stepper.current) return;
      if (event.key === "ArrowRight") { event.preventDefault(); grouped ? setPage(Math.min(pages - 1, pageIndex + 1)) : step(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); grouped ? setPage(Math.max(0, pageIndex - 1)) : step(-1); }
      // Keys act on the same segment or page as the visible controls.
      const verdict = VERDICTS.find((entry) => entry.key === event.key.toLowerCase());
      if (verdict && (!isRejected || verdict.id === "reject")) { event.preventDefault(); judge(verdict.id); }
    }} tabIndex={0}>

    <label className="panel-field">Class
      <select value={active?.id ?? ""} onChange={(event) => onClassChange(event.target.value)}>
        {reviewable.map((entry) => <option key={entry.id} value={entry.id}>{entry.label} ({integers.format(entry.segments.length)})</option>)}
      </select>
    </label>

    <label className="panel-field">Order by
      <select value={ordering} onChange={(event) => setOrdering(event.target.value as Ordering)}>
        {ORDERINGS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </label>
    <p className="panel-note">
      {ORDERINGS.find((entry) => entry.id === ordering)?.hint}
      {ordering === "margin" && active?.margin_label ? ` Boundary: ${active.margin_label}.` : ""}
      {ordering === "margin" && !active?.margin_label ? " This class declares no boundary, so the order falls back to the report's." : ""}
    </p>

    <label className="panel-field">Show at a time
      <input className="count-input" type="number" inputMode="numeric" min={1} max={MAX_GROUP_SIZE} value={size}
        onInput={(event) => { const value = clampGroupSize((event.target as HTMLInputElement).value); if (value !== null) setSize(value); }} />
    </label>

    {grouped ? (groupSegments.length ? <div className="review-card">
      <div className="review-top">
        <span className="count">{integers.format(pageStart + 1)}–{integers.format(pageStart + groupSegments.length)} of {integers.format(ordered.length)}</span>
        <span className="badge">Page {pageIndex + 1} of {integers.format(pages)}</span>
      </div>
      <h4>{integers.format(groupSegments.length)} segments loaded</h4>
      <dl>
        <div><dt>Voxels</dt><dd>{integers.format(groupSegments.reduce((sum, segment) => sum + (segment.voxels ?? 0), 0))}</dd></div>
        <div><dt>Judged here</dt><dd>{integers.format(groupSegments.filter((segment) => verdicts[segment.id]).length)} of {integers.format(groupSegments.length)}</dd></div>
      </dl>
      <p className="panel-note">The viewer loads the whole page at once and keeps the glance&apos;s own position, since a page has no single centre.</p>
    </div> : <p className="panel-note">This class has no segments left to show.</p>)
    : current && <div className="review-card">
      <div className="review-top">
        <span className="count">{position + 1} of {integers.format(ordered.length)}</span>
        {verdicts[current.id] && <span className="badge edit-badge">{verdicts[current.id].verdict === "keep" ? `Kept as ${label(verdicts[current.id].class)}${verdicts[current.id].class && verdicts[current.id].class !== origin ? ` — the pipeline now says ${label(origin)}` : ""}` : verdicts[current.id].verdict === "reject" ? "Rejected" : verdicts[current.id].class === null ? "Restored from Rejected" : `Moved from ${label(verdicts[current.id].class)}`}{verdicts[current.id].at !== null ? ` · ${new Date(verdicts[current.id].at!).toLocaleString()}` : ""}</span>}

      </div>
      <h4>Segment {current.id}</h4>
      <dl>
        <div><dt>Voxels</dt><dd>{current.voxels === null ? "—" : integers.format(current.voxels)}</dd></div>
        <div><dt>Volume</dt><dd>{measurement(current.volume_um3, "µm³")}</dd></div>
        <div><dt>Radius</dt><dd>{measurement(current.radius_um, "µm")}</dd></div>
        <div><dt>Length</dt><dd>{measurement(current.length_um, "µm")}</dd></div>
        <div><dt>Margin</dt><dd>{measurement(current.margin, "", 4)}</dd></div>
      </dl>
      <p className="panel-note">{current.centroid_um ? "The viewer is centred on this segment, with only it loaded." : "This segment has no centroid in the report, so the viewer shows it without recentring."}</p>
    </div>}

    {grouped ? <>
      <div className="review-controls">
        <button className="secondary" type="button" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>← Previous page</button>
        <button className="secondary" type="button" disabled={pageIndex >= pages - 1} onClick={() => setPage(pageIndex + 1)}>Next page →</button>
      </div>
    </> : <div className="review-controls">
      <button className="secondary" type="button" disabled={position === 0} onClick={() => step(-1)}>← Previous</button>
      <button className="secondary" type="button" disabled={position >= ordered.length - 1} onClick={() => step(1)}>Next →</button>
    </div>}
    <div className="review-controls verdict-row">
      {!isRejected && <button type="button" className="secondary" title={`Keep as ${active?.label}, even if a later report changes it`} onClick={() => judge("keep")}>Keep <kbd>K</kbd></button>}
      <button type="button" className="secondary" onClick={() => judge("reject")}>Reject <kbd>R</kbd></button>
      {!isRejected && <button type="button" className="secondary" onClick={() => judge("reassign")}>Reassign <kbd>A</kbd></button>}
      {actionIds().some((id) => verdicts[id]) && <button type="button" className="text-button" onClick={() => onReviewChange(usePipeline(review, actionIds()))}>Use the pipeline&apos;s class</button>}
    </div>
    {!isRejected && <label className="panel-field">{grouped ? `Reassign all ${groupSegments.length} to` : "Reassign to"}
      <select ref={targetSelect} value="" onChange={(event) => retarget(event.target.value)}>
        <option value="">Choose a class</option>
        {report.classes.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{actionIds().every((id) => filed.get(id) === entry.id) ? " (pipeline)" : ""}</option>)}
      </select>
    </label>}
    <p className="panel-note">
      Focus this panel and use ← → to {grouped ? "change page; K keeps, R rejects, and A focuses the class selector for the page" : "step, K to keep, R to reject, A to choose a class"}. {integers.format(decided)} of {integers.format(ordered.length)} judged in this class.
      {saveError ? ` Not saved: ${saveError}` : " Saved to the glance as you go."}
    </p>

    <h3 className="panel-subheading">Change the class of many</h3>
    <label className="panel-field">Segment ids, or a Neuroglancer link or state
      <textarea className="id-input" rows={3} value={batchDraft} placeholder="13460 17942 22072"
        onInput={(event) => { setBatchDraft((event.target as HTMLTextAreaElement).value); setBatchNote(""); }} />
    </label>
    <label className="panel-field">Move to
      <select value={batchTo} onChange={(event) => setBatchTo(event.target.value)}>
        <option value="">Choose a class</option>
        {report.classes.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </label>
    <div className="review-controls">
      <button className="secondary" type="button" disabled={readOnly || !batchIds.length || !batchTo} onClick={moveBatch}>
        Move {integers.format(batchIds.length)} {batchIds.length === 1 ? "segment" : "segments"}
      </button>
    </div>
    <p className="panel-note">{batchNote || "Ids separated by spaces, commas, or newlines; from a viewer link or its {} state, the segments with their mesh switched on. Each becomes a reassignment, the same as choosing it one at a time, and the Quality control tab sees the move."}</p>

    <button className="text-button" type="button" disabled={!decided} onClick={download}>Download verdicts</button>
  </div></fieldset>;
}
