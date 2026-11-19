"use client";

import { useEffect, useRef, useState } from "react";
import { Tldraw, createTLStore, defaultBindingUtils, defaultShapeUtils, loadSnapshot, type Editor, type TLRecord, type TLStore } from "tldraw";
import type { Plan } from "../../../lib/roadmap-plan";
import { drawPlan } from "./plan-shapes";
import "tldraw/tldraw.css";

export type SyncState = "loading" | "saved" | "saving" | "offline" | "readonly" | "plan";
export interface CanvasProps {
  slug: string;
  onTitle(title: string): void;
  onState(state: SyncState): void;
  onError(message: string): void;
}

interface Opened { title: string; seq: number; schema: unknown; records: TLRecord[]; archived_at: number | null; license_key: string | null; plan: Plan | null; plan_rev: number; }
interface Exchange { seq: number; plan_rev: number; puts: TLRecord[]; removes: string[]; }

/* How often a browser trades changes with the server, and how soon after an
 * edit it stops waiting for the next turn. */
const POLL_MS = 2000;
const FLUSH_MS = 350;

class Refused extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const text = await response.text();
  let body: (T & { detail?: string }) | undefined;
  try { body = text ? JSON.parse(text) as T & { detail?: string } : undefined; } catch { body = undefined; }
  if (response.status === 401) throw new Refused("Signed out. Reload the page to sign in again; unsaved changes on this page will be lost.");
  // A 4xx is the server's considered answer: sending the same thing again
  // gets the same answer, so it is reported rather than retried.
  if (response.status >= 400 && response.status < 500) throw new Refused(body?.detail ?? `The server refused the request (HTTP ${response.status}).`);
  if (!response.ok || body === undefined) throw new Error(`HTTP ${response.status}`);
  return body;
}

/* The canvas and its sync loop.
 *
 * tldraw keeps the document in a store of records. Every local change to a
 * document record is noted in `pending`; an exchange sends the pending records
 * and applies whatever other browsers wrote since the last one. Records are
 * merged one by one and the last write to a record wins, so two people moving
 * different boxes both keep their work, and two people moving the same box see
 * it settle where the later of them left it. */
