/* Roadmaps: shared tldraw canvases, one per plan, owned by an account.
 *
 * A canvas is stored as its tldraw records (shapes, arrows' bindings, pages,
 * assets), one row each, rather than as one document. Two people editing
 * different boxes therefore never overwrite each other: a write replaces only
 * the records it names, and the last write to one record wins. Every write
 * takes the roadmap's next sequence number, so a browser asks "what changed
 * after N" and receives only that. Removed records stay as tombstones for the
 * same reason: a removal has to reach the browsers that still show the shape.
 *
 * There is no socket. A browser sends what it changed and receives what others
 * changed in one exchange, repeated every couple of seconds. */
import type { Actor } from "./accounts";
import type { AppConfig } from "./config";
import { bodyObject, failure, json, rejectUnknown } from "./http";
import { parsePlan } from "./roadmap-plan";

interface RoadmapRow {
  id: string; account_id: string; title: string; slug: string; seq: number; schema: string | null; plan: string | null; plan_rev: number;
  archived_at: number | null; created_at: number; updated_at: number;
}

/* Only what tldraw keeps in a document: its document-scoped record types, of
 * which `user` is the name and colour tldraw attributes an edit to. Cursors,
 * selections and each viewer's camera are session state and stay in the
 * browser that owns them. */
const DOCUMENT_TYPES = new Set(["shape", "binding", "page", "asset", "document", "user"]);
const MAX_CHANGES = 2000;
/* A pasted image is stored inside its asset record, so one record can be
 * large; D1 holds 2 MB per row. */
const MAX_RECORD_BYTES = 1_500_000;
const MAX_SCHEMA_BYTES = 100_000;
const CLIENT_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function kebab(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleField(value: unknown, required: boolean) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error("title must be a string.");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("title is required.");
  if (trimmed.length > 200) throw new Error("title must be at most 200 characters.");
  return trimmed;
}

/* Every read starts here, as for studies: another account's roadmap answers
 * the same 404 as one that never existed. */
async function findRoadmap(db: D1Database, actor: Actor, identifier: string) {
  return db.prepare("SELECT * FROM roadmaps WHERE account_id = ? AND (id = ? OR slug = ?)").bind(actor.id, identifier, identifier).first<RoadmapRow>();
}

function summary(row: RoadmapRow) {
  return { id: row.id, title: row.title, slug: row.slug, archived_at: row.archived_at, created_at: row.created_at, updated_at: row.updated_at };
}

async function listRoadmaps(request: Request, db: D1Database, actor: Actor) {
  const include = new URL(request.url).searchParams.get("include_archived") === "1";
  const query = `SELECT r.id, r.title, r.slug, r.archived_at, r.created_at, r.updated_at, json_array_length(r.plan, '$.nodes') AS task_count, (SELECT COUNT(*) FROM roadmap_records c WHERE c.roadmap_id=r.id AND c.deleted=0 AND c.kind='shape') AS shape_count FROM roadmaps r WHERE r.account_id = ?${include ? "" : " AND r.archived_at IS NULL"} ORDER BY r.updated_at DESC, r.id ASC`;
  return json((await db.prepare(query).bind(actor.id).all()).results);
}

async function createRoadmap(request: Request, db: D1Database, actor: Actor) {
  let title: string;
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["title"]);
    title = titleField(body.title, true)!;
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const id = crypto.randomUUID();
  const now = Date.now();
  const base = kebab(title).slice(0, 52) || `roadmap-${id.replace(/-/g, "").slice(0, 8)}`;
  for (let suffix = 1; suffix <= 9999; suffix += 1) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    try {
      await db.prepare("INSERT INTO roadmaps (id,account_id,title,slug,seq,schema,plan,plan_rev,archived_at,created_at,updated_at) VALUES (?,?,?,?,0,NULL,NULL,0,NULL,?,?)").bind(id, actor.id, title, slug, now, now).run();
      return json({ id, title, slug, archived_at: null, created_at: now, updated_at: now, shape_count: 0 }, 201);
    } catch (error) { if (!String(error).includes("UNIQUE constraint failed")) throw error; }
  }
  return failure("conflict", "Unable to allocate a unique roadmap address.", 409);
}

async function getRoadmap(db: D1Database, config: AppConfig, actor: Actor, identifier: string) {
  const roadmap = await findRoadmap(db, actor, identifier);
  if (!roadmap) return failure("not_found", "No such roadmap.", 404);
  const rows = await db.prepare("SELECT body FROM roadmap_records WHERE roadmap_id = ? AND deleted = 0").bind(roadmap.id).all<{ body: string }>();
  return json({
    ...summary(roadmap), seq: roadmap.seq,
    schema: roadmap.schema ? JSON.parse(roadmap.schema) as unknown : null,
    records: rows.results.map((row) => JSON.parse(row.body) as unknown),
    plan: roadmap.plan ? JSON.parse(roadmap.plan) as unknown : null, plan_rev: roadmap.plan_rev,
    license_key: config.tldrawLicenseKey,
  }, 200, { "Cache-Control": "no-store" });
}

