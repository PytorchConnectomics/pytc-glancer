"use client";

import { useState } from "react";
import { Legend, Pie, buildSlices, integers, percents, shareAndCount, type Slice } from "./chart";

import type { CellVerdictId } from "../../../../../lib/review";

/* Mirrors lib/report.ts, which the Worker validates against. */
export interface ReportSegment { id: string; voxels: number | null; volume_um3: number | null; centroid_um: [number, number, number] | null; radius_um: number | null; length_um: number | null; margin: number | null; quality: CellVerdictId | null; }
export interface ReportClass { id: string; label: string; voxels: number; volume_um3: number | null; labels: number | null; note: string | null; margin_label: string | null; segment_ids: string[]; segments: ReportSegment[]; }
export interface ReportFigure { index: number; label: string; caption: string | null; path: string; }
export interface AxonRecord { id: string; class: string | null; length_um: number | null; radius_um: number | null; axis: string | null; continuity: number | null; }
export interface ErrorReport {
  dataset: string; generated_at: string | null; segmentation: string | null; voxel_volume_um3: number | null;
  notes: string | null; total_voxels: number; classes: ReportClass[]; figures: ReportFigure[]; axons: AxonRecord[];
}
/* `centroid_um` moves the camera; the panel cannot convert it to viewer
 * coordinates itself, because the voxel size lives on the glance state. */
export interface Selection { id: string; segments: string[]; centroid_um?: [number, number, number] | null; }

/** Whole segments, never past what the class actually carries. */
export function clampSegmentLimit(raw: string, total: number) {
  // A blank field is mid-edit, not zero: Number("") is 0, and reading it that
  // way would blank the viewer the moment the reader clears the box.
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(total, Math.round(value)));
}

