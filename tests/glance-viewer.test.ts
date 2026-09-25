import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import GlanceClient from "../app/study/[slug]/glance/[key]/glance-client";
import { emptyReview } from "../lib/review";


const SEG = "gs+ngauth+https://auth.example/example_bucket/sample_seg/|neuroglancer-precomputed:";
const state = {
  dimensions: { z: [1.25e-8, "m"] },
  layers: [
    { type: "image", name: "sample.zarr", source: "gs+ngauth+https://auth.example/example_bucket/sample.zarr/|zarr2:" },
    { type: "segmentation", name: "sample_seg", source: SEG, segments: [] }
  ],
  selectedLayer: { visible: true, layer: "sample_seg" }
};
const study = {
  id: "study-id", title: "Fixture study", slug: "fixture-study", description: null, archived_at: null,
  glances: [{
    id: "glance-id", short_key: "key", short_name: null, title: "Sample volume",
    url_base: "https://neuroglancer-demo.appspot.com", state: JSON.stringify(state), source_path: null,
    position: 1, archived_at: null, created_at: 1_700_000_000_000, updated_at: 1_700_000_001_000,
    shareable_link: "https://neuroglancer-demo.appspot.com#!https://mind.example/ng/key"
  }]
};
const report = {
  dataset: "sample", generated_at: "2026-09-06", segmentation: "sample_seg", voxel_volume_um3: 7.776e-6,
  notes: null, total_voxels: 300,
  classes: [
    { id: "through_axon", label: "Through-axon candidate", voxels: 100, volume_um3: 1, labels: 2, note: null, margin_label: null, segment_ids: ["13460", "17942"], segments: [] },
    { id: "broken_axon", label: "Possible broken axon", voxels: 200, volume_um3: 2, labels: 3, note: null, margin_label: null, segment_ids: ["22072"], segments: [] }
  ],
  figures: [], axons: []
};

function click(dom: JSDOM, element: Element) { return element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); }
function rail(label: string) {
  const match = [...document.querySelectorAll<HTMLButtonElement>(".rail-button")].find((entry) => entry.getAttribute("title") === label);
  assert.ok(match, `Expected a ${label} rail button`);
  return match;
}
function show() {
  const match = [...document.querySelectorAll("button")].find((entry) => /^Show \d+ in the viewer$/.test(entry.textContent ?? ""));
  assert.ok(match, "Expected the button that loads a class into the viewer");
  return match;
}
function iframeSrc() { return document.querySelector("iframe")?.getAttribute("src") ?? ""; }
function decodedState() { return JSON.parse(decodeURIComponent(iframeSrc().split("#!")[1] ?? "{}")) as typeof state; }