async function patchRoadmap(request: Request, db: D1Database, actor: Actor, identifier: string) {
  const roadmap = await findRoadmap(db, actor, identifier);
  if (!roadmap) return failure("not_found", "No such roadmap.", 404);
  let title: string; let archivedAt: number | null;
  try {
    const body = await bodyObject(request);
    rejectUnknown(body, ["title", "archived"]);
    if (body.archived !== undefined && typeof body.archived !== "boolean") throw new Error("archived must be a boolean.");
    title = titleField(body.title, false) ?? roadmap.title;
    archivedAt = body.archived === undefined ? roadmap.archived_at : body.archived ? (roadmap.archived_at ?? Date.now()) : null;
  } catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const now = Date.now();
  await db.prepare("UPDATE roadmaps SET title=?, archived_at=?, updated_at=? WHERE id=?").bind(title, archivedAt, now, roadmap.id).run();
  return json({ ...summary(roadmap), title, archived_at: archivedAt, updated_at: now });
}

interface Change { id: string; kind: string; body: string; deleted: 0 | 1; }

function parseChanges(body: Record<string, unknown>) {
  rejectUnknown(body, ["client", "since", "puts", "removes", "schema"]);
  if (typeof body.client !== "string" || !CLIENT_PATTERN.test(body.client)) throw new Error("client must be a browser session id.");
  if (!Number.isSafeInteger(body.since) || (body.since as number) < 0) throw new Error("since must be a sequence number.");
  const puts = body.puts ?? []; const removes = body.removes ?? [];
  if (!Array.isArray(puts) || !Array.isArray(removes)) throw new Error("puts and removes must be arrays.");
  if (puts.length + removes.length > MAX_CHANGES) throw new Error(`At most ${MAX_CHANGES} changes per request.`);
  const changes = new Map<string, Change>();
  for (const record of puts as unknown[]) {
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Each put must be a record object.");
    const { id, typeName } = record as { id?: unknown; typeName?: unknown };
    if (typeof id !== "string" || !id || id.length > 200) throw new Error("Each record needs an id of at most 200 characters.");
    if (typeof typeName !== "string" || !DOCUMENT_TYPES.has(typeName)) throw new Error(`Record ${id} is not a document record.`);
    if (!id.startsWith(`${typeName}:`)) throw new Error(`Record ${id} does not match its type ${typeName}.`);
    const text = JSON.stringify(record);
    if (text.length > MAX_RECORD_BYTES) throw new Error(`Record ${id} is too large to store (${Math.round(text.length / 1024)} KiB); link to large images instead of pasting them.`);
    changes.set(id, { id, kind: typeName, body: text, deleted: 0 });
  }
  for (const id of removes as unknown[]) {
    if (typeof id !== "string" || !id || id.length > 200) throw new Error("Each removal needs a record id.");
    const kind = id.slice(0, Math.max(0, id.indexOf(":")));
    if (!DOCUMENT_TYPES.has(kind)) throw new Error(`Record ${id} is not a document record.`);
    changes.set(id, { id, kind, body: "", deleted: 1 });
  }
  let schema: string | null = null;
  if (body.schema !== undefined) {
    if (!body.schema || typeof body.schema !== "object" || Array.isArray(body.schema)) throw new Error("schema must be an object.");
    schema = JSON.stringify(body.schema);
    if (schema.length > MAX_SCHEMA_BYTES) throw new Error("schema is too large.");
  }
  return { client: body.client, since: body.since as number, changes: [...changes.values()], schema };
}

