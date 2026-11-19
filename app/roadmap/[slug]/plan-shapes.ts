import { createBindingId, createShapeId, toRichText, type Editor, type TLDefaultColorStyle, type TLShapeId } from "tldraw";
import { BOX, layout, nodeLabel, nodeMark, type Plan, type Status } from "../../../lib/roadmap-plan";

const COLOR: Record<Status, TLDefaultColorStyle> = { done: "green", doing: "orange", todo: "grey", blocked: "red" };
const LEGEND = "green done · orange doing · grey todo · red blocked";

/* Bring the canvas in step with the project's plan.
 *
 * Every shape drawn from the plan has an id derived from the task it stands
 * for, so drawing the same plan twice, or from two browsers at once, arrives
 * at the same shapes rather than at duplicates. A shape that already exists is
 * only ever given new text and colour: its place and size belong to whoever
 * arranged the board. Shapes people drew themselves carry no `plan` mark and
 * are never touched. A task that left the plan takes its box and arrows with it. */
export function drawPlan(editor: Editor, plan: Plan) {
  const page = editor.getPages()[0].id;
  const placed = layout(plan);
  const wanted = new Set<TLShapeId>();

  function label(key: string, text: string, x: number, y: number, size: "s" | "m" | "l" | "xl") {
    const id = createShapeId(`plan-${key}`);
    wanted.add(id);
    const existing = editor.getShape(id);
    if (!existing) editor.createShape({ id, type: "text", parentId: page, x, y, props: { richText: toRichText(text), size, font: "sans" }, meta: { plan: "label", mark: text } });
    else if (existing.meta.mark !== text) editor.updateShape({ id, type: "text", props: { richText: toRichText(text) }, meta: { plan: "label", mark: text } });
  }

  editor.run(() => {
    label("title", plan.title, placed.title.x, placed.title.y, "xl");
    label("legend", plan.source ? `${LEGEND}\nStatus and owners follow ${plan.source}. Move boxes freely.` : LEGEND, placed.title.x, placed.title.y + 74, "s");
    for (const lane of placed.lanes) label(`lane-${lane.id}`, lane.title, lane.x, lane.y, "l");

    for (const node of plan.nodes) {
      const id = createShapeId(`plan-node-${node.id}`);
      wanted.add(id);
      const mark = nodeMark(node);
      const shown = { richText: toRichText(nodeLabel(node)), color: COLOR[node.status], url: node.link };
      const existing = editor.getShape(id);
      const at = placed.nodes.get(node.id)!;
      if (!existing) editor.createShape({ id, type: "geo", parentId: page, x: at.x, y: at.y, props: { geo: "rectangle", w: BOX.w, h: BOX.h, fill: "solid", size: "s", font: "sans", dash: "solid", ...shown }, meta: { plan: "node", mark } });
      else if (existing.meta.mark !== mark) editor.updateShape({ id, type: "geo", props: shown, meta: { plan: "node", mark } });
    }

    for (const node of plan.nodes) for (const need of node.needs) {
      const id = createShapeId(`plan-edge-${need}--${node.id}`);
      wanted.add(id);
      if (editor.getShape(id)) continue;
      const from = createShapeId(`plan-node-${need}`); const to = createShapeId(`plan-node-${node.id}`);
      const start = editor.getShapePageBounds(from)?.center; const end = editor.getShapePageBounds(to)?.center;
      if (!start || !end) continue;
      editor.createShape({ id, type: "arrow", parentId: page, x: 0, y: 0, props: { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y }, color: "grey", size: "s" }, meta: { plan: "edge" } });
      editor.createBindings([
        { id: createBindingId(`plan-edge-${need}--${node.id}-start`), type: "arrow", fromId: id, toId: from, props: { terminal: "start", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
        { id: createBindingId(`plan-edge-${need}--${node.id}-end`), type: "arrow", fromId: id, toId: to, props: { terminal: "end", normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
      ]);
    }

    const gone = editor.store.allRecords().filter((record) => record.typeName === "shape" && record.meta.plan && !wanted.has(record.id)).map((record) => record.id as TLShapeId);
    if (gone.length) editor.deleteShapes(gone);
  }, { history: "ignore", ignoreShapeLock: true });
}