test("the framed viewer reloads with a class's segments when its pie slice is clicked", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/study/fixture-study/glance/key" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://mind.example");
    asked.push(url.pathname);
    if (url.pathname === "/api/studies/fixture-study") return Response.json(study);
    if (url.pathname === "/api/glances/key/report") return Response.json(report);
    if (url.pathname === "/api/glances/key/review") return Response.json(emptyReview());
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const root = createRoot(document.querySelector("#app")!);
  await act(async () => { root.render(createElement(GlanceClient, { slug: "fixture-study", shortKey: "key" })); });
  await settle();

  // The viewer is framed in-app, pointed at the glance's own stored state.
  assert.ok(iframeSrc().startsWith("https://neuroglancer-demo.appspot.com#!"));
  assert.deepEqual(decodedState().layers[1].segments, []);
  // The report is only fetched once its panel is opened.
  assert.equal(asked.filter((path) => path.endsWith("/report")).length, 0);

  // Assert the rail's contents, not its length: a new panel should not have
  // to touch this test.
  assert.deepEqual([...document.querySelectorAll(".rail-button")].map((entry) => entry.getAttribute("title")),
    ["Glance details", "Semantic classes", "Quality control", "History", "Saved state", "Study figures"]);
  await act(async () => { click(dom, rail("Semantic classes")); });
  await settle();
  assert.deepEqual(asked.filter((path) => path.endsWith("/report")), ["/api/glances/key/report"]);
  assert.match(document.body.textContent ?? "", /Through-axon candidate/);

  // A slice picks the class to proofread; loading all of it is its own button,
  // so the stepper's one-segment view does not undo it.
  const before = iframeSrc();
  await act(async () => { click(dom, document.querySelectorAll(".legend-row")[0]); });
  await settle();
  assert.equal(iframeSrc(), before);
  await act(async () => { click(dom, show()); });
  await settle();
  assert.notEqual(iframeSrc(), before);
  assert.deepEqual(decodedState().layers[1].segments, ["13460", "17942"]);
  // Only the segmentation layer changes; the image layer and camera are intact.
  assert.equal(decodedState().layers[0].source, state.layers[0].source);
  assert.deepEqual(decodedState().dimensions, state.dimensions);

  await act(async () => { click(dom, document.querySelectorAll(".legend-row")[1]); });
  await settle();
  await act(async () => { click(dom, show()); });
  await settle();
  assert.deepEqual(decodedState().layers[1].segments, ["22072"]);

  // The saved-state panel edits this glance rather than listing its siblings.
  await act(async () => { click(dom, rail("Saved state")); });
  await settle();
  const nameField = document.querySelector<HTMLInputElement>(".config-stack input[name=title]");
  assert.equal(nameField?.value, "Sample volume");
  const toggles = [...document.querySelectorAll<HTMLInputElement>(".layer-toggle-list input[type=checkbox]")];
  assert.deepEqual(toggles.map((entry) => entry.checked), [true, true]);
  assert.equal(document.querySelectorAll(".glance-link").length, 0);
  await act(async () => { root.unmount(); });
});

test("the saved-state panel renames the glance and changes which layers load", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/study/fixture-study/glance/key" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "FormData", { configurable: true, value: dom.window.FormData });
  const patched: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://mind.example");
    if (url.pathname === "/api/studies/fixture-study") return Response.json(study);
    if (url.pathname === "/api/glances/key" && init?.method === "PATCH") {
      patched.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json(emptyReview());
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const root = createRoot(document.querySelector("#app")!);
  await act(async () => { root.render(createElement(GlanceClient, { slug: "fixture-study", shortKey: "key" })); });
  await settle();
  await act(async () => { click(dom, rail("Saved state")); });
  await settle();

  // Unloading the image layer rewrites only that layer's visibility.
  const toggles = [...document.querySelectorAll<HTMLInputElement>(".layer-toggle-list input[type=checkbox]")];
  await act(async () => { click(dom, toggles[0]); });
  await settle();
  const layers = (patched[0].state as { layers: Record<string, unknown>[] }).layers;
  assert.equal(layers[0].visible, false);
  assert.equal("visible" in layers[1], false);
  assert.equal(layers[1].source, SEG);

  // The name is stored as the glance title.
  const field = document.querySelector<HTMLInputElement>(".config-stack input[name=title]")!;
  assert.equal(field.value, "Sample volume");
  field.value = "Renamed volume";
  await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
  assert.deepEqual(patched[1], { title: "Renamed volume" });
  await act(async () => { root.unmount(); });
});

/* The reported bug, end to end: something in front of the Worker answers the
 * report call with its own HTML page, and the error-analysis panel showed
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` -- the parser's
 * complaint, with neither the status nor the call that failed. */
test("an HTML answer to the report call is reported as one, not as a parse failure", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/study/fixture-study/glance/key" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://mind.example");
    if (url.pathname === "/api/studies/fixture-study") return Response.json(study);
    if (url.pathname === "/api/glances/key/report") {
      return Object.defineProperty(new Response("<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>error</body></html>",
        { status: 502, statusText: "Bad Gateway", headers: { "Content-Type": "text/html" } }), "url", { value: url.href });
    }
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const root = createRoot(document.querySelector("#app")!);
  await act(async () => { root.render(createElement(GlanceClient, { slug: "fixture-study", shortKey: "key" })); });
  await settle();
  await act(async () => { click(dom, rail("Semantic classes")); });
  await settle();

  const shown = document.body.textContent ?? "";
  assert.doesNotMatch(shown, /Unexpected token/);
  assert.match(shown, /\/api\/glances\/key\/report answered HTTP 502 Bad Gateway with an HTML page, not JSON\./);
  // The panel stays usable: the viewer is still framed beside the message.
  assert.ok(iframeSrc().startsWith("https://neuroglancer-demo.appspot.com#!"));
  await act(async () => { root.unmount(); });
});

