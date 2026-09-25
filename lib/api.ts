import { mergeEdits, summarizeEdits, deriveEdits, compareViews } from "./edits";
import { summarizeReport, summarizeReview, summaryJson, type HistoryState } from "./history";
import type { Actor } from "./accounts";
import type { AppConfig } from "./config";
import { metadataStoreFor, parseServiceAccount, readObject } from "./gcs";
import { parseNeuroglancerUrl, publicOrigin, shareableLink, shortKey, validateState } from "./glance";
import { bodyObject, failure, json, rejectUnknown } from "./http";
import { compositionCandidates, parseComposition, segmentationsFromState } from "./composition";
import { datasetFromState, figureObjectName, parseReport, reportObjectName } from "./report";
import { MAX_REVIEW_BYTES, emptyReview, parseReview, reviewIsEmpty } from "./review";
import { generateStateFromStore } from "./omezarr/generate";
import { resolveSourcePath } from "./sources";

interface StudyRow {
  id: string;
  account_id: string;
  title: string;
  slug: string;
  description: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  glance_count?: number;
}

interface GlanceRow {
  id: string; study_id: string; source_id: string | null; short_key: string; short_name: string | null; title: string | null;
  url_base: string; state: string; source_path: string | null; position: number; archived_at: number | null; created_at: number; updated_at: number;
}

