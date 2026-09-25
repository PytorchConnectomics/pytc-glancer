import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import EditStatusLine from "../app/study/[slug]/glance/[key]/edit-status";
import { mergeEdits } from "../lib/edits";
import { emptyReview } from "../lib/review";
import { parseReport, type DatasetRef } from "../lib/report";

test("status lists all inactive edits past 50 and Remove clears the selected edit", async () => {
  const dom = new JSDOM("<div id=app></div>");
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, value });
  const report = parseReport(JSON.stringify({ dataset: "sample", classes: [{ id: "glia", label: "Glia", voxels: 0 }] }), { dataset: "sample" } as DatasetRef);
  let review = emptyReview();
  for (let i = 1; i <= 55; i++) review.class_review[String(i)] = { verdict: "reject", class: "glia", to: null, at: 1 };
  const root = createRoot(document.querySelector("#app")!);
  const render = () => act(async () => root.render(createElement(EditStatusLine, { review, merged: mergeEdits(report, review.class_review), readOnly: false, onChange: (next) => { review = next; } })));
  await render(); assert.match(document.body.textContent!, /55 inactive/); assert.equal(document.querySelectorAll("li").length, 50);
  const more = [...document.querySelectorAll("button")].find((b) => b.textContent === "Show more")!;
  await act(async () => more.click()); assert.equal(document.querySelectorAll("li").length, 55);
  await act(async () => document.querySelector<HTMLButtonElement>("li button")!.click()); await render();
  assert.equal(Object.keys(review.class_review).length, 54);
  await act(async () => root.unmount()); dom.window.close();
});
