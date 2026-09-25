import assert from "node:assert/strict";
import test from "node:test";
import { mergeEdits, summarizeEdits, setClass, keepClass, reject, usePipeline, deriveEdits, compareViews } from "../lib/edits";
import { emptyReview } from "../lib/review";
import type { ErrorReport, ReportSegment } from "../lib/report";
function segment(id: string, voxels: number | null): ReportSegment {
  return { id, voxels, volume_um3: voxels === null ? null : voxels * 2, centroid_um: [1, 2, 3], radius_um: 0.4, length_um: 5, margin: 0.01, quality: null };
}
function fixture(): ErrorReport {
  return {
    dataset: "sample", generated_at: "2026-09-21", segmentation: "sample_seg", voxel_volume_um3: 7.776e-6,
    notes: null, total_voxels: 1_000, figures: [], axons: [],
    classes: [
      { id: "dendrite_like", label: "Dendrite-like", voxels: 600, volume_um3: 1_200, labels: 3, note: null, margin_label: null,
        segment_ids: ["10", "11", "12"], segments: [segment("10", 100), segment("11", 200), segment("12", null)] },
      // Carries ids alone, as an older report does.
      { id: "glia_like", label: "Glia-like", voxels: 400, volume_um3: 800, labels: 2, note: null, margin_label: null, segment_ids: ["20", "21"], segments: [] }
    ]
  };
}

test("overlay moves counts, rejects immediately and never mutates its inputs", () => {
  const report = fixture(), review = emptyReview();
  review.class_review = { "10": { verdict: "reassign", class: "dendrite_like", to: "glia_like", at: 1 }, "11": { verdict: "reject", class: "dendrite_like", to: null, at: 1 } };
  const before = JSON.stringify([report, review]);
  const merged = mergeEdits(report, review.class_review);
  assert.equal(JSON.stringify([report, review]), before);
  assert.deepEqual(merged.report.classes.map((c) => [c.voxels, c.volume_um3, c.labels]), [[300, 600, 1], [500, 1000, 3]]);
  assert.equal(merged.report.total_voxels, 800);
  assert.deepEqual(merged.report.classes.map((c) => c.segment_ids), [["12"], ["10", "20", "21"]]);
  assert.deepEqual(merged.rejected.map((s) => s.id), ["11"]);
});
test("absolute edits agree, survive drift, distinguish inactive causes and keep untouched ids-only classes", () => {
  const report = fixture(), review = emptyReview();
  review.class_review = { "10": { verdict: "keep", class: "glia_like", to: null, at: 1 }, "11": { verdict: "keep", class: null, to: null, at: 1 }, "12": { verdict: "reassign", class: null, to: null, at: 1 }, "20": { verdict: "reassign", class: null, to: "absent", at: 1 }, "999": { verdict: "reject", class: null, to: null, at: 1 } };
  const merged = mergeEdits(report, review.class_review);
  assert.deepEqual(merged.status, { "10": "applied", "11": "agrees", "12": "pending", "20": "no_class", "999": "no_segment" });
  assert.deepEqual(summarizeEdits(merged).inactive, ["12", "20", "999"]);
  assert.equal(mergeEdits(report, { "11": review.class_review["11"] }).report.classes[1], report.classes[1]);
  const agrees = mergeEdits(merged.report, review.class_review);
  assert.equal(agrees.status["10"], "agrees");
  assert.equal(mergeEdits(report, { "10": { ...review.class_review["10"], verdict: "reassign", to: "glia_like" } }).status["10"], "applied");
});
test("operations remove agreeing edits and drifted pins, keep effective classes and skip rejected/unknown ids", () => {
  const report = fixture();
  let review = emptyReview();
  review = setClass(review, mergeEdits(report, {}), ["10", "999"], "glia_like").review;
  review = keepClass(review, mergeEdits(report, review.class_review), ["10"]).review;
  assert.equal(review.class_review["10"].class, "glia_like");
  const back = setClass(review, mergeEdits(report, review.class_review), ["10"], "dendrite_like");
  assert.deepEqual(back.moved, ["10"]); assert.deepEqual(back.review.class_review, {});
  review = reject(review, mergeEdits(report, review.class_review), ["10"]).review;
  assert.equal(review.class_review["10"].class, "glia_like");
  assert.deepEqual(keepClass(review, mergeEdits(report, review.class_review), ["10", "999"]).rejected, ["10"]);
  assert.deepEqual(usePipeline(review, ["10"]).class_review, {});
  const pin = keepClass(emptyReview(), mergeEdits(report, {}), ["10"]).review;
  assert.deepEqual(setClass(pin, mergeEdits(report, pin.class_review), ["10"], "dendrite_like").moved, ["10"]);
});
test("multiple rejects do not resurrect empty classes; unknown counts stay approximate", () => {
  const report = fixture();
  const review = reject(emptyReview(), mergeEdits(report, {}), ["10", "11", "12", "20", "21"]).review;
  const merged = mergeEdits(report, review.class_review);
  assert.deepEqual(merged.report.classes.map((c) => c.segment_ids), [[], []]);
  assert.deepEqual(merged.uncounted, ["12", "20", "21"]);
});
test("derivation and view comparison include membership, totals, volume and labels", () => {
  const pipeline = fixture();
  const current = mergeEdits(pipeline, { "10": { verdict: "reassign", class: "dendrite_like", to: "glia_like", at: 1 }, "11": { verdict: "reject", class: null, to: null, at: 1 } }).report;
  const derived = deriveEdits(current, pipeline, 42);
  assert.equal(derived.edits["10"].at, 42); assert.equal(derived.edits["11"].verdict, "reject");
  assert.deepEqual(compareViews(current, mergeEdits(pipeline, derived.edits).report), { classes: [], total_voxels: [800, 800] });
  assert.deepEqual(deriveEdits(pipeline, pipeline, 42), { edits: {}, cannotExpress: [] });
  assert.deepEqual(deriveEdits(pipeline, current, 42).cannotExpress, ["11"]);
  const changed = structuredClone(pipeline); changed.classes[0].labels = 42; changed.classes[0].volume_um3 = 0;
  assert.equal(compareViews(pipeline, changed).classes.length, 1);
});

