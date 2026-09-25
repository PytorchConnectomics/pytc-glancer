/** Error-report reading: locate a glance's report on GCS and validate its JSON.
 *
 * The report is produced upstream by the segmentation-evaluation pipeline and
 * published beside the volume it describes, at
 * `<prefix>/<dataset>_nogt_eval/error_report.json`. pytc_glancer never computes
 * these numbers; it reads them with the same get-only credential the OME-Zarr
 * metadata reads use, and refuses buckets that are not a configured source.
 */
import type { AppConfig, SourceConfig } from "./config";
import { CELL_VERDICTS, type CellVerdictId } from "./review";

export const REPORT_DIRECTORY_SUFFIX = "_nogt_eval";
export const REPORT_OBJECT = "error_report.json";
export const MAX_CLASSES = 32;
export const MAX_FIGURES = 12;
export const MAX_SEGMENT_IDS = 200_000;
export const MAX_AXONS = 20_000;
/* A semantic report carries a record for every analysed segment, and one
 * class can hold tens of thousands; the upload ceiling is the real bound. */
export const MAX_SEGMENTS_PER_CLASS = 200_000;

const DATASET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEGMENT_ID_PATTERN = /^\d{1,20}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const FIGURE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
const AXES = new Set(["z", "y", "x"]);
// zarr:// is present on states the app generates from a path; states imported
// from a pasted viewer URL carry the bare gs+ngauth form.
const SOURCE_PATTERN = /^(?:zarr:\/\/)?gs\+ngauth\+https:\/\/[^/\s|]+\/([^|\s]+)/;

export interface DatasetRef { source: SourceConfig; bucket: string; dataset: string; directory: string; }
export interface LayerLocation { source: SourceConfig; bucket: string; path: string; }
/* One reviewable member of a class. `margin` is the segment's distance to
 * the class's own decision boundary in that variable's units, computed
 * upstream where the screen's thresholds live; the panel only sorts by it, so
 * no threshold is duplicated here. `quality` is the pipeline's starting call
 * on whether the segment is whole, in the quality-control vocabulary; absent
 * means the pipeline made none. */
export interface ReportSegment { id: string; voxels: number | null; volume_um3: number | null; centroid_um: [number, number, number] | null; radius_um: number | null; length_um: number | null; margin: number | null; quality: CellVerdictId | null; }
export interface ReportClass { id: string; label: string; voxels: number; volume_um3: number | null; labels: number | null; note: string | null; margin_label: string | null; segment_ids: string[]; segments: ReportSegment[]; }
export interface ReportFigure { index: number; label: string; caption: string | null; path: string; }
/* One measured axon candidate. The panel bins these itself rather than
 * reading precomputed bins, because the same records answer three questions:
 * the length histogram, and the pie under either grouping. */
