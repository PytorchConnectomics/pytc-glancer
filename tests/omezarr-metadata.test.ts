import assert from "node:assert/strict";
import test from "node:test";
import { generateStateFromStore } from "../lib/omezarr/generate";
import { isMetadataKey, MetadataOnlyStore } from "../lib/omezarr/store";

const axes = [
  { name: "c", type: "channel" },
  { name: "z", type: "space", unit: "micrometer" },
  { name: "y", type: "space", unit: "micrometer" },
  { name: "x", type: "space", unit: "micrometer" }
];

function v2Array(shape = [2, 3, 16, 16]) {
  return { zarr_format: 2, shape, chunks: [1, 1, 8, 8], dtype: "<u2", compressor: null, fill_value: 0, order: "C", filters: null };
}

function v2Root(datasets = [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1, 1] }] }], omero?: unknown) {
  return { multiscales: [{ version: "0.4", axes, datasets }], ...(omero ? { omero } : {}) };
}

function v3Array() {
  return { zarr_format: 3, node_type: "array", shape: [1, 2, 16, 16], data_type: "uint16", chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 1, 8, 8] } }, chunk_key_encoding: { name: "default", configuration: { separator: "/" } }, fill_value: 0, codecs: [{ name: "bytes", configuration: { endian: "little" } }], attributes: {} };
}

function fixtureFetch(root: string, documents: Record<string, unknown>, calls: string[]) {
  return async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const objectName = decodeURIComponent(url.pathname.split("/o/")[1] ?? "");
    const key = `/${objectName.slice(root.length).replace(/^\/+/, "")}`;
    calls.push(key);
    const value = documents[key];
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  };
}

test("metadata-only store rejects chunk keys before fetch", async () => {
  let fetchCount = 0;
  const store = new MetadataOnlyStore({ bucket: "fixture-bucket", rootPath: "dataset", fetcher: async () => { fetchCount += 1; throw new Error("fetch must not run"); } });
  await assert.rejects(() => store.get("/0/0/0"), /Refusing non-metadata/);
  await assert.rejects(() => store.get("/c/0/0/0"), /Refusing non-metadata/);
  assert.equal(fetchCount, 0);
});

const fixtures: Array<{ name: string; documents: Record<string, unknown>; expectedLayers: number }> = [
  {
    name: "zarr-v2",
    documents: { "/.zgroup": { zarr_format: 2 }, "/.zattrs": v2Root(), "/0/.zarray": v2Array(), "/0/.zattrs": {} },
    expectedLayers: 2
  },
  {
    name: "zarr-v3",
    documents: {
      "/zarr.json": { zarr_format: 3, node_type: "group", attributes: { ome: { version: "0.5", multiscales: [{ axes, datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1, 1] }] }] }] } } },
      "/0/zarr.json": v3Array()
    },
    expectedLayers: 1
  },
  {
    name: "multiscale-pyramid",
    documents: {
      "/.zgroup": { zarr_format: 2 },
      "/.zattrs": v2Root([
        { path: "0", coordinateTransformations: [{ type: "scale", scale: [1, 1, 1, 1] }] },
        { path: "1", coordinateTransformations: [{ type: "scale", scale: [1, 1, 2, 2] }] }
      ]),
      "/0/.zarray": v2Array(), "/0/.zattrs": {}
    },
    expectedLayers: 2
  },
  {
    name: "omero-multichannel",
    documents: {
      "/.zgroup": { zarr_format: 2 },
      "/.zattrs": v2Root(undefined, { channels: [
        { label: "DNA", color: "00FFFF", window: { min: 0, max: 65535, start: 100, end: 5000 } },
        { label: "Membrane", color: "FF00FF", window: { min: 0, max: 65535, start: 200, end: 8000 } }
      ], rdefs: { model: "color", defaultZ: 0, defaultT: 0 } }),
      "/0/.zarray": v2Array(), "/0/.zattrs": {}
    },
    expectedLayers: 2
  }
];

for (const fixture of fixtures) {
  test(`full state generation reads metadata only: ${fixture.name}`, async () => {
    const calls: string[] = [];
    const root = `fixtures/${fixture.name}`;
    const store = new MetadataOnlyStore({ bucket: "fixture-bucket", rootPath: root, fetcher: fixtureFetch(root, fixture.documents, calls) });
    const state = await generateStateFromStore(`zarr://gs+ngauth+https://auth.example/fixture-bucket/${root}`, store);
    assert.ok(Array.isArray(state.layers));
    assert.equal((state.layers as unknown[]).length, fixture.expectedLayers);
    assert.equal(calls.filter((key) => !isMetadataKey(key)).length, 0);
    assert.ok(calls.length > 0);
    console.log(`${fixture.name} metadata keys: ${calls.join(", ")}`);
  });
}

test("OME image-label metadata selects a segmentation layer without reading chunks", async () => {
  const calls: string[] = [];
  const root = "fixtures/label";
  const documents = { "/.zgroup": { zarr_format: 2 }, "/.zattrs": { ...v2Root(), "image-label": { version: "0.4" } }, "/0/.zarray": v2Array([1, 3, 16, 16]), "/0/.zattrs": {} };
  const store = new MetadataOnlyStore({ bucket: "fixture-bucket", rootPath: root, fetcher: fixtureFetch(root, documents, calls) });
  const state = await generateStateFromStore(`zarr://gs+ngauth+https://auth.example/fixture-bucket/${root}`, store);
  assert.equal((state.layers as Array<{ type: string }>)[0].type, "segmentation");
  assert.equal(calls.filter((key) => !isMetadataKey(key)).length, 0);
});
