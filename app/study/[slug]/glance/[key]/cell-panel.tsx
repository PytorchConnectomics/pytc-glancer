"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Histogram, Legend, OTHER_COLOR, Pie, buildSlices, decimals, histogram, integers, percents, shareAndCount } from "./chart";
import { orderSegments, type Ordering } from "./proofread-panel";
import type { CellCategoryId, CellVerdictId, GlanceReview } from "../../../../../lib/review";
import { REVIEW_ORDER, inOrder } from "../../../../../lib/structures";
import type { ErrorReport, ReportSegment, Selection } from "./report-panel";
import { usePipeline, type MergeOutcome } from "../../../../../lib/edits";
import { reassignIds } from "./corrections";
import { parseIds, viewerSegments } from "./ids";
import { MAX_GROUP_SIZE, clampGroupSize } from "./paging";

export { DEFAULT_GROUP_SIZE, MAX_GROUP_SIZE, clampGroupSize } from "./paging";
export { parseIds, viewerSegments } from "./ids";

/* The structures quality control is done over: the app's own vocabulary,
 * declared in lib/structures.ts, and the same five semantic classes the report
 * files every segment under. A category's members are therefore its report
 * class, read with human edits applied, so a segment moved in either tab
 * is already where it was sent in both. The label is the review one: a reader
 * judging an object asserts what it is. Only the hint is local, because it is
 * about reviewing rather than about the structure. */
const LOCAL: Record<CellCategoryId, { hint: string }> = {
  axon: { hint: "Thin unbranched processes." },
  dendrite: { hint: "Thick elongated processes, spines where visible." },
  blood_vessel: { hint: "Vessels and their walls." },
  glia: { hint: "Astrocytes, oligodendrocytes, microglia — bushy processes without a clear trunk." },
  unclassified: { hint: "Segments the pipeline did not place in any class." }
};
export const CATEGORIES: Array<{ id: CellCategoryId; label: string; hint: string }> =
  inOrder(REVIEW_ORDER).map((entry) => ({ id: entry.id as CellCategoryId, label: entry.review, ...LOCAL[entry.id as CellCategoryId] }));
/* Three sub-tabs, in the order the work is done. Length is only a meaningful
 * screen for the two process types: a vessel or glial cell has no skeleton
 * length that says whether it is whole. */
export const GROUPS: Array<{ id: string; label: string; categories: CellCategoryId[]; lengths: boolean }> = [
  { id: "axon", label: "Axon", categories: ["axon"], lengths: true },
  { id: "dendrite", label: "Dendrite", categories: ["dendrite"], lengths: true },
  { id: "other", label: "BV · Glia · Unclassified", categories: ["blood_vessel", "glia", "unclassified"], lengths: false }
];
export const VERDICTS: Array<{ id: CellVerdictId; label: string; key: string; hint: string }> = [
  { id: "complete", label: "Complete", key: "c", hint: "One object, whole." },
  { id: "false_split", label: "False split", key: "s", hint: "A fragment: this object carries on past where it stops, under other ids." },
  { id: "false_merge", label: "False merge", key: "m", hint: "Two or more objects joined under one id." },
  { id: "unknown", label: "Unknown", key: "u", hint: "Cannot tell from this view." }
];
const ORDERINGS: Array<{ id: Ordering; label: string }> = [
  { id: "size", label: "Largest first" },
  { id: "length", label: "Longest first" },
  { id: "margin", label: "Closest to the cutoff" },
  { id: "report", label: "Report order" }
];

const BARE: Omit<ReportSegment, "id"> = { voxels: null, volume_um3: null, centroid_um: null, radius_um: null, length_um: null, margin: null, quality: null };

/** What the pipeline's own class says about a segment's quality.
 *
 * The fallback for a report whose records carry no `quality` of their own,
 * which only morphology-class reports do. The axon screen splits candidates
 * into good, broken, and suspicious, which is a completeness call; any other
 * class name says nothing about it.
 * A broken candidate is a false split specifically -- the object stops inside
 * the volume and continues under another id. Nothing upstream screens for
 * merges, so `false_merge` is only ever a reader's call, never a starting
 * value; a good_axon_candidate has not been checked for merges either. */
