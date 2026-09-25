import assert from "node:assert/strict";
import test from "node:test";
import { TestD1 } from "./d1";
import { DEFAULT_ACTOR } from "../lib/accounts";
import { handleApi, unpackBody } from "../lib/api";
import { parseConfig } from "../lib/config";
import { emptyReview } from "../lib/review";

const config = parseConfig({ PYTC_GLANCER_SOURCES: JSON.stringify([{ id: "test", label: "Test", bucket: "test-bucket", prefix: "", ngauth_base: "https://auth.example" }]) });
const state = { layers: [{ type: "image", source: "gs+ngauth+https://auth.example/test-bucket/sample.zarr" }] };
const segment = { id: "1", voxels: 10, volume_um3: 20 };
const pipeline = { dataset: "sample", total_voxels: 10, classes: [{ id: "glia", label: "Glia", voxels: 10, labels: 1, volume_um3: 20, segments: [segment] }, { id: "axon", label: "Axon", voxels: 0, labels: 0, volume_um3: 0, segments: [] }] };
const corrected = { ...pipeline, classes: [{ ...pipeline.classes[0], voxels: 0, labels: 0, volume_um3: 0, segments: [] }, { ...pipeline.classes[1], voxels: 10, labels: 1, volume_um3: 20, segments: [segment] }] };
const candidate = { pipeline: JSON.stringify(pipeline), base: { kind: "file", detail: "fixture" } };
function api(db: TestD1, route: string, method = "GET", body?: unknown, actor = DEFAULT_ACTOR) {
  return handleApi(new Request(`https://mind.example/api/glances/key/${route}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), db.db, config, actor);
}
async function ok(response: Promise<Response>, status = 200): Promise<any> { const result = await response, body = await result.json(); assert.equal(result.status, status, JSON.stringify(body)); return body; }
const snapshot = (db: TestD1) => JSON.stringify(["glance_reports", "glance_reviews", "glance_versions"].map((t) => db.sqlite.prepare(`SELECT * FROM ${t}`).all()));
async function fixture() { const db = new TestD1().seed(state); await ok(api(db, "report", "PUT", corrected)); return db; }
const apply = (plan: any, extra = {}) => ({ ...candidate, apply: true, derived_at: plan.derived_at, expect: plan.state, expect_outcome: plan.outcome, ...extra });

test("merged GET, raw GET and ingest summary preserve review bytes", async () => {
  const db = await fixture(), review = emptyReview();
  review.class_review["1"] = { verdict: "reject", class: "axon", to: null, at: 1 };
  await ok(api(db, "review", "PUT", review));
  const before = db.sqlite.prepare("SELECT body FROM glance_reviews").get()!.body;
  assert.equal((await ok(api(db, "report"))).total_voxels, 0);
  const raw = await ok(api(db, "report?raw=1")); assert.equal(raw.total_voxels, 10); assert.equal(raw.merged, undefined);
  const result = await ok(api(db, "report?source=ingest", "PUT", pipeline));
  assert.equal(result.edits.applied, 1);
  assert.equal(db.sqlite.prepare("SELECT body FROM glance_reviews").get()!.body, before);
  db.sqlite.exec("UPDATE glance_reviews SET body='broken'");
  const unreadable = await ok(api(db, "report")); assert.ok(unreadable.edits_error); assert.equal(unreadable.total_voxels, 10);
});
test("history report reads exact text and checks kind and ownership", async () => {
  const db = await fixture();
  assert.equal((await ok(api(db, "versions/1/report"))).body, JSON.stringify(corrected));
  await ok(api(db, "review", "PUT", { class_review: { "2": { verdict: "keep" } } }));
  await ok(api(db, "versions/2/report"), 404);
  await ok(api(db, "versions/1/report", "GET", undefined, { id: "foreign", label: "Foreign" }), 404);
});
test("dry run writes nothing; later clean apply has stable token, paired ingest and exact rollback", async (t) => {
  let now = 100; t.mock.method(Date, "now", () => now);
  const db = await fixture();
  const before = snapshot(db), plan = await ok(api(db, "unbake", "POST", candidate));
  assert.equal(snapshot(db), before); assert.equal(plan.clean, true); assert.equal(plan.derived.length, 1);
  now = 10000;
  const result = await ok(api(db, "unbake", "POST", apply(plan)));
  assert.equal(result.outcome, plan.outcome);
  const rows = db.sqlite.prepare("SELECT * FROM glance_versions ORDER BY id").all() as any[];
  assert.deepEqual(rows.slice(-2).map((r) => r.source), ["ingest", "ingest"]); assert.equal(rows[1].operation, rows[2].operation);
  assert.equal(await unpackBody(rows[1].body), candidate.pipeline);
  assert.deepEqual((await ok(api(db, "report"))).classes.map((c: any) => c.segment_ids), [[], ["1"]]);
  await ok(api(db, "unbake", "POST", apply(plan)), 409);
  await ok(api(db, "restore", "POST", { point: 1 }));
  assert.equal(await unpackBody((db.sqlite.prepare("SELECT body FROM glance_reports").get() as any).body), JSON.stringify(corrected));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM glance_reviews").get()!.n, 0);
});
test("every apply binds exact pipeline text, including fields outside visible comparison", async () => {
  const db = await fixture(), plan = await ok(api(db, "unbake", "POST", candidate)), before = snapshot(db);
  await ok(api(db, "unbake", "POST", apply(plan, { pipeline: JSON.stringify({ ...pipeline, notes: "different" }) })), 409);
  await ok(api(db, "unbake", "POST", apply(plan, { expect_outcome: undefined })), 409);
  assert.equal(snapshot(db), before);
});
test("unclean candidate requires explicit acceptance and remains stable at a later time", async (t) => {
  let now = 200; t.mock.method(Date, "now", () => now);
  const db = await fixture();
  const body = { ...candidate, pipeline: JSON.stringify({ ...pipeline, total_voxels: 999 }) };
  const plan = await ok(api(db, "unbake", "POST", body)); assert.equal(plan.clean, false);
  const before = snapshot(db); now = 900;
  await ok(api(db, "unbake", "POST", apply(plan, { pipeline: body.pipeline })), 409);
  assert.equal(snapshot(db), before);
  assert.equal((await ok(api(db, "unbake", "POST", apply(plan, { pipeline: body.pipeline, accept: true })))).outcome, plan.outcome);
});
test("existing edits win and quality calls and hand members survive", async () => {
  const db = await fixture(), review = emptyReview();
  review.class_review["1"] = { verdict: "reject", class: "axon", to: null, at: 5 };
  review.cell_review.glia["1"] = { verdict: "complete", at: 6 }; review.cell_members.glia.ids = ["999"];
  await ok(api(db, "review", "PUT", review));
  const plan = await ok(api(db, "unbake", "POST", candidate));
  await ok(api(db, "unbake", "POST", apply(plan)));
  const saved = await ok(api(db, "review")); delete saved.updated_at;
  assert.deepEqual(saved, review);
});
test("intervening review write and transaction-entry race both refuse all migration writes", async () => {
  for (const race of [false, true]) {
    const db = await fixture(), plan = await ok(api(db, "unbake", "POST", candidate));
    let before: string;
    if (!race) {
      await ok(api(db, "review", "PUT", { class_review: { "9": { verdict: "keep" } } })); before = snapshot(db);
    } else {
      const batch = db.batch.bind(db);
      db.batch = async (statements) => {
        db.sqlite.prepare("INSERT INTO glance_reviews VALUES ('glance-id',?,1,1)").run(JSON.stringify(emptyReview()));
        before = snapshot(db); return batch(statements);
      };
    }
    await ok(api(db, "unbake", "POST", apply(plan)), 409);
    assert.equal(snapshot(db), before!);
  }
});
test("failed atomic batch rolls back current rows and both version inserts", async () => {
  const db = await fixture(), plan = await ok(api(db, "unbake", "POST", candidate)), before = snapshot(db);
  db.failOn((sql) => sql.startsWith("INSERT INTO glance_reviews"));
  await ok(api(db, "unbake", "POST", apply(plan)), 500); assert.equal(snapshot(db), before);
});
test("merged review entry and byte limits reject dry run and apply without changes", async () => {
  for (const byteLimit of [false, true]) {
    const db = await fixture();
    const ids = Array.from({ length: byteLimit ? 10000 : 20001 }, (_, i) => String(i + 1));
    const base = { ...pipeline, classes: pipeline.classes.map((c) => ({ ...c, segments: [], segment_ids: c.id === "glia" ? ids : [] })) };
    const baked = { ...base, classes: base.classes.map((c) => ({ ...c, segment_ids: c.id === "axon" ? ids : [] })) };
    await ok(api(db, "report", "PUT", baked));
    const largeCandidate = { ...candidate, pipeline: JSON.stringify(base) };
    const before = snapshot(db);
    const result = await ok(api(db, "unbake", "POST", largeCandidate), 422);
    assert.match(result.detail, byteLimit ? /byte limit/ : /at most 20000/);
    await ok(api(db, "unbake", "POST", { ...largeCandidate, apply: true, derived_at: 1 }), 422);
    assert.equal(snapshot(db), before);
  }
});
test("archived, foreign, and no-report migrations are rejected", async () => {
  const db = new TestD1().seed(state);
  await ok(api(db, "unbake", "POST", candidate), 409);
  await ok(api(db, "unbake", "POST", candidate, { id: "foreign", label: "Foreign" }), 404);
  db.sqlite.exec("UPDATE studies SET archived_at=1");
  await ok(api(db, "unbake", "POST", candidate), 410);
});


test("API caps inactive ids while preserving the full count", async () => {
  const db = await fixture(), review = emptyReview();
  for (let i = 2; i < 603; i++) review.class_review[String(i)] = { verdict: "reject", class: "glia", to: null, at: 1 };
  await ok(api(db, "review", "PUT", review));
  const result = await ok(api(db, "report"));
  assert.equal(result.edits.inactive_total, 601);
  assert.equal(result.edits.inactive.length, 500);
});

test("coalesced review changes invalidate unbake before apply and at transaction entry", async (t) => {
  let now = 100; t.mock.method(Date, "now", () => now);
  for (const race of [false, true]) for (const sameTimestamp of [false, true]) {
    now = 100;
    const db = await fixture(), review = emptyReview();
    review.class_review["9"] = { verdict: "keep", class: "axon", to: null, at: 1 };
    await ok(api(db, "review", "PUT", review));
    const version = db.sqlite.prepare("SELECT * FROM glance_versions WHERE kind='review'").get()!;
    const plan = await ok(api(db, "unbake", "POST", candidate));
    review.class_review["9"].class = "glia";
    let before: string;
    if (!race) {
      now = sameTimestamp ? 100 : 101;
      await ok(api(db, "review", "PUT", review));
      const rows = db.sqlite.prepare("SELECT * FROM glance_versions WHERE kind='review'").all();
      assert.equal(rows.length, 1); assert.equal(rows[0].id, version.id);
      assert.notEqual(rows[0].body, version.body);
      assert.equal(rows[0].updated_at, now);
      before = snapshot(db);
    } else {
      const batch = db.batch.bind(db);
      db.batch = async (statements) => {
        const timestamp = sameTimestamp ? 100 : 101;
        db.sqlite.prepare("UPDATE glance_reviews SET body=?, updated_at=?").run(JSON.stringify(review), timestamp);
        db.sqlite.prepare("UPDATE glance_versions SET body=?, updated_at=? WHERE kind='review'").run(JSON.stringify(review), timestamp);
        before = snapshot(db);
        return batch(statements);
      };
    }
    const result = await ok(api(db, "unbake", "POST", apply(plan)), 409);
    assert.equal(result.error, "changed");
    assert.equal(snapshot(db), before!);
  }
});
