/** Human decisions overlay the pipeline; neither input is ever rewritten.
 * Counts follow measured segments, while unknown measurements remain explicit. */
import type { ErrorReport, ReportClass, ReportSegment } from "./report";
import type { ClassVerdict, GlanceReview } from "./review";

export type EditStatus = "applied" | "agrees" | "pending" | "no_segment" | "no_class";
export interface MergeOutcome {
  report: ErrorReport; status: Record<string, EditStatus>;
  pipelineClass: Map<string, string>; effective: Map<string, string | null>;
  rejected: { id: string; from: string; segment: ReportSegment }[]; uncounted: string[];
}
export interface EditSummary {
  applied: number; agrees: number; pending: number; no_segment: number; no_class: number;
  rejected: number; uncounted: number; inactive: string[];
}
function withRecords(entry: ReportClass): ReportClass {
  if (entry.segments.length || !entry.segment_ids.length) return entry;
  return { ...entry, segments: entry.segment_ids.map((id) => ({ id, voxels: null, volume_um3: null, centroid_um: null, radius_um: null, length_um: null, margin: null, quality: null })) };
}

function count(entry: ReportClass, segment: ReportSegment, sign: 1 | -1): ReportClass {
  return {
    ...entry,
    voxels: segment.voxels === null ? entry.voxels : Math.max(0, entry.voxels + sign * segment.voxels),
    volume_um3: entry.volume_um3 === null || segment.volume_um3 === null ? entry.volume_um3 : Math.max(0, entry.volume_um3 + sign * segment.volume_um3),
    labels: entry.labels === null ? null : Math.max(0, entry.labels + sign)
  };
}


