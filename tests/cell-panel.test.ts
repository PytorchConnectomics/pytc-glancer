import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import CellPanel, { qualityOf, clearQualityIds, setQualityIds, categorySegments, clampGroupSize, parseIds, pipelineQuality, viewerSegments } from "../app/study/[slug]/glance/[key]/cell-panel";
import { mergeEdits } from "../lib/edits";
import type { ErrorReport, ReportClass, ReportSegment, Selection } from "../app/study/[slug]/glance/[key]/report-panel";
import { emptyReview, type GlanceReview } from "../lib/review";

function segment(id: string, voxels: number | null = 1_000, length: number | null = 5, quality: ReportSegment["quality"] = null): ReportSegment {
  return { id, voxels, volume_um3: 8, centroid_um: [1.5, 2.5, 3.5], radius_um: 0.4, length_um: length, margin: null, quality };
}
function klass(id: string, label: string, segments: ReportSegment[], ids = segments.map((entry) => entry.id)): ReportClass {
  return { id, label, voxels: 1_000, volume_um3: null, labels: null, note: null, margin_label: null, segment_ids: ids, segments };
}
const report: ErrorReport = {
  dataset: "sample", generated_at: null, segmentation: "sample_seg", voxel_volume_um3: null,
  notes: null, total_voxels: 8_000, figures: [], axons: [],
  // The five semantic classes, keyed by the structures' own ids, each record
  // carrying the pipeline's starting quality. Segment 40 has no voxel count.
  classes: [
    klass("blood_vessel", "Blood vessel", [segment("10"), segment("11")]),
    klass("glia", "Glia (incl. soma)", [segment("20")]),
    klass("dendrite", "Dendrite candidate", [segment("5", 9_000, 20)]),
    klass("axon", "Axon candidate", [segment("1", 500, 12, "complete"), segment("2", 3_000, 3, "false_split"), segment("3", 2_000, 40, "false_split"), segment("4", 100, 4), segment("40", null, null)]),
    klass("unclassified", "Unclassified", [segment("30")])
  ]
};

test("a structure's members are its own semantic class, and a morphology report offers none", () => {
  assert.deepEqual(categorySegments(report, "axon", []).map((entry) => entry.id), ["1", "2", "3", "4", "40"]);
  assert.deepEqual(categorySegments(report, "glia", []).map((entry) => entry.id), ["20"]);
  const morphology = { ...report, classes: [klass("good_axon_candidate", "Good axon candidate", [segment("1")])] };
  assert.deepEqual(categorySegments(morphology, "axon", []), []);
});

test("the pipeline's class sets the starting quality, and says nothing when it cannot", () => {
  assert.equal(pipelineQuality("good_axon_candidate"), "complete");
  assert.equal(pipelineQuality("broken_axon_candidate"), "false_split");
  assert.equal(pipelineQuality("suspicious_axon_candidate"), "unknown");
  assert.equal(pipelineQuality("dendrite_like"), "unknown");
  assert.equal(pipelineQuality("x", "Incomplete trace"), "false_split");
  // Nothing upstream screens for merges, so no class name starts a segment there.
  assert.ok(["good_axon_candidate", "broken_axon_candidate", "suspicious_axon_candidate", "dendrite_like"]
    .every((name) => pipelineQuality(name) !== "false_merge"));
  assert.equal(pipelineQuality(null), "unknown");
});

test("members are a category's class then its hand-added ids, each id once", () => {
  const segments = categorySegments(report, "blood_vessel", ["11", "40", "999"]);
  assert.deepEqual(segments.map((entry) => entry.id), ["10", "11", "40", "999"]);
  // An id the report describes arrives with its centroid; one it does not is bare.
  assert.deepEqual(segments[1].centroid_um, [1.5, 2.5, 3.5]);
  assert.deepEqual(segments[2].centroid_um, [1.5, 2.5, 3.5]);
  assert.equal(segments[3].voxels, null);
  assert.equal(segments[3].centroid_um, null);
  assert.deepEqual(categorySegments(null, "blood_vessel", ["7"]).map((entry) => entry.id), ["7"]);
});

test("ids are read out of whatever separators the reader pasted", () => {
  assert.deepEqual(parseIds("13460, 17942\n22072 13460"), ["13460", "17942", "22072"]);
  assert.deepEqual(parseIds("0013460"), ["13460"]);
  assert.deepEqual(parseIds("  "), []);
});

