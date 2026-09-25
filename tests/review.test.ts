import assert from "node:assert/strict";
import test from "node:test";
import { emptyReview, parseReview, reviewIsEmpty } from "../lib/review";

test("a review round-trips its verdicts and normalises the ids they are keyed on", () => {
  const review = parseReview(JSON.stringify({
    version: 1,
    class_review: { "0013460": { verdict: "reassign", class: "dendrite_like", to: "glia_like", at: 1_700_000_000_000 } },
    // "soma" is a category earlier reviews stored; it is no longer read.
    cell_review: { blood_vessel: { "17942": { verdict: "false_split" } }, glia: {}, soma: { "8": { verdict: "good" } } },
    cell_members: { blood_vessel: { classes: ["vessel_like"], ids: ["17942", "17942", "022072"] } }
  }));
  assert.deepEqual(review.class_review, { "13460": { verdict: "reassign", class: "dendrite_like", to: "glia_like", at: 1_700_000_000_000 } });
  assert.deepEqual(review.cell_review.blood_vessel, { "17942": { verdict: "false_split", at: null } });
  // Duplicates collapse and leading zeros go, so an id means one segment however it was typed.
  assert.deepEqual(review.cell_members.blood_vessel, { classes: ["vessel_like"], ids: ["17942", "22072"] });
  // Every category is present whether the body named it or not.
  assert.deepEqual(Object.keys(review.cell_review), ["axon", "dendrite", "blood_vessel", "glia", "unclassified"]);
  assert.deepEqual(review.cell_members.axon, { classes: [], ids: [] });
});

test("a target class is only kept on the verdict that can act on one", () => {
  const review = parseReview({ class_review: { "5": { verdict: "keep", to: "glia_like" }, "6": { verdict: "reassign" } } });
  assert.equal(review.class_review["5"].to, null);
  // A reassignment still choosing its target is a legitimate mid-review state.
  assert.equal(review.class_review["6"].to, null);
  assert.equal(review.class_review["6"].verdict, "reassign");
});

test("a review refuses what it cannot mean", () => {
  const rejects = [
    { body: { class_review: { "5": { verdict: "delete" } } }, message: /verdict must be one of keep, reject, reassign/ },
    { body: { cell_review: { blood_vessel: { "5": { verdict: "merged" } } } }, message: /must be one of complete, false_split, false_merge, unknown/ },
    { body: { class_review: { "seg-5": { verdict: "keep" } } }, message: /unsigned decimal segment id/ },
    { body: { cell_members: { blood_vessel: { ids: [17942] } } }, message: /must be a string/ },
    { body: { version: 2 }, message: /version must be 1/ },
    { body: { class_review: [] }, message: /class_review must be an object/ }
  ];
  for (const { body, message } of rejects) assert.throws(() => parseReview(body), message, JSON.stringify(body));
  assert.throws(() => parseReview("{"), /not valid JSON/);
  assert.throws(() => parseReview("[]"), /must be a JSON object/);
});

test("an empty review is recognised, so an untouched glance stores no row", () => {
  assert.equal(reviewIsEmpty(emptyReview()), true);
  assert.equal(reviewIsEmpty(parseReview({ cell_members: { glia: { ids: ["5"] } } })), false);
  assert.equal(reviewIsEmpty(parseReview({ class_review: { "5": { verdict: "keep" } } })), false);
});