export interface AxonRecord { id: string; class: string | null; length_um: number | null; radius_um: number | null; axis: string | null; continuity: number | null; }
export interface ErrorReport {
  dataset: string; generated_at: string | null; segmentation: string | null; voxel_volume_um3: number | null;
  notes: string | null; total_voxels: number; classes: ReportClass[]; figures: ReportFigure[]; axons: AxonRecord[];
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

/** Bucket and object path of one gs+ngauth layer, confined to a configured source.
 *
 * Shared by the two readers that locate published artifacts: the report wants
 * the image layer's dataset name, the composition wants a segmentation layer's
 * own directory. Only configured sources resolve, because a glance imported
 * from a pasted viewer URL can name any bucket, and without that check either
 * route would turn the get-only credential into a general fetcher.
 */
export function layerLocation(raw: string, config: AppConfig, what: string): LayerLocation {
  const match = SOURCE_PATTERN.exec(raw.trim());
  if (!match) throw new Error(`${what} is not a gs+ngauth source.`);
  const parts = match[1].replace(/\/+$/, "").split("/").filter(Boolean);
  const bucket = parts.shift();
  if (!bucket || !parts.length) throw new Error(`${what} source names no object path.`);
  if (parts.includes("..")) throw new Error(`${what} source contains a .. segment.`);
  const path = parts.join("/");
  const source = config.sources.find((entry) => entry.bucket === bucket && (!entry.prefix || path === entry.prefix || path.startsWith(`${entry.prefix}/`)));
  if (!source) throw new Error("This glance's bucket is not a configured source, so no report is readable for it.");
  return { source, bucket, path };
}

/** Bare dataset name of a state's image layer, plus where its report lives. */
export function datasetFromState(state: unknown, config: AppConfig): DatasetRef {
  const layers = (state as { layers?: unknown[] } | null)?.layers;
  const image = Array.isArray(layers) ? layers.find((layer) => (layer as Record<string, unknown> | null)?.type === "image") : undefined;
  const raw = layerSourceUrl(image);
  if (!raw) throw new Error("This glance has no OME-Zarr image layer, so it names no dataset to report on.");
  const { source, bucket, path } = layerLocation(raw, config, "The image layer");
  const parts = path.split("/");
  const leaf = parts.pop() as string;
  const dataset = leaf.endsWith(".zarr") ? leaf.slice(0, -".zarr".length) : leaf;
  if (!DATASET_PATTERN.test(dataset)) throw new Error("The image layer names no usable dataset.");
  const prefix = parts.join("/");
  return { source, bucket, dataset, directory: [prefix, `${dataset}${REPORT_DIRECTORY_SUFFIX}`].filter(Boolean).join("/") };
}

export function reportObjectName(reference: DatasetRef) { return `${reference.directory}/${REPORT_OBJECT}`; }
export function figureObjectName(reference: DatasetRef, figure: ReportFigure) { return `${reference.directory}/${figure.path}`; }

function fieldError(where: string, detail: string): never { throw new Error(`${REPORT_OBJECT} ${where} ${detail}.`); }

function optionalText(value: unknown, where: string, max: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fieldError(where, "must be a string");
  const trimmed = value.trim();
  if (trimmed.length > max) fieldError(where, `must be at most ${max} characters`);
  return trimmed || null;
}

function optionalNumber(value: unknown, where: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fieldError(where, "must be a finite number of at least 0");
  return value as number;
}

function segmentIds(value: unknown, where: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fieldError(where, "must be an array");
  if (value.length > MAX_SEGMENT_IDS) fieldError(where, `must hold at most ${MAX_SEGMENT_IDS} ids`);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    // Neuroglancer segment ids are uint64, so they travel as decimal strings; a
    // JSON number past 2^53 has already lost precision by the time we see it.
    const candidate = typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? String(entry) : entry;
    if (typeof candidate !== "string" || !SEGMENT_ID_PATTERN.test(candidate)) fieldError(where, "entries must be unsigned decimal integer ids");
    const id = (candidate as string).replace(/^0+(?=\d)/, "");
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function centroid(value: unknown, where: string): [number, number, number] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length !== 3) fieldError(where, "must be a [z, y, x] triple");
  const triple = (value as unknown[]).map((entry, axis) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) fieldError(`${where}[${axis}]`, "must be a finite number");
    return entry as number;
  });
  return [triple[0], triple[1], triple[2]];
}

/* A record's quality is either a name or, in compact reports, an index into
 * the report's own `qualities` list, which names each code once. */
function quality(value: unknown, where: string, names: readonly CellVerdictId[]): CellVerdictId | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value >= names.length) fieldError(where, `must index the report's qualities (0 to ${names.length - 1})`);
    return names[value];
  }
  if (typeof value !== "string" || !(CELL_VERDICTS as readonly string[]).includes(value)) fieldError(where, `must be one of ${CELL_VERDICTS.join(", ")}`);
  return value as CellVerdictId;
}

function qualityNames(value: unknown): readonly CellVerdictId[] {
  if (value === undefined || value === null) return CELL_VERDICTS;
  if (!Array.isArray(value) || !value.length || value.length > CELL_VERDICTS.length) fieldError("qualities", "must be a non-empty array of quality names");
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !(CELL_VERDICTS as readonly string[]).includes(entry)) fieldError(`qualities[${index}]`, `must be one of ${CELL_VERDICTS.join(", ")}`);
    return entry as CellVerdictId;
  });
}