export default function RoadmapCanvas({ slug, onTitle, onState, onError }: CanvasProps) {
  const [opened, setOpened] = useState<{ store: TLStore; licenseKey: string | null } | null>(null);
  const [planView, setPlanView] = useState<{ plan: Plan | null } | null>(null);
  // The editor arrives from tldraw after the store is handed to it, and the
  // plan from the server; whichever comes second draws the plan.
  const board = useRef<{ editor: Editor | null; plan: Plan | null; editable: boolean }>({ editor: null, plan: null, editable: false });

  function draw() {
    const { editor, plan, editable } = board.current;
    if (!editor || !plan || !editable) return;
    try { drawPlan(editor, plan); }
    catch (value) { console.error("roadmap: the plan could not be drawn", value); onError("The project's plan could not be drawn on this canvas. The rest of the board is unaffected."); }
  }

  useEffect(() => {
    let live = true;
    let busy = false;
    let since = 0;
    let planRev = 0;
    let store: TLStore | null = null;
    let flush: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let unlisten = () => {};
    const client = crypto.randomUUID();
    // id -> the record to store, or null for a removal.
    const pending = new Map<string, TLRecord | null>();
    const path = `/api/roadmaps/${encodeURIComponent(slug)}`;

    function body(batch: Map<string, TLRecord | null>) {
      const puts: TLRecord[] = []; const removes: string[] = [];
      for (const [id, record] of batch) { if (record) puts.push(record); else removes.push(id); }
      return JSON.stringify({ client, since, puts, removes, ...(batch.size && store ? { schema: store.schema.serialize() } : {}) });
    }

    async function exchange() {
      if (busy || !live || !store) return;
      busy = true;
      const batch = new Map(pending);
      pending.clear();
      if (batch.size) onState("saving");
      try {
        const answer = await call<Exchange>(`${path}/changes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(batch) });
        if (!live) return;
        since = answer.seq;
        // A record changed here since the batch left is newer than what the
        // server sent, and is on its way there; the local one stays.
        const puts = answer.puts.filter((record) => !pending.has(record.id));
        const removes = answer.removes.filter((id) => !pending.has(id) && store!.has(id as TLRecord["id"]));
        if (puts.length || removes.length) {
          try {
            store.mergeRemoteChanges(() => {
              if (puts.length) store!.put(puts);
              if (removes.length) store!.remove(removes as TLRecord["id"][]);
            });
          } catch (value) {
            console.error("roadmap: a change from another browser could not be applied", value);
            onError("A change made in another browser could not be shown here. Reload the page to see the current roadmap.");
          }
        }
        onState(pending.size ? "saving" : "saved");
        // The project pushed a new plan while this page was open.
        if (answer.plan_rev !== planRev) {
          const fresh = await call<Opened>(path);
          if (!live) return;
          planRev = fresh.plan_rev;
          board.current.plan = fresh.plan;
          onTitle(fresh.title);
          draw();
        }
      } catch (value) {
        if (!live) return;
        if (value instanceof Refused) {
          // Not retried: the batch is dropped, and the page says so.
          onError(`Your last change was not saved. ${value.message}`);
          onState("saved");
        } else {
          for (const [id, record] of batch) if (!pending.has(id)) pending.set(id, record);
          onState("offline");
        }
      } finally { busy = false; }
    }

    void (async () => {
      try {
        const roadmap = await call<Opened>(path);
        if (!live) return;
        onTitle(roadmap.title);
        if (!roadmap.license_key && location.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
          setPlanView({ plan: roadmap.plan });
          onState("plan");
          return;
        }
        const created = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils });
        if (roadmap.records.length && roadmap.schema) {
          // Loading through a snapshot runs tldraw's migrations, so records
          // written by an older tldraw open in a newer one.
          loadSnapshot(created, { document: { store: Object.fromEntries(roadmap.records.map((record) => [record.id, record])), schema: roadmap.schema } } as Parameters<typeof loadSnapshot>[1]);
        }
        store = created;
        since = roadmap.seq;
        planRev = roadmap.plan_rev;
        const readonly = roadmap.archived_at !== null;
        board.current = { editor: null, plan: roadmap.plan, editable: !readonly };
        if (!readonly) {
          unlisten = created.listen(({ changes }) => {
            for (const record of Object.values(changes.added)) pending.set(record.id, record);
            for (const [, record] of Object.values(changes.updated)) pending.set(record.id, record);
            for (const record of Object.values(changes.removed)) pending.set(record.id, null);
            onState("saving");
            clearTimeout(flush);
            flush = setTimeout(() => { void exchange(); }, FLUSH_MS);
          }, { source: "user", scope: "document" });
          poll = setInterval(() => { void exchange(); }, POLL_MS);
        }
        setOpened({ store: created, licenseKey: roadmap.license_key });
        onState(readonly ? "readonly" : "saved");
      } catch (value) {
        if (live) onError(value instanceof Refused ? value.message : `The roadmap could not be opened (${value instanceof Error ? value.message : String(value)}). Reload to try again.`);
      }
    })();

    // Leaving with changes still waiting: send them on the way out. `keepalive`
    // lets the request outlive the page.
    function leave() {
      if (!pending.size) return;
      const batch = new Map(pending);
      pending.clear();
      void fetch(`${path}/changes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(batch), keepalive: true }).catch(() => {});
    }
    window.addEventListener("pagehide", leave);

    return () => {
      leave();
      live = false;
      clearTimeout(flush); clearInterval(poll); unlisten();
      window.removeEventListener("pagehide", leave);
    };
  }, [slug]);

  if (planView) {
    const plan = planView.plan;
    if (!plan) return <p className="empty-panel">This roadmap has no published task plan.</p>;
    const titles = new Map(plan.nodes.map((node) => [node.id, node.title]));
    return <article className="roadmap-plan" aria-label={plan.title}>
      {plan.lanes.map((lane) => <section key={lane.id}>
        <h2>{lane.title}</h2>
        <ul className="roadmap-tasks">{plan.nodes.filter((node) => node.lane === lane.id).map((node) =>
          <li key={node.id} id={`task-${node.id}`}>
            <h3>{node.link ? <a href={node.link}>{node.title}</a> : node.title}</h3>
            <p>{node.owner || "Unassigned"} · {node.status}</p>
            {node.note && <p>{node.note}</p>}
            {node.needs.length > 0 && <div>Depends on <ul>{node.needs.map((id) =>
              <li key={id}><a href={`#task-${id}`}>{titles.get(id)}</a></li>)}</ul></div>}
          </li>)}</ul>
      </section>)}
    </article>;
  }
  if (!opened) return null;
  return <Tldraw store={opened.store} licenseKey={opened.licenseKey ?? undefined} colorScheme="dark"
                 onMount={(editor) => {
                   board.current.editor = editor;
                   draw();
                   if (editor.getCurrentPageShapeIds().size) editor.zoomToFit();
                 }} />;
}