function kebab(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function textField(value: unknown, name: string, max: number, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${name} is required.`);
  if (trimmed.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return trimmed;
}

async function insertStudy(db: D1Database, actor: Actor, id: string, title: string, description: string | null, now: number) {
  const base = kebab(title).slice(0, 52);
  const fallback = `study-${id.replace(/-/g, "").slice(0, 8)}`;
  function* candidates() {
    if (base) {
      yield base;
      for (let suffix = 2; suffix <= 9999; suffix += 1) yield `${base}-${suffix}`;
    }
    yield fallback;
  }
  for (const slug of candidates()) {
    if (!slug || slug.length > 60) throw new Error("Internal slug invariant failed.");
    try {
      await db.prepare("INSERT INTO studies (id,account_id,title,slug,description,archived_at,created_at,updated_at) VALUES (?,?,?,?,?,NULL,?,?)").bind(id, actor.id, title, slug, description, now, now).run();
      return slug;
    } catch (error) {
      if (!String(error).includes("UNIQUE constraint failed")) throw error;
    }
  }
  throw new Error("Unable to allocate a unique study slug.");
}

/* Every study read starts here, so no route can forget the account: a study
 * belonging to another one is not merely hidden from the listing, it does not
 * resolve by slug or by id either, and the caller gets the same 404 as for a
 * study that never existed. */
async function findStudy(db: D1Database, actor: Actor, identifier: string) {
  return db.prepare("SELECT * FROM studies WHERE account_id = ? AND (id = ? OR slug = ?)").bind(actor.id, identifier, identifier).first<StudyRow>();
}

async function listStudies(request: Request, db: D1Database, actor: Actor) {
  const url = new URL(request.url);
  const include = url.searchParams.get("include_archived") === "1";
  const query = `SELECT s.*, (SELECT COUNT(*) FROM glances g WHERE g.study_id=s.id AND g.archived_at IS NULL) AS glance_count FROM studies s WHERE s.account_id = ?${include ? "" : " AND s.archived_at IS NULL"} ORDER BY s.updated_at DESC, s.id ASC`;
  const result = await db.prepare(query).bind(actor.id).all<StudyRow>();
  return json(result.results);
}

async function createStudy(request: Request, db: D1Database, actor: Actor) {
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["title", "description"]);
    const title = textField(body.title, "title", 200, true)!;
    const description = textField(body.description, "description", 2000) ?? null;
    const id = crypto.randomUUID();
    const now = Date.now();
    const slug = await insertStudy(db, actor, id, title, description, now);
    return json({ id, account_id: actor.id, title, slug, description, archived_at: null, created_at: now, updated_at: now, glance_count: 0 }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return failure("conflict", "That study already exists.", 409);
    return failure("invalid_request", error instanceof Error ? error.message : String(error), 422);
  }
}

async function getStudy(request: Request, db: D1Database, actor: Actor, identifier: string) {
  const study = await findStudy(db, actor, identifier);
  if (!study) return failure("not_found", "No such study.", 404);
  const include = new URL(request.url).searchParams.get("include_archived") === "1";
  const result = await db.prepare(`SELECT * FROM glances WHERE study_id = ? ${include ? "" : "AND archived_at IS NULL"} ORDER BY position ASC, created_at ASC, id ASC`).bind(study.id).all();
  const origin = publicOrigin(request);
  const glances = (result.results as unknown as GlanceRow[]).map((glance) => ({ ...glance, shareable_link: shareableLink(glance.url_base, origin, glance.short_key, glance.short_name) }));
  return json({ ...study, glances });
}

async function patchStudy(request: Request, db: D1Database, actor: Actor, identifier: string) {
  const study = await findStudy(db, actor, identifier);
  if (!study) return failure("not_found", "No such study.", 404);
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["title", "description", "archived"]);
    if (!Object.keys(body).length) throw new Error("At least one field is required.");
    if (study.archived_at !== null && !(Object.keys(body).length === 1 && body.archived === false)) return failure("archived", "Unarchive the study before changing it.", 410);
    const title = body.title === undefined ? study.title : textField(body.title, "title", 200, true)!;
    const description = body.description === undefined ? study.description : textField(body.description, "description", 2000) ?? null;
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw new Error("archived must be a boolean.");
    const archivedAt = body.archived === true ? Date.now() : body.archived === false ? null : study.archived_at;
    const now = Date.now();
    await db.prepare("UPDATE studies SET title=?, description=?, archived_at=?, updated_at=? WHERE id=?").bind(title, description, archivedAt, now, study.id).run();
    return json({ ...study, title, description, archived_at: archivedAt, updated_at: now });
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
}

async function listSources(request: Request, db: D1Database) {
  const include = new URL(request.url).searchParams.get("include_inactive") === "1";
  const result = await db.prepare(`SELECT * FROM data_sources ${include ? "" : "WHERE active = 1"} ORDER BY label COLLATE NOCASE, id`).all();
  return json(result.results);
}

function optionalGlanceText(value: unknown, name: string, max: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return trimmed || null;
}

function validateShortName(value: unknown) {
  const name = optionalGlanceText(value, "short_name", 60);
  if (name && !/^[a-z0-9-]+$/.test(name)) throw new Error("short_name may contain only lowercase letters, digits, and hyphens.");
  return name;
}

async function createGlance(request: Request, db: D1Database, config: AppConfig, gcsKey: string | undefined, actor: Actor) {
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["study_id", "url", "source_id", "path", "title", "short_name"]);
    if (typeof body.study_id !== "string" || !body.study_id) throw new Error("study_id is required.");
    const study = await db.prepare("SELECT id, archived_at FROM studies WHERE id = ? AND account_id = ?").bind(body.study_id, actor.id).first<{ id: string; archived_at: number | null }>();
    if (!study) return failure("not_found", "No such study.", 404);
    if (study.archived_at !== null) return failure("archived", "Unarchive the study before adding a glance.", 410);
    const hasUrl = Object.prototype.hasOwnProperty.call(body, "url");
    const hasPath = Object.prototype.hasOwnProperty.call(body, "path");
    if (hasUrl === hasPath) throw new Error("Supply exactly one of url or path.");
    if (hasUrl && (typeof body.url !== "string" || !body.url.trim())) throw new Error("url must be a non-empty string.");
    if (hasPath && (typeof body.path !== "string" || !body.path.trim())) throw new Error("path must be a non-empty string.");
    const title = optionalGlanceText(body.title, "title", 200);
    const name = validateShortName(body.short_name);
    let state: Record<string, unknown>;
    let urlBase: string;
    let sourceId: string | null = null;
    let sourcePath: string | null = null;

    if (hasUrl) {
      if (body.source_id !== undefined) throw new Error("source_id is only valid with path.");
      const parsed = await parseNeuroglancerUrl(String(body.url), publicOrigin(request), db, config);
      state = parsed.state;
      urlBase = parsed.urlBase;
    } else {
      if (!config.sources.length) return failure("no_sources_configured", "No OME-Zarr sources are configured; URL import remains available.", 422);
      if (typeof body.source_id !== "string" || !body.source_id) throw new Error("source_id is required with path.");
      const configured = config.sources.find((source) => source.id === body.source_id);
      const active = configured ? await db.prepare("SELECT active FROM data_sources WHERE id = ?").bind(configured.id).first<{ active: number }>() : null;
      if (!configured || !active?.active) throw new Error("source_id is unknown or inactive.");
      const account = parseServiceAccount(gcsKey);
      if (!account) return failure("source_unavailable", "GCS_SA_KEY is missing or unparseable; paste-based creation remains available.", 503);
      sourceId = configured.id;
      sourcePath = resolveSourcePath(configured, String(body.path));
      const layerSource = `zarr://gs+ngauth+${configured.ngauth_base}/${configured.bucket}/${sourcePath}`;
      try { state = await generateStateFromStore(layerSource, await metadataStoreFor(configured, sourcePath, account)); }
      catch (error) { return failure("source_unavailable", error instanceof Error ? error.message : String(error), 503); }
      urlBase = config.defaultViewerUrl;
    }

    validateState(state);
    const serialized = JSON.stringify(state);
    const id = crypto.randomUUID();
    const key = shortKey();
    const now = Date.now();
    await db.prepare(`INSERT INTO glances (id,study_id,source_id,short_key,short_name,title,url_base,state,source_path,position,archived_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM glances WHERE study_id=?),NULL,?,?)`)
      .bind(id, study.id, sourceId, key, name, title, urlBase, serialized, sourcePath, study.id, now, now).run();
    return json({ id, study_id: study.id, source_id: sourceId, short_key: key, short_name: name, title, url_base: urlBase, state, source_path: sourcePath, position: await glancePosition(db, key), archived_at: null, created_at: now, updated_at: now, shareable_link: shareableLink(urlBase, publicOrigin(request), key, name) }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) return failure("conflict", "Could not allocate a unique glance key.", 409);
    return failure("invalid_request", error instanceof Error ? error.message : String(error), 422);
  }
}

async function glancePosition(db: D1Database, key: string) { return (await db.prepare("SELECT position FROM glances WHERE short_key=?").bind(key).first<{ position: number }>())?.position ?? 0; }

async function patchGlance(request: Request, db: D1Database, actor: Actor, key: string) {
  const glance = await db.prepare("SELECT g.*, s.archived_at AS study_archived_at FROM glances g JOIN studies s ON s.id=g.study_id WHERE g.short_key=? AND s.account_id=?").bind(key, actor.id).first<GlanceRow & { study_archived_at: number | null }>();
  if (!glance) return failure("not_found", "No such glance.", 404);
  if (glance.study_archived_at !== null) return failure("archived", "Unarchive the study before changing its glances.", 410);
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["title", "state", "position", "archived"]);
    if (!Object.keys(body).length) throw new Error("At least one field is required.");
    const title = body.title === undefined ? glance.title : optionalGlanceText(body.title, "title", 200);
    const state = body.state === undefined ? glance.state : JSON.stringify(validateState(body.state));
    if (body.position !== undefined && (!Number.isInteger(body.position) || Number(body.position) < 0 || Number(body.position) > 100000)) throw new Error("position must be an integer from 0 to 100000.");
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw new Error("archived must be a boolean.");
    const position = body.position === undefined ? glance.position : Number(body.position);
    const archivedAt = body.archived === true ? Date.now() : body.archived === false ? null : glance.archived_at;
    const now = Date.now();
    await db.prepare("UPDATE glances SET title=?, state=?, position=?, archived_at=?, updated_at=? WHERE short_key=?").bind(title, state, position, archivedAt, now, key).run();
    return json({ ...glance, title, state: JSON.parse(state), position, archived_at: archivedAt, updated_at: now });
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
}

