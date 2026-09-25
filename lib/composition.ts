/** Composition reading: what one segmentation's foreground is made of.
 *
 * The evaluation pipeline publishes `semantic_summary.json` beside the
 * segmentation it describes -- a small chart payload, not the catalog. It is
 * read at request time rather than stored, because nothing in the app edits
 * it: a stored copy could only go stale, and staleness is the one failure this
 * panel must not have. The error report is stored precisely because
 * proofreading rewrites it; this is the opposite case.
 */
import type { AppConfig } from "./config";
import { layerLocation } from "./report";
import { COMPOSITION_ORDER, inOrder } from "./structures";

export const COMPOSITION_OBJECT = "semantic_summary.json";
export const MAX_CATEGORIES = 24;

/* Where the summary is looked for under a segmentation layer, in order.
 *
 * The pipeline writes it at the layer root today. The eval subdirectory is
 * tried first because that is the prefix a deployment can actually publish:
 * this Worker reads anonymously when no `GCS_SA_KEY` is configured, managed
 * folders take a prefix rather than an object, and a grant on the layer root
 * would expose the segmentation chunks along with it. An eval-only folder
 * exposes eval output only, which is the existing convention for reports. */
export const COMPOSITION_DIRECTORIES = ["nogt_eval", ""] as const;

/* The panel's rows, in the order a false merge is assigned: an object that is
 * two things at once counts once, as the first row it matches. The pipeline
 * applies that precedence upstream, where the merge is still visible; this
 * order is the same rule, written where a reader can see it.
 *
 * The vocabulary itself lives in lib/structures.ts, shared with the quality
 * control panel, so the two cannot name the same five things differently. */
export const COMPOSITION_ROWS = inOrder(COMPOSITION_ORDER).map((entry) => ({ id: entry.id, label: entry.composition, from: entry.from }));

export interface CompositionCategory {
  id: string;
  label: string;
  /** Published classes folded into this row, for provenance. */
  classes: string[];
  /** False when the run did not look for this category. Distinct from zero. */
  assessed: boolean;
  voxels: number;
  volume_um3: number | null;
  segments: number | null;
}

export interface Composition {
  layer: string | null;
  bucket: string;
  directory: string;
  total_voxels: number | null;
  foreground_voxels: number;
  foreground_volume_um3: number | null;
  segment_count: number | null;
  categories: CompositionCategory[];
  /** Objects at or above the review threshold, when the payload reports them. */
  large_objects: { threshold_volume_um3: number | null; segment_count: number; voxels: number | null } | null;
  notes: string | null;
}

function layerSourceUrl(layer: unknown): string | null {
  const source = (layer as Record<string, unknown> | null)?.source;
  for (const candidate of Array.isArray(source) ? source : [source]) {
    if (typeof candidate === "string") return candidate;
    const url = (candidate as Record<string, unknown> | null)?.url;
    if (typeof url === "string") return url;
  }
  return null;
}

export interface SegmentationRef { name: string | null; bucket: string; directory: string; }

/** Every segmentation layer that resolves inside a configured source, in the
 *  state's own order.
 *
 * A glance can carry more than one variant of the same volume, and each
 * publishes its own summary beside itself. Layers that do not resolve are
 * skipped rather than fatal, so one pasted layer cannot hide a good one; the
 * caller reports which layer it ended up reading. */
export function segmentationsFromState(state: unknown, config: AppConfig): SegmentationRef[] {
  const layers = (state as { layers?: unknown[] } | null)?.layers;
  const refs: SegmentationRef[] = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    const entry = layer as Record<string, unknown> | null;
    if (entry?.type !== "segmentation") continue;
    const raw = layerSourceUrl(entry);
    if (!raw) continue;
    try {
      const { bucket, path } = layerLocation(raw, config, "The segmentation layer");
      refs.push({ name: typeof entry.name === "string" ? entry.name : null, bucket, directory: path });
    } catch { /* not readable from here; try the next layer */ }
  }
  return refs;
}

export function compositionObjectName(reference: SegmentationRef, directory = "") {
  return [reference.directory, directory, COMPOSITION_OBJECT].filter(Boolean).join("/");
}

/** Every place one segmentation layer's summary may be published, in order. */
export function compositionCandidates(reference: SegmentationRef) {
  return COMPOSITION_DIRECTORIES.map((directory) => compositionObjectName(reference, directory));
}

function fieldError(where: string, detail: string): never { throw new Error(`${COMPOSITION_OBJECT} ${where} ${detail}.`); }