test("the viewer's shown segments are read from its link, its state, or bare ids", () => {
  const state = { layers: [
    { type: "image", name: "em" },
    { type: "segmentation", name: "seg", segments: ["2", "!3", "0095003"] },
    { type: "segmentation", name: "hidden", visible: false, segments: ["77"] }
  ] };
  // A hidden mesh is marked with "!", and a hidden layer shows nothing.
  assert.deepEqual(viewerSegments(`https://neuroglancer-demo.appspot.com/#!${encodeURIComponent(JSON.stringify(state))}`), ["2", "95003"]);
  assert.deepEqual(viewerSegments(`https://neuroglancer-demo.appspot.com/#!${JSON.stringify(state)}`), ["2", "95003"]);
  assert.deepEqual(viewerSegments(JSON.stringify(state)), ["2", "95003"]);
  assert.deepEqual(viewerSegments(JSON.stringify({ layers: [] })), []);
  assert.deepEqual(viewerSegments("2, 3"), ["2", "3"]);
  assert.equal(viewerSegments("nothing here"), null);
  assert.equal(viewerSegments("  "), null);
});

function mount(dom: JSDOM) {
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
}
const click = (dom: JSDOM, element: Element) => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
function button(label: string) {
  const match = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label));
  assert.ok(match, `Expected a ${label} button`);
  return match;
}