/* A semantic report carries a record for every analysed segment, a few MiB of
 * JSON for a large volume. It is stored gzipped, because a D1 row holds at
 * most 2 MB and records this repetitive shrink about sixfold. */
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_STORED_REPORT_BYTES = 1_900_000;
const PACKED = "gz:";

async function drain(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A report body as the glance_reports row keeps it: gzip, base64, marked. */
export async function packBody(body: string) {
  const bytes = await drain(new Blob([body]).stream().pipeThrough(new CompressionStream("gzip")));
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return PACKED + btoa(binary);
}

/** The JSON a stored row holds. Rows written before packing are plain JSON. */
export async function unpackBody(stored: string) {
  if (!stored.startsWith(PACKED)) return stored;
  const binary = atob(stored.slice(PACKED.length));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(await drain(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))));
}
export const packReport = packBody;
export const unpackReport = unpackBody;

const MAX_COMPOSITION_BYTES = 256 * 1024;
const MAX_FIGURE_BYTES = 8 * 1024 * 1024;
const FIGURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };

/** Resolve a glance to its dataset reference and the credential that reads it.
 *
 * Without a key the read falls back to anonymous, which serves deployments
 * that publish reports openly. Reports stay confined to a configured source
 * either way, and image chunks are untouched by this path. */
async function reportContext(db: D1Database, config: AppConfig, gcsKey: string | undefined, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return { failed: failure("not_found", "No such glance.", 404) };
  const account = parseServiceAccount(gcsKey);
  try { return { reference: datasetFromState(JSON.parse(glance.state), config), account }; }
  catch (error) { return { failed: failure("report_unavailable", error instanceof Error ? error.message : String(error), 404) }; }
}

async function readReport(reference: ReturnType<typeof datasetFromState>, account: ReturnType<typeof parseServiceAccount>) {
  const object = await readObject(reference.bucket, reportObjectName(reference), account, MAX_REPORT_BYTES);
  if (!object) return null;
  return parseReport(new TextDecoder().decode(object.bytes), reference);
}

/** An uploaded report, parsed against the same schema as a published one. */
async function storedReport(db: D1Database, config: AppConfig, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return null;
  const row = await db.prepare("SELECT body FROM glance_reports WHERE glance_id = ?").bind(glance.id).first<{ body: string }>();
  if (!row) return null;
  return parseReport(await unpackBody(row.body), datasetFromState(JSON.parse(glance.state), config));
}

async function putGlanceReport(request: Request, db: D1Database, config: AppConfig, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  if (glance.study_archived_at !== null) return failure("archived", "Unarchive the study before changing its report.", 410);
  const source = new URL(request.url).searchParams.get("source") ?? "upload";
  if (!["upload", "ingest"].includes(source)) return failure("invalid_request", "source must be ingest or upload.", 422);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REPORT_BYTES) return failure("invalid_request", `The report must be at most ${MAX_REPORT_BYTES} bytes.`, 413);
  let report;
  try {
    // Parse before storing so a malformed upload fails here, not on every read.
    report = parseReport(body, datasetFromState(JSON.parse(glance.state), config));
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const packed = await packReport(body);
  if (packed.length > MAX_STORED_REPORT_BYTES) return failure("invalid_request", `The report compresses to ${packed.length} bytes, past the ${MAX_STORED_REPORT_BYTES} a stored row can hold.`, 413);
  const now = Date.now();
  await db.batch([
    currentWrite(db, glance.id, "report", packed, now),
    versionWrite(db, glance.id, crypto.randomUUID(), "report", source, actor.id, packed, summaryJson(summarizeReport(report)), now)
  ]);
  const { edits, edits_error } = await reportOverlay(db, glance.id, report, false);
  return json({ edits, edits_error, stored: true, bytes: body.length, stored_bytes: packed.length, updated_at: now }, 200, { "Cache-Control": "no-store" });
}

/* An uploaded report wins over a published one: pytc_glancer owns reports and
 * figures, and the bucket read stays only as a fallback for datasets whose
 * pipeline still publishes them there. */
async function getGlanceReport(request: Request, db: D1Database, config: AppConfig, gcsKey: string | undefined, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  const raw = new URL(request.url).searchParams.get("raw") === "1";
  try {
    const stored = await storedReport(db, config, actor, key);
    if (stored) return json({ ...stored, ...await reportOverlay(db, glance.id, stored, raw), source: "pytc_glancer" }, 200, { "Cache-Control": "no-store" });
  } catch (error) { return failure("report_unavailable", error instanceof Error ? error.message : String(error), 422); }
  const context = await reportContext(db, config, gcsKey, actor, key);
  if (context.failed) return context.failed;
  try {
    const report = await readReport(context.reference!, context.account ?? null);
    if (!report) return failure("report_unavailable", `No report uploaded for this glance, and none published at gs://${context.reference!.bucket}/${reportObjectName(context.reference!)}.`, 404);
    return json({ ...report, ...await reportOverlay(db, glance.id, report, raw), source: "bucket", bucket: context.reference!.bucket, directory: context.reference!.directory }, 200, { "Cache-Control": "no-store" });
  } catch (error) { return failure("report_unavailable", error instanceof Error ? error.message : String(error), 502); }
}

