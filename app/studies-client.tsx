"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { readJson as responseJson } from "../lib/read-response";

interface Study { id: string; title: string; slug: string; description: string | null; archived_at: number | null; created_at: number; updated_at: number; glance_count: number; }

function when(value: number) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value); }

export default function StudiesClient() {
  const [studies, setStudies] = useState<Study[]>([]);
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  async function load(showArchived = archived) {
    setLoading(true); setError("");
    try { setStudies(await responseJson<Study[]>(await fetch(`/api/studies${showArchived ? "?include_archived=1" : ""}`, { cache: "no-store" }))); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setFormError("");
    // Capture the element synchronously: React clears event.currentTarget once
    // dispatch ends, so touching it after an await throws on null.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const study = await responseJson<Study>(await fetch("/api/studies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: form.get("title"), description: form.get("description") }) }));
      dialog.current?.close(); formElement.reset();
      window.location.href = `/study/${study.slug}`;
    } catch (value) { setFormError(value instanceof Error ? value.message : String(value)); }
  }

  // The page shell owns the topbar and the tab strip; this is the Studies tab's
  // own body, rendered into it.
  return <>
    <section className="page-heading"><div><p className="eyebrow">Workspace</p><h1>Studies</h1></div><button className="primary" type="button" onClick={() => dialog.current?.showModal()}>New study</button></section>
    <div className="toolbar"><label className="switch"><input type="checkbox" checked={archived} onChange={(event) => { setArchived(event.target.checked); void load(event.target.checked); }} /> <span>Show archived</span></label><span>{studies.length} {studies.length === 1 ? "study" : "studies"}</span></div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {loading ? <div className="empty-panel"><p>Loading studies…</p></div> : studies.length ? <section className="study-grid" aria-label="Studies">{studies.map((study) => <a className="study-card" href={`/study/${study.slug}`} key={study.id}>
      <div className="card-top"><span className="count">{study.glance_count} {study.glance_count === 1 ? "glance" : "glances"}</span>{study.archived_at && <span className="badge">Archived</span>}</div>
      <h2>{study.title}</h2><p>{study.description || "No description"}</p>
      <dl className="timestamps"><div><dt>Created</dt><dd>{when(study.created_at)}</dd></div><div><dt>Updated</dt><dd>{when(study.updated_at)}</dd></div></dl>
    </a>)}</section> : <div className="empty-panel"><p>No studies yet.</p><span>Create a study to collect related Neuroglancer views.</span></div>}
    <dialog ref={dialog} className="dialog"><form method="dialog" className="dialog-close"><button aria-label="Close dialog">×</button></form><form onSubmit={create} className="form-stack"><div><p className="eyebrow">New record</p><h2>Create study</h2></div><label>Title<input name="title" maxLength={200} required autoFocus /></label><label>Description<textarea name="description" maxLength={2000} rows={4} /></label>{formError && <p className="inline-error" role="alert">{formError}</p>}<button className="primary" type="submit">Create study</button></form></dialog>
  </>;
}
