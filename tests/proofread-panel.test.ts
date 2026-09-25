import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import ProofreadPanel, { orderSegments } from "../app/study/[slug]/glance/[key]/proofread-panel";
import type { ErrorReport, ReportSegment, Selection } from "../app/study/[slug]/glance/[key]/report-panel";
import { emptyReview, type GlanceReview } from "../lib/review";

function segment(id: string, voxels: number | null, margin: number | null, radius: number): ReportSegment {
  return { id, voxels, volume_um3: voxels === null ? null : voxels * 7.776e-6, centroid_um: [1.5, 2.5, 3.5], radius_um: radius, length_um: 4, margin, quality: null };
}
/* Deliberately not in either sorted order, so a passing test cannot be an
 * accident of the fixture already being sorted. */
const segments = [
  segment("big", 500_000, 0.75, 1.1),
  segment("borderline", 1_000, 0.0095, 0.3595),
  segment("middle", 20_000, 0.2, 0.55),
  segment("unmeasured", null, null, 0.6)
];
const report: ErrorReport = {
  dataset: "sample", generated_at: "2026-09-07", segmentation: "sample_seg", voxel_volume_um3: 7.776e-6,
  notes: null, total_voxels: 521_000, figures: [], axons: [],
  classes: [
    { id: "dendrite_like", label: "Dendrite-like candidate", voxels: 521_000, volume_um3: 4, labels: 4, note: null,
      margin_label: "radius above the 0.35 um axon cutoff", segment_ids: segments.map((entry) => entry.id), segments },
    { id: "empty", label: "No records", voxels: 1, volume_um3: null, labels: 1, note: null, margin_label: null, segment_ids: ["9"], segments: [] }
  ]
};

test("ordering puts the borderline case first, the biggest first, or leaves the report alone", () => {
  assert.deepEqual(orderSegments(segments, "margin").map((entry) => entry.id), ["borderline", "middle", "big", "unmeasured"]);
  assert.deepEqual(orderSegments(segments, "size").map((entry) => entry.id), ["big", "middle", "borderline", "unmeasured"]);
  assert.deepEqual(orderSegments(segments, "report").map((entry) => entry.id), segments.map((entry) => entry.id));
  // Ordering is a view, never a mutation of the report's own list.
  assert.deepEqual(segments.map((entry) => entry.id), ["big", "borderline", "middle", "unmeasured"]);
});

/* The panel no longer owns its verdicts -- the glance page does, and saves
 * them -- so the harness holds the record and hands back each change. */
function harness(overrides: Record<string, unknown> = {}) {
  const state = { review: emptyReview(), applied: 0 };
  const props = () => ({
    report, classId: "dendrite_like", onClassChange: () => {}, onSelect: () => {},
    review: state.review, onReviewChange: (next: GlanceReview) => { state.review = next; },
    onApply: () => { state.applied += 1; }, applying: false, applyNote: "", saveError: "",
    ...overrides
  });
  return { state, props };
}

function mount(dom: JSDOM) {
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, Blob: dom.window.Blob })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
}
// jsdom and lib.dom disagree on HTMLSelectElement, so ask for only the two
// members these assertions touch.
type Select = Element & { value: string; options: { length: number; item(index: number): { value: string } | null } };
const selects = () => [...document.querySelectorAll("select")] as unknown as Select[];
const click = (dom: JSDOM, element: Element) => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
function button(label: string) {
  const match = [...document.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label));
  assert.ok(match, `Expected a ${label} button`);
  return match;
}

test("the stepper shows one segment at a time, centred, between Previous, Reassign, and Next", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const picked: { value: Selection | null } = { value: null };
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness({ onSelect: (value: Selection | null) => { picked.value = value; } });
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, props())); });
  await render();

  // Only classes with records are offered; the ids-only class is not steppable.
  const classes = selects()[0];
  assert.deepEqual(Array.from({ length: classes.options.length }, (_, index) => classes.options.item(index)!.value), ["dendrite_like"]);

  // The default ordering opens on the borderline segment, one segment loaded,
  // with the centroid handed up for the camera.
  assert.match(document.body.textContent ?? "", /Segment borderline/);
  assert.match(document.body.textContent ?? "", /1 of 4/);
  assert.deepEqual(picked.value, { id: "review:dendrite_like:borderline", segments: ["borderline"], centroid_um: [1.5, 2.5, 3.5] });
  assert.match(document.body.textContent ?? "", /radius above the 0\.35 um axon cutoff/);

  await act(async () => { click(dom, button("Next")); });
  await render();
  assert.match(document.body.textContent ?? "", /Segment middle/);
  assert.deepEqual(picked.value?.segments, ["middle"]);

  await act(async () => { click(dom, button("Previous")); });
  await render();
  assert.deepEqual(picked.value?.segments, ["borderline"]);

  // Reassign is the only verdict, in one row between the two steps: a
  // segment that looks right needs nothing, so moving on keeps it.
  const row = document.querySelector(".review-controls.verdict-row")!;
  assert.deepEqual([...row.querySelectorAll("button")].map((entry) => entry.textContent), ["Keep K", "Reject R", "Reassign A"]);
  assert.equal([...document.querySelectorAll("button")].some((entry) => /^(Keep|Reject)/.test(entry.textContent ?? "")), true);
  await act(async () => { click(dom, button("Next")); });
  await render();
  assert.deepEqual(state.review.class_review, {});
  await act(async () => { root.unmount(); });
});