/** What a segmentation's foreground is made of, read straight from the bucket.
 *
 * Unlike the report, this is never stored: nothing in the app edits it, so a
 * stored copy could only drift from what the pipeline last published. The
 * layers are tried in the state's own order and the first that carries a
 * summary answers, with the layer it came from named in the body -- a glance
 * can hold two variants of one volume, and a composition describes exactly one
 * of them.
 */
async function getGlanceComposition(db: D1Database, config: AppConfig, gcsKey: string | undefined, actor: Actor, key: string) {
  const glance = await db.prepare("SELECT g.state FROM glances g JOIN studies s ON s.id=g.study_id WHERE g.short_key=? AND s.account_id=?").bind(key, actor.id).first<{ state: string }>();
  if (!glance) return failure("not_found", "No such glance.", 404);
  const account = parseServiceAccount(gcsKey);
  const references = segmentationsFromState(JSON.parse(glance.state), config);
  if (!references.length) return failure("composition_unavailable", "This glance has no segmentation layer in a configured source, so no composition is readable for it.", 404);
  const tried: string[] = [];
  /* A denial is not an answer: without a key the read is anonymous, and an
   * unpublished object denies rather than 404s. Remember the first one and
   * keep looking, so a summary published in a readable place still wins, and
   * report the denial only if nothing else answers. */
  let denied = "";
  for (const reference of references) {
    for (const name of compositionCandidates(reference)) {
      tried.push(`gs://${reference.bucket}/${name}`);
      let object;
      try { object = await readObject(reference.bucket, name, account, MAX_COMPOSITION_BYTES); }
      catch (error) { denied ||= error instanceof Error ? error.message : String(error); continue; }
      if (!object) continue;
      try { return json(parseComposition(new TextDecoder().decode(object.bytes), reference), 200, { "Cache-Control": "no-store" }); }
      catch (error) { return failure("composition_unavailable", error instanceof Error ? error.message : String(error), 422); }
    }
  }
  if (denied) return failure("composition_unavailable", denied, 502);
  return failure("composition_unavailable", `No semantic composition published for this glance. Looked for ${tried.join(", ")}.`, 404);
}

/* A glance's review record. Verdicts are the reader's, not the pipeline's, so
 * they live in their own table: re-uploading a regenerated report leaves them
 * standing, and overlay reads leave them readable as a
 * record of what was decided. */
async function getGlanceReview(db: D1Database, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  const row = await db.prepare("SELECT body, updated_at FROM glance_reviews WHERE glance_id = ?").bind(glance.id).first<{ body: string; updated_at: number }>();
  if (!row) {
    // An unreviewed glance is not an error: answer the empty record the panels
    // would otherwise have to invent for themselves.
    return json({ ...emptyReview(), updated_at: null }, 200, { "Cache-Control": "no-store" });
  }
  try { return json({ ...parseReview(row.body), updated_at: row.updated_at }, 200, { "Cache-Control": "no-store" }); }
  catch (error) { return failure("review_unreadable", error instanceof Error ? error.message : String(error), 422); }
}

async function putGlanceReview(request: Request, db: D1Database, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  if (glance.study_archived_at !== null) return failure("archived", "Unarchive the study before reviewing its glances.", 410);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REVIEW_BYTES) return failure("invalid_request", `The review must be at most ${MAX_REVIEW_BYTES} bytes.`, 413);
  let review;
  // Normalise before storing, so a read never has to repair what a write let through.
  try { review = parseReview(raw); }
  catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const now = Date.now();
  const present = Number(!reviewIsEmpty(review));
  const packed = present ? await packBody(JSON.stringify(review)) : "";
  const summary = summaryJson(summarizeReview(review));
  /* The fold decision belongs inside the transaction. In particular, a report
   * committed before this batch must form a boundary, even at the same time. */
  await db.batch([
    currentWrite(db, glance.id, "review", present ? JSON.stringify(review) : null, now),
    db.prepare(`UPDATE glance_versions SET body = ?, summary = ?, updated_at = ?
      WHERE id = (SELECT MAX(id) FROM glance_versions WHERE glance_id = ?)
        AND glance_id = ? AND kind = 'review' AND source = 'review' AND author = ? AND present = 1
        AND ? = 1 AND created_at >= ?`).bind(packed, summary, now, glance.id, glance.id, actor.id, present, now - 10 * 60 * 1000),
    versionWrite(db, glance.id, crypto.randomUUID(), "review", "review", actor.id, present ? packed : null, summary, now, null, true)
  ]);
  return json({ ...review, updated_at: present ? now : null }, 200, { "Cache-Control": "no-store" });
}

/* Every report, review, and history route resolves ownership before looking at
 * stored bodies or points. A foreign key has the same answer as a missing one. */
async function resolveGlance(db: D1Database, actor: Actor, key: string) {
  return db.prepare("SELECT g.id, g.state, s.archived_at AS study_archived_at FROM glances g JOIN studies s ON s.id = g.study_id WHERE g.short_key = ? AND s.account_id = ?")
    .bind(key, actor.id).first<{ id: string; state: string; study_archived_at: number | null }>();
}

function currentWrite(db: D1Database, glance: string, kind: "report" | "review", body: string | null, now: number) {
  const table = kind === "report" ? "glance_reports" : "glance_reviews";
  return body === null ? db.prepare(`DELETE FROM ${table} WHERE glance_id = ?`).bind(glance)
    : db.prepare(`INSERT INTO ${table} (glance_id, body, created_at, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(glance_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`).bind(glance, body, now, now);
}