function count(value: unknown, where: string, required = false) {
  if (value === undefined || value === null) {
    if (required) fieldError(where, "is required");
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fieldError(where, "must be a finite number of at least 0");
  return value as number;
}

function text(value: unknown, where: string, max: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fieldError(where, "must be a string");
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** Normalise the published summary into the panel's fixed row vocabulary.
 *
 * Two decisions are made here rather than in the panel. A class the payload
 * does not mention at all is "not assessed", not zero: a run that never looked
 * for vessels and a volume with no vessels are different claims, and only the
 * payload's own `assessment_status` can tell them apart. And a published class
 * this vocabulary does not know is appended as its own row rather than dropped,
 * so a category added upstream shows up as itself instead of disappearing into
 * the total.
 */
export function parseComposition(raw: string, reference: SegmentationRef): Composition {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${COMPOSITION_OBJECT} is not valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${COMPOSITION_OBJECT} must be a JSON object.`);
  const body = parsed as Record<string, unknown>;
  if (!Array.isArray(body.categories)) fieldError("categories", "must be an array");
  if (body.categories.length > MAX_CATEGORIES) fieldError("categories", `must hold at most ${MAX_CATEGORIES} entries`);

  const published = new Map<string, { label: string | null; assessed: boolean; voxels: number; volume_um3: number | null; segments: number | null }>();
  for (const [index, entry] of body.categories.entries()) {
    const where = `categories[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fieldError(where, "must be an object");
    const item = entry as Record<string, unknown>;
    const id = text(item.class, `${where}.class`, 64);
    if (!id) fieldError(`${where}.class`, "is required");
    if (published.has(id)) fieldError(`${where}.class`, `duplicates ${id}`);
    published.set(id, {
      label: text(item.label, `${where}.label`, 120),
      assessed: text(item.assessment_status, `${where}.assessment_status`, 64) !== "not_assessed",
      voxels: Math.round(count(item.voxel_count, `${where}.voxel_count`, true) as number),
      volume_um3: count(item.volume_um3, `${where}.volume_um3`),
      segments: count(item.segment_count, `${where}.segment_count`)
    });
  }

  const taken = new Set<string>();
  const categories: CompositionCategory[] = COMPOSITION_ROWS.map((row) => {
    const found = row.from.filter((name) => published.has(name));
    found.forEach((name) => taken.add(name));
    const parts = found.map((name) => published.get(name)!);
    return {
      id: row.id,
      label: row.label,
      classes: found,
      // Nothing published for this row means the run did not report on it.
      assessed: parts.length > 0 && parts.some((part) => part.assessed),
      voxels: parts.reduce((sum, part) => sum + part.voxels, 0),
      volume_um3: parts.length && parts.every((part) => part.volume_um3 !== null) ? parts.reduce((sum, part) => sum + (part.volume_um3 as number), 0) : null,
      segments: parts.length && parts.every((part) => part.segments !== null) ? parts.reduce((sum, part) => sum + (part.segments as number), 0) : null
    };
  });
  for (const [name, part] of published) {
    if (taken.has(name)) continue;
    categories.push({ id: name, label: part.label ?? name.replace(/_/g, " "), classes: [name], assessed: part.assessed, voxels: part.voxels, volume_um3: part.volume_um3, segments: part.segments });
  }

  const foreground = count(body.foreground_voxels, "foreground_voxels", true) as number;
  const review = body.large_object_review;
  return {
    layer: reference.name,
    bucket: reference.bucket,
    directory: reference.directory,
    total_voxels: count(body.total_voxels, "total_voxels"),
    foreground_voxels: Math.round(foreground),
    foreground_volume_um3: count(body.foreground_volume_um3, "foreground_volume_um3"),
    segment_count: count(body.segment_count, "segment_count"),
    categories,
    large_objects: review && typeof review === "object" && !Array.isArray(review)
      ? {
        threshold_volume_um3: count((review as Record<string, unknown>).threshold_volume_um3, "large_object_review.threshold_volume_um3"),
        segment_count: Math.round(count((review as Record<string, unknown>).segment_count, "large_object_review.segment_count", true) as number),
        voxels: (() => {
          const percent = count((review as Record<string, unknown>).percent_foreground, "large_object_review.percent_foreground");
          return percent === null ? null : Math.round((percent / 100) * foreground);
        })()
      }
      : null,
    notes: text(body.denominator, "denominator", 400)
  };
}
