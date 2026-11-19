/* A roadmap's plan: the tasks and dependencies a project declares in its own
 * repository (`projects/<name>/roadmap/roadmap.md`), pushed here by
 * `scripts/sync_roadmaps.py`.
 *
 * The plan and the canvas are owned by different hands. The file owns which
 * tasks exist, who is responsible, how far each is and what it waits for; the
 * canvas owns where a box sits and everything people draw around the boxes.
 * So the canvas draws one box per task, keeps its text and colour in step with
 * the file, and never moves a box that is already there. This module is the
 * part of that both sides share: the server checks a plan with it, and the
 * browser lays out the boxes that are new. */

export const STATUSES = ["done", "doing", "todo", "blocked"] as const;
export type Status = (typeof STATUSES)[number];

export interface PlanLane { id: string; title: string; }
export interface PlanNode { id: string; title: string; lane: string; status: Status; owner: string; needs: string[]; link: string; note: string; }
export interface Plan { title: string; source: string; lanes: PlanLane[]; nodes: PlanNode[]; }

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_NODES = 300;
const MAX_LANES = 20;

function text(value: unknown, name: string, max: number, required = false) {
  if (value === undefined || value === null) { if (required) throw new Error(`${name} is required.`); return ""; }
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${name} is required.`);
  if (trimmed.length > max) throw new Error(`${name} must be at most ${max} characters.`);
  return trimmed;
}

function only(item: Record<string, unknown>, allowed: string[], where: string) {
  const unknown = Object.keys(item).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${where} has an unknown field: ${unknown}.`);
}

function object(value: unknown, where: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object.`);
  return value as Record<string, unknown>;
}

/** Check a plan and return it in canonical form; throws with the first fault. */
export function parsePlan(value: unknown): Plan {
  const raw = object(value, "The plan");
  only(raw, ["title", "source", "lanes", "nodes"], "The plan");
  if (!Array.isArray(raw.lanes) || !raw.lanes.length || raw.lanes.length > MAX_LANES) throw new Error(`lanes must list 1 to ${MAX_LANES} lanes.`);
  if (!Array.isArray(raw.nodes) || raw.nodes.length > MAX_NODES) throw new Error(`nodes must list at most ${MAX_NODES} tasks.`);
  const lanes: PlanLane[] = (raw.lanes as unknown[]).map((entry, index) => {
    const lane = object(entry, `Lane ${index + 1}`);
    only(lane, ["id", "title"], `Lane ${index + 1}`);
    if (typeof lane.id !== "string" || !ID.test(lane.id)) throw new Error(`Lane ${index + 1} needs a lowercase id such as top-down.`);
    return { id: lane.id, title: text(lane.title, `Lane ${lane.id} title`, 120, true) };
  });
  if (new Set(lanes.map((lane) => lane.id)).size !== lanes.length) throw new Error("Two lanes share an id.");
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const nodes: PlanNode[] = (raw.nodes as unknown[]).map((entry, index) => {
    const node = object(entry, `Task ${index + 1}`);
    only(node, ["id", "title", "lane", "status", "owner", "needs", "link", "note"], `Task ${index + 1}`);
    if (typeof node.id !== "string" || !ID.test(node.id)) throw new Error(`Task ${index + 1} needs a lowercase id such as soma-seg.`);
    if (typeof node.lane !== "string" || !laneIds.has(node.lane)) throw new Error(`Task ${node.id} names a lane that is not declared.`);
    if (typeof node.status !== "string" || !(STATUSES as readonly string[]).includes(node.status)) throw new Error(`Task ${node.id} status must be one of ${STATUSES.join(", ")}.`);
    const needs = node.needs ?? [];
    if (!Array.isArray(needs) || !needs.every((need) => typeof need === "string")) throw new Error(`Task ${node.id} needs must be a list of task ids.`);
    const link = text(node.link, `Task ${node.id} link`, 500);
    if (link && !/^https?:\/\//.test(link)) throw new Error(`Task ${node.id} link must start with http:// or https://.`);
    return { id: node.id, title: text(node.title, `Task ${node.id} title`, 120, true), lane: node.lane, status: node.status as Status,
      owner: text(node.owner, `Task ${node.id} owner`, 60), needs: [...new Set(needs as string[])], link, note: text(node.note, `Task ${node.id} note`, 300) };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error("Two tasks share an id.");
  for (const node of nodes) for (const need of node.needs) {
    if (need === node.id) throw new Error(`Task ${node.id} needs itself.`);
    if (!byId.has(need)) throw new Error(`Task ${node.id} needs ${need}, which is not a task.`);
  }
  ranks(nodes); // throws on a cycle
  return { title: text(raw.title, "title", 200, true), source: text(raw.source, "source", 300), lanes, nodes };
}

/** How many steps of waiting stand before each task: 0 for one that waits for nothing. */
export function ranks(nodes: PlanNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rank = new Map<string, number>();
  const open = new Set<string>();
  function visit(id: string): number {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (open.has(id)) throw new Error(`The tasks wait on each other in a circle through ${id}; a roadmap must have no cycle.`);
    open.add(id);
    const value = Math.max(-1, ...byId.get(id)!.needs.map(visit)) + 1;
    open.delete(id);
    rank.set(id, value);
    return value;
  }
  for (const node of nodes) visit(node.id);
  return rank;
}

export const BOX = { w: 230, h: 96, gapX: 90, gapY: 34, laneGap: 70, header: 56 };

export interface Placed { lanes: Array<{ id: string; title: string; x: number; y: number }>; nodes: Map<string, { x: number; y: number }>; title: { x: number; y: number }; }

/* Where a box goes the first time it is drawn: columns by how much a task
 * waits for, so every arrow points right, and one band per lane. Only new
 * boxes are placed by this; a box someone has moved stays where they put it. */
export function layout(plan: Plan): Placed {
  const rank = ranks(plan.nodes);
  const placed: Placed = { lanes: [], nodes: new Map(), title: { x: 0, y: -170 } };
  let top = 0;
  for (const lane of plan.lanes) {
    placed.lanes.push({ id: lane.id, title: lane.title, x: 0, y: top });
    const rows = new Map<number, number>();
    for (const node of plan.nodes.filter((entry) => entry.lane === lane.id)) {
      const column = rank.get(node.id)!;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      placed.nodes.set(node.id, { x: column * (BOX.w + BOX.gapX), y: top + BOX.header + row * (BOX.h + BOX.gapY) });
    }
    const tallest = Math.max(1, ...rows.values());
    top += BOX.header + tallest * (BOX.h + BOX.gapY) + BOX.laneGap;
  }
  return placed;
}

/** The text in a task's box. An unnamed owner is shown as a question, not hidden. */
export function nodeLabel(node: PlanNode) { return `${node.title}\n${node.owner || "DRI ?"} · ${node.status}`; }

/** Changes exactly when what the box shows should change. */
export function nodeMark(node: PlanNode) { return JSON.stringify([node.title, node.owner, node.status, node.link]); }