function versionWrite(db: D1Database, glance: string, operation: string, kind: string, source: string, author: string,
  body: string | null, summary: string, now: number, restoredFrom: number | null = null, fallback = false) {
  return db.prepare(`INSERT INTO glance_versions (glance_id,operation,kind,source,author,present,body,summary,restored_from,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?${fallback ? " WHERE changes() = 0" : ""}`)
    .bind(glance, operation, kind, source, author, Number(body !== null), body ?? "", summary, restoredFrom, now, now);
}

/** Canonical hashes bind the exact candidate, independent of request time or
 * object key insertion order. The pipeline itself remains exact posted text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function reportOverlay(db: D1Database, glance: string, report: ReturnType<typeof parseReport>, raw: boolean) {
  if (raw) return { edits: undefined, edits_error: undefined };
  const row = await db.prepare("SELECT body FROM glance_reviews WHERE glance_id = ?").bind(glance).first<{ body: string }>();
  let review = emptyReview(), edits_error: string | undefined;
  try { if (row) review = parseReview(row.body); }
  catch (error) { edits_error = error instanceof Error ? error.message : String(error); }
  const merged = mergeEdits(report, review.class_review), summary = summarizeEdits(merged);
  return { ...merged.report, merged: true, edits: { ...summary, inactive: summary.inactive.slice(0, 500), inactive_total: summary.inactive.length }, ...(edits_error ? { edits_error } : {}) };
}
async function versionReport(db: D1Database, actor: Actor, key: string, point: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  const row = await db.prepare("SELECT body,source,created_at FROM glance_versions WHERE glance_id = ? AND id = ? AND kind = 'report' AND present = 1")
    .bind(glance.id, Number(point)).first<{ body: string; source: string; created_at: number }>();
  if (!row) return failure("not_found", "No such report version.", 404);
  return json({ body: await unpackBody(row.body), source: row.source, created_at: row.created_at });
}
async function unbakeGlance(request: Request, db: D1Database, config: AppConfig, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  if (glance.study_archived_at !== null) return failure("archived", "Unarchive the study before migrating its report.", 410);
  let body, pipeline, packed: string;
  try {
    body = await request.json() as { pipeline: string; base: { kind: string; detail: string }; apply?: boolean; derived_at?: number; expect?: string; expect_outcome?: string; accept?: boolean };
    if (typeof body.pipeline !== "string") throw new Error("pipeline must be the exact report JSON text.");
    if (!body.base || !["history", "file", "gcs"].includes(body.base.kind) || typeof body.base.detail !== "string") throw new Error("A pipeline base is required.");
    if (new TextEncoder().encode(body.pipeline).length > MAX_REPORT_BYTES) return failure("invalid_request", "Report exceeds its size limit.", 413);
    pipeline = parseReport(body.pipeline, datasetFromState(JSON.parse(glance.state), config));
    packed = await packBody(body.pipeline);
    if (packed.length > MAX_STORED_REPORT_BYTES) return failure("invalid_request", "Packed report exceeds its size limit.", 413);
  } catch (error) { return failure("invalid_request", String(error), 422); }
  /* One SELECT pins both current resources and their history, even when a
   * proofreading write coalesces into an existing version in the same ms. */
  const pinned = await db.prepare(`SELECT
    (SELECT body FROM glance_reports WHERE glance_id = ?) AS report,
    (SELECT updated_at FROM glance_reports WHERE glance_id = ?) AS report_at,
    (SELECT body FROM glance_reviews WHERE glance_id = ?) AS review,
    (SELECT updated_at FROM glance_reviews WHERE glance_id = ?) AS review_at,
    (SELECT MAX(id) FROM glance_versions WHERE glance_id = ? AND kind = 'report') AS report_id,
    (SELECT MAX(id) FROM glance_versions WHERE glance_id = ? AND kind = 'review') AS review_id`)
    .bind(...Array(6).fill(glance.id)).first<{ report: string | null; report_at: number | null; review: string | null; review_at: number | null; report_id: number | null; review_id: number | null }>();
  if (!pinned?.report) return failure("no_report", "No stored report to migrate.", 409);
  const derived_at = body.derived_at ?? Date.now();
  if (!Number.isSafeInteger(derived_at) || derived_at < 0 || (body.apply && body.derived_at === undefined)) return failure("invalid_request", "derived_at is required for apply and must be an epoch in milliseconds.", 422);
  let current, review, mergedReview, derivation;
  try {
    current = parseReport(await unpackBody(pinned.report), datasetFromState(JSON.parse(glance.state), config));
    review = pinned.review ? parseReview(pinned.review) : emptyReview();
    derivation = deriveEdits(current, pipeline, derived_at);
    const candidate = { ...review, class_review: { ...derivation.edits, ...review.class_review } };
    const raw = JSON.stringify(candidate);
    mergedReview = parseReview(raw);
    if (new TextEncoder().encode(raw).length > MAX_REVIEW_BYTES) throw new Error("Merged review exceeds its byte limit.");
  } catch (error) { return failure("invalid_request", String(error), 422); }
  const difference = compareViews(mergeEdits(current, review.class_review).report, mergeEdits(pipeline, mergedReview.class_review).report);
  const state = await sha(canonical(pinned));
  const outcome = await sha(canonical({ state, pipeline: await sha(body.pipeline), review: mergedReview, difference, cannot_express: derivation.cannotExpress }));
  const clean = !difference.classes.length && difference.total_voxels[0] === difference.total_voxels[1] && !derivation.cannotExpress.length;
  const result = { base: body.base, derived_at, derived: Object.entries(derivation.edits).map(([id, edit]) => ({ id, from: edit.class, to: edit.verdict === "reject" ? "rejected" : edit.to })), cannot_express: derivation.cannotExpress, difference, state, outcome, clean };
  if (!body.apply) return json(result);
  if (body.expect !== state) return failure("changed", "Glance changed since the plan; re-plan.", 409);
  if (body.expect_outcome !== outcome) return failure("outcome_changed", "Candidate differs from the reviewed plan; re-plan.", 409);
  if (!clean && body.accept !== true) return failure("needs_acceptance", "View would change; review the differences and explicitly accept.", 409);
  const operation = crypto.randomUUID(), now = Date.now();
  const rawReview = reviewIsEmpty(mergedReview) ? null : JSON.stringify(mergedReview);
  const packedReview = rawReview === null ? "" : await packBody(rawReview);
  /* Each statement checks the pinned rows inside the transaction. Subsequent
   * guards recognize only this operation's preceding writes; no other writer
   * can run between statements in D1's atomic batch. Body guards also catch
   * same-timestamp review coalescing. No compensating writes are necessary. */
  function guard(stage: number): { sql: string; values: (string | number | null)[] } {
    const values: (string | number | null)[] = [];
    const checks: string[] = [];
    for (const kind of ["report", "review"] as const) {
      const ownVersion = stage >= (kind === "report" ? 1 : 2);
      checks.push(`(SELECT MAX(id) FROM glance_versions WHERE glance_id = ? AND kind = '${kind}') IS ${ownVersion ? `(SELECT MAX(id) FROM glance_versions WHERE glance_id = ? AND kind = '${kind}' AND operation = ?)` : "?"}`);
      values.push(glance!.id, ...(ownVersion ? [glance!.id, operation] : [pinned![`${kind}_id`]]));
      const ownRow = kind === "report" && stage >= 3;
      checks.push(`(SELECT updated_at FROM glance_${kind === "report" ? "reports" : "reviews"} WHERE glance_id = ?) IS ?`);
      values.push(glance!.id, ownRow ? now : pinned![`${kind}_at`]);
      checks.push(`(SELECT body FROM glance_${kind === "report" ? "reports" : "reviews"} WHERE glance_id = ?) IS ?`);
      values.push(glance!.id, ownRow ? packed : pinned![kind]);
    }
    if (stage) { checks.push("changes() = 1"); }
    return { sql: checks.join(" AND "), values };
  }
  const reportGuard = guard(0), reviewGuard = guard(1), currentReportGuard = guard(2), currentReviewGuard = guard(3);
  const version = (kind: string, value: string, present: number, summary: string, g: ReturnType<typeof guard>) => db.prepare(`INSERT INTO glance_versions
    (glance_id,operation,kind,source,author,present,body,summary,created_at,updated_at)
    SELECT ?,?,?,'ingest',?,?,?,?,?,? WHERE ${g.sql}`).bind(glance.id, operation, kind, actor.id, present, value, summary, now, now, ...g.values);
  const results = await db.batch([
    version("report", packed, 1, summaryJson(summarizeReport(pipeline)), reportGuard),
    version("review", packedReview, Number(rawReview !== null), summaryJson(summarizeReview(mergedReview)), reviewGuard),
    db.prepare(`UPDATE glance_reports SET body = ?, updated_at = ? WHERE glance_id = ? AND ${currentReportGuard.sql}`).bind(packed, now, glance.id, ...currentReportGuard.values),
    rawReview === null
      ? db.prepare(`DELETE FROM glance_reviews WHERE glance_id = ? AND ${currentReviewGuard.sql}`).bind(glance.id, ...currentReviewGuard.values)
      : db.prepare(`INSERT INTO glance_reviews (glance_id,body,created_at,updated_at) SELECT ?,?,?,? WHERE ${currentReviewGuard.sql}
          ON CONFLICT(glance_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`).bind(glance.id, rawReview, now, now, ...currentReviewGuard.values)
  ]);
  if (!results[0].meta.changes) return failure("changed", "Glance changed since the plan; re-plan.", 409);
  return json({ ...result, applied: true, operation });
}

