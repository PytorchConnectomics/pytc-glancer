"use client";

import { ReactNode } from "react";

/* Categorical hues, dark steps only: this app is `color-scheme: dark` and a
 * mode flip would need its own validated column. The order is the documented
 * slot order, and each row was checked with the data-viz validator against
 * this app's own panel surface (#0d141d) over the *cyclic* adjacent pairs a
 * pie creates, including the last-to-first wrap the linear default never sees.
 * Seven slices is the one row that departs from the slot order: violet before
 * green, because green-then-violet leaves violet touching blue (normal-vision
 * Delta E 9.8, below the 15 floor). Past eight groups the tail folds into one
 * neutral Other slice rather than inventing a ninth hue. */
const RINGS: Record<number, string[]> = {
  2: ["#3987e5", "#d95926"],
  3: ["#3987e5", "#d95926", "#199e70"],
  4: ["#3987e5", "#d95926", "#199e70", "#c98500"],
  5: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"],
  6: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"],
  7: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9", "#008300"],
  8: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"]
};
export const MAX_SLICES = 8;
export const OTHER_COLOR = "#6f818d";

export const integers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
export const percents = new Intl.NumberFormat(undefined, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A slice's share of the whole, and how many segments make it up: `15% (2,300)`.
 *  Both pies read this way, so a slice's size and its population are never
 *  confused for one another -- a class can be a sixth of the volume in a
 *  handful of objects, or a hundredth of it across thousands. */
export function shareAndCount(share: number, count: number) { return `${percents.format(share)} (${integers.format(count)})`; }

export function decimals(value: number, digits = 2) { return new Intl.NumberFormat(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); }

export interface Group<T> { id: string; label: string; value: number; members: T[]; }
export interface Slice<T> extends Group<T> { color: string; share: number; start: number; end: number; }

/** Groups arrive in their own meaningful order, so colour follows the group
 *  rather than its rank; a group keeps its hue however large it is. */
export function buildSlices<T>(groups: Group<T>[], foldLabel = (count: number) => `Other (${count} groups)`): Slice<T>[] {
  const total = groups.reduce((sum, group) => sum + group.value, 0) || 1;
  const head = groups.slice(0, groups.length > MAX_SLICES ? MAX_SLICES - 1 : MAX_SLICES);
  const tail = groups.slice(head.length);
  const folded = tail.length
    ? [...head, { id: "other", label: foldLabel(tail.length), value: tail.reduce((sum, group) => sum + group.value, 0), members: tail.flatMap((group) => group.members) }]
    : head;
  const ring = RINGS[Math.min(Math.max(folded.length, 2), MAX_SLICES)] ?? RINGS[MAX_SLICES];
  let angle = -Math.PI / 2;
  return folded.map((group, index) => {
    const start = angle;
    angle += (group.value / total) * Math.PI * 2;
    return { ...group, color: tail.length && index === folded.length - 1 ? OTHER_COLOR : ring[index], share: group.value / total, start, end: angle };
  });
}

function arc(start: number, end: number, radius: number) {
  const [cx, cy] = [radius, radius];
  if (end - start >= Math.PI * 2 - 1e-9) return `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.001} ${cy - radius} Z`;
  const [x1, y1] = [cx + radius * Math.cos(start), cy + radius * Math.sin(start)];
  const [x2, y2] = [cx + radius * Math.cos(end), cy + radius * Math.sin(end)];
  return `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`;
}

interface MarkProps<T> { slices: Slice<T>[]; selected: string | null; hovered: string | null; onSelect: (id: string | null) => void; onHover: (id: string | null) => void; }

export function Pie<T>({ slices, selected, hovered, onSelect, onHover, label, describe }: MarkProps<T> & { label: string; describe: (slice: Slice<T>) => string }) {
  const radius = 92;
  const toggle = (id: string) => onSelect(selected === id ? null : id);
  return <svg viewBox={`0 0 ${radius * 2} ${radius * 2}`} role="img" aria-label={label} className="pie">
    {slices.map((slice) => <path
      key={slice.id} d={arc(slice.start, slice.end, radius)} fill={slice.color}
      className={`slice ${selected && selected !== slice.id ? "dimmed" : ""} ${hovered === slice.id ? "hovered" : ""}`}
      tabIndex={0} role="button" aria-pressed={selected === slice.id} aria-label={describe(slice)}
      onClick={() => toggle(slice.id)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(slice.id); } }}
      onMouseEnter={() => onHover(slice.id)} onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(slice.id)} onBlur={() => onHover(null)}
    />)}
  </svg>;
}

