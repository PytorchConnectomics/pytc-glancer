"use client";

import { FormEvent, MouseEvent, useEffect, useRef, useState } from "react";
import AccountBadge from "../../account-badge";
import { readJson as read } from "../../../lib/read-response";

interface Glance { id: string; short_key: string; short_name: string | null; title: string | null; url_base: string; state: string; source_path: string | null; position: number; archived_at: number | null; created_at: number; updated_at: number; shareable_link: string; }
interface Study { id: string; title: string; slug: string; description: string | null; archived_at: number | null; created_at: number; updated_at: number; glances: Glance[]; }
interface Source { id: string; label: string; bucket: string; prefix: string; }

function when(value: number) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value); }
function glanceName(glance: Glance) {
  if (glance.title) return glance.title;
  if (glance.source_path) return glance.source_path.split("/").filter(Boolean).at(-1) ?? "Untitled glance";
  try { const first = (JSON.parse(glance.state) as { layers?: Array<{ name?: string }> }).layers?.[0]?.name; if (first) return first; } catch { /* use fallback */ }
  return "Untitled glance";
}

export default function StudyClient({ slug }: { slug: string }) {
  const [study, setStudy] = useState<Study | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [tab, setTab] = useState<"url" | "path">("url");
  const [error, setError] = useState("");
  const [glanceError, setGlanceError] = useState("");
  const addDialog = useRef<HTMLDialogElement>(null);

  async function load(include = showArchived) { try { setStudy(await read<Study>(await fetch(`/api/studies/${encodeURIComponent(slug)}${include ? "?include_archived=1" : ""}`, { cache: "no-store" }))); setError(""); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } }
  useEffect(() => { void load(); void fetch("/api/sources", { cache: "no-store" }).then((response) => read<Source[]>(response)).then(setSources).catch((value) => setError(value instanceof Error ? value.message : String(value))); }, [slug]);

  async function patchStudy(body: Record<string, unknown>) { if (!study) return; try { await read(await fetch(`/api/studies/${study.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); await load(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } }
  async function rename(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = new FormData(event.currentTarget); await patchStudy({ title: form.get("title") }); setRenaming(false); }
  async function createGlance(event: FormEvent<HTMLFormElement>, kind: "url" | "path") {
    event.preventDefault(); if (!study) return; setGlanceError("");
    // Capture the element synchronously: React clears event.currentTarget once
    // dispatch ends, so touching it after an await throws on null.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = kind === "url"
      ? { study_id: study.id, url: form.get("url"), title: form.get("title"), short_name: form.get("short_name") }
      : { study_id: study.id, source_id: form.get("source_id"), path: form.get("path"), title: form.get("title"), short_name: form.get("short_name") };
    try { await read(await fetch("/api/glances", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })); formElement.reset(); addDialog.current?.close(); await load(); }
    catch (value) { setGlanceError(value instanceof Error ? value.message : String(value)); }
  }
  async function patchGlance(key: string, body: Record<string, unknown>, event: MouseEvent) { event.preventDefault(); try { await read(await fetch(`/api/glances/${key}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })); await load(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } }
  async function copy(link: string, event: MouseEvent) { event.preventDefault(); try { await navigator.clipboard.writeText(link); } catch { setError("The browser refused clipboard access."); } }

  return <main className="shell">
    <header className="topbar"><a className="brand-lockup" href="/"><span className="brand-mark" role="img" aria-label="PyTorch Connectomics" /><span><span className="brand-name">pytc_glancer</span><span className="brand-context">PyTorch Connectomics</span></span></a><a className="back-link" href="/">← All studies</a><AccountBadge /></header>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!study ? <section className="loading-workspace" aria-busy={!error}><div className="empty-panel"><p>{error ? "Study unavailable" : "Loading study…"}</p></div></section> : <>
      <section className="study-header"><div><p className="eyebrow">Study {study.archived_at && <span className="badge">Archived</span>}</p>{renaming ? <form className="rename-form" onSubmit={rename}><label className="sr-only" htmlFor="rename-title">Rename study</label><input id="rename-title" name="title" maxLength={200} defaultValue={study.title} autoFocus required /><button className="primary" type="submit">Save</button><button className="secondary" type="button" onClick={() => setRenaming(false)}>Cancel</button></form> : <div className="title-line"><h1>{study.title}</h1><button className="text-button" type="button" disabled={!!study.archived_at} onClick={() => setRenaming(true)}>Inline rename</button></div>}<p className="description">{study.description || "No description"}</p></div><button className={study.archived_at ? "secondary" : "danger"} type="button" onClick={() => void patchStudy({ archived: !study.archived_at })}>{study.archived_at ? "Unarchive" : "Archive"}</button></section>
      <section className="glance-heading"><div><p className="eyebrow">Saved views</p><h2>Glances</h2></div><button className="primary" type="button" disabled={!!study.archived_at} onClick={() => { setGlanceError(""); addDialog.current?.showModal(); }}>Add glance</button></section>
      <div className="toolbar"><label className="switch"><input type="checkbox" checked={showArchived} onChange={(event) => { setShowArchived(event.target.checked); void load(event.target.checked); }} /> <span>Show archived</span></label><span>{study.glances.length} {study.glances.length === 1 ? "glance" : "glances"}</span></div>
      {study.glances.length ? <section className="glance-grid" aria-label="Glances">{study.glances.map((glance) => <article className="glance-card" key={glance.id}>
        <a className="glance-open" href={`/study/${encodeURIComponent(slug)}/glance/${glance.short_key}`}><div className="thumbnail-placeholder" aria-label="Thumbnail placeholder"><span /><span /><span /></div><div className="glance-info"><div className="card-top"><span className="count">Position {glance.position}</span>{glance.archived_at && <span className="badge">Archived</span>}</div><h3>{glanceName(glance)}</h3><dl className="timestamps"><div><dt>Created</dt><dd>{when(glance.created_at)}</dd></div><div><dt>Updated</dt><dd>{when(glance.updated_at)}</dd></div></dl></div></a>
        <div className="card-actions"><button className="secondary" type="button" onClick={(event) => void copy(glance.shareable_link, event)}>Copy link</button><button className={glance.archived_at ? "secondary" : "danger"} type="button" disabled={!!study.archived_at} onClick={(event) => void patchGlance(glance.short_key, { archived: !glance.archived_at }, event)}>{glance.archived_at ? "Unarchive" : "Archive"}</button></div>
      </article>)}</section> : <div className="empty-panel"><p>No glances yet.</p><span>Add a Neuroglancer URL or an OME-Zarr path.</span></div>}
      <dialog ref={addDialog} className="dialog glance-dialog"><form method="dialog" className="dialog-close"><button aria-label="Close dialog">×</button></form><div><p className="eyebrow">New saved view</p><h2>Add glance</h2></div><div className="tabs" role="tablist" aria-label="Glance source"><button type="button" role="tab" aria-selected={tab === "url"} onClick={() => { setTab("url"); setGlanceError(""); }}>Paste Neuroglancer URL</button><button type="button" role="tab" aria-selected={tab === "path"} onClick={() => { setTab("path"); setGlanceError(""); }}>From zarr path</button></div>
        <form className={`form-stack tab-panel ${tab !== "url" ? "hidden-panel" : ""}`} onSubmit={(event) => void createGlance(event, "url")} aria-hidden={tab !== "url"}><label>Neuroglancer URL<textarea name="url" rows={5} required={tab === "url"} disabled={tab !== "url"} placeholder="https://neuroglancer-demo.appspot.com/#!{…}" /></label><label>Title <span>(optional)</span><input name="title" maxLength={200} disabled={tab !== "url"} /></label><label>Short name <span>(optional)</span><input name="short_name" maxLength={60} pattern="[a-z0-9-]+" disabled={tab !== "url"} /></label>{tab === "url" && glanceError && <p className="inline-error" role="alert">{glanceError}</p>}<button className="primary" type="submit" disabled={tab !== "url"}>Add glance</button></form>
        <form className={`form-stack tab-panel ${tab !== "path" ? "hidden-panel" : ""}`} onSubmit={(event) => void createGlance(event, "path")} aria-hidden={tab !== "path"}><label>Source<select name="source_id" required={tab === "path"} disabled={tab !== "path" || !sources.length}><option value="">Choose a configured source</option>{sources.map((source) => <option key={source.id} value={source.id}>{source.label} · gs://{source.bucket}/{source.prefix}</option>)}</select></label><label>Zarr path<input name="path" required={tab === "path"} disabled={tab !== "path" || !sources.length} placeholder="path/to/dataset.zarr" /></label><label>Title <span>(optional)</span><input name="title" maxLength={200} disabled={tab !== "path"} /></label><label>Short name <span>(optional)</span><input name="short_name" maxLength={60} pattern="[a-z0-9-]+" disabled={tab !== "path"} /></label>{!sources.length && <p className="source-note">No OME-Zarr sources are configured. Paste a Neuroglancer URL, or ask the operator to set PYTC_GLANCER_SOURCES.</p>}{tab === "path" && glanceError && <p className="inline-error" role="alert">{glanceError}</p>}<button className="primary" type="submit" disabled={tab !== "path" || !sources.length}>Generate glance</button></form>
      </dialog>
    </>}
  </main>;
}
