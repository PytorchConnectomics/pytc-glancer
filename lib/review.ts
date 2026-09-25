/** A glance's review record: the verdicts a reader produces in the panels.
 *
 * Reports describe what the pipeline measured; a review records what a human
 * decided about it. The two are stored apart because they have different
 * authors and different lifetimes -- re-uploading a regenerated report must
 * not discard a morning of judgements, and reading the overlay must never rewrite either stored resource.
 *
 * `class_review` is the proofread panel's: absolute decisions per segment: Keep pins its class,
 * Reassign pins its target, and Reject hides it. `cell_review` is the quality-control
 * panel's: whether a structure's segment is complete, nested by structure so the
 * same id can be judged as more than one kind of object. A segment with no
 * entry takes the quality the pipeline's class implies. `cell_members` is which
 * segments each structure holds -- report classes the reader assigned to it,
 * plus ids typed in by hand.
 *
 * This module is pure and imports nothing, so the Worker validates uploads and
 * the panels read the same shapes without either pulling in the other's deps.
 */

import { REVIEW_ORDER } from "./structures";

export const CLASS_VERDICTS = ["keep", "reject", "reassign"] as const;
/* The two ways a segmentation can be wrong about one object, kept apart rather
 * than folded into one "incomplete": a false split is this object cut short,
 * with the rest of it living under other ids, while a false merge is two
 * objects wearing one id. They call for opposite repairs, so a review that
 * cannot tell them apart cannot drive one. */
export const CELL_VERDICTS = ["complete", "false_split", "false_merge", "unknown"] as const;
/* Earlier reviews stored bv/glia/soma/dendrite with false_merge/incomplete/good
 * verdicts, and the vessel category was keyed `bv` rather than `blood_vessel`.
 * A category no longer listed is ignored on read; no verdict was ever recorded
 * under either spelling, so there is no old vocabulary to translate.
 *
 * The categories themselves come from lib/structures.ts, which the composition
 * panel reads too: both panels are about the same five structures, and a
 * review keyed on a different id than the chart could not be cross-read. */
export const CELL_CATEGORIES = REVIEW_ORDER;

export type ClassVerdictId = (typeof CLASS_VERDICTS)[number];
export type CellVerdictId = (typeof CELL_VERDICTS)[number];
export type CellCategoryId = (typeof CELL_CATEGORIES)[number];

export const MAX_REVIEW_BYTES = 512 * 1024;
export const MAX_REVIEW_ENTRIES = 20_000;
export const MAX_CATEGORY_IDS = 20_000;

const SEGMENT_ID = /^\d{1,20}$/;
const CLASS_ID_LENGTH = 64;

export interface ClassVerdict { class: string | null; verdict: ClassVerdictId; to: string | null; at: number | null; }
export interface CellVerdict { verdict: CellVerdictId; at: number | null; }
export interface CellMembers { classes: string[]; ids: string[]; }
export interface GlanceReview {
  version: 1;
  class_review: Record<string, ClassVerdict>;
  cell_review: Record<CellCategoryId, Record<string, CellVerdict>>;
  cell_members: Record<CellCategoryId, CellMembers>;
}

export function emptyReview(): GlanceReview {
  const review: GlanceReview = { version: 1, class_review: {}, cell_review: {} as GlanceReview["cell_review"], cell_members: {} as GlanceReview["cell_members"] };
  for (const category of CELL_CATEGORIES) {
    review.cell_review[category] = {};
    review.cell_members[category] = { classes: [], ids: [] };
  }
  return review;
}

function fail(where: string, detail: string): never { throw new Error(`review ${where} ${detail}.`); }

function object(value: unknown, where: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(where, "must be an object");
  return value as Record<string, unknown>;
}

/** A segment id as Neuroglancer writes it: unsigned decimal, leading zeros dropped. */
function segmentId(value: string, where: string) {
  if (!SEGMENT_ID.test(value)) fail(where, "must be an unsigned decimal segment id");
  return value.replace(/^0+(?=\d)/, "");
}

