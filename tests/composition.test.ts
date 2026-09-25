import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { parseConfig } from "../lib/config";
import { CELL_CATEGORIES } from "../lib/review";
import { COMPOSITION_ORDER, REVIEW_ORDER, STRUCTURES } from "../lib/structures";
import { compositionCandidates, compositionObjectName, parseComposition, segmentationsFromState, type SegmentationRef } from "../lib/composition";
import CompositionPanel, { sliceComposition } from "../app/study/[slug]/glance/[key]/composition-panel";

const config = parseConfig({
  PYTC_GLANCER_SOURCES: JSON.stringify([{ id: "example", label: "Example", bucket: "example_bucket", prefix: "lab/project", ngauth_base: "https://auth.example" }])
});
const AUTH = "gs+ngauth+https://auth.example/example_bucket/lab/project";
const state = {
  layers: [
    { type: "image", name: "image", source: `${AUTH}/exp96/image/sample.zarr/|zarr2:` },
    { type: "segmentation", name: "sample_seg_mt060", source: `${AUTH}/exp96/mip1_eb2/sample_seg_mt060/|neuroglancer-precomputed:` },
    { type: "segmentation", name: "sample_seg_mt0608", source: `${AUTH}/exp96/mip1_eb8/sample_seg_mt0608/|neuroglancer-precomputed:` }
  ]
};

test("a composition is located from each segmentation layer, in the state's own order", () => {
  const refs = segmentationsFromState(state, config);
  assert.deepEqual(refs.map((entry) => entry.name), ["sample_seg_mt060", "sample_seg_mt0608"]);
  assert.equal(compositionObjectName(refs[0]), "lab/project/exp96/mip1_eb2/sample_seg_mt060/semantic_summary.json");
  // The publishable eval prefix is tried first: a deployment with no key reads
  // anonymously, and only an eval-only folder can be opened without exposing
  // the segmentation chunks that sit beside it.
  assert.deepEqual(compositionCandidates(refs[0]), [
    "lab/project/exp96/mip1_eb2/sample_seg_mt060/nogt_eval/semantic_summary.json",
    "lab/project/exp96/mip1_eb2/sample_seg_mt060/semantic_summary.json"]);
  // A layer outside a configured source is skipped, not fatal: one pasted
  // layer must not hide a sibling that does resolve.
  const mixed = { layers: [{ type: "segmentation", name: "elsewhere", source: "gs+ngauth+https://auth.example/other_bucket/x/|neuroglancer-precomputed:" }, state.layers[1]] };
  assert.deepEqual(segmentationsFromState(mixed, config).map((entry) => entry.name), ["sample_seg_mt060"]);
  assert.deepEqual(segmentationsFromState({ layers: [state.layers[0]] }, config), []);
  assert.deepEqual(segmentationsFromState({ layers: [{ type: "segmentation", source: `${AUTH}/../escape/|neuroglancer-precomputed:` }] }, config), []);
});

const reference: SegmentationRef = { name: "sample_seg_mt060", bucket: "example_bucket", directory: "exp96/mip1_eb2/sample_seg_mt060" };
/* Shaped like the published payload for Exp96 S1 eb2, with its own numbers:
 * vessel and glia are reported but not assessed, and the three assessed
 * categories account for foreground exactly. */
const fixture = {
  total_voxels: 776_355_840,
  foreground_voxels: 554_278_367,
  foreground_volume_um3: 4015.476852837792,
  segment_count: 105_975,
  denominator: "all voxels in the full segmentation array; no tissue mask",
  categories: [
    { class: "blood_vessel", label: "Blood vessel (review required)", segment_count: 0, voxel_count: 0, volume_um3: 0, assessment_status: "not_assessed" },
    { class: "glia_or_soma", label: "Glia / neuron with soma (review required)", segment_count: 0, voxel_count: 0, volume_um3: 0, assessment_status: "not_assessed" },
    { class: "dendrite", label: "Dendrite candidate", segment_count: 128, voxel_count: 44_252_589, volume_um3: 320.588, assessment_status: "provisional_geometry" },
    { class: "axon", label: "Axon candidate", segment_count: 15_466, voxel_count: 426_446_551, volume_um3: 3089.397, assessment_status: "provisional_geometry" },
    { class: "unclassified", label: "Unclassified", segment_count: 90_381, voxel_count: 83_579_227, volume_um3: 605.49, assessment_status: "provisional_geometry" }
  ],
  large_object_review: { threshold_volume_um3: 1, segment_count: 692, percent_foreground: 47.59882790085514 }
};
const composition = parseComposition(JSON.stringify(fixture), reference);