export function pipelineQuality(classId: string | null, label = ""): CellVerdictId {
  const name = `${classId ?? ""} ${label}`;
  if (/good|complete|intact/i.test(name) && !/incomplete/i.test(name)) return "complete";
  if (/broken|incomplete|truncat|split/i.test(name)) return "false_split";
  return "unknown";
}

/** An explicit call in the effective category wins; otherwise the latest
 * call follows the object across pipeline drift and human moves. */
export function qualityOf(review: GlanceReview, id: string, category: CellCategoryId) {
  if (review.cell_review[category]?.[id]) return { ...review.cell_review[category][id], storedUnder: category };
  const candidates = CATEGORIES.flatMap(({ id: storedUnder }) => review.cell_review[storedUnder][id] ? [{ ...review.cell_review[storedUnder][id], storedUnder }] : []);
  return candidates.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? null;
}
export function clearQualityIds(review: GlanceReview, ids: string[]): GlanceReview {
  const cell_review = { ...review.cell_review };
  for (const { id: category } of CATEGORIES) {
    cell_review[category] = { ...cell_review[category] };
    for (const id of ids) delete cell_review[category][id];
  }
  return { ...review, cell_review };
}

export interface QualityBatch { review: GlanceReview; set: string[]; unknown: string[]; }

/** Set one quality on a list of segments, each under the class it now sits in.
 *
 * Quality calls are kept per structure, so each id is filed under its current
 * semantic class -- after any move, which is what `report` shows. An
 * id the report does not describe is set under `category` only if the reader
 * added it there by hand; otherwise there is no structure to file it under. */
export function setQualityIds(review: GlanceReview, report: ErrorReport | null, ids: string[], verdict: CellVerdictId, category: CellCategoryId): QualityBatch {
  const filedUnder = new Map(report?.classes.flatMap((entry) => entry.segment_ids.map((id) => [id, entry.id] as const)) ?? []);
  const cellReview = { ...review.cell_review };
  const set: string[] = [];
  const unknown: string[] = [];
  const at = Date.now();
  for (const id of new Set(ids)) {
    const home = filedUnder.get(id) ?? (review.cell_members[category].ids.includes(id) ? category : null);
    if (!home || !(home in cellReview)) { unknown.push(id); continue; }
    const key = home as CellCategoryId;
    if (cellReview[key] === review.cell_review[key]) cellReview[key] = { ...review.cell_review[key] };
    for (const { id: other } of CATEGORIES) {
      if (cellReview[other] === review.cell_review[other]) cellReview[other] = { ...review.cell_review[other] };
      delete cellReview[other][id];
    }
    cellReview[key][id] = { verdict, at };
    set.push(id);
  }
  return { review: { ...review, cell_review: cellReview }, set, unknown };
}

/** The segments a category holds: its own report class, then ids added by hand.
 *
 * A manually added id is looked up across the whole report first, so an id
 * typed from the viewer still arrives with its centroid and measurements when
 * the report happens to describe it. */
export function categorySegments(report: ErrorReport | null, category: string, ids: string[], effective?: Map<string, string | null>): ReportSegment[] {
  const known = new Map<string, ReportSegment>();
  for (const entry of report?.classes ?? []) {
    for (const segment of entry.segments) if (!known.has(segment.id)) known.set(segment.id, segment);
    for (const id of entry.segment_ids) if (!known.has(id)) known.set(id, { id, ...BARE });
  }
  const seen = new Set<string>();
  const segments: ReportSegment[] = [];
  const push = (id: string) => { if (effective?.get(id) === null) return; if (!seen.has(id)) { seen.add(id); segments.push(known.get(id) ?? { id, ...BARE }); } };
  const own = (report?.classes ?? []).find((candidate) => candidate.id === category);
  for (const id of own?.segment_ids ?? []) push(id);
  for (const id of ids) push(id);
  return segments;
}

