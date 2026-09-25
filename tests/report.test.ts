import { TestD1 } from "./d1";
import { DEFAULT_ACTOR } from "../lib/accounts";
import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { parseConfig } from "../lib/config";
import { datasetFromState, parseReport, reportObjectName } from "../lib/report";
import ReportPanel, { clampSegmentLimit, sliceReport, type ErrorReport } from "../app/study/[slug]/glance/[key]/report-panel";

const config = parseConfig({
  PYTC_GLANCER_SOURCES: JSON.stringify([{ id: "example", label: "Example", bucket: "example_bucket", prefix: "lab/project/clip_percentile_1_99", ngauth_base: "https://auth.example" }])
});

function stateWith(source: string) {
  return { layers: [{ type: "image", name: "image", source }, { type: "segmentation", name: "seg", source: "gs+ngauth+https://auth.example/example_bucket/lab/project/clip_percentile_1_99/sample_seg/|neuroglancer-precomputed:" }] };
}
const IMAGE = "gs+ngauth+https://auth.example/example_bucket/lab/project/clip_percentile_1_99/sample.zarr/|zarr2:";

test("a glance's report location comes from its image layer, inside a configured source", () => {
  const reference = datasetFromState(stateWith(IMAGE), config);
  assert.equal(reference.dataset, "sample");
  assert.equal(reportObjectName(reference), "lab/project/clip_percentile_1_99/sample_nogt_eval/error_report.json");
  // The zarr:// form the app writes for path-created glances resolves the same.
  assert.equal(datasetFromState(stateWith(`zarr://${IMAGE}`), config).directory, reference.directory);
  // A pasted URL may name any bucket; only configured ones are readable.
  assert.throws(() => datasetFromState(stateWith(IMAGE.replace("example_bucket", "someone_elses_bucket")), config), /not a configured source/);
  assert.throws(() => datasetFromState(stateWith(IMAGE.replace("clip_percentile_1_99", "..")), config), /\.\./);
  assert.throws(() => datasetFromState({ layers: [{ type: "segmentation", source: IMAGE }] }, config), /no OME-Zarr image layer/);
  assert.throws(() => datasetFromState(stateWith("https://example.com/sample.zarr"), config), /gs\+ngauth/);
});

const reference = datasetFromState(stateWith(IMAGE), config);
const fixture = {
  version: 1,
  dataset: "sample",
  generated_at: "2026-09-06",
  classes: [
    { id: "through_axon", label: "Through-axon candidate", labels: 99, voxels: 3_521_914, volume_um3: 27.386, segment_ids: [13460, "17942", "017942"] },
    { id: "broken_axon", label: "Possible broken axon", labels: 2262, voxels: 35_926_311, volume_um3: 279.367 }
  ],
  figures: [{ label: "Morphology counts", path: "results/metrics.png" }]
};

test("a published report is validated before the panel ever sees it", () => {
  const report = parseReport(JSON.stringify(fixture), reference);
  assert.equal(report.classes.length, 2);
  // Ids are carried as decimal strings and de-duplicated after zero-stripping.
  assert.deepEqual(report.classes[0].segment_ids, ["13460", "17942"]);
  assert.equal(report.total_voxels, 39_448_225);
  assert.equal(report.figures[0].index, 0);

  const reject = (mutate: (body: Record<string, unknown>) => void, pattern: RegExp) => {
    const body = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
    mutate(body);
    assert.throws(() => parseReport(JSON.stringify(body), reference), pattern);
  };
  reject((body) => { body.classes = []; }, /non-empty array/);
  reject((body) => { (body.classes as Array<Record<string, unknown>>)[0].voxels = -1; }, /voxels/);
  reject((body) => { delete (body.classes as Array<Record<string, unknown>>)[0].label; }, /label is required/);
  reject((body) => { (body.classes as Array<Record<string, unknown>>)[1].id = "through_axon"; }, /duplicates/);
  reject((body) => { (body.classes as Array<Record<string, unknown>>)[0].segment_ids = ["12; DROP"]; }, /decimal integer ids/);
  reject((body) => { (body.figures as Array<Record<string, unknown>>)[0].path = "../../etc/passwd.png"; }, /\.\. segment/);
  reject((body) => { (body.figures as Array<Record<string, unknown>>)[0].path = "results/report.md"; }, /must end with/);
  reject((body) => { body.version = 2; }, /version must be 1/);
  assert.throws(() => parseReport("not json", reference), /not valid JSON/);
});

