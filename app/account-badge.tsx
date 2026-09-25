"use client";

import { useSession } from "./session";

/* Which account this browser is reading. Studies are per-account, so the
 * header has to say which workspace is on screen: two accounts may hold a
 * study of the same name, and the page alone would not tell them apart. */
export default function AccountBadge() {
  const session = useSession();

  if (!session) return null;
  return <span className="account-badge">
    <span className="account-name" title={`Signed in as ${session.id}`}>{session.label}</span>
    <a href="/__logout">Sign out</a>
  </span>;
}
