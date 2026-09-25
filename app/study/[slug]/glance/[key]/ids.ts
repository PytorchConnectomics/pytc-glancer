/** Reading segment ids out of whatever a reader pasted.
 *
 * Shared by the panels that take a list of segments: quality control's viewer
 * selection and hand-added ids, and the semantic panel's batch move. */

/** Segment ids out of a free-text box: commas, spaces, or newlines all work. */
export function parseIds(raw: string) {
  const ids: string[] = [];
  for (const part of raw.split(/[^0-9]+/)) {
    const id = part.replace(/^0+(?=\d)/, "");
    if (id && id.length <= 20 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** The segments a Neuroglancer view has switched on, out of whatever the reader
 * copied from it: the page URL, the state JSON, or bare ids.
 *
 * The viewer runs on another origin, so the page cannot read its state; the
 * reader carries it across. A segmentation layer lists its segments with a
 * leading "!" on the ones whose mesh is hidden, so only the unmarked ones are
 * the selection. Returns null when nothing in the text reads as a state or an id. */
export function viewerSegments(raw: string): string[] | null {
  const text = raw.trim();
  if (!text) return null;
  let state: unknown = null;
  const hash = text.indexOf("#!");
  const body = hash >= 0 ? text.slice(hash + 2) : text;
  for (const candidate of [body, (() => { try { return decodeURIComponent(body); } catch { return body; } })()]) {
    try { state = JSON.parse(candidate); break; } catch { /* not JSON: try the next form, then bare ids */ }
  }
  if (state && typeof state === "object") {
    const layers = Array.isArray((state as { layers?: unknown }).layers) ? (state as { layers: unknown[] }).layers : [];
    const ids: string[] = [];
    for (const layer of layers) {
      if (!layer || typeof layer !== "object") continue;
      const entry = layer as { segments?: unknown; visible?: unknown; archived?: unknown };
      if (!Array.isArray(entry.segments) || entry.visible === false || entry.archived === true) continue;
      for (const segment of entry.segments) {
        const value = String(segment).trim();
        if (value.startsWith("!")) continue;
        for (const id of parseIds(value)) if (!ids.includes(id)) ids.push(id);
      }
    }
    return ids;
  }
  const ids = parseIds(text);
  return ids.length ? ids : null;
}