const text = () => document.body.textContent ?? "";
function harness() {
  const state = { pipeline: report, review: emptyReview() as GlanceReview, picked: null as Selection | null };
  // As the page wires it: moves already applied, the loaded report beside it.
  const props = () => ({
    report: mergeEdits(state.pipeline, state.review.class_review).report, source: state.pipeline, merged: mergeEdits(state.pipeline, state.review.class_review), review: state.review, onReviewChange: (next: GlanceReview) => { state.review = next; },
    onSelect: (value: Selection | null) => { state.picked = value; }, saveError: ""
  });
  return { state, props };
}
async function open() {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness();
  const render = () => act(async () => { root.render(createElement(CellPanel, props())); });
  await render();
  const press = async (label: string) => { await act(async () => { click(dom, button(label)); }); await render(); };
  // The pie's legend rows are buttons named like the verdicts, so a call is
  // pressed in the verdict row itself.
  const call = async (label: string) => {
    const match = [...document.querySelectorAll(".verdict-row button")].find((entry) => entry.textContent?.startsWith(label));
    assert.ok(match, `Expected a ${label} verdict`);
    await act(async () => { click(dom, match); });
    await render();
  };
  const tab = async (label: string) => {
    const input = [...document.querySelectorAll<HTMLInputElement>(".quality-tabs input")].find((entry) => entry.parentElement?.textContent?.includes(label))!;
    await act(async () => { input.click(); });
    await render();
  };
  // The same "Show at a time" dial as the semantic panel: one, or a group.
  const show = async (count: number) => {
    const field = document.querySelector<HTMLInputElement>(".cell-review input[type=number]")!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, String(count));
    await act(async () => { field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await render();
  };
  return { dom, root, state, render, press, call, tab, show };
}

test("the axon tab walks big to small from the pipeline's quality, and a call overrides it", async () => {
  const { root, state, press, call } = await open();

  // Three sub-tabs, axon first; largest first, one segment loaded and centred.
  assert.deepEqual([...document.querySelectorAll(".quality-tabs label")].map((entry) => entry.textContent), ["Axon", "Dendrite", "BV · Glia · Unclassified"]);
  assert.match(text(), /Segment 2/);
  assert.match(text(), /1 of 5/);
  assert.deepEqual(state.picked, { id: "quality:axon:2", segments: ["2"], centroid_um: [1.5, 2.5, 3.5] });
  assert.match(text(), /False split · pipeline/);
  assert.match(text(), /Skeleton length/);
  assert.ok(document.querySelector(".histogram"));
  // The pie counts the pipeline's calls carried on each record: one complete,
  // two split, and two it said nothing about.
  assert.deepEqual([...document.querySelectorAll(".legend-row")].map((entry) => entry.textContent), ["Complete8.93% (1)", "False split89.29% (2)", "False merge0.00% (0)", "Unknown1.79% (2)"]);
  assert.deepEqual(state.review, emptyReview());

  // A call is stored, overrides the pipeline, and advances.
  await call("Complete");
  assert.deepEqual(Object.keys(state.review.cell_review.axon), ["2"]);
  assert.equal(state.review.cell_review.axon["2"].verdict, "complete");
  assert.match(text(), /Segment 3/);
  assert.deepEqual([...document.querySelectorAll(".legend-row")].map((entry) => entry.textContent), ["Complete62.50% (2)", "False split35.71% (1)", "False merge0.00% (0)", "Unknown1.79% (2)"]);

  // Pressing the reader's own call again returns it to the pipeline's.
  await press("Previous");
  await call("Complete");
  assert.deepEqual(state.review.cell_review.axon, {});
  assert.match(text(), /False split · pipeline/);
  await act(async () => { root.unmount(); });
});

test("a quality slice narrows the stepper, and a changed call leaves it", async () => {
  const { dom, root, state, call, render } = await open();
  const split = [...document.querySelectorAll(".legend-row")].find((entry) => entry.textContent?.startsWith("False split"))!;
  await act(async () => { click(dom, split); });
  await render();
  assert.match(text(), /1 of 2/);
  assert.match(text(), /Segment 2/);

  // Marked complete, it no longer belongs under "false split", so the next one
  // slides into place rather than being skipped.
  await call("Complete");
  assert.equal(state.review.cell_review.axon["2"].verdict, "complete");
  assert.match(text(), /Segment 3/);
  assert.match(text(), /1 of 1/);
  await act(async () => { root.unmount(); });
});

test("the third tab switches between vessel, glia, and unclassified, with no length histogram", async () => {
  const { root, state, call, tab } = await open();
  await tab("BV");
  assert.equal(document.querySelector(".histogram"), null);
  assert.deepEqual([...document.querySelectorAll(".category-grid label")].map((entry) => entry.textContent), ["Blood vessel2", "Glia1", "Unclassified1"]);
  assert.match(text(), /Segment 10/);
  await call("False split");
  assert.deepEqual(Object.keys(state.review.cell_review.blood_vessel), ["10"]);

  const glia = [...document.querySelectorAll<HTMLInputElement>(".category-grid input")][1];
  await act(async () => { glia.click(); });
  assert.match(text(), /Segment 20/);
  assert.equal(state.picked?.id, "quality:glia:20");
  await call("Unknown");
  assert.deepEqual(Object.keys(state.review.cell_review.glia), ["20"]);
  assert.deepEqual(Object.keys(state.review.cell_review.blood_vessel), ["10"]);
  await act(async () => { root.unmount(); });
});

test("a pasted list moves to a semantic class or takes a quality, independently, without reloading the viewer", async () => {
  const { dom, root, state, press, render } = await open();
  const onScreen = state.picked;
  const box = () => [...document.querySelectorAll<HTMLTextAreaElement>(".id-input")].at(-1)!;
  const type = async (value: string) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
    await act(async () => { box().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await render();
  };
  type Select = Element & { value: string };
  const choose = async (label: string, value: string) => {
    const select = ([...document.querySelectorAll("select")] as unknown as Select[]).find((entry) => entry.parentElement?.textContent?.startsWith(label))!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    await act(async () => { select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await render();
  };

  // A viewer link: 2 has its mesh hidden, 5 is a dendrite, 77 is unknown.
  await type(`https://neuroglancer-demo.appspot.com/#!${encodeURIComponent(JSON.stringify({ layers: [{ type: "segmentation", segments: ["1", "3", "!2", "5", "77"] }] }))}`);
  await choose("Set quality", "false_merge");
  await press("Set 4 segments");
  // Each is filed under the class it sits in; the unknown one is left alone.
  assert.deepEqual(Object.keys(state.review.cell_review.axon).sort(), ["1", "3"]);
  assert.equal(state.review.cell_review.dendrite["5"].verdict, "false_merge");
  assert.match(text(), /3 set to false merge; 1 not in this report and left alone \(77\)/);
  assert.deepEqual(state.review.class_review, {});

  // The other action is independent: the same list, moved to glia.
  await choose("Move to", "glia");
  await press("Move 4 segments");
  assert.deepEqual(Object.keys(state.review.class_review).sort(), ["1", "3", "5"]);
  assert.ok(["1", "3", "5"].every((id) => state.review.class_review[id].to === "glia"));
  // Their quality calls went with them.
  assert.equal(state.review.cell_review.axon["1"].verdict, "false_merge");
  assert.match(text(), /3 moved to Glia/);
  // Neither action sent the viewer a new selection.
  assert.equal(state.picked, onScreen);
  await act(async () => { root.unmount(); });
});

test("ids typed by hand join a category and are stored as the reader's own", async () => {
  const { dom, root, state, press, render, tab } = await open();
  await tab("BV");
  await press("ids by hand —");
  assert.match(text(), /ids by hand — 2 segments/);
  // Typed the way a reader types: the field's value, then the input event.
  const box = document.querySelector<HTMLTextAreaElement>(".member-picker .id-input")!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "60 61");
  await act(async () => { box.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await render();
  await press("Add ids (2)");
  assert.deepEqual(state.review.cell_members.blood_vessel, { classes: [], ids: ["60", "61"] });
  assert.match(text(), /ids by hand — 4 segments, 2 added/);
  await act(async () => { root.unmount(); });
});

test("assigning a semantic class writes the semantic panel's reassign, and the call goes with it", async () => {
  const { dom, root, state, call, press, render, tab } = await open();
  await call("False merge");
  await press("Previous");
  assert.match(text(), /Segment 2/);
  type Select = Element & { value: string };
  const select = () => ([...document.querySelectorAll(".review-card select")] as unknown as Select[]).find((entry) => entry.parentElement?.textContent?.startsWith("Semantic class"))!;
  const choose = async (value: string) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(select(), value);
    await act(async () => { select().dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await render();
  };
  assert.equal(select().value, "");
  await choose("dendrite");

  assert.deepEqual(state.review.class_review["2"], { ...state.review.class_review["2"], verdict: "reassign", class: "axon", to: "dendrite" });
  assert.equal(state.review.cell_review.dendrite["2"], undefined);
  assert.equal(state.review.cell_review.axon["2"].verdict, "false_merge");
  // It has left the axon list, and waits in the dendrite one.
  assert.match(text(), /1 of 4/);
  await tab("Dendrite");
  // Largest first: the dendrite's own segment 5, then the one moved in.
  assert.match(text(), /1 of 2/);
  await press("Next");
  assert.match(text(), /Segment 2/);
  assert.match(text(), /moved from Axon candidate/);

  // Sending it back to the class the report files it under undoes the move.
  await choose("axon");
  assert.equal(state.review.class_review["2"], undefined);
  const returned: GlanceReview = state.review;
  assert.equal(returned.cell_review.axon["2"]?.verdict, "false_merge");
  await act(async () => { root.unmount(); });
});

test("a group size is whole and bounded, and a blank field is mid-edit", () => {
  assert.equal(clampGroupSize("100"), 100);
  assert.equal(clampGroupSize("100.6"), 101);
  assert.equal(clampGroupSize("0"), 1);
  assert.equal(clampGroupSize("99999"), 1000);
  // Blank and unreadable both mean "leave it alone", not zero.
  assert.equal(clampGroupSize(""), null);
  assert.equal(clampGroupSize("   "), null);
  assert.equal(clampGroupSize("abc"), null);
});

test("group mode loads a whole page into the viewer and pages through the rest", async () => {
  const { root, state, press, call, show } = await open();

  // One at a time is the opening mode: a single segment, centred.
  assert.deepEqual(state.picked?.segments, ["2"]);
  assert.ok(state.picked?.centroid_um);

  await show(100);

  // The whole filtered set fits one default-sized group; largest first.
  assert.deepEqual(state.picked?.segments, ["2", "3", "1", "4", "40"]);
  // A group has no single centre, so the frame is not moved.
  assert.equal(state.picked?.centroid_um, null);
  assert.match(text(), /1–5 of 5/);
  assert.match(text(), /Group 1 of 1/);

  await show(2);

  assert.deepEqual(state.picked?.segments, ["2", "3"]);
  assert.match(text(), /Group 1 of 3/);
  await press("Next group");
  assert.deepEqual(state.picked?.segments, ["1", "4"]);
  assert.match(text(), /3–4 of 5/);
  await press("Next group");
  assert.deepEqual(state.picked?.segments, ["40"]);
  assert.match(text(), /Group 3 of 3/);
  await press("Previous group");
  assert.deepEqual(state.picked?.segments, ["1", "4"]);

  // A call in group mode judges the loaded group, and says so on the button.
  await call("All 2 false merge");
  assert.deepEqual(Object.keys(state.review.cell_review.axon).sort(), ["1", "4"]);
  assert.ok(["1", "4"].every((id) => state.review.cell_review.axon[id].verdict === "false_merge"));
  // Every one already holding it, the same call returns them to the pipeline's.
  await call("All 2 false merge");
  assert.deepEqual(state.review.cell_review.axon, {});
  await act(async () => { root.unmount(); });
});

test("group mode walks whatever the histogram and quality chart left", async () => {
  const { dom, root, state, render, show } = await open();
  // Keep only what the pipeline calls a false split: segments 2 and 3.
  const split = [...document.querySelectorAll(".legend-row")].find((entry) => entry.textContent?.startsWith("False split"))!;
  await act(async () => { click(dom, split); });
  await render();
  await show(100);

  assert.deepEqual(state.picked?.segments, ["2", "3"]);
  assert.match(text(), /1–2 of 2/);
  await act(async () => { root.unmount(); });
});


test("the quality control panel has no correction action", async () => {
  const { root, state, render } = await open();
  try {
    state.review.class_review["2"] = { verdict: "reassign", to: "glia", class: "axon", at: 1 };
    await render();
    assert.doesNotMatch(text(), /Correct the report|Correcting…|Rewrites this glance's report/);
    assert.ok(document.querySelector(".cell-review"));
  } finally { await act(async () => root.unmount()); }
});


test("quality follows drift; explicit effective call wins, clearing removes every fallback", () => {
  const review = emptyReview();
  review.cell_review.glia["1"] = { verdict: "complete", at: 10 };
  review.cell_review.dendrite["1"] = { verdict: "false_merge", at: 20 };
  assert.equal(qualityOf(review, "1", "axon")?.verdict, "false_merge");
  review.cell_review.axon["1"] = { verdict: "false_split", at: 1 };
  assert.equal(qualityOf(review, "1", "axon")?.verdict, "false_split");
  assert.equal(qualityOf(clearQualityIds(review, ["1"]), "1", "axon"), null);
  const next = setQualityIds(review, report, ["1"], "unknown", "axon").review;
  assert.equal(next.cell_review.glia["1"], undefined);
  assert.equal(next.cell_review.dendrite["1"], undefined);
  assert.equal(next.cell_review.axon["1"].verdict, "unknown");
  const hand = emptyReview(); hand.cell_members.glia.ids = ["99"];
  assert.equal(qualityOf(setQualityIds(hand, null, ["99"], "complete", "glia").review, "99", "glia")?.verdict, "complete");
});
test("rejecting a hand-added member hides it without deleting membership and undo restores it", () => {
  const review = emptyReview(); review.cell_members.axon.ids = ["1"];
  review.class_review["1"] = { verdict: "reject", class: "axon", to: null, at: 1 };
  const merged = mergeEdits(report, review.class_review);
  assert.ok(!categorySegments(merged.report, "axon", review.cell_members.axon.ids, merged.effective).some((s) => s.id === "1"));
  assert.deepEqual(review.cell_members.axon.ids, ["1"]);
  assert.ok(categorySegments(report, "axon", review.cell_members.axon.ids, mergeEdits(report, {}).effective).some((s) => s.id === "1"));
});

test("QC controls follow pipeline drift and reassignment, set effective calls and clear fallbacks", async () => {
  const { dom, root, state, render, tab, press, call } = await open();
  try {
    state.review.cell_review.axon["2"] = { verdict: "false_merge", at: 1 };
    // An ingest now files 2 as dendrite; the old quality record stays in axon.
    state.pipeline = mergeEdits(report, { "2": { verdict: "reassign", class: "axon", to: "dendrite", at: 1 } }).report;
    await render(); await tab("Dendrite"); await press("Next");
    assert.match(text(), /Segment 2/);
    assert.match(document.querySelector(".review-card")!.textContent!, /False mergeSegment 2/);
    await call("Complete");
    assert.equal(state.review.cell_review.axon["2"], undefined);
    assert.equal(state.review.cell_review.dendrite["2"].verdict, "complete");
    const select = [...document.querySelectorAll(".review-card select")].find((entry) => entry.parentElement?.textContent?.startsWith("Semantic class"))!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(select, "axon");
    await act(async () => select.dispatchEvent(new dom.window.Event("change", { bubbles: true }))); await render();
    await tab("Axon");
    assert.match(text(), /Segment 2/);
    assert.match(document.querySelector(".review-card")!.textContent!, /CompleteSegment 2/);
    state.review.cell_review.glia["2"] = { verdict: "false_merge", at: 0 };
    await render();
    await call("Complete");
    for (const entries of Object.values(state.review.cell_review)) assert.equal(entries["2"], undefined);
    assert.match(text(), /False split · pipeline/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
