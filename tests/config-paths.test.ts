import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, parseSources } from "../lib/config";
import { resolveSourcePath } from "../lib/sources";

const source = { id: "example", label: "Example", bucket: "example_bucket", prefix: "datasets/brain", ngauth_base: "https://auth.example" };

test("source paths stay beneath the configured prefix", () => {
  assert.equal(resolveSourcePath(source, "sample.zarr"), "datasets/brain/sample.zarr");
  assert.throws(() => resolveSourcePath(source, "../secret"), /\.\./);
  assert.throws(() => resolveSourcePath(source, "/absolute.zarr"), /relative/);
  assert.throws(() => resolveSourcePath(source, "nested//escape"), /empty/);
});

test("source configuration validates every field", () => {
  assert.deepEqual(parseSources(undefined), []);
  assert.throws(() => parseSources('[{"id":"BAD"}]'), /entry \[0\].*id/);
  assert.throws(() => parseSources(JSON.stringify([{ ...source, ngauth_base: "https://user@auth.example" }])), /entry \[0\].*userinfo/);
  assert.throws(() => parseSources(JSON.stringify([source, source])), /entry \[1\].*duplicate/);
  assert.equal(parseConfig({ PYTC_GLANCER_SOURCES: JSON.stringify([source]) }).sources[0].prefix, "datasets/brain");
});
