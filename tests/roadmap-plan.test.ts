import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACTOR, type Actor } from "../lib/accounts";
import { handleApi } from "../lib/api";
import { parseConfig } from "../lib/config";
import { BOX, layout, nodeLabel, parsePlan, ranks } from "../lib/roadmap-plan";
import { TestD1 } from "./d1";

const PLAN = {
  title: "Plan", source: "projects/p/roadmap/roadmap.md",
  lanes: [{ id: "top", title: "Top-down" }, { id: "bottom", title: "Bottom-up" }],
  nodes: [
    { id: "a", lane: "top", title: "A", status: "done", owner: "Tim" },
    { id: "b", lane: "top", title: "B", status: "doing", needs: ["a"] },
    { id: "c", lane: "bottom", title: "C", status: "todo" },
    { id: "d", lane: "bottom", title: "D", status: "todo" },
    { id: "e", lane: "bottom", title: "E", status: "todo", needs: ["b", "c"] },
  ],
};

async function api(d1: TestD1, path: string, method = "GET", body?: object, actor: Actor = DEFAULT_ACTOR) {
  return handleApi(new Request(`https://glancer.example${path}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined }), d1.db, parseConfig({}), actor);
}

test("a plan is read into canonical form, with defaults for what a task leaves out", () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(plan.nodes[0], { id: "a", title: "A", lane: "top", status: "done", owner: "Tim", needs: [], link: "", note: "" });
  assert.equal(nodeLabel(plan.nodes[0]), "A\nTim · done");
  // An unnamed owner is shown as an open question rather than left out.
  assert.equal(nodeLabel(plan.nodes[1]), "B\nDRI ? · doing");
});

test("a plan with a fault is refused with the fault named", () => {
  const change = (edit: (plan: typeof PLAN & { nodes: Array<Record<string, unknown>> }) => void) => { const copy = structuredClone(PLAN) as typeof PLAN & { nodes: Array<Record<string, unknown>> }; edit(copy); return copy; };
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[0].needs = ["e"]; })), /circle/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[1].needs = ["zzz"]; })), /needs zzz, which is not a task/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[1].needs = ["b"]; })), /needs itself/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[2].lane = "side"; })), /lane that is not declared/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[2].status = "finished"; })), /status must be one of/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[3].id = "a"; })), /share an id/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[3].link = "javascript:alert(1)"; })), /link must start with/);
  assert.throws(() => parsePlan(change((plan) => { plan.nodes[3].priority = 1; })), /unknown field: priority/);
  assert.throws(() => parsePlan({ ...PLAN, lanes: [] }), /lanes must list/);
});

test("boxes are laid out in columns by what they wait for, one band per lane, without overlap", () => {
  const plan = parsePlan(PLAN);
  assert.deepEqual(Object.fromEntries(ranks(plan.nodes)), { a: 0, b: 1, c: 0, d: 0, e: 2 });
  const placed = layout(plan);
  const at = (id: string) => placed.nodes.get(id)!;
  // Every arrow points right: a task sits right of everything it needs.
  for (const node of plan.nodes) for (const need of node.needs) assert.ok(at(node.id).x >= at(need).x + BOX.w, `${need} -> ${node.id}`);
  // Two tasks of one lane in one column stack; the lower lane starts below the upper one.
  assert.equal(at("c").x, at("d").x);
  assert.ok(at("d").y >= at("c").y + BOX.h);
  assert.ok(at("c").y >= at("a").y + BOX.h);
  const boxes = [...placed.nodes.values()];
  for (const [i, p] of boxes.entries()) for (const q of boxes.slice(i + 1)) assert.ok(Math.abs(p.x - q.x) >= BOX.w || Math.abs(p.y - q.y) >= BOX.h, "two boxes overlap");
});

test("pushing a plan creates the roadmap, and pushing it again changes nothing", async () => {
  const d1 = new TestD1(6);
  const created = await api(d1, "/api/roadmaps/yale-dlgn-26/plan", "PUT", PLAN);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { slug: "yale-dlgn-26", title: "Plan", plan_rev: 1, tasks: 5, created: true, changed: true });

  const again = await (await api(d1, "/api/roadmaps/yale-dlgn-26/plan", "PUT", PLAN)).json() as { changed: boolean; plan_rev: number };
  assert.deepEqual([again.changed, again.plan_rev], [false, 1]);

  const moved = structuredClone(PLAN); moved.nodes[1].status = "done"; moved.title = "Plan v2";
  const updated = await (await api(d1, "/api/roadmaps/yale-dlgn-26/plan", "PUT", moved)).json() as { changed: boolean; plan_rev: number };
  assert.deepEqual([updated.changed, updated.plan_rev], [true, 2]);

  const opened = await (await api(d1, "/api/roadmaps/yale-dlgn-26")).json() as { title: string; plan_rev: number; plan: { nodes: Array<{ status: string }> }; records: unknown[] };
  assert.deepEqual([opened.title, opened.plan_rev, opened.plan.nodes[1].status, opened.records.length], ["Plan v2", 2, "done", 0]);
  // An open canvas learns of the new plan from its next exchange.
  const exchange = await (await api(d1, "/api/roadmaps/yale-dlgn-26/changes", "POST", { client: "client-aaaa-0001", since: 0 })).json() as { plan_rev: number };
  assert.equal(exchange.plan_rev, 2);
});

test("a plan is refused for a bad address, a bad plan, an archived roadmap, and is private to its account", async () => {
  const d1 = new TestD1(6);
  assert.equal((await api(d1, "/api/roadmaps/Yale_26/plan", "PUT", PLAN)).status, 422);
  const bad = await api(d1, "/api/roadmaps/p/plan", "PUT", { ...PLAN, nodes: [{ id: "a", lane: "top", title: "A", status: "done", needs: ["a"] }] });
  assert.equal(bad.status, 422);
  assert.match(((await bad.json()) as { detail: string }).detail, /needs itself/);
  assert.deepEqual(await (await api(d1, "/api/roadmaps")).json(), []);

  await api(d1, "/api/roadmaps/p/plan", "PUT", PLAN);
  assert.equal((await api(d1, "/api/roadmaps/p", "GET", undefined, { id: "labb", label: "Lab B" })).status, 404);
  await api(d1, "/api/roadmaps/p", "PATCH", { archived: true });
  assert.equal((await api(d1, "/api/roadmaps/p/plan", "PUT", { ...PLAN, title: "Other" })).status, 409);
});
