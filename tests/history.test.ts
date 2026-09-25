import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { TestD1 } from "./d1";
import { DEFAULT_ACTOR } from "../lib/accounts";
import { handleApi, packBody, unpackBody } from "../lib/api";
import { parseConfig } from "../lib/config";
import { emptyReview, parseReview } from "../lib/review";
import { type HistoryPage } from "../lib/history";

const config = parseConfig({ PYTC_GLANCER_SOURCES: JSON.stringify([{ id: "test", label: "Test", bucket: "test-bucket", prefix: "", ngauth_base: "https://auth.example" }]) });
const state = { layers: [{ type: "image", source: "gs+ngauth+https://auth.example/test-bucket/sample.zarr" }] };
const report = { dataset: "sample", classes: [{ id: "glia", label: "Glia", voxels: 12, labels: 2 }] };
const review = { class_review: { "5": { verdict: "keep" } } };
const changed = { class_review: { "6": { verdict: "reject" } } };
function api(db: TestD1, route: string, method = "GET", body?: unknown, actor = DEFAULT_ACTOR) {
  return handleApi(new Request(`https://mind.example/api/glances/key/${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), db.db, config, actor);
}
async function ok(response: Promise<Response>, status = 200) { const result = await response; const body = await result.json(); assert.equal(result.status, status, JSON.stringify(body)); return body as any; }
const rows = (db: TestD1) => db.sqlite.prepare("SELECT * FROM glance_versions ORDER BY id").all() as any[];
const snapshot = (db: TestD1) => JSON.stringify([rows(db), db.sqlite.prepare("SELECT * FROM glance_reports").all(), db.sqlite.prepare("SELECT * FROM glance_reviews").all()]);
async function listing(db: TestD1, query = "") { return await ok(api(db, `versions${query}`)) as HistoryPage; }
function baseline() {
  const db = new TestD1(3).seed(state);
  db.seed(state, null, "report-only", "report-only").seed(state, null, "neither", "neither");
  db.sqlite.prepare("INSERT INTO glance_reports VALUES (?,?,1,1)").run("glance-id", JSON.stringify(report));
  db.sqlite.prepare("INSERT INTO glance_reports VALUES (?,?,1,1)").run("report-only", JSON.stringify(report));
  db.sqlite.prepare("INSERT INTO glance_reviews VALUES (?,?,1,1)").run("glance-id", JSON.stringify(parseReview(review)));
  db.migrate("0004_dear_catseye.sql");
  return db;
}

test("migration seeds presence and absence, one operation per glance and one timestamp", () => {
  const db = baseline(), versions = rows(db);
  assert.equal(versions.length, 6);
  assert.equal(new Set(versions.map((row) => row.created_at)).size, 1);
  for (const id of ["glance-id", "report-only", "neither"]) {
    const pair = versions.filter((row) => row.glance_id === id);
    assert.equal(new Set(pair.map((row) => row.operation)).size, 1);
    assert.deepEqual(pair.map((row) => [row.kind, row.present]), [["report", Number(id !== "neither")], ["review", Number(id === "glance-id")]]);
  }
});

test("report source and account are recorded; invalid source writes nothing", async () => {
  const db = new TestD1().seed(state);
  await ok(api(db, "report?source=ingest", "PUT", report));
  await ok(api(db, "report", "PUT", report));
  assert.deepEqual(rows(db).map((row) => [row.source, row.author]), [["ingest", "default"], ["upload", "default"]]);
  const before = snapshot(db);
  await ok(api(db, "report?source=restore", "PUT", report), 422);
  assert.equal(snapshot(db), before);
});

test("review folds only within its window and preserves empty resets and author boundaries", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const db = new TestD1().seed(state);
  await ok(api(db, "review", "PUT", review));
  now += 100;
  await ok(api(db, "review", "PUT", changed));
  assert.equal(rows(db).length, 1);
  assert.equal(rows(db)[0].updated_at - rows(db)[0].created_at, 100);
  assert.deepEqual(parseReview(await unpackBody(rows(db)[0].body)), parseReview(changed));
  now += 600_001;
  await ok(api(db, "review", "PUT", review));
  assert.equal(rows(db).length, 2);
  // The signed-in actor is an account, so simulate a preceding historical author.
  db.sqlite.exec("UPDATE glance_versions SET author='other' WHERE id=2");
  await ok(api(db, "review", "PUT", changed));
  assert.equal(rows(db).length, 3);
  await ok(api(db, "review", "PUT", {}));
  await ok(api(db, "review", "PUT", review));
  assert.equal(rows(db).length, 5);
  assert.equal(rows(db)[3].present, 0);
  await ok(api(db, "restore", "POST", { point: 3 }));
  assert.deepEqual((await ok(api(db, "review"))).class_review, parseReview(changed).class_review);
  await ok(api(db, "review", "PUT", review));
  assert.equal(rows(db).at(-1).source, "review");
  assert.equal(rows(db).length, 8);
});

test("a report between the current write and fold forces a new review row", async () => {
  const db = new TestD1().seed(state);
  await ok(api(db, "review", "PUT", review));
  const packed = await packBody(JSON.stringify(report));
  db.between(0, (sql) => {
    sql.prepare("INSERT INTO glance_reports VALUES (?,?,1,1)").run("glance-id", packed);
    sql.prepare("INSERT INTO glance_versions (glance_id,operation,kind,source,author,present,body,summary,created_at,updated_at) VALUES ('glance-id','interleaved','report','upload','default',1,?,'{}',1,1)").run(packed);
  });
  await ok(api(db, "review", "PUT", changed));
  assert.deepEqual(rows(db).map((row) => row.kind), ["review", "report", "review"]);
  assert.deepEqual(parseReview(await unpackBody(rows(db)[0].body)), parseReview(review));
});

for (const order of ["review-first", "report-first"]) test(`concurrent ${order} writes preserve report boundaries`, async () => {
  const db = new TestD1().seed(state);
  await ok(api(db, "review", "PUT", review));
  const tasks = [() => ok(api(db, "review", "PUT", changed)), () => ok(api(db, "report", "PUT", report))];
  await Promise.all((order === "review-first" ? tasks : tasks.reverse()).map((task) => task()));
  const first = rows(db).find((row) => row.kind === "report").id;
  await ok(api(db, "review", "PUT", review));
  assert.ok(rows(db).at(-1).id > first);
  const latest = rows(db).at(-1);
  assert.equal(latest.kind, "review");
  assert.deepEqual(parseReview(await unpackBody(latest.body)), parseReview(review));
});

test("removed correction endpoint returns 410 without writes", async () => {
  const db = new TestD1().seed(state);
  await ok(api(db, "report", "PUT", report));
  const before = snapshot(db);
  await ok(api(db, "correct", "POST", { report, review }), 410);
  assert.equal(snapshot(db), before);
});

test("packed and plain baseline reviews restore into plain current JSON, and rollback can be undone", async () => {
  const db = baseline();
  const first = (await listing(db)).entries[0];
  await ok(api(db, "review", "PUT", changed));
  const second = (await listing(db)).entries[0];
  const restored = await ok(api(db, "restore", "POST", { point: first.point }));
  assert.equal(restored.restored_to_at, first.ended_at);
  assert.deepEqual((await ok(api(db, "review"))).class_review, parseReview(review).class_review);
  assert.match((db.sqlite.prepare("SELECT body FROM glance_reviews WHERE glance_id='glance-id'").get() as any).body, /^\{/);
  await ok(api(db, "restore", "POST", { point: second.point }));
  assert.deepEqual((await ok(api(db, "review"))).class_review, parseReview(changed).class_review);
  const entries = (await listing(db)).entries;
  assert.equal(entries[0].restored_from_at, second.ended_at);
  assert.equal(entries[0].restored_from, second.point);
});

test("restoring absent report deletes current row and keeps the existing GET fallback", async () => {
  const db = new TestD1(3).seed(state);
  db.migrate("0004_dear_catseye.sql");
  await ok(api(db, "report", "PUT", report));
  await ok(api(db, "restore", "POST", { point: 2 }));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM glance_reports").get()!.n, 0);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  try { await ok(api(db, "report"), 404); } finally { globalThis.fetch = oldFetch; }
});

test("rejected restores and foreign-account history/correction requests leave all rows unchanged", async () => {
  const db = baseline();
  await listing(db);
  const point = (await listing(db)).entries[0].point;
  for (const [body, status] of [[{ point }, 409], [{ point: 999 }, 404], [{ point: 1 }, 404], [{ point: 1.5 }, 404]] as const) {
    const before = snapshot(db); await ok(api(db, "restore", "POST", body), status); assert.equal(snapshot(db), before);
  }
  const foreign = { id: "foreign", label: "Foreign" };
  for (const [route, method, body] of [["versions", "GET", undefined], ["restore", "POST", { point }], ["correct", "POST", { report, review }]] as const) {
    const before = snapshot(db); await ok(api(db, route, method, body, foreign), 404); assert.equal(snapshot(db), before);
  }
  db.sqlite.exec("UPDATE studies SET archived_at=1");
  const before = snapshot(db);
  await ok(api(db, "restore", "POST", { point }), 410);
  await ok(api(db, "correct", "POST", { report, review }), 410);
  assert.equal(snapshot(db), before);
});

test("listing paginates metadata, caches baseline summaries, and carries the exact restorable state", async () => {
  const db = baseline();
  await listing(db);
  assert.equal(rows(db).filter((row) => row.glance_id === "glance-id" && row.summary === null).length, 0);
  db.statements = [];
  await ok(api(db, "report", "PUT", { ...report, classes: [{ id: "axon", label: "Axon", voxels: 10, labels: 1 }] }));
  await ok(api(db, "review", "PUT", changed));
  const page = await listing(db, "?limit=1");
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].current, true);
  assert.ok(!JSON.stringify(page).includes('"body"'));
  const next = await listing(db, `?before=${page.next_before}&limit=1`);
  assert.ok(next.entries[0].point < page.entries[0].point);
  assert.ok("class_verdicts" in next.entries[0].state.review);
  assert.equal(next.entries[0].state.review.class_verdicts, 1);
  for (const entry of (await listing(db)).entries.filter((entry) => !entry.current)) {
    const restored = await ok(api(db, "restore", "POST", { point: entry.point }));
    assert.deepEqual(restored.state, { report: entry.state.report, review: entry.state.review });
  }
  assert.equal(db.statements.filter((sql) => sql.startsWith("UPDATE glance_versions SET summary")).length, 0);
  const bodyReads = db.statements.filter((sql) => /SELECT.*body.*FROM glance_versions/.test(sql));
  assert.ok(bodyReads.every((sql) => sql.includes("source = 'baseline'") || sql.includes("id IN")));
});

test("packed report ceiling accepts just under and rejects over without writing", async () => {
  const db = new TestD1().seed(state);
  /* Unknown fields survive storage but do not affect the parsed report. A
   * random payload exercises gzip's real byte ceiling without huge fixtures. */
  const noise = randomBytes(1_600_000).toString("base64");
  let low = 1_800_000, high = 2_050_000;
  while (high - low > 100) {
    const mid = Math.floor((low + high) / 2);
    const packed = await packBody(JSON.stringify({ ...report, padding: noise.slice(0, mid) }));
    if (packed.length <= 1_900_000) low = mid; else high = mid;
  }
  const under = { ...report, padding: noise.slice(0, low) }, over = { ...report, padding: noise.slice(0, high) };
  const size = (await packBody(JSON.stringify(under))).length;
  assert.ok(size <= 1_900_000 && size > 1_899_000, String(size));
  await ok(api(db, "report", "PUT", under));
  const before = snapshot(db);
  await ok(api(db, "report", "PUT", over), 413);
  await ok(api(db, "correct", "POST", { report: over, review }), 410);
  assert.equal(snapshot(db), before);
});

for (const damaged of ["report", "state", "review"]) test(`listing caches an unreadable baseline marker for damaged ${damaged} and retains other points`, async () => {
  const db = baseline();
  if (damaged === "state") db.sqlite.exec("UPDATE glances SET state='invalid' WHERE id='glance-id'");
  else db.sqlite.prepare("UPDATE glance_versions SET body='invalid' WHERE glance_id='glance-id' AND kind=?").run(damaged);
  await ok(api(db, "review", "PUT", changed));
  const page = await listing(db);
  assert.equal(page.entries.length, 2);
  const kind = damaged === "review" ? "review" : "report";
  assert.deepEqual(page.entries[1].state[kind], { unreadable: true });
  const baselineRow = rows(db).find((row) => row.glance_id === "glance-id" && row.kind === kind && row.source === "baseline");
  assert.deepEqual(JSON.parse(baselineRow.summary), { unreadable: true });
  db.statements = [];
  assert.deepEqual(await listing(db), page);
  assert.equal(db.statements.filter((sql) => sql.startsWith("UPDATE glance_versions SET summary")).length, 0);
});
