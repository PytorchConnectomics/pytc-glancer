import assert from "node:assert/strict";
import test from "node:test";
import { histogram } from "../app/study/[slug]/glance/[key]/chart";

const lengths = [2.1, 2.4, 3.0, 4.2, 5.5, 9.9, 12.4, 3.3].map((length, index) => ({ id: String(index + 1), length_um: length as number | null }));

test("length bins cover every measured segment and put the tail in one open bin", () => {
  const bins = histogram(lengths, (entry) => entry.length_um);
  assert.ok(bins.length >= 2);
  assert.equal(bins.reduce((sum, bin) => sum + bin.members.length, 0), lengths.length);
  // The axis spans the data, not the origin: empty bins are trimmed off both
  // ends, so the shortest and longest segments sit in the first and last bars.
  assert.ok(bins[0].members.length > 0);
  assert.ok(bins.at(-1)!.members.length > 0);
  assert.equal(bins[0].from, 2);
  // An outlier must not collapse every real value into the first bin.
  const skewed = [...lengths, { id: "9", length_um: 400 }];
  const wide = histogram(skewed, (entry) => entry.length_um);
  assert.ok(wide.filter((bin) => bin.members.length).length >= 3);
  assert.match(wide.at(-1)!.label, /^≥ /);
  assert.equal(wide.reduce((sum, bin) => sum + bin.members.length, 0), skewed.length);
  // A segment with no measured length is left out rather than binned at zero.
  assert.equal(histogram([...lengths, { id: "10", length_um: null }], (entry) => entry.length_um).reduce((sum, bin) => sum + bin.members.length, 0), lengths.length);
  assert.deepEqual(histogram([], (entry: { length_um: number | null }) => entry.length_um), []);
});
