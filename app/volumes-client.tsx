"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import AtlasMap, { type MapLayers } from "./atlas-map";
import { ALLEN_REGIONS, DATASETS, MODALITIES, type AtlasDataset } from "../lib/atlas-data";
import { loadPlate, type AtlasManifest, type Plate, type PlateStructure, type PlateSummary } from "../lib/atlas-plates";

const MODALITY_COLORS: Record<string, string> = {
  vEM: "#f7c76f", "Light sheet": "#5df0f0",
  "X-ray": "#75b9ff", Atlas: "#38d7db", Other: "#ff796f",
};

const LAYER_LABELS: [keyof MapLayers, string][] = [
  ["points", "Datasets"], ["divisions", "Division colour"], ["labels", "Region labels"], ["detail", "Fine structure"],
];

/** Neuroglancer states in the catalog point at public precomputed sources, so
 * this frames a fixed public viewer. No pytc_glancer credential is involved and
 * the state never touches D1 — unlike a glance, which is stored and shareable. */
const CATALOG_VIEWER = "https://neuroglancer.bossdb.io/#!";

function viewerUrl(dataset: AtlasDataset) {
  return dataset.viewerState ? CATALOG_VIEWER + encodeURIComponent(JSON.stringify(dataset.viewerState)) : null;
}

function pad(value: number) { return String(value).padStart(2, "0"); }