interface VersionRow { id: number; kind: "report" | "review"; present: number; body: string; summary: string | null; }
interface PointRow { point: number; operation: string; source: string; author: string; started_at: number; ended_at: number; kinds: string; restored_from: number | null; restored_from_at: number | null; }
/* Bodies are deliberately absent from ordinary listing queries. Only the two
 * migration rows may need hydration, and their summaries are then cached. */
const POINT_COLUMNS = `MAX(v.id) AS point, v.operation, v.source, v.author, MIN(v.created_at) AS started_at,
  MAX(v.updated_at) AS ended_at, GROUP_CONCAT(v.kind) AS kinds, v.restored_from,
  (SELECT MAX(t.updated_at) FROM glance_versions t WHERE t.glance_id = v.glance_id AND t.operation =
    (SELECT p.operation FROM glance_versions p WHERE p.glance_id = v.glance_id AND p.id = v.restored_from)) AS restored_from_at`;

async function stateAt(db: D1Database, glance: string, point: number): Promise<HistoryState> {
  const rows = await db.prepare(`SELECT id,kind,present,summary FROM glance_versions WHERE glance_id = ? AND id IN
    (SELECT MAX(id) FROM glance_versions WHERE glance_id = ? AND id <= ? GROUP BY kind)`).bind(glance, glance, point).all<VersionRow>();
  const report = rows.results.find((row) => row.kind === "report"), review = rows.results.find((row) => row.kind === "review");
  return { report_version: report?.id ?? null, report: report?.present && report.summary ? JSON.parse(report.summary) : null,
    review_version: review?.id ?? null, review: review?.present && review.summary ? JSON.parse(review.summary) : summarizeReview(emptyReview()) };
}
async function hydrateBaseline(db: D1Database, glance: { id: string; state: string }, config: AppConfig) {
  const rows = await db.prepare("SELECT id,kind,present,body FROM glance_versions WHERE glance_id = ? AND source = 'baseline' AND summary IS NULL LIMIT 2").bind(glance.id).all<VersionRow>();
  for (const row of rows.results) {
    let summary;
    try {
      summary = row.kind === "report"
        ? row.present ? summarizeReport(parseReport(await unpackBody(row.body), datasetFromState(JSON.parse(glance.state), config))) : null
        : summarizeReview(row.present ? parseReview(await unpackBody(row.body)) : emptyReview());
    } catch {
      /* A damaged baseline must not hide the other restore points. Cache the
       * marker so subsequent listings do not retry the unreadable body. */
      summary = { unreadable: true as const };
    }
    await db.prepare("UPDATE glance_versions SET summary = ? WHERE glance_id = ? AND id = ? AND summary IS NULL").bind(summaryJson(summary), glance.id, row.id).run();
  }
}
async function listVersions(request: Request, db: D1Database, config: AppConfig, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  const params = new URL(request.url).searchParams;
  const before = params.has("before") ? Number(params.get("before")) : Number.MAX_SAFE_INTEGER;
  const requested = params.has("limit") ? Number(params.get("limit")) : 50;
  if (!Number.isSafeInteger(before) || before <= 0 || !Number.isSafeInteger(requested) || requested <= 0)
    return failure("invalid_request", "before and limit must be positive integers.", 422);
  const limit = Math.min(requested, 200);
  await hydrateBaseline(db, glance, config);
  const rows = await db.prepare(`SELECT ${POINT_COLUMNS} FROM glance_versions v WHERE v.glance_id = ?
    GROUP BY v.operation HAVING MAX(v.id) < ? ORDER BY point DESC LIMIT ?`).bind(glance.id, before, limit + 1).all<PointRow>();
  const latest = await stateAt(db, glance.id, Number.MAX_SAFE_INTEGER);
  const entries = await Promise.all(rows.results.slice(0, limit).map(async (row) => {
    const state = await stateAt(db, glance.id, row.point);
    return { ...row, kinds: row.kinds.split(","), state, current: state.report_version === latest.report_version && state.review_version === latest.review_version };
  }));
  return json({ entries, next_before: rows.results.length > limit ? entries.at(-1)!.point : null }, 200, { "Cache-Control": "no-store" });
}

