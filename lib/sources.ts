import type { AppConfig, SourceConfig } from "./config";

const synced = new WeakMap<object, string>();

export async function syncSources(db: D1Database, config: AppConfig, rawKey: string) {
  if (synced.get(db as object) === rawKey) return;
  const now = Date.now();
  const statements = [db.prepare("UPDATE data_sources SET active = 0, updated_at = ?").bind(now)];
  for (const source of config.sources) {
    statements.push(db.prepare(`INSERT INTO data_sources (id,label,kind,bucket,prefix,ngauth_base,active,updated_at)
      VALUES (?,?, 'gcs', ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, bucket=excluded.bucket, prefix=excluded.prefix, ngauth_base=excluded.ngauth_base, active=1, updated_at=excluded.updated_at`)
      .bind(source.id, source.label, source.bucket, source.prefix, source.ngauth_base, now));
  }
  await db.batch(statements);
  synced.set(db as object, rawKey);
}

export function resolveSourcePath(source: SourceConfig, submitted: string) {
  const path = submitted.trim();
  if (!path || path.length > 1024 || path.startsWith("/") || /[\u0000-\u001f\u007f]/.test(path)) throw new Error("path must be relative, non-empty, and at most 1024 characters");
  const parts = path.split("/");
  if (parts.includes("..") || parts.some((part) => !part)) throw new Error("path contains an empty or .. segment");
  const finalPath = [...(source.prefix ? source.prefix.split("/") : []), ...parts].join("/");
  if (source.prefix && finalPath !== source.prefix && !finalPath.startsWith(`${source.prefix}/`)) throw new Error("path escapes the configured prefix");
  return finalPath;
}