test("setClass restores rejected ids with null provenance and complete operation results", (t) => {
  t.mock.method(Date, "now", () => 42);
  const report = fixture(), review = emptyReview();
  review.class_review["10"] = { verdict: "reject", class: "dendrite_like", to: null, at: 1 };
  const result = setClass(review, mergeEdits(report, review.class_review), ["10", "20", "999", "10"], "glia_like");
  assert.deepEqual(result, {
    review: { ...emptyReview(), class_review: { "10": { verdict: "reassign", class: null, to: "glia_like", at: 42 } } },
    moved: ["10"], already: ["20"], unknown: ["999"]
  });
  assert.equal(mergeEdits(report, result.review.class_review).effective.get("10"), "glia_like");
  assert.equal(review.class_review["10"].verdict, "reject");
});

test("ingest agreement and later drift preserve absolute edits until selecting pipeline removes them", (t) => {
  t.mock.method(Date, "now", () => 42);
  const original = fixture();
  const reassigned = setClass(emptyReview(), mergeEdits(original, {}), ["10"], "glia_like").review;
  const ingested = mergeEdits(original, reassigned.class_review).report;
  const agrees = mergeEdits(ingested, reassigned.class_review);
  assert.equal(agrees.status["10"], "agrees");
  assert.deepEqual(setClass(reassigned, agrees, ["10", "20", "999"], "glia_like"), {
    review: emptyReview(), moved: ["10"], already: ["20"], unknown: ["999"]
  });
  const drifted = mergeEdits(original, reassigned.class_review);
  assert.equal(drifted.status["10"], "applied");
  assert.equal(drifted.effective.get("10"), "glia_like");
  const pinned = keepClass(emptyReview(), mergeEdits(ingested, {}), ["10"]).review;
  assert.deepEqual(pinned.class_review["10"], { verdict: "keep", class: "glia_like", to: null, at: 42 });
  for (const review of [reassigned, pinned]) {
    const merged = mergeEdits(original, review.class_review);
    assert.equal(merged.status["10"], "applied");
    assert.deepEqual(setClass(review, merged, ["10", "11", "999"], "dendrite_like"), {
      review: emptyReview(), moved: ["10"], already: ["11"], unknown: ["999"]
    });
  }
});
