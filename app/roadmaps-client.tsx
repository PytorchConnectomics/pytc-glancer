"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { readJson } from "../lib/read-response";

interface Roadmap { id: string; title: string; slug: string; archived_at: number | null; created_at: number; updated_at: number; shape_count: number; task_count: number | null; }

function when(value: number) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value); }

/* The Roadmaps tab's body: the account's shared canvases, listed the way
 * Studies lists studies. A roadmap opens on its own page, where the canvas has
 * the whole window. */
export default function RoadmapsClient() {
  const [roadmaps, setRoadmaps] = useState<Roadmap[]>([]);
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  async function load(showArchived = archived) {
    setLoading(true); setError("");
    try { setRoadmaps(await readJson<Roadmap[]>(await fetch(`/api/roadmaps${showArchived ? "?include_archived=1" : ""}`, { cache: "no-store" }))); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError("");
    const formElement = event.currentTarget;
    try {
      const roadmap = await readJson<Roadmap>(await fetch("/api/roadmaps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: new FormData(formElement).get("title") }) }));
      dialog.current?.close(); formElement.reset();
      window.location.href = `/roadmap/${roadmap.slug}`;
    } catch (value) { setFormError(value instanceof Error ? value.message : String(value)); }
  }

  return <>
    <section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Roadmaps</h1></div><button className="primary" type="button" onClick={() => dialog.current?.showModal()}>New roadmap</button></section>
    <div className="toolbar"><label className="switch"><input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); void load(event.target.checked); }} /> <span>Show archived</span></label><span>{roadmaps.length} {roadmaps.length === 1 ? "roadmap" : "roadmaps"}</span></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading ? <div className="empty-panel"><p>Loading roadmaps…</p></div> : roadmaps.length ? <section className="study-grid" aria-label="Roadmaps">{roadmaps.map((roadmap) => <a className="study-card roadmap-card" href={`/roadmap/${roadmap.slug}`} key={roadmap.id}>
      <div className="card-top"><span className="count">{roadmap.task_count != null ? `${roadmap.task_count} ${roadmap.task_count === 1 ? "task" : "tasks"}` : `${roadmap.shape_count} ${roadmap.shape_count === 1 ? "shape" : "shapes"}`}</span>{roadmap.archived_at && <span className="badge">Archived</span>}</div>
      <h2>{roadmap.title}</h2>
      <dl className="timestamps"><div><dt>Created</dt><dd>{when(roadmap.created_at)}</dd></div><div><dt>Updated</dt><dd>{when(roadmap.updated_at)}</dd></div></dl>
    </a>)}</section> : <div className="empty-panel"><p>No roadmaps yet.</p><span>Create a roadmap to draw a plan the whole team can edit: boxes for tasks, arrows for what depends on what.</span></div>}
    <dialog ref={dialog} className="dialog"><form method="dialog" className="dialog-close"><button aria-label="Close dialog">×</button></form><form onSubmit={create} className="form-stack"><div><p className="eyebrow">New record</p><h2>Create roadmap</h2></div><label>Title<input name="title" maxLength={200} required autoFocus /></label>{formError && <p className="inline-error" role="alert">{formError}</p>}<button className="primary" type="submit">Create roadmap</button></form></dialog>
  </>;
}