test("switching to largest-first reorders the stepper and restarts it", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const picked: { value: Selection | null } = { value: null };
  const root = createRoot(document.querySelector("#app")!);
  const { props } = harness({ onSelect: (value: Selection | null) => { picked.value = value; } });
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, props())); });
  await render();

  await act(async () => { click(dom, button("Next")); });
  await render();
  assert.match(document.body.textContent ?? "", /2 of 4/);

  const ordering = selects()[1];
  const nativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
  nativeValue.call(ordering, "size");
  await act(async () => { ordering.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await render();

  assert.match(document.body.textContent ?? "", /Segment big/);
  assert.match(document.body.textContent ?? "", /1 of 4/);
  assert.deepEqual(picked.value?.segments, ["big"]);
  assert.match(document.body.textContent ?? "", /Biggest segments first/);
  await act(async () => { root.unmount(); });
});

test("a report with no per-segment records says so instead of an empty stepper", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const bare = { ...report, classes: report.classes.map((entry) => ({ ...entry, segments: [] })) };
  const { props } = harness({ report: bare, classId: null });
  await act(async () => { root.render(createElement(ProofreadPanel, props())); });
  assert.equal(document.querySelectorAll("select").length, 0);
  assert.match(document.body.textContent ?? "", /no per-segment records/);
  await act(async () => { root.unmount(); });
});

test("a reassignment waits for a target, then moves the segment into that class", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const view = { classId: "dendrite_like" };
  const { state, props } = harness({ onClassChange: (id: string) => { view.classId = id; } });
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, { ...props(), classId: view.classId })); });
  const nativeValue = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!;
  const choose = async (select: Select, value: string) => {
    nativeValue.call(select, value);
    await act(async () => { select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    await render();
  };
  await render();

  // Pressing the same verdict again clears it, and the target select goes too.
  await act(async () => { click(dom, button("Reassign")); });
  await render();
  assert.equal(selects().length, 4);  // class, order, reassign target, batch target
  await act(async () => { click(dom, button("Reassign")); });
  await render();
  assert.equal(selects().length, 4);  // class, order, batch target
  assert.deepEqual(state.review.class_review, {});

  // Reassign waits for a target.
  await act(async () => { click(dom, button("Reassign")); });
  await render();
  assert.match(document.body.textContent ?? "", /Segment borderline/);
  const target = selects()[2];
  assert.equal(target.value, "");
  assert.deepEqual(Array.from({ length: target.options.length }, (_, index) => target.options.item(index)!.value), ["", "dendrite_like", "empty"]);

  // Choosing it takes the segment out of this class: the next one slides in
  // under the cursor, and the class it went to now offers it for review.
  await choose(target, "empty");
  assert.deepEqual(state.review.class_review.borderline, { ...state.review.class_review.borderline, verdict: "reassign", class: "dendrite_like", to: "empty" });
  assert.match(document.body.textContent ?? "", /Segment middle/);
  assert.match(document.body.textContent ?? "", /1 of 3/);
  assert.match(document.body.textContent ?? "", /0 of 3 judged in this class/);
  assert.equal(selects().length, 4);  // class, order, batch target
  const classes = selects()[0];
  assert.deepEqual(Array.from({ length: classes.options.length }, (_, index) => classes.options.item(index)!.value), ["dendrite_like", "empty"]);

  // In its new class it sits among that class's own members and says where it
  // came from; moving on leaves the move standing.
  await choose(classes, "empty");
  assert.match(document.body.textContent ?? "", /Segment borderline/);
  assert.match(document.body.textContent ?? "", /1 of 2/);
  assert.match(document.body.textContent ?? "", /Moved from Dendrite-like candidate/);
  await act(async () => { click(dom, button("Next")); });
  await render();
  assert.match(document.body.textContent ?? "", /Segment 9/);
  assert.equal(state.review.class_review.borderline.to, "empty");
  await act(async () => { click(dom, button("Previous")); });
  await render();

  // Sending it back to the class the report files it under undoes the move.
  await choose(selects()[2], "dendrite_like");
  assert.deepEqual(state.review.class_review, {});
  assert.equal(selects()[0].options.length, 1);
  assert.match(document.body.textContent ?? "", /Segment borderline/);
  await act(async () => { root.unmount(); });
});