function measurement(value: number | null, unit: string, digits = 3) { return value === null ? "—" : `${decimals(value, digits)} ${unit}`; }

/* `report` is what the reader sees, with human edits already
 * applied; `source` is the report as loaded, whose class a reassignment is
 * recorded against, exactly as the semantic panel records it. */
export default function CellPanel({ report, source, merged, review, onReviewChange: changeReview, readOnly = false, onSelect, saveError }: {
  merged?: MergeOutcome | null; readOnly?: boolean; report: ErrorReport | null; source?: ErrorReport | null; review: GlanceReview; onReviewChange: (next: GlanceReview) => void;
  onSelect: (selection: Selection | null) => void; saveError: string;
}) {
  const onReviewChange = (next: GlanceReview) => { if (!readOnly) changeReview(next); };
  const [groupId, setGroupId] = useState(GROUPS[0].id);
  const group = GROUPS.find((entry) => entry.id === groupId) ?? GROUPS[0];
  const [picked, setPicked] = useState<Record<string, CellCategoryId>>({});
  const category = picked[group.id] ?? group.categories[0];
  // Big to small is the order proofreading goes in: the largest mistakes first.
  const [ordering, setOrdering] = useState<Ordering>("size");
  const [bin, setBin] = useState<string | null>(null);
  const [only, setOnly] = useState<CellVerdictId | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  /* How many segments the viewer shows at once, the same dial as the semantic
   * panel's. One centres each segment in turn; more loads a group of them
   * together, and a call then applies to the whole group. The filters above
   * feed both. */
  const [size, setSize] = useState(1);
  const batch = size > 1;
  const [page, setPage] = useState(0);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  /* A pasted list, as in the semantic panel: bare ids, or a Neuroglancer link
   * or state. Its two actions are independent -- move the list to a semantic
   * class, or set its quality -- and neither reloads the viewer. */
  const [pasteDraft, setPasteDraft] = useState("");
  const [pasteClass, setPasteClass] = useState("");
  const [pasteQuality, setPasteQuality] = useState("");
  const [pasteNote, setPasteNote] = useState("");
  const holdViewer = useRef(false);
  const stepper = useRef<HTMLDivElement>(null);

  const stored = review.cell_members[category];
  const members = useMemo(() => categorySegments(report, category, stored.ids, merged?.effective), [report, category, stored.ids, merged]);
  const verdicts = useMemo(() => Object.fromEntries(members.flatMap((s) => { const call = qualityOf(review, s.id, (merged?.effective.get(s.id) as CellCategoryId) ?? category); return call ? [[s.id, call]] : []; })), [review, members, merged, category]);
  const filed = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>();
    for (const entry of report?.classes ?? []) for (const id of entry.segment_ids) if (!map.has(id)) map.set(id, entry);
    return map;
  }, [report]);
  // The class the loaded report files a segment under, before any move.
  const origins = useMemo(() => new Map((source ?? report)?.classes.flatMap((entry) => entry.segment_ids.map((id) => [id, entry.id] as const)) ?? []), [source, report]);
  const records = useMemo(() => new Map(report?.classes.flatMap((entry) => entry.segments.map((segment) => [segment.id, segment] as const)) ?? []), [report]);
  const prior = (id: string) => {
    const recorded = records.get(id)?.quality;
    if (recorded) return recorded;
    const entry = filed.get(id);
    return pipelineQuality(entry?.id ?? null, entry?.label);
  };
  const quality = (id: string) => verdicts[id]?.verdict ?? prior(id);

  /* The histogram and the pie both narrow what the stepper walks: a length bin
   * picks the range, a quality slice picks which calls to look at again. The
   * pie counts only the chosen bin, so the two read together. */
  const bins = useMemo(() => group.lengths ? histogram(members, (segment) => segment.length_um) : [], [members, group.lengths]);
  const activeBin = bins.find((entry) => entry.id === bin) ?? null;
  const inBin = activeBin ? activeBin.members : members;
  /* Sized by volume, like the semantic pie, so the two charts mean the same
   * thing by a slice. Counting segments instead would make a thousand crumbs
   * outweigh the one merged object that actually costs the reconstruction. A
   * glance whose report carries no voxel counts falls back to counting, since
   * a pie of zeros shows nothing at all. */
  const measured = inBin.some((segment) => segment.voxels);
  const slices = buildSlices(VERDICTS.map((entry) => {
    const holding = inBin.filter((segment) => quality(segment.id) === entry.id);
    const voxels = holding.reduce((sum, segment) => sum + (segment.voxels ?? 0), 0);
    return { id: entry.id, label: entry.label, value: measured ? voxels : holding.length, members: holding };
  })).map((slice) => slice.id === "unknown" ? { ...slice, color: OTHER_COLOR } : slice);
  const ordered = useMemo(() => orderSegments(only ? inBin.filter((segment) => quality(segment.id) === only) : inBin, ordering),
    [inBin, only, ordering, verdicts, filed]);
  const position = Math.min(index, Math.max(ordered.length - 1, 0));
  const current = ordered[position] ?? null;

  const pages = Math.max(1, Math.ceil(ordered.length / size));
  const pageIndex = Math.min(page, pages - 1);
  const pageStart = pageIndex * size;
  const groupSegments = useMemo(() => batch ? ordered.slice(pageStart, pageStart + size) : [], [batch, ordered, pageStart, size]);

  useEffect(() => { setIndex(0); setPage(0); }, [category, ordering, bin, only, size]);
  useEffect(() => { setBin(null); setOnly(null); }, [category]);

  /* What the viewer is asked to show. One at a time is centred where the report
   * knows where the segment is; a group is not, because its members are
   * scattered and their mean is nowhere in particular, so the frame keeps the
   * glance's own position and the reader pans. The key changes whenever the
   * page's contents do -- including when a verdict takes a segment out from
   * under a quality filter -- so the frame reloads exactly then. */
  const selection = useMemo(() => {
    if (batch) return groupSegments.length ? { id: `quality:${category}:group:${pageStart}:${groupSegments.map((segment) => segment.id).join(",")}`, segments: groupSegments.map((segment) => segment.id), centroid_um: null } : null;
    return current ? { id: `quality:${category}:${current.id}`, segments: [current.id], centroid_um: current.centroid_um } : null;
  }, [batch, groupSegments, category, pageStart, current?.id]);
  useEffect(() => {
    // A pasted list's action only records calls; the viewer follows again on the next step.
    if (holdViewer.current) { holdViewer.current = false; return; }
    onSelect(selection);
  }, [selection?.id]);

  const setMembers = (ids: string[]) =>
    onReviewChange({ ...review, cell_members: { ...review.cell_members, [category]: { classes: [], ids } } });
  const addIds = () => {
    const added = parseIds(draft).filter((id) => !stored.ids.includes(id));
    if (added.length) setMembers([...stored.ids, ...added]);
    setDraft("");
  };
  /* Assigning a semantic class is the semantic panel's reassign verdict, so
   * both tabs write one overlay record against the pipeline. The
   * segment leaves this category straight away and the next takes its place.
   * A quality call already made travels with it, since it is a judgement
   * about the object rather than about the class it was filed under. Only
   * segments the report files somewhere can move; an id added by hand has no
   * class for a correction to take it out of. */
  const reassign = (segments: ReportSegment[], to: CellCategoryId) => {
    const loaded = source ?? report;
    if (!loaded) return;
    onReviewChange(reassignIds(review, loaded, movable(segments).map((segment) => segment.id), to).review);
    stepper.current?.focus();
  };
  const movable = (segments: ReportSegment[]) => segments.filter((segment) => origins.has(segment.id));
  const step = (delta: number) => setIndex(Math.max(0, Math.min(ordered.length - 1, position + delta)));
  const judge = (verdict: CellVerdictId) => {
    if (!current) return;
    const clearing = verdicts[current.id]?.verdict === verdict;
    const next = clearing ? clearQualityIds(review, [current.id]) : setQualityIds(review, report, [current.id], verdict, category).review;
    onReviewChange(next);
    if (!clearing && (!only || verdict === only) && position < ordered.length - 1) step(1);
  };

  const pasted = viewerSegments(pasteDraft) ?? [];
  const summarize = (done: string, counts: Array<[number, string]>, skipped: string[]) => [
    done, ...counts.filter(([count]) => count).map(([count, text]) => `${integers.format(count)} ${text}`),
    skipped.length ? `${integers.format(skipped.length)} not in this report and left alone (${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""})` : ""
  ].filter(Boolean).join("; ") + ".";
  const movePasted = () => {
    const loaded = source ?? report;
    if (!loaded || !pasted.length || !pasteClass) return;
    const result = reassignIds(review, loaded, pasted, pasteClass);
    holdViewer.current = true;
    onReviewChange(result.review);
    setPasteNote(summarize(`${integers.format(result.moved.length)} moved to ${CATEGORIES.find((entry) => entry.id === pasteClass)?.label}`,
      [[result.already.length, "already there"]], result.unknown));
  };
  const qualityPasted = () => {
    if (!pasted.length || !pasteQuality) return;
    const result = setQualityIds(review, report, pasted, pasteQuality as CellVerdictId, category);
    holdViewer.current = true;
    onReviewChange(result.review);
    setPasteNote(summarize(`${integers.format(result.set.length)} set to ${VERDICTS.find((entry) => entry.id === pasteQuality)?.label.toLowerCase()}`, [], result.unknown));
  };
  /* Setting the group now loaded in the viewer at once: they were chosen
   * together and are being judged together. Pressing a call every one of them
   * already holds returns them all to the pipeline's. */
  const judgeAll = (verdict: CellVerdictId, segments: ReportSegment[]) => {
    if (!segments.length) return;
    const ids = segments.map((s) => s.id);
    const clearing = segments.every((s) => verdicts[s.id]?.verdict === verdict);
    onReviewChange(clearing ? clearQualityIds(review, ids) : setQualityIds(review, report, ids, verdict, category).review);
  };

  const judged = members.filter((segment) => verdicts[segment.id]).length;
  const describe = (id: CellVerdictId) => VERDICTS.find((entry) => entry.id === id)?.label ?? id;
  const shown = slices.find((slice) => slice.id === hovered) ?? slices.find((slice) => slice.id === only) ?? null;

  return <fieldset className="review-controls" disabled={readOnly}><div className="proofread cell-review" ref={stepper} tabIndex={0}
    onKeyDown={(event) => {
      if (event.target !== stepper.current) return;
      if (event.key === "ArrowRight") { event.preventDefault(); batch ? setPage(Math.min(pages - 1, pageIndex + 1)) : step(1); }
      if (event.key === "ArrowLeft") { event.preventDefault(); batch ? setPage(Math.max(0, pageIndex - 1)) : step(-1); }
      const verdict = VERDICTS.find((entry) => entry.key === event.key.toLowerCase());
      // In group mode a key judges the whole loaded group, which is what the
      // buttons beneath it say it does; pressing it again returns them all.
      if (verdict) { event.preventDefault(); batch ? judgeAll(verdict.id, groupSegments) : judge(verdict.id); }
    }}>

    <div className="grouping-toggle quality-tabs" role="tablist" aria-label="Structure">
      {GROUPS.map((entry) => <label key={entry.id} className={group.id === entry.id ? "active" : ""}>
        <input type="radio" name="quality-group" value={entry.id} checked={group.id === entry.id} onChange={() => setGroupId(entry.id)} />
        <span>{entry.label}</span>
      </label>)}
    </div>

    {group.categories.length > 1 && <div className="category-grid three" role="radiogroup" aria-label="Category">
      {group.categories.map((id) => <label key={id} className={category === id ? "active" : ""}>
        <input type="radio" name="quality-category" value={id} checked={category === id} onChange={() => setPicked({ ...picked, [group.id]: id })} />
        <span>{CATEGORIES.find((entry) => entry.id === id)?.label}</span>
        <span className="category-count">{integers.format(categorySegments(report, id, review.cell_members[id].ids).length)}</span>
      </label>)}
    </div>}
    <p className="panel-note">{CATEGORIES.find((entry) => entry.id === category)?.hint} Quality starts from the pipeline&apos;s end check — complete when every skeleton end is at the volume border, a surface spur, or an axon terminal; a false split when an end lies inside the volume. Older reports fall back to the axon screen. Nothing upstream looks for merges, so a false merge is always your call. Move a segment to another semantic class below; the Semantic classes tab sees the same move.</p>

    <button className="text-button table-toggle" type="button" aria-expanded={picking} onClick={() => setPicking(!picking)}>
      {picking ? "Hide" : "Add"} ids by hand — {integers.format(members.length)} segments{stored.ids.length ? `, ${integers.format(stored.ids.length)} added` : ""}
    </button>
    {picking && <div className="member-picker">
      <h3 className="panel-subheading">Add ids by hand</h3>
      <label className="panel-field">Segment ids
        {/* onInput rather than onChange: the value changes on every keystroke
          * here, which is what this event names, and it does not depend on
          * React's change tracker seeing the field's previous value. */}
        <textarea className="id-input" rows={2} value={draft} placeholder="13460 17942"
          onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); addIds(); } }} />
      </label>
      <div className="review-controls">
        <button className="secondary" type="button" disabled={readOnly || !parseIds(draft).length} onClick={addIds}>Add ids{parseIds(draft).length ? ` (${parseIds(draft).length})` : ""}</button>
        <button className="secondary" type="button" disabled={readOnly || !stored.ids.length} onClick={() => setMembers([])}>Clear {integers.format(stored.ids.length)} added</button>
      </div>
      <p className="panel-note">Ids as the viewer shows them, separated by spaces, commas, or newlines. An id the report also describes keeps its measurements.</p>
    </div>}

    {group.lengths && <>
      <h3 className="panel-subheading">Skeleton length</h3>
      {bins.length ? <>
        <Histogram bins={bins} unit="µm" label={`${CATEGORIES.find((entry) => entry.id === category)?.label} segments by skeleton length`}
          selected={activeBin?.id ?? null} onSelect={setBin} />
        <p className="panel-note">{activeBin ? `Stepping through ${activeBin.label} µm only. Click the bar again to widen.` : "Click a bar to step through that length range only."}</p>
      </> : <p className="panel-note">No member has a measured length.</p>}
    </>}

    <h3 className="panel-subheading">Quality</h3>
    <figure className="pie-figure">
      <Pie slices={slices} selected={only} hovered={hovered} onHover={setHovered} onSelect={(id) => setOnly(id as CellVerdictId | null)}
        label={`Quality of ${CATEGORIES.find((entry) => entry.id === category)?.label} segments`}
        describe={(slice) => `${slice.label}, ${percents.format(slice.share)} of ${measured ? "volume" : "segments"}, ${integers.format(slice.members.length)} segments`} />
      <figcaption className="pie-readout" aria-live="polite">
        {shown
          ? <><strong>{percents.format(shown.share)}</strong><span>{shown.label} · {integers.format(shown.members.length)} segments</span></>
          : <><strong>{integers.format(inBin.length)}</strong><span>segments{activeBin ? ` of ${activeBin.label} µm` : ""}</span></>}
      </figcaption>
    </figure>
    <Legend slices={slices} selected={only} onHover={setHovered} onSelect={(id) => setOnly(id as CellVerdictId | null)}
      value={(slice) => shareAndCount(slice.share, slice.members.length)} />

    <label className="panel-field">Order by
      <select value={ordering} onChange={(event) => setOrdering(event.target.value as Ordering)}>
        {ORDERINGS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </label>

    <label className="panel-field">Show at a time
      <input className="count-input" type="number" inputMode="numeric" min={1} max={MAX_GROUP_SIZE} value={size}
        onInput={(event) => { const value = clampGroupSize((event.target as HTMLInputElement).value); if (value !== null) setSize(value); }} />
    </label>

    {batch ? (groupSegments.length ? <div className="review-card">
      <div className="review-top">
        <span className="count">{integers.format(pageStart + 1)}–{integers.format(pageStart + groupSegments.length)} of {integers.format(ordered.length)}</span>
        <span className="badge">Group {pageIndex + 1} of {integers.format(pages)}</span>
      </div>
      <h4>{integers.format(groupSegments.length)} segments loaded</h4>
      <dl>
        <div><dt>Set by you here</dt><dd>{integers.format(groupSegments.filter((segment) => verdicts[segment.id]).length)} of {integers.format(groupSegments.length)}</dd></div>
      </dl>
      <label className="panel-field">Move all {integers.format(movable(groupSegments).length)} to
        <select value="" disabled={readOnly || !movable(groupSegments).length} onChange={(event) => { if (event.target.value) reassign(groupSegments, event.target.value as CellCategoryId); }}>
          <option value="">Semantic class…</option>
          {CATEGORIES.filter((entry) => entry.id !== category).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
      <p className="panel-note">The viewer loads the whole group at once. A group has no single centre, so the frame keeps the glance&apos;s own position rather than jumping somewhere arbitrary.</p>
    </div> : <p className="panel-note">{members.length ? "No segment matches the length and quality chosen above." : report?.classes.some((entry) => entry.id === category) ? "The report files no segments under this class." : "This report has no class for this structure; re-ingest it with scripts/push_report.py, or add ids by hand."}</p>)
    : current ? <div className="review-card">
      <div className="review-top">
        <span className="count">{position + 1} of {integers.format(ordered.length)}</span>
        <span className="badge">{describe(quality(current.id))}{verdicts[current.id] ? "" : " · pipeline"}</span>
      </div>
      <h4>Segment {current.id}</h4>
      {review.class_review[current.id] && <><p className="panel-note">Edited{review.class_review[current.id].at !== null ? ` · ${new Date(review.class_review[current.id].at!).toLocaleString()}` : ""}</p><button type="button" className="text-button" onClick={() => onReviewChange(usePipeline(review, [current.id]))}>Use the pipeline&apos;s class</button></>}
      <dl>
        <div><dt>Filed as</dt><dd>{filed.get(current.id)?.label ?? "Added by hand"}{origins.get(current.id) && origins.get(current.id) !== filed.get(current.id)?.id ? ` · moved from ${(source ?? report)?.classes.find((entry) => entry.id === origins.get(current.id))?.label}` : ""}</dd></div>
        <div><dt>Pipeline</dt><dd>{describe(prior(current.id))}</dd></div>
        <div><dt>Voxels</dt><dd>{current.voxels === null ? "—" : integers.format(current.voxels)}</dd></div>
        <div><dt>Volume</dt><dd>{measurement(current.volume_um3, "µm³")}</dd></div>
        <div><dt>Radius</dt><dd>{measurement(current.radius_um, "µm")}</dd></div>
        <div><dt>Length</dt><dd>{measurement(current.length_um, "µm")}</dd></div>
      </dl>
      <label className="panel-field">Semantic class
        <select value="" disabled={readOnly || !origins.has(current.id)} onChange={(event) => { if (event.target.value) reassign([current], event.target.value as CellCategoryId); }}>
          <option value="">Choose a class</option>
          {CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{current && origins.get(current.id) === entry.id ? " (pipeline)" : ""}</option>)}
        </select>
      </label>
      <p className="panel-note">{current.centroid_um ? "The viewer is centred on this segment, with only it loaded." : "The report gives this segment no centroid, so the viewer shows it without recentring."}</p>
    </div> : <p className="panel-note">{members.length ? "No segment matches the length and quality chosen above." : report?.classes.some((entry) => entry.id === category) ? "The report files no segments under this class." : "This report has no class for this structure; re-ingest it with scripts/push_report.py, or add ids by hand."}</p>}

    {batch
      ? <div className="review-controls">
        <button className="secondary" type="button" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>← Previous group</button>
        <button className="secondary" type="button" disabled={pageIndex >= pages - 1} onClick={() => setPage(pageIndex + 1)}>Next group →</button>
      </div>
      : <div className="review-controls">
        <button className="secondary" type="button" disabled={position === 0} onClick={() => step(-1)}>← Previous</button>
        <button className="secondary" type="button" disabled={position >= ordered.length - 1} onClick={() => step(1)}>Next →</button>
      </div>}
    <div className="verdict-row">
      {batch
        ? VERDICTS.map((entry) => <button key={entry.id} type="button" title={`Set all ${groupSegments.length} to ${entry.label.toLowerCase()}`}
          className={`secondary ${groupSegments.length > 0 && groupSegments.every((segment) => verdicts[segment.id]?.verdict === entry.id) ? "active" : ""}`}
          aria-pressed={groupSegments.length > 0 && groupSegments.every((segment) => verdicts[segment.id]?.verdict === entry.id)} disabled={readOnly || !groupSegments.length}
          onClick={() => judgeAll(entry.id, groupSegments)}>All {integers.format(groupSegments.length)} {entry.label.toLowerCase()} <kbd>{entry.key.toUpperCase()}</kbd></button>)
        : VERDICTS.map((entry) => <button key={entry.id} type="button" title={entry.hint}
          className={`secondary ${current && verdicts[current.id]?.verdict === entry.id ? "active" : ""}`}
          aria-pressed={!!current && verdicts[current.id]?.verdict === entry.id} disabled={readOnly || !current}
          onClick={() => judge(entry.id)}>{entry.label} <kbd>{entry.key.toUpperCase()}</kbd></button>)}
    </div>
    <p className="panel-note">
      {/* Derived, not spelled out: the keys move when the vocabulary does. */}
      Focus this panel and use ← → to {batch ? "change group" : "step"}, {VERDICTS.map((entry) => entry.key.toUpperCase()).join(" / ")} to set the quality{batch ? " of the whole group" : ""}; pressing your own call again returns {batch ? "them" : "it"} to the pipeline&apos;s. {integers.format(judged)} of {integers.format(members.length)} set by you in this category.
      {saveError ? ` Not saved: ${saveError}` : " Saved to the glance as you go."}
    </p>

    <h3 className="panel-subheading">Change many</h3>
    <label className="panel-field">Segment ids, or a Neuroglancer link or state
      <textarea className="id-input" rows={3} value={pasteDraft} placeholder="13460 17942 22072"
        onInput={(event) => { setPasteDraft((event.target as HTMLTextAreaElement).value); setPasteNote(""); }} />
    </label>
    <label className="panel-field">Move to
      <select value={pasteClass} onChange={(event) => setPasteClass(event.target.value)}>
        <option value="">Choose a semantic class</option>
        {CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{pasted.length > 0 && pasted.every((id) => origins.get(id) === entry.id) ? " (pipeline)" : ""}</option>)}
      </select>
    </label>
    <div className="review-controls">
      <button className="secondary" type="button" disabled={readOnly || !pasted.length || !pasteClass} onClick={movePasted}>
        Move {integers.format(pasted.length)} {pasted.length === 1 ? "segment" : "segments"}
      </button>
    </div>
    <label className="panel-field">Set quality
      <select value={pasteQuality} onChange={(event) => setPasteQuality(event.target.value)}>
        <option value="">Choose a quality</option>
        {VERDICTS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
    </label>
    <div className="review-controls">
      <button className="secondary" type="button" disabled={readOnly || !pasted.length || !pasteQuality} onClick={qualityPasted}>
        Set {integers.format(pasted.length)} {pasted.length === 1 ? "segment" : "segments"}
      </button>
    </div>
    <p className="panel-note">{pasteNote || "Ids separated by spaces, commas, or newlines; from a viewer link or its {} state, the segments with their mesh switched on. The two actions are independent. A move is the same reassignment as the semantic panel's; a quality is set under whichever class each segment now sits in. Neither reloads the viewer, so you can keep picking."}</p>

  </div></fieldset>;
}