/** One exchange: store what this browser changed, answer what the others did. */
async function exchangeChanges(request: Request, db: D1Database, actor: Actor, identifier: string) {
  const roadmap = await findRoadmap(db, actor, identifier);
  if (!roadmap) return failure("not_found", "No such roadmap.", 404);
  let input: ReturnType<typeof parseChanges>;
  try { input = parseChanges(await bodyObject(request)); }
  catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  if (input.changes.length) {
    if (roadmap.archived_at) return failure("archived", "This roadmap is archived; restore it to edit.", 409);
    /* The sequence number is taken and used inside one batch, which D1 runs as
     * a transaction: every record of this write carries the same number, and
     * no reader can see the number without the records. */
    await db.batch([
      db.prepare("UPDATE roadmaps SET seq=seq+1, schema=COALESCE(?,schema), updated_at=? WHERE id=?").bind(input.schema, Date.now(), roadmap.id),
      ...input.changes.map((change) => db.prepare(
        "INSERT INTO roadmap_records (roadmap_id,record_id,kind,body,seq,deleted,client) VALUES (?,?,?,?,(SELECT seq FROM roadmaps WHERE id=?),?,?) " +
        "ON CONFLICT(roadmap_id,record_id) DO UPDATE SET kind=excluded.kind, body=excluded.body, seq=excluded.seq, deleted=excluded.deleted, client=excluded.client"
      ).bind(roadmap.id, change.id, change.kind, change.body, roadmap.id, change.deleted, input.client)),
    ]);
  }
  /* The number is read before the rows. A write landing between the two reads
   * is then sent now and again on the next exchange, which is harmless; read
   * the other way round it could be skipped for good. */
  const current = await db.prepare("SELECT seq, plan_rev FROM roadmaps WHERE id=?").bind(roadmap.id).first<{ seq: number; plan_rev: number }>();
  const rows = await db.prepare("SELECT record_id, body, deleted FROM roadmap_records WHERE roadmap_id=? AND seq>? AND client<>? ORDER BY seq ASC")
    .bind(roadmap.id, input.since, input.client).all<{ record_id: string; body: string; deleted: number }>();
  return json({
    seq: current?.seq ?? roadmap.seq, plan_rev: current?.plan_rev ?? roadmap.plan_rev,
    puts: rows.results.filter((row) => !row.deleted).map((row) => JSON.parse(row.body) as unknown),
    removes: rows.results.filter((row) => row.deleted).map((row) => row.record_id),
  }, 200, { "Cache-Control": "no-store" });
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

/* Replace a roadmap's plan with the one its project declares, creating the
 * roadmap at this address the first time. Pushing the same plan again changes
 * nothing and does not make open canvases redraw. */
async function putPlan(request: Request, db: D1Database, actor: Actor, slug: string) {
  if (!SLUG_PATTERN.test(slug)) return failure("invalid_request", "A roadmap address is lowercase letters, digits and hyphens.", 422);
  let plan: ReturnType<typeof parsePlan>;
  try { plan = parsePlan(await bodyObject(request)); }
  catch (error) { return failure("invalid_request", error instanceof Error ? error.message : String(error), 422); }
  const body = JSON.stringify(plan);
  const now = Date.now();
  const existing = await findRoadmap(db, actor, slug);
  if (!existing) {
    await db.prepare("INSERT INTO roadmaps (id,account_id,title,slug,seq,schema,plan,plan_rev,archived_at,created_at,updated_at) VALUES (?,?,?,?,0,NULL,?,1,NULL,?,?)")
      .bind(crypto.randomUUID(), actor.id, plan.title, slug, body, now, now).run();
    return json({ slug, title: plan.title, plan_rev: 1, tasks: plan.nodes.length, created: true, changed: true }, 201);
  }
  if (existing.archived_at) return failure("archived", "This roadmap is archived; restore it to update its plan.", 409);
  if (existing.plan === body) return json({ slug, title: existing.title, plan_rev: existing.plan_rev, tasks: plan.nodes.length, created: false, changed: false });
  await db.prepare("UPDATE roadmaps SET plan=?, plan_rev=plan_rev+1, title=?, updated_at=? WHERE id=?").bind(body, plan.title, now, existing.id).run();
  return json({ slug, title: plan.title, plan_rev: existing.plan_rev + 1, tasks: plan.nodes.length, created: false, changed: true });
}

/** Routes under /api/roadmaps; `null` means the path is not one of them. */
export async function routeRoadmaps(request: Request, db: D1Database, config: AppConfig, actor: Actor, parts: string[]): Promise<Response | null> {
  if (parts[1] !== "roadmaps") return null;
  const identifier = parts[2] === undefined ? "" : decodeURIComponent(parts[2]);
  if (parts.length === 2 && request.method === "GET") return listRoadmaps(request, db, actor);
  if (parts.length === 2 && request.method === "POST") return createRoadmap(request, db, actor);
  if (parts.length === 3 && request.method === "GET") return getRoadmap(db, config, actor, identifier);
  if (parts.length === 3 && request.method === "PATCH") return patchRoadmap(request, db, actor, identifier);
  if (parts.length === 4 && parts[3] === "plan" && request.method === "PUT") return putPlan(request, db, actor, identifier);
  if (parts.length === 4 && parts[3] === "changes" && request.method === "POST") return exchangeChanges(request, db, actor, identifier);
  return null;
}