function classId(value: unknown, where: string, required: boolean) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(where, "is required");
    return null;
  }
  if (typeof value !== "string") fail(where, "must be a string");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CLASS_ID_LENGTH) fail(where, `must be 1 to ${CLASS_ID_LENGTH} characters`);
  return trimmed;
}

function timestamp(value: unknown, where: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(where, "must be a finite epoch in milliseconds");
  return value;
}

function member<T extends readonly string[]>(value: unknown, allowed: T, where: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) fail(where, `must be one of ${allowed.join(", ")}`);
  return value;
}

function entries(value: unknown, where: string) {
  const record = object(value, where);
  const keys = Object.keys(record);
  if (keys.length > MAX_REVIEW_ENTRIES) fail(where, `must hold at most ${MAX_REVIEW_ENTRIES} segments`);
  return keys.map((key) => [key, record[key]] as const);
}

function idList(value: unknown, where: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(where, "must be an array");
  if (value.length > MAX_CATEGORY_IDS) fail(where, `must hold at most ${MAX_CATEGORY_IDS} ids`);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const [index, entry] of value.entries()) {
    // A uint64 id past 2^53 has already lost precision as a JSON number, so
    // only the decimal-string form is accepted here, as in the report reader.
    if (typeof entry !== "string") fail(`${where}[${index}]`, "must be a string");
    const id = segmentId(entry.trim(), `${where}[${index}]`);
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

function classList(value: unknown, where: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(where, "must be an array");
  if (value.length > 64) fail(where, "must name at most 64 classes");
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const [index, entry] of value.entries()) {
    const id = classId(entry, `${where}[${index}]`, true) as string;
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

/** Validate a review body, filling in every category so readers need no guards. */
export function parseReview(raw: string | unknown): GlanceReview {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { throw new Error("The review is not valid JSON."); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The review must be a JSON object.");
  const body = parsed as Record<string, unknown>;
  if (body.version !== undefined && body.version !== 1) fail("version", "must be 1");

  const review = emptyReview();
  for (const [key, value] of entries(body.class_review, "class_review")) {
    const where = `class_review[${key}]`;
    const item = object(value, where);
    const verdict = member(item.verdict, CLASS_VERDICTS, `${where}.verdict`);
    review.class_review[segmentId(key.trim(), where)] = {
      verdict,
      class: classId(item.class, `${where}.class`, false),
      // A reassignment that names no target is not actionable, but it is a
      // legitimate mid-review state, so it stores rather than throws.
      to: verdict === "reassign" ? classId(item.to, `${where}.to`, false) : null,
      at: timestamp(item.at, `${where}.at`)
    };
  }

  const cellReview = object(body.cell_review, "cell_review");
  for (const category of CELL_CATEGORIES) {
    for (const [key, value] of entries(cellReview[category], `cell_review.${category}`)) {
      const where = `cell_review.${category}[${key}]`;
      const item = object(value, where);
      review.cell_review[category][segmentId(key.trim(), where)] = {
        verdict: member(item.verdict, CELL_VERDICTS, `${where}.verdict`),
        at: timestamp(item.at, `${where}.at`)
      };
    }
  }

  const members = object(body.cell_members, "cell_members");
  for (const category of CELL_CATEGORIES) {
    const where = `cell_members.${category}`;
    const item = object(members[category], where);
    review.cell_members[category] = { classes: classList(item.classes, `${where}.classes`), ids: idList(item.ids, `${where}.ids`) };
  }
  return review;
}

/** True when nothing has been recorded, so an empty record need not be stored. */
export function reviewIsEmpty(review: GlanceReview) {
  return !Object.keys(review.class_review).length
    && CELL_CATEGORIES.every((category) => !Object.keys(review.cell_review[category]).length)
    && CELL_CATEGORIES.every((category) => !review.cell_members[category].classes.length && !review.cell_members[category].ids.length);
}