async function restoreGlance(request: Request, db: D1Database, config: AppConfig, actor: Actor, key: string) {
  const glance = await resolveGlance(db, actor, key);
  if (!glance) return failure("not_found", "No such glance.", 404);
  if (glance.study_archived_at !== null) return failure("archived", "Unarchive the study before rolling back.", 410);
  let point: number;
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["point"]);
    point = body.point as number;
    if (!Number.isSafeInteger(point) || point <= 0) return failure("no_such_point", "No such restore point.", 404);
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const target = await db.prepare(`SELECT MAX(updated_at) AS ended_at FROM glance_versions WHERE glance_id = ? GROUP BY operation HAVING MAX(id) = ?`)
    .bind(glance.id, point).first<{ ended_at: number }>();
  if (!target) return failure("no_such_point", "No such restore point.", 404);
  const rows = await db.prepare(`SELECT id,kind,present,body,summary FROM glance_versions WHERE glance_id = ? AND id IN
    (SELECT MAX(id) FROM glance_versions WHERE glance_id = ? AND id <= ? GROUP BY kind)`).bind(glance.id, glance.id, point).all<VersionRow>();
  const reportRow = rows.results.find((row) => row.kind === "report"), reviewRow = rows.results.find((row) => row.kind === "review");
  const latest = await stateAt(db, glance.id, Number.MAX_SAFE_INTEGER);
  if ((reportRow?.id ?? null) === latest.report_version && (reviewRow?.id ?? null) === latest.review_version)
    return failure("already_current", "This point is already current.", 409);
  let report = null, review, packed: string | null = null;
  try {
    /* History reviews may be packed or plain baseline JSON; current reviews
     * are always plain JSON. Absence never goes through the report parser. */
    if (reportRow?.present) {
      const raw = await unpackBody(reportRow.body);
      report = parseReport(raw, datasetFromState(JSON.parse(glance.state), config));
      packed = reportRow.body.startsWith(PACKED) ? reportRow.body : await packBody(raw);
      if (new TextEncoder().encode(raw).length > MAX_REPORT_BYTES || packed.length > MAX_STORED_REPORT_BYTES) throw new Error("Stored report exceeds its size limit.");
    }
    review = reviewRow?.present ? parseReview(await unpackBody(reviewRow.body)) : emptyReview();
    if (new TextEncoder().encode(JSON.stringify(review)).length > MAX_REVIEW_BYTES) throw new Error("Stored review exceeds its size limit.");
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const now = Date.now(), operation = crypto.randomUUID();
  const result = await db.batch([
    currentWrite(db, glance.id, "report", packed, now),
    currentWrite(db, glance.id, "review", reviewIsEmpty(review) ? null : JSON.stringify(review), now),
    versionWrite(db, glance.id, operation, "report", "restore", actor.id, reportRow?.present ? reportRow.body : null, summaryJson(report ? summarizeReport(report) : null), now, point),
    versionWrite(db, glance.id, operation, "review", "restore", actor.id, reviewRow?.present ? reviewRow.body : null, summaryJson(summarizeReview(review)), now, point)
  ]);
  return json({ point: result[3].meta.last_row_id, restored_to: point, restored_to_at: target.ended_at,
    state: { report: report ? summarizeReport(report) : null, review: summarizeReview(review) } }, 200, { "Cache-Control": "no-store" });
}

