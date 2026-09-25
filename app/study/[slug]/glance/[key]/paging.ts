/** How many segments a panel loads into the viewer at once.
 *
 * Shared by the semantic panel's proofreading and quality control's group
 * mode, so the two dials mean the same thing and stop at the same ceiling. */

/* Group review: the whole filtered set in the viewer, a page at a time. 100 is
 * a size a reader can actually scan; the ceiling is well under the report
 * schema's per-class cap, because Neuroglancer draws every one of them. */
export const DEFAULT_GROUP_SIZE = 100;
export const MAX_GROUP_SIZE = 1000;

/** Whole segments, never past the ceiling; a blank field is mid-edit, not zero. */
export function clampGroupSize(raw: string) {
  if (!raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(1, Math.min(MAX_GROUP_SIZE, Math.round(value)));
}