test("a segment carries the pipeline's starting quality, in the quality-control vocabulary", () => {
  const body = { classes: [{ id: "axon", label: "Axon candidate", voxels: 30, segments: [{ id: "1", voxels: 10, quality: "false_split" }, { id: "2", voxels: 20 }] }] };
  const report = parseReport(JSON.stringify(body), reference);
  assert.deepEqual(report.classes[0].segments.map((entry) => entry.quality), ["false_split", null]);
  // Compact reports name each quality once and give records its index.
  const compact = { qualities: ["complete", "false_split", "false_merge", "unknown"], classes: [{ id: "axon", label: "Axon", voxels: 1, segments: [{ id: "1", quality: 1 }, { id: "2", quality: 0 }] }] };
  assert.deepEqual(parseReport(JSON.stringify(compact), reference).classes[0].segments.map((entry) => entry.quality), ["false_split", "complete"]);
  compact.classes[0].segments[0].quality = 4;
  assert.throws(() => parseReport(JSON.stringify(compact), reference), /must index the report's qualities/);
  (body.classes[0].segments[0] as { quality: unknown }).quality = "broken";
  assert.throws(() => parseReport(JSON.stringify(body), reference), /quality must be one of complete, false_split, false_merge, unknown/);
});

test("pie slices keep report order and fold a long tail into one Other slice", () => {
  const report = parseReport(JSON.stringify(fixture), reference);
  const slices = sliceReport(report);
  assert.deepEqual(slices.map((slice) => slice.id), ["through_axon", "broken_axon"]);
  assert.ok(Math.abs(slices.reduce((sum, slice) => sum + slice.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs((slices.at(-1)!.end - slices[0].start) - Math.PI * 2) < 1e-9);

  const many = { ...report, classes: Array.from({ length: 11 }, (_, index) => ({ id: `c${index}`, label: `Class ${index}`, voxels: 100, volume_um3: null, labels: null, note: null, margin_label: null, segment_ids: [], segments: [] })) };
  const folded = sliceReport(many as ErrorReport);
  assert.equal(folded.length, 8);
  assert.equal(folded.at(-1)!.label, "Other (4 classes)");
  assert.equal(folded.at(-1)!.value, 400);
});

test("the report panel draws one clickable slice per class, with a legend and a table", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const report = parseReport(JSON.stringify(fixture), reference);
  const chosen: Array<string | null> = [];
  const root = createRoot(document.querySelector("#app")!);
  await act(async () => { root.render(createElement(ReportPanel, { report, selected: null, onSelect: (slice) => chosen.push(slice?.id ?? null) })); });

  const slices = [...document.querySelectorAll("path.slice")];
  assert.equal(slices.length, 2);
  // Identity is never colour-alone: every slice is also a legend row.
  assert.equal(document.querySelectorAll(".legend-row").length, 2);
  assert.match(document.body.textContent ?? "", /Through-axon candidate/);
  assert.equal(document.querySelector(".report-table"), null);

  await act(async () => { slices[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(chosen, ["through_axon"]);

  assert.equal([...document.querySelectorAll("button")].some((entry) => entry.textContent === "Show table"), false);
  await act(async () => { root.unmount(); });
});

test("the report route reads the published JSON with the get-only credential", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = JSON.stringify({ client_email: "report-test@example.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n` });

  const db = { prepare: (sql: string) => ({ bind: (short: string) => ({ first: async () => sql.includes("FROM glances") && short === "key" ? { state: JSON.stringify(stateWith(IMAGE)) } : null }) }) } as unknown as D1Database;
  const asked: string[] = [];
  const sentAuth: (string | null)[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://oauth2.googleapis.com/")) return Response.json({ access_token: "fixture", expires_in: 3600 });
    const object = decodeURIComponent(new URL(url).pathname.split("/o/")[1] ?? "");
    asked.push(object);
    sentAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization ?? null);
    // The figure route re-reads the report first: the report is what names
    // the figure, so a request can never reach an object it did not list.
    return object.endsWith("error_report.json") ? new Response(JSON.stringify(fixture)) : new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;

  try {
    const request = (path: string) => new Request(`https://mind.example${path}`);
    const report = await (await import("../lib/api")).handleApi(request("/api/glances/key/report"), db, config, DEFAULT_ACTOR, key);
    assert.equal(report.status, 200);
    assert.equal((await report.json() as ErrorReport).classes[0].label, "Through-axon candidate");
    assert.equal(asked[0], "lab/project/clip_percentile_1_99/sample_nogt_eval/error_report.json");

    const figure = await (await import("../lib/api")).handleApi(request("/api/glances/key/report/figures/0"), db, config, DEFAULT_ACTOR, key);
    assert.equal(figure.status, 200);
    // The type comes from the report's extension allowlist, not the object's.
    assert.equal(figure.headers.get("Content-Type"), "image/png");
    assert.deepEqual(asked.slice(1), ["lab/project/clip_percentile_1_99/sample_nogt_eval/error_report.json", "lab/project/clip_percentile_1_99/sample_nogt_eval/results/metrics.png"]);

    const missing = await (await import("../lib/api")).handleApi(request("/api/glances/absent/report"), db, config, DEFAULT_ACTOR, key);
    assert.equal(missing.status, 404);
    // Without a key the same object is read anonymously, for deployments that
    // publish reports openly rather than holding a credential.
    asked.length = 0;
    sentAuth.length = 0;
    const anonymous = await (await import("../lib/api")).handleApi(request("/api/glances/key/report"), db, config, DEFAULT_ACTOR, undefined);
    assert.equal(anonymous.status, 200);
    assert.deepEqual(asked, ["lab/project/clip_percentile_1_99/sample_nogt_eval/error_report.json"]);
    assert.deepEqual(sentAuth, [null]);
  } finally { globalThis.fetch = original; }
});

test("an anonymous read of a still-private report names the fix", async () => {
  const db = { prepare: (sql: string) => ({ bind: (short: string) => ({ first: async () => sql.includes("FROM glances") && short === "key" ? { state: JSON.stringify(stateWith(IMAGE)) } : null }) }) } as unknown as D1Database;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
  try {
    const response = await (await import("../lib/api")).handleApi(new Request("https://mind.example/api/glances/key/report"), db, config, DEFAULT_ACTOR, undefined);
    assert.equal(response.status, 502);
    assert.match((await response.json() as { detail: string }).detail, /not publicly readable, and GCS_SA_KEY is not configured/);
  } finally { globalThis.fetch = original; }
});

test("an uploaded report is stored, validated, and preferred over the bucket", async () => {
  const fixtureDb = new TestD1().seed(stateWith(IMAGE));
  const db = fixtureDb.db;
  const rows = {
    get size() { return (fixtureDb.sqlite.prepare("SELECT COUNT(*) AS n FROM glance_reports").get() as { n: number }).n; },
    get(_key: string) { return (fixtureDb.sqlite.prepare("SELECT body FROM glance_reports").get() as { body: string } | undefined)?.body; }
  };

  const original = globalThis.fetch;
  // Any bucket read would be a failure: the stored report must win.
  globalThis.fetch = (async () => { throw new Error("bucket must not be read"); }) as typeof fetch;
  try {
    const put = (body: string) => new Request("https://mind.example/api/glances/key/report", { method: "PUT", body });
    const api = (await import("../lib/api")).handleApi;

    const bad = await api(put(JSON.stringify({ classes: [{ label: "x" }] })), db, config, DEFAULT_ACTOR, undefined);
    assert.equal(bad.status, 422);
    assert.equal(rows.size, 0);

    const stored = await api(put(JSON.stringify(fixture)), db, config, DEFAULT_ACTOR, undefined);
    assert.equal(stored.status, 200);
    // Stored gzipped, so a report of every analysed segment fits one D1 row.
    assert.match(rows.get("key") ?? "", /^gz:/);
    const { packReport, unpackReport } = await import("../lib/api");
    assert.equal(await unpackReport(rows.get("key")!), JSON.stringify(fixture));
    assert.equal(await unpackReport(await packReport("{\"a\":1}")), "{\"a\":1}");
    // A row written before packing is plain JSON and still reads.
    assert.equal(await unpackReport("{\"a\":1}"), "{\"a\":1}");

    const read = await api(new Request("https://mind.example/api/glances/key/report"), db, config, DEFAULT_ACTOR, undefined);
    assert.equal(read.status, 200);
    const parsed = await read.json() as ErrorReport & { source: string };
    assert.equal(parsed.source, "pytc_glancer");
    assert.equal(parsed.classes[0].label, "Through-axon candidate");
  } finally { globalThis.fetch = original; }
});

test("the segments-shown count clamps to what the class carries", () => {
  assert.equal(clampSegmentLimit("2", 4), 2);
  assert.equal(clampSegmentLimit("0", 4), 0);
  // Out of range clamps rather than asking the viewer for ids that do not
  // exist, or for a negative slice.
  assert.equal(clampSegmentLimit("99", 4), 4);
  assert.equal(clampSegmentLimit("-3", 4), 0);
  assert.equal(clampSegmentLimit("2.7", 4), 3);
  // An emptied field must not be read as zero mid-edit.
  assert.equal(clampSegmentLimit("", 4), null);
  assert.equal(clampSegmentLimit("abc", 4), null);
});

test("selecting a class offers every id it carries, in an editable field", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

  const wide = parseReport(JSON.stringify({
    ...fixture,
    classes: [{ id: "broken_axon", label: "Possible broken axon", voxels: 10, segment_ids: [11, 22, 33, 44] }]
  }), reference);
  const picked: { value: { id: string; segments: string[] } | null } = { value: null };
  const root = createRoot(document.querySelector("#app")!);
  const render = () => act(async () => { root.render(createElement(ReportPanel, { report: wide, selected: picked.value?.id ?? null, onSelect: (value) => { picked.value = value; } })); });
  await render();

  await act(async () => { document.querySelectorAll(".legend-row")[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.deepEqual(picked.value?.segments, ["11", "22", "33", "44"]);
  await render();

  const field = document.querySelector<HTMLInputElement>("input#segments-shown")!;
  assert.equal(field.value, "4");
  assert.equal(field.getAttribute("max"), "4");
  assert.equal(field.getAttribute("min"), "0");
  await act(async () => { root.unmount(); });
});

/* The panels read every API answer as JSON. A route that throws would
 * otherwise leave the runtime to substitute a non-JSON error page of its own,
 * which reached the error-analysis panel as a complaint about '<'. */
test("an unplanned failure still answers JSON", async () => {
  const api = (await import("../lib/api")).handleApi;
  const db = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("D1_ERROR: no such table"); } }) }) } as unknown as D1Database;

  const thrown = await api(new Request("https://mind.example/api/studies/fixture"), db, config, DEFAULT_ACTOR, undefined);
  assert.equal(thrown.status, 500);
  assert.equal(thrown.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.match((await thrown.json() as { detail: string }).detail, /no such table/);

  // A malformed escape in the key decodes to nothing real, so it is a 404 and
  // not a URIError that escapes the route.
  const quiet = { prepare: () => ({ bind: () => ({ first: async () => null }) }) } as unknown as D1Database;
  const malformed = await api(new Request("https://mind.example/api/glances/%/report"), quiet, config, DEFAULT_ACTOR, undefined);
  assert.equal(malformed.status, 404);
  assert.equal((await malformed.json() as { error: string }).error, "not_found");
});