/* Two segmentations of one volume, one layer per pipeline variant. The report
 * describes the first; its segment ids name different objects in the second. */
test("a selection drives the segmentation the report names, not its sibling", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/study/fixture-study/glance/key" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const variant = { ...state, layers: [...state.layers, { type: "segmentation", name: "sample_seg_v2", source: `${SEG}v2`, segments: ["99"], visible: false }] };
  const paired = { ...study, glances: [{ ...study.glances[0], state: JSON.stringify(variant) }] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://mind.example");
    if (url.pathname === "/api/studies/fixture-study") return Response.json(paired);
    if (url.pathname === "/api/glances/key/report") return Response.json(report);
    if (url.pathname === "/api/glances/key/review") return Response.json(emptyReview());
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  }) as typeof fetch;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const root = createRoot(document.querySelector("#app")!);
  await act(async () => { root.render(createElement(GlanceClient, { slug: "fixture-study", shortKey: "key" })); });
  await settle();
  await act(async () => { click(dom, rail("Semantic classes")); });
  await settle();
  await act(async () => { click(dom, document.querySelectorAll(".legend-row")[0]); });
  await settle();
  await act(async () => { click(dom, show()); });
  await settle();

  const layers = decodedState().layers as Record<string, unknown>[];
  assert.deepEqual(layers[1].segments, ["13460", "17942"]);
  // The sibling keeps its own segments and stays unloaded.
  assert.deepEqual(layers[2].segments, ["99"]);
  assert.equal(layers[2].visible, false);
  // Both segmentations are offered in the saved-state panel.
  await act(async () => { click(dom, rail("Saved state")); });
  await settle();
  assert.deepEqual([...document.querySelectorAll<HTMLInputElement>(".layer-toggle-list input[type=checkbox]")].map((entry) => entry.checked),
    [true, true, false]);
  await act(async () => { root.unmount(); });
});

/* A real panel round-trip complements the queue tests: deferred GETs exercise
 * the generation guard where responses actually enter React state. */
