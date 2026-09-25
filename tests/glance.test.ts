import assert from "node:assert/strict";
import test from "node:test";
import { parseNeuroglancerUrl, shareableLink, shortKey, validateState } from "../lib/glance";
import { parseConfig } from "../lib/config";

const config = parseConfig({});
const state = { layers: [{ name: "brain", source: "zarr://gs+ngauth+https://auth.example/bucket/brain.zarr" }] };
const stored = JSON.stringify(state);
const fakeDb = {
  prepare() { return { bind() { return { first: async () => ({ state: stored }) }; } }; }
} as unknown as D1Database;

test("short keys contain 160 random bits encoded as base32", () => {
  const key = shortKey();
  assert.match(key, /^[a-z2-7]{32}$/);
  assert.notEqual(key, shortKey());
});

test("Neuroglancer parser accepts inline and encoded state", async () => {
  const inline = await parseNeuroglancerUrl(`https://neuroglancer-demo.appspot.com/#!${JSON.stringify(state)}`, "https://mind.example", fakeDb, config);
  assert.deepEqual(inline.state, state);
  const encoded = await parseNeuroglancerUrl(`https://neuroglancer-demo.appspot.com/#!${encodeURIComponent(JSON.stringify(state))}`, "https://mind.example", fakeDb, config);
  assert.deepEqual(encoded.state, state);
});

test("Neuroglancer parser resolves both local state-link shapes without fetch", async () => {
  const key = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  for (const path of [`/ng/${key}`, `/ng/${key}/brain-scan`]) {
    const parsed = await parseNeuroglancerUrl(`https://neuroglancer-demo.appspot.com/#!https://mind.example${path}`, "https://mind.example", fakeDb, config);
    assert.deepEqual(parsed.state, state);
  }
});

test("remote state URLs, existing viewer fragments, and invalid states are refused", async () => {
  await assert.rejects(() => parseNeuroglancerUrl("https://neuroglancer-demo.appspot.com/#!https://foreign.example/state", "https://mind.example", fakeDb, config), /Remote state URLs/);
  await assert.rejects(() => parseNeuroglancerUrl("https://evil.example/#!%7B%22layers%22%3A%5B%5D%7D", "https://mind.example", fakeDb, config), /allowlisted/);
  assert.throws(() => validateState({ nope: true }), /layers array/);
});

test("shareable links include the optional cosmetic short name", () => {
  const plain = shareableLink("https://neuroglancer-demo.appspot.com", "https://mind.example", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(plain, "https://neuroglancer-demo.appspot.com#!https://mind.example/ng/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.match(shareableLink("https://neuroglancer-demo.appspot.com", "https://mind.example", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "brain-scan"), /\/brain-scan$/);
});
