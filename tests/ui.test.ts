import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import StudiesClient from "../app/studies-client";
import StudyClient from "../app/study/[slug]/study-client";
import HomeClient from "../app/home-client";

const study = {
  id: "study-id",
  title: "Hydrated study",
  slug: "hydrated-study",
  description: "Mounted with API data.",
  archived_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_001_000,
  glance_count: 1,
  glances: [{
    id: "glance-id",
    short_key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    short_name: "brain-scan",
    title: "Brain scan",
    url_base: "https://neuroglancer-demo.appspot.com",
    state: JSON.stringify({ layers: [{ name: "brain" }] }),
    source_path: null,
    position: 1,
    archived_at: null,
    created_at: 1_700_000_002_000,
    updated_at: 1_700_000_003_000,
    shareable_link: "https://neuroglancer-demo.appspot.com#!https://mind.example/ng/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/brain-scan"
  }]
};

function button(label: string) {
  const match = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(match, `Expected button ${label}`);
  return match as HTMLButtonElement;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("mounted clients expose enabled, wired controls without registering a global tool", async () => {
  const serverHtml = renderToStaticMarkup(createElement(StudyClient, { slug: study.slug }));
  for (const placeholderLeak of ["Inline rename", "Add glance", "Show archived", "Paste Neuroglancer URL", "From zarr path", "thumbnail-placeholder", "Title (optional)", "Short name (optional)"]) {
    assert.doesNotMatch(serverHtml, new RegExp(placeholderLeak.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/study/hydrated-study" });
  const browserGlobals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    FormData: dom.window.FormData
  };
  for (const [name, value] of Object.entries(browserGlobals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.setAttribute("open", ""); } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { configurable: true, value() { this.removeAttribute("open"); } });

  let registerToolCalls = 0;
  Object.defineProperty(document, "modelContext", { configurable: true, value: { registerTool() { registerToolCalls += 1; } } });
  const requests: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://mind.example");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    requests.push({ path: url.pathname, method, body });
    if (url.pathname === "/api/studies" && method === "GET") return Response.json([study]);
    if (url.pathname === `/api/studies/${study.slug}` && method === "GET") return Response.json(study);
    if (url.pathname === "/api/sources" && method === "GET") return Response.json([{ id: "source", label: "Fixture source", bucket: "fixture-bucket", prefix: "datasets" }]);
    if (url.pathname === `/api/studies/${study.id}` && method === "PATCH") return Response.json({ ...study, archived_at: Date.now() });
    if (url.pathname === "/api/glances" && method === "POST") return Response.json({ ok: true }, { status: 201 });
    throw new Error(`Unexpected fetch: ${method} ${url.pathname}`);
  };

  const container = document.querySelector("#app")!;
  let root = createRoot(container);
  await act(async () => { root.render(createElement(StudiesClient)); });
  await settle();
  assert.equal(registerToolCalls, 0);
  assert.equal(button("New study").disabled, false);
  const rootToggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(rootToggle);
  assert.equal(rootToggle.disabled, false);
  await act(async () => { root.unmount(); });

  root = createRoot(container);
  await act(async () => { root.render(createElement(StudyClient, { slug: study.slug })); });
  await settle();
  assert.equal(button("Inline rename").disabled, false);
  assert.equal(button("Archive").disabled, false);
  assert.equal(button("Add glance").disabled, false);
  assert.equal(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled, false);
  assert.equal(document.querySelectorAll(".thumbnail-placeholder").length, 1);
  assert.match(document.body.textContent ?? "", /Created/);
  assert.match(document.body.textContent ?? "", /Updated/);

  await act(async () => { button("Add glance").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  const dialog = document.querySelector("dialog");
  assert.ok(dialog?.hasAttribute("open"));
  assert.equal(button("Paste Neuroglancer URL").disabled, false);
  assert.equal(button("From zarr path").disabled, false);
  const forms = [...document.querySelectorAll<HTMLFormElement>("form.tab-panel")];
  assert.equal(forms.length, 2);
  assert.equal(forms[0].querySelectorAll('input[name="title"]').length, 1);
  assert.equal(forms[0].querySelectorAll('input[name="short_name"]').length, 1);
  assert.equal(forms[1].querySelectorAll('input[name="title"]').length, 1);
  assert.equal(forms[1].querySelectorAll('input[name="short_name"]').length, 1);
  assert.equal(forms[0].querySelector<HTMLInputElement>('input[name="title"]')?.disabled, false);

  const urlInput = forms[0].querySelector<HTMLTextAreaElement>('textarea[name="url"]')!;
  // Hold the expected value in a local: a successful submit resets the form, so
  // reading urlInput.value after submitting would compare against an empty field.
  const submittedUrl = 'https://neuroglancer-demo.appspot.com/#!{"layers":[]}';
  urlInput.value = submittedUrl;
  await act(async () => { forms[0].dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(requests.some((request) => request.path === "/api/glances" && request.method === "POST" && request.body?.url === submittedUrl));
  assert.equal(urlInput.value, "", "a successful glance submit must reset the form");
  assert.equal(document.querySelectorAll(".inline-error").length, 0, "a successful glance submit must not surface an inline error");
  assert.equal(dialog?.hasAttribute("open"), false, "a successful glance submit must close the dialog");

  await act(async () => { button("Add glance").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); button("From zarr path").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
  assert.equal(forms[1].getAttribute("aria-hidden"), "false");
  for (const control of forms[1].querySelectorAll('select, input')) assert.equal((control as HTMLInputElement | HTMLSelectElement).disabled, false);
  assert.equal(forms[1].querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled, false);

  (dialog as HTMLDialogElement).close();
  await act(async () => { button("Archive").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.ok(requests.some((request) => request.path === `/api/studies/${study.id}` && request.method === "PATCH" && request.body?.archived === true));

  await act(async () => { root.unmount(); });
  dom.window.close();
});

/* The Volumes catalog describes one account's inventory, so another account is
 * not offered the tab -- not even by following a `#volumes` link. */
test("the volumes tab is offered only to the account whose catalog it is", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id=app></div></body></html>", { url: "https://mind.example/#volumes" });
  for (const [name, value] of Object.entries({
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLDialogElement: dom.window.HTMLDialogElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, FormData: dom.window.FormData
  })) Object.defineProperty(globalThis, name, { configurable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  // React's legacy input polyfill calls these on the focused element, and an
  // autofocused field in the studies panel is focused as it mounts.
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });

  let account = { id: "labb", label: "Lab B" };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://mind.example");
    if (url.pathname === "/api/session") return Response.json(account);
    if (url.pathname === "/api/studies") return Response.json([]);
    throw new Error(`Unexpected fetch: ${url.pathname}`);
  };

  const container = document.querySelector("#app")!;
  const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim());

  let root = createRoot(container);
  await act(async () => { root.render(createElement(HomeClient)); });
  await settle();
  assert.deepEqual(tabs(), ["Studies"], "an account without a volumes catalog is not offered the tab");
  assert.equal(document.querySelector("#panel-volumes"), null, "the volumes panel must not be rendered at all");
  // `#volumes` in the URL must not leave the page on a panel it will not draw.
  assert.equal(document.querySelector("#panel-studies")?.hasAttribute("hidden"), false);
  await act(async () => { root.unmount(); });

  account = { id: "default", label: "PyTorch Connectomics" };
  root = createRoot(container);
  await act(async () => { root.render(createElement(HomeClient)); });
  await settle();
  assert.deepEqual(tabs(), ["Studies", "Volumes"]);
  assert.equal(document.querySelector("#panel-studies")?.hasAttribute("hidden"), true, "the #volumes fragment must open the volumes panel");

  await act(async () => { root.unmount(); });
  dom.window.close();
});