function volume(value: number | null) { return value === null ? "—" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value)} µm³`; }

/** How many segments a slice stands for: the class's own label count where the
 *  report gives one, else the records it carries. The slice's size is volume,
 *  so the two numbers together say a share of the volume in how many objects. */
export function labelsIn(slice: Slice<ReportClass>) {
  return slice.members.reduce((sum, entry) => sum + (entry.labels ?? entry.segments.length), 0);
}

/** Report order is the pipeline's, so colour follows the class, never its size. */
/* Empty classes are dropped after colouring rather than before, so a class
 * keeps its colour whether or not a neighbour is empty -- vessel and glia are
 * zero until the pipeline assesses them, and should not shift the rest. */
export function sliceReport(report: ErrorReport): Slice<ReportClass>[] {
  return buildSlices(report.classes.map((entry) => ({ id: entry.id, label: entry.label, value: entry.voxels, members: [entry] })), (count) => `Other (${count} classes)`)
    .filter((slice) => slice.value > 0);
}

/* Given `onPickClass`, a slice chooses the class the proofreading stepper walks
 * rather than loading the whole class, and loading it becomes an explicit
 * button: the stepper puts one segment in the viewer, and a click on the pie
 * should not be undone by it a moment later. */
export default function ReportPanel({ report, selected, onSelect, onPickClass }: {
  report: ErrorReport; selected: string | null; onSelect: (selection: Selection | null) => void; onPickClass?: (id: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  /* How many of a class's segments to load, per class. A class can carry
   * hundreds of ids and Neuroglancer draws every one of them, so the count is
   * the reader's dial rather than a fixed cap. Absent means "all of them". */
  const [limits, setLimits] = useState<Record<string, number>>({});
  const slices = sliceReport(report);
  const active = slices.find((slice) => slice.id === selected) ?? null;
  const available = (slice: Slice<ReportClass>) => slice.members.flatMap((entry) => entry.segment_ids);
  const load = (id: string | null, limit?: number) => {
    const slice = id ? slices.find((entry) => entry.id === id) : null;
    if (!slice) return onSelect(null);
    const segments = available(slice);
    onSelect({ id: slice.id, segments: segments.slice(0, limit ?? limits[slice.id] ?? segments.length) });
  };
  const setLimit = (slice: Slice<ReportClass>, raw: string) => {
    const value = clampSegmentLimit(raw, available(slice).length);
    if (value === null) return;
    setLimits((current) => ({ ...current, [slice.id]: value }));
    if (!onPickClass) load(slice.id, value);
  };
  // A folded "Other" slice is not one class, so it cannot be proofread as one.
  const pick = (id: string | null) => {
    if (!onPickClass) return load(id);
    if (id && report.classes.some((entry) => entry.id === id)) onPickClass(id);
  };

  return <div className="report">
    <p className="panel-note">Foreground voxels per semantic class in the report for <strong>{report.dataset}</strong>{report.generated_at ? `, ${report.generated_at}` : ""}. Each segment sits in exactly one class; the classes are geometric candidates, not verified cell types.</p>

    <figure className="pie-figure">
      <Pie slices={slices} selected={active?.id ?? null} hovered={hovered} onHover={setHovered} onSelect={pick}
        label={`Voxel share by morphology class for ${report.dataset}`}
        describe={(slice) => `${slice.label}, ${percents.format(slice.share)} of volume, ${integers.format(labelsIn(slice))} segments`} />
      <figcaption className="pie-readout" aria-live="polite">
        {(() => {
          const shown = slices.find((slice) => slice.id === hovered) ?? active;
          if (!shown) return <><strong>{integers.format(report.total_voxels)}</strong><span>voxels measured</span></>;
          return <><strong>{percents.format(shown.share)}</strong><span>{shown.label} · {integers.format(shown.value)} voxels</span></>;
        })()}
      </figcaption>
    </figure>

    <Legend slices={slices} selected={active?.id ?? null} onSelect={pick} onHover={setHovered} value={(slice) => shareAndCount(slice.share, labelsIn(slice))} />
    {report.classes.some((entry) => entry.voxels === 0) && <p className="class-note">
      Empty, so not drawn: {report.classes.filter((entry) => entry.voxels === 0).map((entry) => entry.label).join(", ")}.
      {report.classes.some((entry) => entry.voxels === 0 && entry.note) ? " This run did not assess them, which is not the same as their being absent." : ""} Segments can still be moved into them.
    </p>}

    {active && <div className="class-detail">
      <h4>{active.label}</h4>
      <dl>
        <div><dt>Voxels</dt><dd>{integers.format(active.value)}</dd></div>
        <div><dt>Volume</dt><dd>{volume(active.members.reduce<number | null>((sum, entry) => entry.volume_um3 === null || sum === null ? null : sum + entry.volume_um3, 0))}</dd></div>
        <div><dt>Labels</dt><dd>{active.members.every((entry) => entry.labels === null) ? "—" : integers.format(active.members.reduce((sum, entry) => sum + (entry.labels ?? 0), 0))}</dd></div>
        <div><dt><label htmlFor="segments-shown">Segments shown</label></dt><dd>
          <input id="segments-shown" className="count-input" type="number" inputMode="numeric" min={0} max={available(active).length}
            value={Math.min(limits[active.id] ?? available(active).length, available(active).length)}
            onChange={(event) => setLimit(active, event.target.value)} />
          <span className="count-total"> of {integers.format(available(active).length)}</span>
        </dd></div>
      </dl>
      {active.members.map((entry) => entry.note && <p key={entry.id} className="class-note">{entry.note}</p>)}
      {!active.members.some((entry) => entry.segment_ids.length) && <p className="class-note">The report lists no segment ids for this class, so the viewer still shows every segment.</p>}
      {onPickClass
        ? <button className="secondary" type="button" disabled={!available(active).length} onClick={() => load(active.id)}>Show {integers.format(Math.min(limits[active.id] ?? available(active).length, available(active).length))} in the viewer</button>
        : <button className="text-button" type="button" onClick={() => onSelect(null)}>Clear selection</button>}
    </div>}

    {report.notes && <p className="panel-note">{report.notes}</p>}
  </div>;
}