test("rollback ignores an older GET and a failed refresh keeps the panels read-only until Reload", async () => {
  const dom = new JSDOM("<div id='app'></div>", { url: "https://mind.example" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const original = globalThis.fetch;
  let oldReport!: (response: Response) => void;
  let reportGets = 0, restored = false, failReview = true;
  const restoredReport = { ...report, classes: [{ ...report.classes[0], label: "Restored class" }] };
  const entry = { point: 1, operation: "old", source: "upload", author: "default", started_at: 1000, ended_at: 1000, kinds: ["report"], restored_from: null, restored_from_at: null, current: false,
    state: { report_version: 1, review_version: null, report: { classes: [{ id: "glia", labels: 2, voxels: 1 }], total_voxels: 1, segmentation: null }, review: { class_verdicts: 0, moves: 0, qc_calls: 0, hand_ids: 0, empty: true } } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/studies/")) return Response.json(study);
    if (url.endsWith("/versions")) return Response.json({ entries: [entry], next_before: null });
    if (url.endsWith("/restore")) { assert.equal(init?.method, "POST"); restored = true; return Response.json({ point: 3 }); }
    if (url.endsWith("/report?raw=1")) {
      reportGets += 1;
      if (reportGets === 1) return new Promise<Response>((resolve) => { oldReport = resolve; });
      return Response.json(restoredReport);
    }
    if (url.endsWith("/review")) {
      assert.notEqual(init?.method, "PUT", "read-only panels must not send a review");
      if (restored && failReview) return Response.json({ detail: "refetch failed" }, { status: 500 });
      return Response.json(emptyReview());
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const root = createRoot(document.getElementById("app")!);
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => { root.render(createElement(GlanceClient, { slug: "fixture-study", shortKey: "key" })); });
    await act(async () => click(dom, rail("Semantic classes")));
    await act(async () => click(dom, rail("History")));
    await act(async () => click(dom, document.querySelector(".history-entry")!));
    await act(async () => click(dom, button("Roll back")));
    assert.match(document.body.textContent!, /Reload needed/);
    await act(async () => { oldReport(Response.json(report)); });
    failReview = false;
    await act(async () => click(dom, button("Reload")));
    assert.doesNotMatch(document.body.textContent!, /Reload needed/);
    await act(async () => click(dom, rail("Semantic classes")));
    assert.match(document.body.textContent!, /Restored class/);
    assert.doesNotMatch(document.body.textContent!, /Possible broken axon/);
    await act(async () => click(dom, rail("Quality control")));
    assert.equal((document.querySelector(".review-controls") as HTMLFieldSetElement).disabled, false);
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; dom.window.close(); }
});

test("rejection updates pie and stepper once, survives refreshed state, and restore to absence clears both", async () => {
  const dom = new JSDOM("<div id=app></div>", { url: "https://mind.example" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const original = globalThis.fetch;
  const measured = { ...report, classes: report.classes.map((entry) => ({ ...entry, labels: entry.segment_ids.length,
    segments: entry.segment_ids.map((id) => ({ id, voxels: entry.voxels / entry.segment_ids.length, volume_um3: 1, centroid_um: null, radius_um: null, length_um: null, margin: null, quality: null })) })) };
  let saved = emptyReview(), absent = false, restores = 0, puts = 0, gets = 0;
  const entry = { point: 1, operation: "old", source: "upload", author: "default", started_at: 1000, ended_at: 1000, kinds: ["report"], restored_from: null, restored_from_at: null, current: false,
    state: { report_version: 1, review_version: null, report: null, review: { class_verdicts: 0, moves: 0, qc_calls: 0, hand_ids: 0, empty: true } } };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/studies/")) return Response.json(study);
    if (url.endsWith("/versions")) return Response.json({ entries: [entry], next_before: null });
    if (url.endsWith("/restore")) { restores++; absent = restores === 2; return Response.json({ point: restores + 1 }); }
    if (url.includes("/report")) {
      assert.ok(url.endsWith("/report?raw=1")); gets++;
      return absent ? Response.json({ error: "report_unavailable" }, { status: 404 }) : Response.json(measured);
    }
    if (url.endsWith("/review")) {
      if (init?.method === "PUT") { saved = JSON.parse(String(init.body)); puts++; }
      return Response.json(absent ? emptyReview() : saved);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const root = createRoot(document.getElementById("app")!);
  const button = (label: string) => {
    const found = [...document.querySelectorAll("button")].find((node) => node.textContent === label);
    assert.ok(found, label); return found;
  };
  const semantic = async () => { await act(async () => click(dom, rail("Semantic classes"))); };
  const legend = () => [...document.querySelectorAll(".report .legend-row")].map((node) => node.textContent);
  const rollback = async () => {
    await act(async () => click(dom, rail("History")));
    await act(async () => click(dom, document.querySelector(".history-entry")!));
    await act(async () => click(dom, button("Roll back")));
    await semantic();
  };
  try {
    await act(async () => root.render(createElement(GlanceClient, { slug: "fixture-study", shortKey: "key" })));
    await semantic();
    const before = legend();
    assert.match(document.body.textContent!, /1 of 2/);
    await act(async () => click(dom, button("Reject R")));
    assert.match(document.body.textContent!, /1 of 1/);
    assert.deepEqual(decodedState().layers[1].segments, ["17942"]);
    const rejected = legend();
    assert.notDeepEqual(rejected, before);
    assert.ok(rejected.some((label) => label?.includes("20.00%")), JSON.stringify(rejected));
    // Rollback refreshes both raw report and review through the production path.
    await rollback();
    assert.deepEqual(legend(), rejected);
    assert.match(document.body.textContent!, /1 of 1/);
    assert.equal(Object.keys(saved.class_review).length, 1);
    assert.equal(puts, 1);
    assert.equal(gets, 2);
    await rollback();
    assert.match(document.body.textContent!, /No report for this glance/);
    assert.equal(document.querySelector(".pie"), null);
    assert.equal(document.querySelector(".review-card"), null);
    assert.deepEqual(legend(), []);
    assert.equal(gets, 3);
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; dom.window.close(); }
});