export function mergeEdits(report: ErrorReport, edits: Record<string, ClassVerdict>): MergeOutcome {
  const classes = new Map(report.classes.map((entry) => [entry.id, entry]));
  const pipelineClass = new Map<string, string>();
  const records = new Map<string, ReportSegment>();
  for (const entry of report.classes) for (const segment of withRecords(entry).segments) {
    pipelineClass.set(segment.id, entry.id); records.set(segment.id, segment);
  }
  const effective = new Map<string, string | null>(pipelineClass);
  const status: Record<string, EditStatus> = {};
  const rejected: MergeOutcome["rejected"] = [], uncounted: string[] = [];
  const touched = new Set<string>();
  let lost = 0;
  for (const id of Object.keys(edits).sort()) {
    const edit = edits[id], origin = pipelineClass.get(id);
    if (!origin) { status[id] = "no_segment"; continue; }
    if (edit.verdict === "reassign" && !edit.to) { status[id] = "pending"; continue; }
    const target = edit.verdict === "reject" ? null : edit.verdict === "keep" ? edit.class ?? origin : edit.to;
    if (target !== null && !classes.has(target)) { status[id] = "no_class"; continue; }
    if (target === origin) { status[id] = "agrees"; continue; }
    status[id] = "applied"; effective.set(id, target);
    const segment = records.get(id)!;
    if (segment.voxels === null) uncounted.push(id);
    const from = withRecords(classes.get(origin)!);
    const remaining = from.segments.filter((s) => s.id !== id);
    classes.set(origin, count({ ...from, segments: remaining, segment_ids: remaining.map((s) => s.id) }, segment, -1));
    touched.add(origin);
    if (target !== null) {
      const to = withRecords(classes.get(target)!);
      classes.set(target, count({ ...to, segments: [...to.segments, segment] }, segment, 1));
      touched.add(target);
    } else { lost += segment.voxels ?? 0; rejected.push({ id, from: origin, segment }); }
  }
  return { report: { ...report, total_voxels: Math.max(0, report.total_voxels - lost), classes: report.classes.map((entry) => {
    if (!touched.has(entry.id)) return entry;
    const changed = classes.get(entry.id)!;
    const segments = [...changed.segments].sort((a, b) => a.id.localeCompare(b.id));
    return { ...changed, segments, segment_ids: segments.map((s) => s.id) };
  }) }, status, pipelineClass, effective, rejected, uncounted };
}
export function summarizeEdits(outcome: MergeOutcome): EditSummary {
  const result: EditSummary = { applied: 0, agrees: 0, pending: 0, no_segment: 0, no_class: 0,
    rejected: outcome.rejected.length, uncounted: outcome.uncounted.length, inactive: [] };
  for (const [id, status] of Object.entries(outcome.status)) {
    result[status]++;
    if (status !== "applied" && status !== "agrees") result.inactive.push(id);
  }
  result.inactive.sort(); return result;
}
export function usePipeline(review: GlanceReview, ids: string[]): GlanceReview {
  const class_review = { ...review.class_review };
  for (const id of ids) delete class_review[id];
  return { ...review, class_review };
}
export function setClass(review: GlanceReview, merged: MergeOutcome, ids: string[], target: string) {
  const next = { ...review, class_review: { ...review.class_review } };
  const moved: string[] = [], already: string[] = [], unknown: string[] = [];
  for (const id of new Set(ids)) {
    const origin = merged.pipelineClass.get(id);
    if (!origin) { unknown.push(id); continue; }
    if (target === origin && next.class_review[id]) delete next.class_review[id];
    else if (merged.effective.get(id) === target) { already.push(id); continue; }
    else if (target !== origin) next.class_review[id] = { verdict: "reassign", class: merged.effective.get(id) ?? null, to: target, at: Date.now() };
    moved.push(id);
  }
  return { review: next, moved, already, unknown };
}
export function keepClass(review: GlanceReview, merged: MergeOutcome, ids: string[]) {
  const next = { ...review, class_review: { ...review.class_review } };
  const unknown: string[] = [], rejected: string[] = [];
  for (const id of new Set(ids)) {
    if (!merged.pipelineClass.has(id)) { unknown.push(id); continue; }
    const effective = merged.effective.get(id)!;
    if (effective === null) { rejected.push(id); continue; }
    next.class_review[id] = { verdict: "keep", class: effective, to: null, at: Date.now() };
  }
  return { review: next, unknown, rejected };
}
export function reject(review: GlanceReview, merged: MergeOutcome, ids: string[]) {
  const next = { ...review, class_review: { ...review.class_review } };
  const unknown: string[] = [];
  for (const id of new Set(ids)) {
    const origin = merged.pipelineClass.get(id);
    if (!origin) { unknown.push(id); continue; }
    next.class_review[id] = { verdict: "reject", class: merged.effective.get(id) ?? origin, to: null, at: Date.now() };
  }
  return { review: next, unknown };
}
export interface Derivation { edits: Record<string, ClassVerdict>; cannotExpress: string[]; }
export function deriveEdits(current: ErrorReport, pipeline: ErrorReport, now: number): Derivation {
  const before = mergeEdits(current, {}).pipelineClass, base = mergeEdits(pipeline, {}).pipelineClass;
  const edits: Record<string, ClassVerdict> = {}, cannotExpress: string[] = [];
  for (const id of [...new Set([...before.keys(), ...base.keys()])].sort()) {
    const cur = before.get(id), pipe = base.get(id);
    if (!pipe) cannotExpress.push(id);
    else if (!cur) edits[id] = { verdict: "reject", class: pipe, to: null, at: now };
    else if (cur !== pipe) edits[id] = { verdict: "reassign", class: pipe, to: cur, at: now };
  }
  return { edits, cannotExpress };
}
export interface ViewDifference { class: string; missing: string[]; extra: string[]; voxels: [number, number];
  volume_um3: [number | null, number | null]; labels: [number | null, number | null]; }
export function compareViews(before: ErrorReport, after: ErrorReport): { classes: ViewDifference[]; total_voxels: [number, number] } {
  const classes: ViewDifference[] = [];
  for (const id of [...new Set([...before.classes, ...after.classes].map((c) => c.id))].sort()) {
    const a = before.classes.find((c) => c.id === id), b = after.classes.find((c) => c.id === id);
    const ids = (c: ReportClass | undefined) => new Set(c ? [...c.segment_ids, ...c.segments.map((s) => s.id)] : []);
    const left = ids(a), right = ids(b);
    const diff: ViewDifference = { class: id, missing: [...left].filter((s) => !right.has(s)).sort(), extra: [...right].filter((s) => !left.has(s)).sort(),
      voxels: [a?.voxels ?? 0, b?.voxels ?? 0], volume_um3: [a?.volume_um3 ?? null, b?.volume_um3 ?? null], labels: [a?.labels ?? null, b?.labels ?? null] };
    if (diff.missing.length || diff.extra.length || diff.voxels[0] !== diff.voxels[1] || diff.volume_um3[0] !== diff.volume_um3[1] || diff.labels[0] !== diff.labels[1]) classes.push(diff);
  }
  return { classes, total_voxels: [before.total_voxels, after.total_voxels] };
}
