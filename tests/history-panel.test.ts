import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import HistoryPanel from "../app/study/[slug]/glance/[key]/history-panel";
import type { HistoryEntry } from "../lib/history";
import type { MutationGate } from "../lib/write-queue";

const entry = (point: number, current = false): HistoryEntry => ({ point, current, operation: `op${point}`, source: "review", author: "default", started_at: 1000, ended_at: 2000, kinds: ["review"], restored_from: null, restored_from_at: null,
  state: { report_version: 1, review_version: point, report: { classes: [{ id: "glia", labels: point, voxels: 1 }], segmentation: null, total_voxels: 1 }, review: { class_verdicts: point, moves: 0, qc_calls: 3, hand_ids: 0, empty: false } } });

test("history confirms the chosen state, disables current/gated rollback, restores, and loads older", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://mind.example" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const oldFetch = globalThis.fetch, calls: string[] = [], restored: number[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json(String(url).includes("before=") ? { entries: [entry(3)], next_before: null } : { entries: [entry(10, true), entry(7)], next_before: 7 });
  };
  const root = createRoot(document.getElementById("root")!);
  const render = (gate: MutationGate = null) => act(async () => { root.render(createElement(HistoryPanel, { shortKey: "key", archived: false, gate, onRestore: async (point) => { restored.push(point); } })); });
  const button = (text: string) => [...document.querySelectorAll("button")].find((node) => node.textContent === text)!;
  try {
    await render();
    assert.match(document.body.textContent!, /Proofreading/);
    await act(async () => { (document.querySelectorAll(".history-entry")[0] as HTMLButtonElement).click(); });
    assert.equal(button("Roll back").disabled, true);
    await act(async () => { (document.querySelectorAll(".history-entry")[1] as HTMLButtonElement).click(); });
    assert.match(document.querySelector(".history-confirm")!.textContent!, /Glia 7; proofreading becomes 7 verdicts/);
    assert.equal(button("Roll back").disabled, false);
    await act(async () => button("Roll back").click());
    assert.deepEqual(restored, [7]);
    await act(async () => button("Load older").click());
    assert.ok(calls.some((url) => url.endsWith("?before=7")));
    assert.equal(document.querySelectorAll(".history-entry").length, 3);
    await render("restoring");
    await act(async () => { (document.querySelectorAll(".history-entry")[1] as HTMLButtonElement).click(); });
    assert.equal(button("Roll back").disabled, true);
  } finally { await act(async () => root.unmount()); globalThis.fetch = oldFetch; dom.window.close(); }
});

test("history displays unreadable summaries without presenting them as empty state", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://mind.example" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const oldFetch = globalThis.fetch;
  const damaged = entry(1);
  damaged.state.report = { unreadable: true };
  damaged.state.review = { unreadable: true };
  globalThis.fetch = async () => Response.json({ entries: [damaged, entry(2)], next_before: null });
  const root = createRoot(document.getElementById("root")!);
  try {
    await act(async () => { root.render(createElement(HistoryPanel, { shortKey: "key", archived: false, gate: null, onRestore: async () => {} })); });
    const row = document.querySelector<HTMLButtonElement>(".history-entry")!;
    assert.match(row.textContent!, /Unreadable report/);
    assert.match(row.textContent!, /Unreadable review/);
    assert.doesNotMatch(row.textContent!, /No report|0 verdicts/);
    assert.equal(document.querySelectorAll(".history-entry").length, 2);
    await act(async () => row.click());
    assert.match(document.querySelector(".history-confirm")!.textContent!, /Unreadable report; proofreading becomes Unreadable review/);
  } finally { await act(async () => root.unmount()); globalThis.fetch = oldFetch; dom.window.close(); }
});
