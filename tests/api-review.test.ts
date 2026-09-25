import { TestD1 } from "./d1";
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACTOR } from "../lib/accounts";
import { handleApi } from "../lib/api";
import { parseConfig } from "../lib/config";
import { MAX_REVIEW_BYTES } from "../lib/review";

/* Route fixtures use the same transactional SQLite double as history tests. */
class ReviewDb extends TestD1 {
  constructor(studyArchivedAt: number | null = null, key = "key") { super(); this.seed({}, studyArchivedAt, key); }
  get rows() {
    const db = this.sqlite;
    return {
      get size() { return (db.prepare("SELECT COUNT(*) AS n FROM glance_reviews").get() as { n: number }).n; },
      set(id: string, row: { body: string; updated_at: number }) { db.prepare("INSERT INTO glance_reviews VALUES (?,?,?,?)").run(id, row.body, row.updated_at, row.updated_at); }
    };
  }
}

function api(db: ReviewDb, path: string, method = "GET", body?: string) {
  return handleApi(new Request(`https://mind.example${path}`, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined, body
  }), db as unknown as D1Database, parseConfig({}), DEFAULT_ACTOR);
}

test("an unreviewed glance answers the empty record rather than a 404", async () => {
  const db = new ReviewDb();
  const response = await api(db, "/api/glances/key/review");
  assert.equal(response.status, 200);
  const review = await response.json() as Record<string, unknown>;
  assert.deepEqual(review.class_review, {});
  assert.deepEqual(Object.keys(review.cell_review as object), ["axon", "dendrite", "blood_vessel", "glia", "unclassified"]);
  assert.equal(review.updated_at, null);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await api(db, "/api/glances/other/review")).status, 404);
});

test("verdicts round-trip through the glance, normalised on the way in", async () => {
  const db = new ReviewDb();
  const stored = await api(db, "/api/glances/key/review", "PUT", JSON.stringify({
    class_review: { "0013460": { verdict: "reject" } },
    cell_review: { blood_vessel: { "17942": { verdict: "false_split", at: 1_700_000_000_000 } } },
    cell_members: { blood_vessel: { classes: ["vessel_like"], ids: ["17942"] } }
  }));
  assert.equal(stored.status, 200);
  assert.ok((await stored.json() as { updated_at: number }).updated_at > 0);

  const read = await api(db, "/api/glances/key/review").then((response) => response.json()) as Record<string, any>;
  assert.deepEqual(read.class_review, { "13460": { verdict: "reject", class: null, to: null, at: null } });
  assert.deepEqual(read.cell_review.blood_vessel, { "17942": { verdict: "false_split", at: 1_700_000_000_000 } });
  assert.deepEqual(read.cell_members.blood_vessel, { classes: ["vessel_like"], ids: ["17942"] });
  assert.deepEqual(read.cell_members.glia, { classes: [], ids: [] });
});

test("a review that says nothing stores nothing, so clearing a glance clears its row", async () => {
  const db = new ReviewDb();
  await api(db, "/api/glances/key/review", "PUT", JSON.stringify({ class_review: { "5": { verdict: "keep" } } }));
  assert.equal(db.rows.size, 1);
  await api(db, "/api/glances/key/review", "PUT", JSON.stringify({ class_review: {} }));
  assert.equal(db.rows.size, 0);
});

test("a review is refused when it is unreadable, oversized, or the study is archived", async () => {
  const db = new ReviewDb();
  const bad = await api(db, "/api/glances/key/review", "PUT", JSON.stringify({ class_review: { "5": { verdict: "delete" } } }));
  assert.equal(bad.status, 422);
  assert.match((await bad.json() as { detail: string }).detail, /verdict must be one of/);

  const huge = await api(db, "/api/glances/key/review", "PUT", `{"notes":"${"x".repeat(MAX_REVIEW_BYTES)}"}`);
  assert.equal(huge.status, 413);
  assert.equal(db.rows.size, 0);

  const archived = new ReviewDb(1_700_000_000_000);
  const refused = await api(archived, "/api/glances/key/review", "PUT", JSON.stringify({ class_review: { "5": { verdict: "keep" } } }));
  assert.equal(refused.status, 410);
});

test("a stored review that no longer parses is reported, not served as truth", async () => {
  const db = new ReviewDb();
  db.rows.set("glance-id", { body: '{"class_review":{"5":{"verdict":"delete"}}}', updated_at: 1 });
  const response = await api(db, "/api/glances/key/review");
  assert.equal(response.status, 422);
  assert.equal((await response.json() as { error: string }).error, "review_unreadable");
});
