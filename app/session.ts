"use client";

import { useEffect, useState } from "react";

/** The account this browser is reading, as `/api/session` reports it. */
export interface Session { id: string; label: string; }

/* Asked for at run time rather than rendered in, so signing in as another
 * account shows that account without a rebuild. `null` means the question has
 * not been answered yet -- either the request is in flight, or it failed --
 * so a caller that gates something on the account waits rather than guessing.
 * An open server with no accounts configured still answers, with the default
 * account, so `null` never means "no account". */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/session", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<Session> : null))
      .then((value) => { if (live) setSession(value); })
      .catch(() => { /* nothing is shown that depends on the account */ });
    return () => { live = false; };
  }, []);

  return session;
}
