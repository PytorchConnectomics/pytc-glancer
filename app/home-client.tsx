"use client";

import { useEffect, useState } from "react";
import AccountBadge from "./account-badge";
import { useSession } from "./session";
import StudiesClient from "./studies-client";
import VolumesClient from "./volumes-client";
import { DEFAULT_ACCOUNT_ID } from "../lib/accounts";

const TABS = [
  { id: "studies", label: "Studies", note: "OME-Zarr view index" },
  { id: "volumes", label: "Volumes", note: "Allen atlas dataset inventory" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/* Which accounts are offered the Volumes tab.
 *
 * Volumes is one catalog, hand-written in `lib/atlas-data.ts`, of the public
 * datasets this workspace places on the Allen atlas. It describes the default
 * account's inventory and says nothing about another account's volumes, so an account
 * with no entries of its own would open a tab that is wrong about its data
 * rather than merely empty. An account is listed here once its volumes are
 * described. */
const VOLUMES_ACCOUNTS: ReadonlySet<string> = new Set([DEFAULT_ACCOUNT_ID]);

function tabFromHash(hash: string): TabId {
  const value = hash.replace(/^#/, "");
  return TABS.some((tab) => tab.id === value) ? value as TabId : "studies";
}

export default function HomeClient() {
  const session = useSession();
  const [tab, setTab] = useState<TabId>("studies");
  // Volumes fetches atlas geometry on mount, so it is not built until the tab is
  // first opened. After that it stays mounted and keeps its state.
  const [volumesOpened, setVolumesOpened] = useState(false);

  // The tab lives in the fragment so a view is linkable and survives reload,
  // without the server ever needing to know which one is open.
  useEffect(() => {
    const sync = () => {
      const next = tabFromHash(window.location.hash);
      setTab(next);
      if (next === "volumes") setVolumesOpened(true);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // Withheld until the account is known, rather than shown and then taken
  // away: the session arrives a render after the page does, and a tab that
  // appears only to vanish is worse than one that arrives a moment late. A
  // `#volumes` link from an account that is not offered the tab opens Studies.
  const volumes = session !== null && VOLUMES_ACCOUNTS.has(session.id);
  const tabs = volumes ? TABS : TABS.filter((entry) => entry.id !== "volumes");
  const shown: TabId = tab === "volumes" && !volumes ? "studies" : tab;

  function choose(next: TabId) {
    setTab(next);
    if (next === "volumes") setVolumesOpened(true);
    // replaceState keeps the back button meaning "the page before this one".
    history.replaceState(null, "", next === "studies" ? window.location.pathname : `#${next}`);
  }

  const active = TABS.find((entry) => entry.id === shown) ?? TABS[0];

  return <main className={`shell${shown === "volumes" ? " shell-wide" : ""}`}>
    <header className="topbar">
      <a className="brand-lockup" href="/">
        <span className="brand-mark" role="img" aria-label="PyTorch Connectomics" />
        <span><span className="brand-name">pytc_glancer</span><span className="brand-context">PyTorch Connectomics</span></span>
      </a>
      <nav className="home-tabs" role="tablist" aria-label="Workspace sections">
        {tabs.map((entry) => (
          <button key={entry.id} type="button" role="tab" id={`tab-${entry.id}`}
                  aria-selected={shown === entry.id} aria-controls={`panel-${entry.id}`}
                  onClick={() => choose(entry.id)}>{entry.label}</button>
        ))}
      </nav>
      <span className="top-note">{active.note}</span>
      <AccountBadge />
    </header>
    {/* A panel stays mounted once opened, so switching tabs keeps filters, the
      * loaded study list and the fetched atlas plate; the inactive one hides. */}
    <div role="tabpanel" id="panel-studies" aria-labelledby="tab-studies" hidden={shown !== "studies"}>
      <StudiesClient />
    </div>
    {volumes && <div role="tabpanel" id="panel-volumes" aria-labelledby="tab-volumes" hidden={shown !== "volumes"}>
      {volumesOpened && <VolumesClient />}
    </div>}
  </main>;
}