test("the published classes fold into the panel's five rows, in precedence order", () => {
  assert.deepEqual(composition.categories.map((entry) => entry.label), [
    "Blood vessel", "Glia-like (incl. soma)", "Dendrite-like (incl. neuron with soma)", "Axon-like", "Unclassified"]);
  assert.deepEqual(composition.categories.map((entry) => entry.assessed), [false, false, true, true, true]);
  assert.equal(composition.categories[3].voxels, 426_446_551);
  assert.equal(composition.categories[2].segments, 128);
  assert.equal(composition.foreground_voxels, 554_278_367);
  // percent_foreground is derived, never read: a row that folds two published
  // classes has to sum, and two published percentages would not.
  assert.equal(composition.large_objects?.segment_count, 692);
  assert.equal(composition.large_objects?.voxels, 263_830_006);
});

test("a class the payload never mentions is not assessed, not zero", () => {
  const without = { ...fixture, categories: fixture.categories.filter((entry) => entry.class !== "blood_vessel") };
  const parsed = parseComposition(JSON.stringify(without), reference);
  assert.equal(parsed.categories[0].label, "Blood vessel");
  assert.equal(parsed.categories[0].assessed, false);
});

test("a class this vocabulary does not know keeps its own row rather than vanishing", () => {
  const extra = { ...fixture, categories: [...fixture.categories, { class: "myelin", label: "Myelin", segment_count: 3, voxel_count: 10, assessment_status: "provisional_geometry" }] };
  const parsed = parseComposition(JSON.stringify(extra), reference);
  assert.equal(parsed.categories.length, 6);
  assert.equal(parsed.categories[5].label, "Myelin");
  assert.equal(parsed.categories[5].voxels, 10);
});

test("the pie partitions foreground, and draws a shortfall rather than renormalising", () => {
  const slices = sliceComposition(composition);
  assert.deepEqual(slices.map((slice) => slice.label), ["Dendrite-like (incl. neuron with soma)", "Axon-like", "Unclassified"]);
  assert.equal(slices.reduce((sum, slice) => sum + slice.value, 0), composition.foreground_voxels);
  assert.ok(Math.abs(slices[1].share - 0.7693725) < 1e-6);

  // Drop a category's voxels out of the assessed set: the remainder must show
  // up as its own slice, so the shares stay shares of foreground.
  const short = parseComposition(JSON.stringify({ ...fixture, categories: fixture.categories.map((entry) => entry.class === "dendrite" ? { ...entry, assessment_status: "not_assessed" } : entry) }), reference);
  const shortSlices = sliceComposition(short);
  assert.equal(shortSlices.at(-1)?.label, "Not accounted for");
  assert.equal(shortSlices.at(-1)?.value, 44_252_589);
  assert.equal(shortSlices.reduce((sum, slice) => sum + slice.value, 0), short.foreground_voxels);
});

test("a malformed payload names the field rather than reaching the panel", () => {
  assert.throws(() => parseComposition("not json", reference), /not valid JSON/);
  assert.throws(() => parseComposition(JSON.stringify({ foreground_voxels: 1 }), reference), /categories must be an array/);
  assert.throws(() => parseComposition(JSON.stringify({ ...fixture, foreground_voxels: -1 }), reference), /foreground_voxels/);
  assert.throws(() => parseComposition(JSON.stringify({ ...fixture, categories: [{ class: "axon" }] }), reference), /voxel_count is required/);
  assert.throws(() => parseComposition(JSON.stringify({ ...fixture, categories: [...fixture.categories, fixture.categories[3]] }), reference), /duplicates axon/);
});

test("the panel reports foreground share, and never prints a number for an unassessed category", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const root = createRoot(document.querySelector("#app")!);
  await act(async () => { root.render(createElement(CompositionPanel, { composition })); });
  const text = document.body.textContent ?? "";
  // 554,278,367 of 776,355,840 voxels.
  assert.match(text, /71\.39%/);
  assert.match(text, /76\.94%/);            // axon, of foreground
  assert.match(text, /Blood vessel/);
  assert.match(text, /not assessed/);
  // The unassessed rows carry no share at all, not a zero one.
  assert.doesNotMatch(text, /0\.00%/);
  await act(async () => { root.unmount(); });
});

test("the composition chart and the quality control panel name the same five structures", () => {
  // The two panels answer different questions about one vocabulary: how much
  // of the foreground each structure holds, and whether its members are whole.
  // They drifted once -- one called a vessel `bv`, the other `blood_vessel` --
  // so the shared declaration is what this pins.
  const ids = STRUCTURES.map((entry) => entry.id);
  assert.deepEqual([...COMPOSITION_ORDER].sort(), [...ids].sort());
  assert.deepEqual([...REVIEW_ORDER].sort(), [...ids].sort());
  assert.deepEqual([...CELL_CATEGORIES], [...REVIEW_ORDER]);
  assert.deepEqual(composition.categories.map((entry) => entry.id), [...COMPOSITION_ORDER]);
  // The orders differ on purpose: precedence for the chart, work order for review.
  assert.notDeepEqual([...COMPOSITION_ORDER], [...REVIEW_ORDER]);
  // Every published class a composition row folds is claimed exactly once.
  const claimed = STRUCTURES.flatMap((entry) => entry.from);
  assert.equal(new Set(claimed).size, claimed.length);
});