async function getGlanceFigure(db: D1Database, config: AppConfig, gcsKey: string | undefined, actor: Actor, key: string, rawIndex: string) {
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0) return failure("not_found", "No such figure.", 404);
  const context = await reportContext(db, config, gcsKey, actor, key);
  if (context.failed) return context.failed;
  try {
    const report = await storedReport(db, config, actor, key).catch(() => null) ?? await readReport(context.reference!, context.account ?? null);
    const figure = report?.figures.find((entry) => entry.index === index);
    if (!figure) return failure("report_unavailable", "No such figure in the published report.", 404);
    const object = await readObject(context.reference!.bucket, figureObjectName(context.reference!, figure), context.account ?? null, MAX_FIGURE_BYTES);
    if (!object) return failure("report_unavailable", "The report names a figure that is not in the bucket.", 404);
    // The declared type comes from the report's own extension allowlist rather
    // than from the object's stored Content-Type, and the CSP keeps a scripted
    // SVG inert even if one is ever published here.
    const type = FIGURE_TYPES[figure.path.toLowerCase().split(".").pop() as string] ?? "application/octet-stream";
    return new Response(object.bytes as BodyInit, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
  } catch (error) { return failure("report_unavailable", error instanceof Error ? error.message : String(error), 502); }
}

/** A path segment as the route means it, tolerating a malformed escape.
 *
 * `decodeURIComponent` throws on a stray `%`, and a thrown URIError leaves the
 * runtime to answer with its own non-JSON error page. An undecodable segment
 * simply matches no record, which is the 404 the caller deserves anyway. */
function segment(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

async function routeApi(request: Request, db: D1Database, config: AppConfig, actor: Actor, gcsKey?: string) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  // Which account this session is working in. The header already knows the
  // label; the page asks rather than being told at build time, so a sign-in as
  // another account shows the workspace it actually reads.
  if (parts[1] === "session" && parts.length === 2 && request.method === "GET") return json(actor, 200, { "Cache-Control": "no-store" });
  if (parts[1] === "sources" && parts.length === 2 && request.method === "GET") return listSources(request, db);
  if (parts[1] === "studies" && parts.length === 2) {
    if (request.method === "GET") return listStudies(request, db, actor);
    if (request.method === "POST") return createStudy(request, db, actor);
  }
  if (parts[1] === "studies" && parts.length === 3) {
    if (request.method === "GET") return getStudy(request, db, actor, segment(parts[2]));
    if (request.method === "PATCH") return patchStudy(request, db, actor, segment(parts[2]));
  }
  if (parts[1] === "glances" && parts.length === 2 && request.method === "POST") return createGlance(request, db, config, gcsKey, actor);
  if (parts[1] === "glances" && parts.length === 3 && request.method === "PATCH") return patchGlance(request, db, actor, segment(parts[2]));
  if (parts[1] === "glances" && parts.length === 4) {
    if (parts[3] === "versions" && request.method === "GET") return listVersions(request, db, config, actor, segment(parts[2]));
    if (parts[3] === "correct" && request.method === "POST") {
      if (!await resolveGlance(db, actor, segment(parts[2]))) return failure("not_found", "No such glance.", 404);
      return failure("gone", "Correct the report was removed: edits now apply automatically. Reload the page.", 410);
    }
    if (parts[3] === "unbake" && request.method === "POST") return unbakeGlance(request, db, config, actor, segment(parts[2]));
    if (parts[3] === "restore" && request.method === "POST") return restoreGlance(request, db, config, actor, segment(parts[2]));
  }
  if (parts[1] === "glances" && parts.length === 6 && parts[3] === "versions" && parts[5] === "report" && request.method === "GET") return versionReport(db, actor, segment(parts[2]), parts[4]);
  if (parts[1] === "glances" && parts.length === 4 && parts[3] === "report" && request.method === "PUT") return putGlanceReport(request, db, config, actor, segment(parts[2]));
  if (parts[1] === "glances" && parts.length === 4 && parts[3] === "report" && request.method === "GET") return getGlanceReport(request, db, config, gcsKey, actor, segment(parts[2]));
  if (parts[1] === "glances" && parts.length === 6 && parts[3] === "report" && parts[4] === "figures" && request.method === "GET") return getGlanceFigure(db, config, gcsKey, actor, segment(parts[2]), parts[5]);
  if (parts[1] === "glances" && parts.length === 4 && parts[3] === "composition" && request.method === "GET") return getGlanceComposition(db, config, gcsKey, actor, segment(parts[2]));
  if (parts[1] === "glances" && parts.length === 4 && parts[3] === "review" && request.method === "GET") return getGlanceReview(db, actor, segment(parts[2]));
  if (parts[1] === "glances" && parts.length === 4 && parts[3] === "review" && request.method === "PUT") return putGlanceReview(request, db, actor, segment(parts[2]));
  return failure("not_found", "No such API endpoint.", 404);
}

/** Every API answer is JSON, including the ones no route planned for.
 *
 * An escaping error in a path, a D1 fault mid-query, or any other unplanned
 * throw otherwise reaches the runtime, which substitutes a plain-text or HTML
 * error page of its own. The panels read these responses as JSON, so such a
 * failure surfaced as a parser complaint about `<` rather than as what went
 * wrong. Answer the status here instead, and let the client show it. */
export async function handleApi(request: Request, db: D1Database, config: AppConfig, actor: Actor, gcsKey?: string) {
  try { return await routeApi(request, db, config, actor, gcsKey); }
  catch (error) {
    console.error("pytc_glancer: unhandled API error", error);
    return failure("internal_error", error instanceof Error ? error.message : String(error), 500);
  }
}