test("a pasted list of ids moves to one class together, and says what it left alone", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness();
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, props())); });
  await render();

  const box = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1)!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, "9, 12345");
  await act(async () => { box.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await render();
  assert.equal(button("Move 2 segments").disabled, true);

  const target = selects().at(-1)!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(target, "dendrite_like");
  await act(async () => { target.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await render();
  await act(async () => { click(dom, button("Move 2 segments")); });
  await render();

  assert.deepEqual(state.review.class_review["9"], { ...state.review.class_review["9"], verdict: "reassign", class: "empty", to: "dendrite_like" });
  assert.equal(state.review.class_review["12345"], undefined);
  assert.match(document.body.textContent ?? "", /1 moved to Dendrite-like candidate; 1 not in this report and left alone \(12345\)/);
  await act(async () => { root.unmount(); });
});

test("showing more than one at a time loads a page, and a verdict judges the whole page", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const picked: { value: Selection | null } = { value: null };
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness({ onSelect: (value: Selection | null) => { picked.value = value; } });
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, props())); });
  await render();
  assert.equal(picked.value?.segments.length, 1);

  const field = document.querySelector<HTMLInputElement>("input[type=number]")!;
  assert.equal(field.value, "1");
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "3");
  await act(async () => { field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await render();

  // Closest to the cutoff first, three of four; a page keeps the frame's position.
  assert.deepEqual(picked.value?.segments, ["borderline", "middle", "big"]);
  assert.equal(picked.value?.centroid_um, null);
  assert.match(document.body.textContent ?? "", /1–3 of 4/);
  assert.match(document.body.textContent ?? "", /Page 1 of 2/);

  // A page is only ever reassigned: there is no keep-all or reject-all.
  assert.equal([...document.querySelectorAll("button")].some((entry) => /Keep all|Reject all/.test(entry.textContent ?? "")), false);
  const target = selects().find((entry) => entry.parentElement?.textContent?.startsWith("Reassign all 3 to"))!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(target, "empty");
  await act(async () => { target.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await render();
  assert.deepEqual(Object.keys(state.review.class_review).sort(), ["big", "borderline", "middle"]);
  assert.ok(Object.values(state.review.class_review).every((entry) => entry.verdict === "reassign" && entry.class === "dendrite_like" && entry.to === "empty"));
  // Moved out, they leave the class, and what remains is the next page's worth.
  assert.deepEqual(picked.value?.segments, ["unmeasured"]);
  assert.match(document.body.textContent ?? "", /Page 1 of 1/);
  await act(async () => { root.unmount(); });
});

test("a page steps forward and back", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const picked: { value: Selection | null } = { value: null };
  const root = createRoot(document.querySelector("#app")!);
  const { props } = harness({ onSelect: (value: Selection | null) => { picked.value = value; } });
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, props())); });
  await render();
  const field = document.querySelector<HTMLInputElement>("input[type=number]")!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "3");
  await act(async () => { field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await render();
  await act(async () => { click(dom, button("Next page")); });
  await render();
  assert.deepEqual(picked.value?.segments, ["unmeasured"]);
  assert.match(document.body.textContent ?? "", /Page 2 of 2/);
  await act(async () => { root.unmount(); });
});