/** Identity is never colour-alone: every mark is also a legend row. */
export function Legend<T>({ slices, selected, onSelect, onHover, value }: Omit<MarkProps<T>, "hovered"> & { value: (slice: Slice<T>) => ReactNode }) {
  return <ul className="legend">
    {slices.map((slice) => <li key={slice.id}>
      <button type="button" className={`legend-row ${selected === slice.id ? "active" : ""}`} aria-pressed={selected === slice.id}
        onClick={() => onSelect(selected === slice.id ? null : slice.id)}
        onMouseEnter={() => onHover(slice.id)} onMouseLeave={() => onHover(null)}>
        <span className="swatch" style={{ background: slice.color }} aria-hidden="true" />
        <span className="legend-label">{slice.label}</span>
        <span className="legend-value">{value(slice)}</span>
      </button>
    </li>)}
  </ul>;
}

export interface Bin<T> { id: string; label: string; from: number; to: number; members: T[]; }

/** Nice-width bins over a measured value, with the long tail in a final open bin. */
export function histogram<T>(items: T[], measure: (item: T) => number | null, target = 12): Bin<T>[] {
  const values = items.map(measure).filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) return [];
  const sorted = [...values].sort((left, right) => left - right);
  // The upper edge is a high percentile, not the maximum: one 40 um outlier
  // would otherwise squeeze every real axon into the first bin. The index is
  // taken over (n - 1) so the percentile still trims on short inputs, where
  // floor(n * 0.98) would land on the maximum and trim nothing.
  const upper = sorted[Math.max(0, Math.floor((sorted.length - 1) * 0.98))];
  const raw = Math.max(upper, 1e-6) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const width = [1, 2, 2.5, 5, 10].map((step) => step * magnitude).find((step) => step >= raw) ?? 10 * magnitude;
  const count = Math.max(1, Math.min(target, Math.ceil(upper / width)));
  const bins: Bin<T>[] = Array.from({ length: count }, (_, index) => ({
    id: `bin-${index}`, from: index * width, to: (index + 1) * width,
    label: `${decimals(index * width, width < 1 ? 2 : 1)}–${decimals((index + 1) * width, width < 1 ? 2 : 1)}`, members: []
  }));
  bins.push({ id: "bin-tail", from: count * width, to: Infinity, label: `≥ ${decimals(count * width, width < 1 ? 2 : 1)}`, members: [] });
  for (const item of items) {
    const value = measure(item);
    if (value === null || !Number.isFinite(value)) continue;
    bins[Math.min(bins.length - 1, Math.floor(value / width))].members.push(item);
  }
  // Trim empty bins off both ends so the axis spans the data rather than the
  // origin: the axon screen selects on length >= 2 um, so a run starting at 0
  // would open on two dead bars. Interior empties are kept -- a gap in the
  // distribution is a fact about it.
  const first = bins.findIndex((bin) => bin.members.length);
  const last = bins.length - 1 - [...bins].reverse().findIndex((bin) => bin.members.length);
  return bins.slice(first, last + 1);
}

export function Histogram<T>({ bins, selected, onSelect, unit, label }: { bins: Bin<T>[]; selected: string | null; onSelect: (id: string | null) => void; unit: string; label: string }) {
  const peak = Math.max(1, ...bins.map((bin) => bin.members.length));
  const toggle = (id: string) => onSelect(selected === id ? null : id);
  return <figure className="histogram-figure">
    <div className="histogram" role="group" aria-label={label}>
      {bins.map((bin) => <button key={bin.id} type="button"
        className={`histogram-bar ${selected === bin.id ? "active" : ""} ${selected && selected !== bin.id ? "dimmed" : ""}`}
        aria-pressed={selected === bin.id} title={`${bin.label} ${unit}: ${integers.format(bin.members.length)}`}
        aria-label={`${bin.label} ${unit}, ${integers.format(bin.members.length)}`} onClick={() => toggle(bin.id)}>
        <span className="histogram-count">{bin.members.length ? integers.format(bin.members.length) : ""}</span>
        <span className="histogram-fill" style={{ height: `${(bin.members.length / peak) * 100}%` }} />
      </button>)}
    </div>
    <div className="histogram-axis" aria-hidden="true">
      <span>{bins[0]?.label.split("–")[0] ?? ""}</span><span>{unit}</span><span>{bins.at(-1)?.label ?? ""}</span>
    </div>
  </figure>;
}