export default function VolumesClient() {
  const [species, setSpecies] = useState<"mouse" | "human">("mouse");
  const [modality, setModality] = useState("All");
  const [region, setRegion] = useState("All");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("microns-minnie");
  const [layers, setLayers] = useState<MapLayers>({ points: true, divisions: true, labels: true, detail: false });
  const [manifest, setManifest] = useState<AtlasManifest | null>(null);
  const [plateId, setPlateId] = useState("coronal-326");
  const [plate, setPlate] = useState<Plate | null>(null);
  const [plateError, setPlateError] = useState("");
  const [hovered, setHovered] = useState<PlateStructure | null>(null);
  const [viewing, setViewing] = useState<AtlasDataset | null>(null);
  const [toast, setToast] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const detailPanel = useRef<HTMLElement>(null);

  const speciesData = useMemo(() => DATASETS.filter((dataset) => dataset.species === species), [species]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return speciesData.filter((dataset) => {
      if (modality !== "All" && dataset.modality !== modality) return false;
      if (region !== "All" && dataset.region !== region) return false;
      if (!needle) return true;
      return [dataset.name, dataset.title, dataset.modality, dataset.technique, dataset.provider,
        ALLEN_REGIONS[dataset.region]?.label, ...dataset.layers].join(" ").toLowerCase().includes(needle);
    });
  }, [speciesData, modality, region, query]);

  // Selection is derived rather than corrected in place: when a filter hides the
  // selected record the panel falls through to the first visible one.
  const selected = visible.find((dataset) => dataset.id === selectedId) ?? visible[0] ?? null;
  const focusRegion = region !== "All" ? region : selected?.region ?? null;

  useEffect(() => {
    let live = true;
    fetch("/atlas/manifest.json", { cache: "force-cache" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Atlas manifest unavailable (${response.status}).`);
        return await response.json() as AtlasManifest;
      })
      .then((value) => { if (live) setManifest(value); })
      .catch((error) => { if (live) setPlateError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, []);

  const summaries = useMemo(() => manifest?.plates ?? [], [manifest]);
  const coronal = summaries.filter((entry) => entry.orientation === "coronal");
  const locator = summaries.find((entry) => entry.orientation === "sagittal");

  // The plates cover disjoint bands of the brain, so the map follows the filter:
  // pick a plate that actually contains the region being looked at. This fires
  // only when the region changes, so picking a plate by hand sticks — otherwise
  // the locator would be unreachable whenever it lacks the selected region.
  const autoPlatedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRegion || !summaries.length || autoPlatedFor.current === focusRegion) return;
    autoPlatedFor.current = focusRegion;
    const current = summaries.find((entry) => entry.id === plateId);
    if (current?.regions.includes(focusRegion)) return;
    const match = summaries.find((entry) => entry.orientation === "coronal" && entry.regions.includes(focusRegion))
      ?? summaries.find((entry) => entry.regions.includes(focusRegion));
    if (match) setPlateId(match.id);
  }, [focusRegion, summaries, plateId]);

  useEffect(() => {
    const summary = summaries.find((entry) => entry.id === plateId);
    if (!summary) return;
    let live = true;
    setPlateError("");
    loadPlate(summary.file)
      .then((value) => { if (live) setPlate(value); })
      .catch((error) => { if (live) setPlateError(error instanceof Error ? error.message : String(error)); });
    return () => { live = false; };
  }, [plateId, summaries]);

  const notify = useCallback((message: string) => {
    setToast(message);
    const timer = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, []);

  function chooseSpecies(next: "mouse" | "human") {
    setSpecies(next); setModality("All"); setRegion("All"); setQuery("");
    if (next === "mouse") setSelectedId("microns-minnie");
    else notify("Human mode is scaffolded; mouse data ingestion is the current focus.");
  }

  function clearFilters() { setModality("All"); setRegion("All"); setQuery(""); }

  function selectFromTable(id: string) {
    setSelectedId(id);
    if (window.innerWidth < 850) detailPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function openViewer(dataset: AtlasDataset) {
    setViewing(dataset);
    dialog.current?.showModal();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === "/" && !typing) { event.preventDefault(); search.current?.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const totals = useMemo(() => {
    const mouse = DATASETS.filter((dataset) => dataset.species === "mouse");
    return { datasets: mouse.length, regions: new Set(mouse.map((d) => d.region)).size, viewers: mouse.filter((d) => d.viewerState).length };
  }, []);

  /** Regions with no CCF counterpart cannot be drawn; say so rather than
   * letting the map look as though the data is missing. */
  const mappedRegions = useMemo(() => new Set(summaries.flatMap((entry) => entry.regions)), [summaries]);
  const regionEntries = Object.entries(ALLEN_REGIONS).filter(([key]) => speciesData.some((d) => d.region === key));
  const isHuman = species === "human";

  return <div className="volumes-root">
    <section className="intro">
      <div>
        <p className="eyebrow"><span /> Mouse brain · inventory v0.1</p>
        <h1>Where does the data live?</h1>
        <p>Volumetric datasets placed on the Allen Reference Atlas by anatomical region, imaging modality, and viewer availability.</p>
      </div>
      <div className="intro-stats" aria-label="Inventory summary">
        <div><strong>{totals.datasets}</strong><span>datasets</span></div>
        <div><strong>{totals.regions}</strong><span>regions</span></div>
        <div><strong>{totals.viewers}</strong><span>viewer-ready</span></div>
      </div>
      <div className="species-switch" role="group" aria-label="Species">
        {(["mouse", "human"] as const).map((option) => (
          <button key={option} type="button" className={`species-option${species === option ? " active" : ""}`}
                  aria-pressed={species === option} onClick={() => chooseSpecies(option)}>
            {option === "mouse" ? <><span aria-hidden="true">●</span> Mouse</> : <>Human <em>next</em></>}
          </button>
        ))}
      </div>
    </section>

    <section className="modality-bar" aria-label="Filter by modality">
      <span className="control-label">Modality</span>
      <div className="chips">
        {MODALITIES.map((option) => {
          const count = option === "All" ? speciesData.length : speciesData.filter((d) => d.modality === option).length;
          return <button key={option} type="button" className={`chip${modality === option ? " active" : ""}`}
                         aria-pressed={modality === option} onClick={() => setModality(option)}>
            {option}<span>{pad(count)}</span>
          </button>;
        })}
      </div>
      <span className="result-count" aria-live="polite">{isHuman ? "Catalog pending" : `${visible.length} / ${speciesData.length} records`}</span>
    </section>

    <section className="workspace" id="inventory">
      <aside className="filter-panel" aria-label="Dataset filters">
        <div className="panel-heading">
          <div><span className="kicker">01</span><h2>Browse coverage</h2></div>
          <button className="text-button" type="button" onClick={clearFilters}>Clear</button>
        </div>
        <label className="search-field">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.6" /><path d="m13 13 4 4" /></svg>
          <input ref={search} type="search" placeholder="Search datasets" autoComplete="off"
                 value={query} onChange={(event) => setQuery(event.target.value)} />
          <span className="shortcut" aria-hidden="true">/</span>
        </label>
        <div className="filter-section">
          <div className="section-label"><span>Allen region</span><small>CCF structure</small></div>
          <div className="region-list">
            <button type="button" className={`region-button${region === "All" ? " active" : ""}`} onClick={() => setRegion("All")}>
              <span className="region-swatch" style={{ "--region-color": "#38d7db" } as CSSProperties} />
              <strong>All regions</strong><small>{pad(speciesData.length)}</small>
            </button>
            {regionEntries.map(([key, entry]) => (
              <button key={key} type="button" className={`region-button${region === key ? " active" : ""}`} onClick={() => setRegion(key)}>
                <span className="region-swatch" style={{ "--region-color": entry.color } as CSSProperties} />
                <strong>{entry.label}</strong>
                <small>{pad(speciesData.filter((d) => d.region === key).length)}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="filter-note">
          <span className="status-dot" />
          <p><strong>Reference system</strong>Regions follow the Allen Mouse Brain Common Coordinate Framework. Retina and whole-brain records have no single CCF structure, so they do not appear on a plate.</p>
        </div>
      </aside>

      <section className="atlas-panel" aria-labelledby="atlas-heading">
        <div className="panel-heading atlas-heading-row">
          <div><span className="kicker">02</span><h2 id="atlas-heading">Allen Reference Atlas</h2></div>
        </div>

        <div className="map-controls" role="group" aria-label="Choose map layers" hidden={isHuman}>
          <span className="map-controls-label">Show</span>
          {LAYER_LABELS.map(([key, label]) => (
            <label key={key}>
              <input type="checkbox" checked={layers[key]}
                     onChange={(event) => setLayers((current) => ({ ...current, [key]: event.target.checked }))} />
              <span>{label}</span>
            </label>
          ))}
        </div>

        <div className="plate-bar" hidden={isHuman}>
          <span className="control-label">Plate</span>
          {coronal.map((entry) => (
            <button key={entry.id} type="button" className={`plate-option${plateId === entry.id ? " active" : ""}`}
                    onClick={() => setPlateId(entry.id)} title={entry.note}>{entry.label}</button>
          ))}
          {locator && (
            <button type="button" className={`plate-option${plateId === locator.id ? " active" : ""}`}
                    onClick={() => setPlateId(locator.id)} title={locator.note}>{locator.label}</button>
          )}
          <span className="plate-note">{summaries.find((entry) => entry.id === plateId)?.note}</span>
        </div>

        {isHuman ? (
          <div className="human-empty">
            <div className="empty-orbit" aria-hidden="true"><i /><i /><i /></div>
            <span>Human inventory</span>
            <h3>Reference scaffold ready.</h3>
            <p>Dataset ingestion will follow the mouse catalog.</p>
            <button type="button" onClick={() => chooseSpecies("mouse")}>Return to mouse</button>
          </div>
        ) : (
          <div className="brain-canvas">
            {plateError ? <div className="empty-panel"><p>Atlas unavailable.</p><span>{plateError}</span></div>
              : plate ? <AtlasMap plate={plate} focusRegion={focusRegion} datasets={visible} selectedId={selected?.id ?? null}
                                 layers={layers} hovered={hovered} onHover={setHovered}
                                 onSelectRegion={(value) => setRegion((current) => (current === value ? "All" : value))}
                                 onSelectDataset={setSelectedId} />
                : <div className="empty-panel"><p>Loading atlas plate…</p></div>}
            <div className="map-readout">
              <div><span className="readout-dot" /><strong>{region === "All" ? "All regions" : ALLEN_REGIONS[region]?.label}</strong></div>
              <span>{visible.length} {visible.length === 1 ? "volume" : "volumes"} indexed</span>
            </div>
            {hovered && (
              <div className="ccf-readout"><strong>{hovered.name}</strong><span>{hovered.acr}{hovered.division ? ` · ${hovered.division}` : ""}</span></div>
            )}
          </div>
        )}
        <p className="atlas-credit">
          Structure outlines: <a href="https://atlas.brain-map.org/" target="_blank" rel="noreferrer">Allen Reference Atlas — Mouse Brain</a>, Allen Institute for Brain Science. Plate geometry is vendored; the app makes no runtime call to brain-map.org.
        </p>
      </section>

      <aside className="detail-panel" aria-label="Selected dataset" ref={detailPanel}>
        <div className="panel-heading">
          <div><span className="kicker">03</span><h2>Dataset record</h2></div>
          <span className="record-index">
            {selected && !isHuman ? `${pad(visible.indexOf(selected) + 1)} / ${pad(visible.length)}` : "00 / 00"}
          </span>
        </div>
        <div id="dataset-detail">{
          isHuman ? <>
            <div className="record-topline"><span className="modality-badge" style={{ "--badge-color": "#5df0f0" } as CSSProperties}>Catalog scaffold</span></div>
            <h3 className="record-title">Human datasets arrive next.</h3>
            <p className="record-description">The same schema is ready for a human reference atlas, anatomical regions, modalities, manifests, and Neuroglancer states.</p>
            <div className="record-actions"><button className="primary-action source-only" type="button" onClick={() => chooseSpecies("mouse")}>Browse mouse inventory</button></div>
          </> : !selected ? <>
            <div className="record-topline"><span className="modality-badge" style={{ "--badge-color": "#8fa2ae" } as CSSProperties}>No match</span></div>
            <h3 className="record-title">Try a broader filter.</h3>
            <p className="record-description">No dataset record currently matches this combination of modality, region, and search terms.</p>
            <div className="record-actions"><button className="primary-action source-only" type="button" onClick={clearFilters}>Clear filters</button></div>
          </> : <>
            <div className="record-topline">
              <span className="modality-badge" style={{ "--badge-color": MODALITY_COLORS[selected.modality] ?? ALLEN_REGIONS[selected.region].color } as CSSProperties}>{selected.modality}</span>
              <span className="record-year">{selected.year}</span>
            </div>
            <h3 className="record-title">{selected.title}</h3>
            <p className="record-name">{selected.name} · {ALLEN_REGIONS[selected.region].acronym} · {ALLEN_REGIONS[selected.region].organization}</p>
            <p className="record-description">{selected.description}</p>
            <div className="record-metrics">
              <div className="record-metric"><span>Technique</span><strong>{selected.technique}</strong></div>
              <div className="record-metric"><span>Resolution</span><strong>{selected.resolution}</strong></div>
              <div className="record-metric"><span>Physical extent</span><strong>{selected.scale}</strong></div>
              <div className="record-metric"><span>Data scale</span><strong>{selected.size}</strong></div>
            </div>
            <p className="record-section-label">Available layers</p>
            <div className="layer-list">{selected.layers.map((layer) => <span key={layer}>{layer}</span>)}</div>
            <p className="record-source">{selected.provider}</p>
            {!mappedRegions.has(selected.region) && (
              <p className="record-source">Not drawn on a plate: {ALLEN_REGIONS[selected.region].label} has no single CCF structure.</p>
            )}
            <div className="record-actions">
              {selected.viewerState
                ? <button className="primary-action" type="button" onClick={() => openViewer(selected)}>
                    <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2v14M2 9h14M4 4l10 10M14 4 4 14" /></svg>
                    Launch Neuroglancer
                  </button>
                : <a className="primary-action source-only" href={selected.sourceUrl} target="_blank" rel="noreferrer">View source record ↗</a>}
              <a className="secondary-action" href={selected.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open source for ${selected.name}`}>↗</a>
            </div>
          </>
        }</div>
      </aside>
    </section>

    <section className="catalog" aria-labelledby="catalog-heading">
      <div className="catalog-heading">
        <div><span className="kicker">04</span><h2 id="catalog-heading">Visible inventory</h2></div>
        <p>Click a record to locate it on the atlas.</p>
      </div>
      <div className="table-wrap" hidden={!visible.length}>
        <table>
          <thead><tr><th>Dataset</th><th>Primary region</th><th>Modality</th><th>Resolution</th><th>Scale</th><th><span className="sr-only">Availability</span></th></tr></thead>
          <tbody>{visible.map((dataset) => {
            const entry = ALLEN_REGIONS[dataset.region];
            return <tr key={dataset.id} className={dataset.id === selected?.id ? "selected" : ""} tabIndex={0}
                       onClick={() => selectFromTable(dataset.id)}
                       onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectFromTable(dataset.id); } }}>
              <td><div className="table-title" style={{ "--row-color": entry.color } as CSSProperties}>
                <i className="table-swatch" /><div><strong>{dataset.name}</strong><span>{dataset.title} · {dataset.year}</span></div>
              </div></td>
              <td><span className="table-region" style={{ "--row-color": entry.color } as CSSProperties}><i />{entry.label} <small>{entry.acronym}</small></span></td>
              <td><span className="table-modality">{dataset.modality}</span></td>
              <td>{dataset.resolution}</td>
              <td>{dataset.scale}</td>
              <td><span className="table-viewer">{dataset.viewerState ? "Viewer ready ↗" : "Source ↗"}</span></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!visible.length && !isHuman && (
        <div className="catalog-empty"><p>No mouse records match these filters.</p><button type="button" onClick={clearFilters}>Clear filters</button></div>
      )}
    </section>

    <section className="methodology" id="methodology">
      <div><span className="kicker">Method</span><h2>Inventory first. Registration next.</h2></div>
      <p>
        Each record carries a species, acquisition modality, primary Allen region, physical scale, source manifest,
        and optional Neuroglancer state. Records are placed at the centroid of their region on the reference plate,
        which locates a dataset to its structure but not within it; per-dataset atlas-space transforms can be added
        as they become available.
      </p>
      <div className="method-links">
        <a href="https://atlas.brain-map.org/" target="_blank" rel="noreferrer">Allen Mouse Brain Atlas ↗</a>
        <a href="https://bossdb.org/projects?selectedSpecies=Mouse" target="_blank" rel="noreferrer">BossDB mouse catalog ↗</a>
        <a href="https://home.webknossos.org/publications" target="_blank" rel="noreferrer">WEBKNOSSOS publications ↗</a>
        <a href="https://github.com/google/neuroglancer" target="_blank" rel="noreferrer">Neuroglancer ↗</a>
      </div>
    </section>

    <dialog ref={dialog} className="viewer-dialog" onClose={() => setViewing(null)}
            onClick={(event) => { if (event.target === dialog.current) dialog.current?.close(); }}>
      <div className="viewer-shell">
        <header>
          <div>
            <span className="viewer-live"><i /> Neuroglancer</span>
            <strong>{viewing ? `${viewing.name} · ${viewing.title}` : "Dataset viewer"}</strong>
          </div>
          <div className="viewer-actions">
            {viewing && <a href={viewerUrl(viewing) ?? "#"} target="_blank" rel="noreferrer">Open full screen ↗</a>}
            <button type="button" aria-label="Close viewer" onClick={() => dialog.current?.close()}>×</button>
          </div>
        </header>
        <div className="viewer-frame-wrap">
          <div className="viewer-loading"><span /><p>Connecting to volumetric source…</p></div>
          {/* Mounted only while open, so closing the dialog tears the viewer down. */}
          {viewing && <iframe title="Neuroglancer volumetric viewer" allow="fullscreen" src={viewerUrl(viewing) ?? undefined} />}
        </div>
      </div>
    </dialog>

    <div className={`toast${toast ? " visible" : ""}`} role="status" aria-live="polite">{toast}</div>
  </div>;
}
