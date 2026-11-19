import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACTOR, type Actor } from "../lib/accounts";
import { handleApi } from "../lib/api";
import { parseConfig } from "../lib/config";
import { TestD1 } from "./d1";

const A = "client-aaaa-0001";
const B = "client-bbbb-0002";

async function api(d1: TestD1, path: string, method = "GET", body?: object, actor: Actor = DEFAULT_ACTOR) {
  return handleApi(new Request(`https://glancer.example${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }), d1.db, parseConfig({ PYTC_GLANCER_TLDRAW_LICENSE_KEY: " key-1 " }), actor);
}

function shape(id: string, x: number) { return { id: `shape:${id}`, typeName: "shape", type: "geo", x, y: 0 }; }

async function exchange(d1: TestD1, slug: string, client: string, since: number, puts: object[] = [], removes: string[] = []) {
  const response = await api(d1, `/api/roadmaps/${slug}/changes`, "POST", { client, since, puts, removes, ...(puts.length ? { schema: { schemaVersion: 2, sequences: {} } } : {}) });
  return { status: response.status, body: await response.json() as { seq: number; puts: Array<{ id: string; x: number }>; removes: string[]; detail?: string } };
}

test("a roadmap is created, listed and opened with its records, schema and licence key", async () => {
  const d1 = new TestD1(6);
  const created = await api(d1, "/api/roadmaps", "POST", { title: "Yale dLGN 26" });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { slug: string }).slug, "yale-dlgn-26");
  // The same title again takes the next free address rather than colliding.
  assert.equal(((await (await api(d1, "/api/roadmaps", "POST", { title: "Yale dLGN 26" })).json()) as { slug: string }).slug, "yale-dlgn-26-2");

  assert.equal((await exchange(d1, "yale-dlgn-26", A, 0, [shape("a", 1), shape("b", 2), { id: "page:p", typeName: "page", name: "Page 1" }, { id: "user:u", typeName: "user", name: "New user" }])).status, 200);
  const opened = await (await api(d1, "/api/roadmaps/yale-dlgn-26")).json() as { seq: number; schema: unknown; records: Array<{ id: string }>; license_key: string };
  assert.equal(opened.seq, 1);
  assert.deepEqual(opened.records.map((record) => record.id).sort(), ["page:p", "shape:a", "shape:b", "user:u"]);
  assert.deepEqual(opened.schema, { schemaVersion: 2, sequences: {} });
  assert.equal(opened.license_key, "key-1");

  const listed = await (await api(d1, "/api/roadmaps")).json() as Array<{ slug: string; shape_count: number }>;
  assert.deepEqual(listed.map((row) => [row.slug, row.shape_count]).sort(), [["yale-dlgn-26", 2], ["yale-dlgn-26-2", 0]]);
});

test("an exchange answers what other browsers changed since, and never a browser's own writes", async () => {
  const d1 = new TestD1(6);
  await api(d1, "/api/roadmaps", "POST", { title: "Plan" });

  const first = await exchange(d1, "plan", A, 0, [shape("a", 1), shape("b", 1)]);
  assert.deepEqual(first.body, { seq: 1, plan_rev: 0, puts: [], removes: [] });

  // B has seen nothing yet: it receives both of A's shapes while writing its own.
  const second = await exchange(d1, "plan", B, 0, [shape("c", 5)]);
  assert.equal(second.body.seq, 2);
  assert.deepEqual(second.body.puts.map((record) => record.id).sort(), ["shape:a", "shape:b"]);

  // A hears of B's shape only, and an idle exchange does not advance the count.
  const third = await exchange(d1, "plan", A, 1);
  assert.deepEqual([third.body.seq, third.body.puts.map((record) => record.id)], [2, ["shape:c"]]);
  assert.deepEqual((await exchange(d1, "plan", A, 2)).body, { seq: 2, plan_rev: 0, puts: [], removes: [] });
});

test("the last write to a record wins, other records are untouched, and a removal reaches the others", async () => {
  const d1 = new TestD1(6);
  await api(d1, "/api/roadmaps", "POST", { title: "Plan" });
  await exchange(d1, "plan", A, 0, [shape("a", 1), shape("b", 1)]);
  await exchange(d1, "plan", B, 1, [shape("a", 9)]);
  await exchange(d1, "plan", A, 1, [shape("b", 7)]);

  const opened = await (await api(d1, "/api/roadmaps/plan")).json() as { records: Array<{ id: string; x: number }> };
  assert.deepEqual(Object.fromEntries(opened.records.map((record) => [record.id, record.x])), { "shape:a": 9, "shape:b": 7 });

  const removed = await exchange(d1, "plan", A, 3, [], ["shape:a"]);
  assert.equal(removed.body.seq, 4);
  assert.deepEqual((await exchange(d1, "plan", B, 3)).body, { seq: 4, plan_rev: 0, puts: [], removes: ["shape:a"] });
  const after = await (await api(d1, "/api/roadmaps/plan")).json() as { records: Array<{ id: string }> };
  assert.deepEqual(after.records.map((record) => record.id), ["shape:b"]);

  // Drawing it again brings the record back from its tombstone.
  await exchange(d1, "plan", B, 4, [shape("a", 3)]);
  assert.equal(((await (await api(d1, "/api/roadmaps/plan")).json()) as { records: unknown[] }).records.length, 2);
});

test("a roadmap is invisible to another account", async () => {
  const d1 = new TestD1(6);
  const other: Actor = { id: "labb", label: "Lab B" };
  await api(d1, "/api/roadmaps", "POST", { title: "Plan" });
  await exchange(d1, "plan", A, 0, [shape("a", 1)]);

  assert.equal((await api(d1, "/api/roadmaps/plan", "GET", undefined, other)).status, 404);
  assert.equal((await api(d1, "/api/roadmaps/plan/changes", "POST", { client: B, since: 0, puts: [shape("x", 1)] }, other)).status, 404);
  assert.deepEqual(await (await api(d1, "/api/roadmaps", "GET", undefined, other)).json(), []);
  // The other account may hold a roadmap of the same name at the same address.
  assert.equal(((await (await api(d1, "/api/roadmaps", "POST", { title: "Plan" }, other)).json()) as { slug: string }).slug, "plan");
});

test("an archived roadmap can be read but not written, and restoring reopens it", async () => {
  const d1 = new TestD1(6);
  await api(d1, "/api/roadmaps", "POST", { title: "Plan" });
  await exchange(d1, "plan", A, 0, [shape("a", 1)]);
  assert.equal((await api(d1, "/api/roadmaps/plan", "PATCH", { archived: true })).status, 200);

  assert.deepEqual(await (await api(d1, "/api/roadmaps")).json(), []);
  assert.equal(((await (await api(d1, "/api/roadmaps?include_archived=1")).json()) as unknown[]).length, 1);
  const refused = await exchange(d1, "plan", A, 1, [shape("a", 2)]);
  assert.equal(refused.status, 409);
  assert.equal((await exchange(d1, "plan", B, 0)).body.puts.length, 1);

  await api(d1, "/api/roadmaps/plan", "PATCH", { archived: false, title: "Plan B" });
  assert.equal((await exchange(d1, "plan", A, 1, [shape("a", 2)])).status, 200);
  assert.equal(((await (await api(d1, "/api/roadmaps/plan")).json()) as { title: string }).title, "Plan B");
});

test("malformed changes are refused whole, leaving the roadmap as it was", async () => {
  const d1 = new TestD1(6);
  await api(d1, "/api/roadmaps", "POST", { title: "Plan" });
  const bad: Array<[object, RegExp]> = [
    [{ client: A, since: 0, puts: [shape("a", 1), { id: "instance:x", typeName: "instance" }] }, /not a document record/],
    [{ client: A, since: 0, puts: [{ id: "page:a", typeName: "shape" }] }, /does not match its type/],
    [{ client: A, since: 0, removes: ["camera:x"] }, /not a document record/],
    [{ client: "x", since: 0, puts: [] }, /browser session id/],
    [{ client: A, since: -1 }, /sequence number/],
    [{ client: A, since: 0, puts: [{ ...shape("big", 1), blob: "x".repeat(1_500_000) }] }, /too large/],
  ];
  for (const [body, message] of bad) {
    const response = await api(d1, "/api/roadmaps/plan/changes", "POST", body);
    assert.equal(response.status, 422);
    assert.match(((await response.json()) as { detail: string }).detail, message);
  }
  const opened = await (await api(d1, "/api/roadmaps/plan")).json() as { seq: number; records: unknown[] };
  assert.deepEqual([opened.seq, opened.records.length], [0, 0]);
  assert.equal((await api(d1, "/api/roadmaps", "POST", { title: "   " })).status, 422);
});

test("a failure halfway through a write stores none of it", async () => {
  const d1 = new TestD1(6);
  await api(d1, "/api/roadmaps", "POST", { title: "Plan" });
  let inserts = 0;
  d1.failOn((sql) => sql.startsWith("INSERT INTO roadmap_records") && (inserts += 1) === 2);
  assert.equal((await api(d1, "/api/roadmaps/plan/changes", "POST", { client: A, since: 0, puts: [shape("a", 1), shape("b", 1)] })).status, 500);
  d1.failOn(null);
  const opened = await (await api(d1, "/api/roadmaps/plan")).json() as { seq: number; records: unknown[] };
  assert.deepEqual([opened.seq, opened.records.length], [0, 0]);
});