function parseSegments(value: unknown, where: string, names: readonly CellVerdictId[]): ReportSegment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fieldError(where, "must be an array");
  if (value.length > MAX_SEGMENTS_PER_CLASS) fieldError(where, `must hold at most ${MAX_SEGMENTS_PER_CLASS} entries`);
  const seen = new Set<string>();
  const segments: ReportSegment[] = [];
  for (const [index, entry] of value.entries()) {
    const at = `${where}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fieldError(at, "must be an object");
    const item = entry as Record<string, unknown>;
    const id = segmentIds([item.id], `${at}.id`)[0];
    if (id === undefined) fieldError(`${at}.id`, "is required");
    if (seen.has(id)) continue;
    seen.add(id);
    segments.push({
      id,
      voxels: optionalNumber(item.voxels, `${at}.voxels`),
      volume_um3: optionalNumber(item.volume_um3, `${at}.volume_um3`),
      centroid_um: centroid(item.centroid_um, `${at}.centroid_um`),
      radius_um: optionalNumber(item.radius_um, `${at}.radius_um`),
      length_um: optionalNumber(item.length_um, `${at}.length_um`),
      margin: optionalNumber(item.margin, `${at}.margin`),
      quality: quality(item.quality, `${at}.quality`, names)
    });
  }
  return segments;
}

function figurePath(value: unknown, where: string) {
  if (typeof value !== "string" || !value.trim()) fieldError(where, "must be a non-empty string");
  const path = (value as string).trim();
  if (path.length > 256 || path.startsWith("/") || CONTROL_CHARACTER.test(path)) fieldError(where, "must be a relative path of at most 256 characters");
  if (path.split("/").some((part) => !part || part === "." || part === "..")) fieldError(where, "must not contain an empty, . or .. segment");
  if (!FIGURE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) fieldError(where, `must end with one of ${FIGURE_EXTENSIONS.join(", ")}`);
  return path;
}

function parseAxons(value: unknown): AxonRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fieldError("axons", "must be an array");
  if (value.length > MAX_AXONS) fieldError("axons", `must hold at most ${MAX_AXONS} entries`);
  const seen = new Set<string>();
  const axons: AxonRecord[] = [];
  for (const [index, entry] of value.entries()) {
    const where = `axons[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fieldError(where, "must be an object");
    const item = entry as Record<string, unknown>;
    const id = segmentIds([item.id], `${where}.id`)[0];
    if (id === undefined) fieldError(`${where}.id`, "is required");
    if (seen.has(id)) continue;
    seen.add(id);
    const axis = optionalText(item.axis, `${where}.axis`, 4)?.toLowerCase() ?? null;
    if (axis !== null && !AXES.has(axis)) fieldError(`${where}.axis`, "must be z, y, or x");
    axons.push({
      id, axis,
      class: optionalText(item.class, `${where}.class`, 64),
      length_um: optionalNumber(item.length_um, `${where}.length_um`),
      radius_um: optionalNumber(item.radius_um, `${where}.radius_um`),
      continuity: optionalNumber(item.continuity, `${where}.continuity`)
    });
  }
  return axons;
}

export function parseReport(raw: string, reference: DatasetRef): ErrorReport {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${REPORT_OBJECT} is not valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${REPORT_OBJECT} must be a JSON object.`);
  const body = parsed as Record<string, unknown>;
  if (body.version !== undefined && body.version !== 1) fieldError("version", "must be 1");
  if (!Array.isArray(body.classes) || !body.classes.length) fieldError("classes", "must be a non-empty array");
  if (body.classes.length > MAX_CLASSES) fieldError("classes", `must hold at most ${MAX_CLASSES} entries`);

  const seen = new Set<string>();
  const names = qualityNames(body.qualities);
  const classes = body.classes.map((entry, index) => {
    const where = `classes[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fieldError(where, "must be an object");
    const item = entry as Record<string, unknown>;
    const label = optionalText(item.label, `${where}.label`, 120);
    if (!label) fieldError(`${where}.label`, "is required");
    const voxels = optionalNumber(item.voxels, `${where}.voxels`);
    if (voxels === null) fieldError(`${where}.voxels`, "is required");
    const id = optionalText(item.id, `${where}.id`, 64) ?? `class-${index + 1}`;
    if (seen.has(id)) fieldError(`${where}.id`, `duplicates ${id}`);
    seen.add(id);
    const segments = parseSegments(item.segments, `${where}.segments`, names);
    return {
      id, label: label as string, voxels: Math.round(voxels),
      volume_um3: optionalNumber(item.volume_um3, `${where}.volume_um3`),
      labels: optionalNumber(item.labels, `${where}.labels`),
      note: optionalText(item.note, `${where}.note`, 1000),
      margin_label: optionalText(item.margin_label, `${where}.margin_label`, 120),
      // Records supersede the bare id list; older reports carry only the ids,
      // and newer ones need not repeat them.
      segment_ids: segments.length ? segments.map((segment) => segment.id) : segmentIds(item.segment_ids, `${where}.segment_ids`),
      segments
    };
  });

  const rawFigures = body.figures ?? [];
  if (!Array.isArray(rawFigures)) fieldError("figures", "must be an array");
  if (rawFigures.length > MAX_FIGURES) fieldError("figures", `must hold at most ${MAX_FIGURES} entries`);
  const figures = rawFigures.map((entry, index) => {
    const where = `figures[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fieldError(where, "must be an object");
    const item = entry as Record<string, unknown>;
    return { index, path: figurePath(item.path, `${where}.path`), label: optionalText(item.label, `${where}.label`, 120) ?? `Figure ${index + 1}`, caption: optionalText(item.caption, `${where}.caption`, 1000) };
  });

  const declaredTotal = optionalNumber(body.total_voxels, "total_voxels");
  return {
    dataset: optionalText(body.dataset, "dataset", 128) ?? reference.dataset,
    generated_at: optionalText(body.generated_at, "generated_at", 64),
    segmentation: optionalText(body.segmentation, "segmentation", 200),
    voxel_volume_um3: optionalNumber(body.voxel_volume_um3, "voxel_volume_um3"),
    notes: optionalText(body.notes, "notes", 2000),
    total_voxels: declaredTotal === null ? classes.reduce((sum, entry) => sum + entry.voxels, 0) : Math.round(declaredTotal),
    classes, figures, axons: parseAxons(body.axons)
  };
}