test("a batch move leaves the viewer alone, even when it moves the segment on screen", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  mount(dom);
  const shown: Array<Selection | null> = [];
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness({ onSelect: (value: Selection | null) => { shown.push(value); } });
  // Ids must be numeric to paste, so this report's dendrite class uses them.
  const numbered = { ...report, classes: [{ ...report.classes[0], segment_ids: ["1", "2", "3"], segments: [
    { ...segments[0], id: "1" }, { ...segments[1], id: "2" }, { ...segments[2], id: "3" }] }, report.classes[1]] };
  const render = () => act(async () => { root.render(createElement(ProofreadPanel, { ...props(), report: numbered })); });
  await render();
  const onScreen = shown.at(-1)?.segments[0];
  const loads = shown.length;

  const box = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].at(-1)!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(box, onScreen!);
  await act(async () => { box.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const target = selects().at(-1)!;
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(target, "empty");
  await act(async () => { target.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
  await render();
  await act(async () => { click(dom, button("Move 1 segment")); });
  await render();

  assert.equal(state.review.class_review[onScreen!].to, "empty");
  assert.equal(shown.length, loads, "the move must not send the viewer a new selection");
  // The box is emptied for the next paste; stepping brings the viewer back in step.
  assert.equal(box.value, "");
  await act(async () => { click(dom, button("Next")); });
  assert.ok(shown.length > loads);
  await act(async () => { root.unmount(); });
});

test("reject keeps the cursor, the last rejection stays reachable, and pipeline undo restores it", async () => {
  const dom = new JSDOM("<div id=app></div>", { url: "https://mind.example/" }); mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const view = { classId: "dendrite_like" };
  const { state, props } = harness({ onClassChange: (id: string) => { view.classId = id; } });
  const small = { ...report, classes: [{ ...report.classes[0], segments: segments.slice(0, 2), segment_ids: ["big", "borderline"] }] };
  const render = () => act(async () => root.render(createElement(ProofreadPanel, { ...props(), report: small, classId: view.classId })));
  await render();
  assert.doesNotMatch(document.body.textContent!, /Correct the report/);
  await act(async () => click(dom, button("Reassign"))); await render();
  assert.deepEqual(state.review.class_review, {});
  assert.equal(document.activeElement, selects()[2]);
  await act(async () => click(dom, button("Reject"))); await render();
  assert.match(document.body.textContent!, /Segment big/);
  assert.match(document.body.textContent!, /Rejected \(1\)/);
  await act(async () => click(dom, button("Reject"))); await render();
  assert.match(document.body.textContent!, /Rejected \(2\)/);
  assert.equal([...document.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Keep")), false);
  await act(async () => click(dom, button("Use the pipeline's class"))); await render();
  assert.equal(Object.keys(state.review.class_review).length, 1);
  await act(async () => root.unmount()); dom.window.close();
});

test("a drifted Keep pin explains pipeline disagreement and selecting pipeline removes it", async () => {
  const dom = new JSDOM("<div id=app></div>", { url: "https://mind.example/" }); mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness();
  state.review.class_review.borderline = { verdict: "keep", class: "empty", to: null, at: 42 };
  const render = () => act(async () => root.render(createElement(ProofreadPanel, { ...props(), classId: "empty" })));
  await render();
  assert.match(document.body.textContent!, /Kept as No records — the pipeline now says Dendrite-like candidate/);
  const target = selects()[2];
  assert.match(target.textContent!, /Dendrite-like candidate \(pipeline\)/);
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, "value")!.set!.call(target, "dendrite_like");
  await act(async () => target.dispatchEvent(new dom.window.Event("change", { bubbles: true }))); await render();
  assert.deepEqual(state.review.class_review, {});
  await act(async () => root.unmount()); dom.window.close();
});

test("null move provenance renders as restored from Rejected", async () => {
  const dom = new JSDOM("<div id=app></div>"); mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const { state, props } = harness();
  state.review.class_review.borderline = { verdict: "reassign", class: null, to: "empty", at: 42 };
  try {
    await act(async () => root.render(createElement(ProofreadPanel, { ...props(), classId: "empty" })));
    assert.match(document.body.textContent!, /Restored from Rejected/);
    assert.doesNotMatch(document.body.textContent!, /Moved from null/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("page selection resynchronizes when membership changes at the same page offset", async () => {
  const dom = new JSDOM("<div id=app></div>"); mount(dom);
  const root = createRoot(document.querySelector("#app")!);
  const picked: { value: Selection | null } = { value: null };
  const { state, props } = harness({ onSelect: (value: Selection | null) => { picked.value = value; } });
  const render = () => act(async () => root.render(createElement(ProofreadPanel, props())));
  try {
    await render();
    const field = document.querySelector<HTMLInputElement>("input[type=number]")!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, "2");
    await act(async () => field.dispatchEvent(new dom.window.Event("input", { bubbles: true }))); await render();
    assert.deepEqual(picked.value?.segments, ["borderline", "middle"]);
    state.review = { ...state.review, class_review: { borderline: { verdict: "reject", class: "dendrite_like", to: null, at: 42 } } };
    await render();
    assert.deepEqual(picked.value?.segments, ["middle", "big"]);
    assert.equal(picked.value?.centroid_um, null);
    assert.match(document.body.textContent!, /Page 1 of 2/);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});
