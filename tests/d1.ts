import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

/* Real SQLite semantics matter here: changes(), foreign keys, and rollback
 * must behave like D1, including failures halfway through a batch. */
export class TestD1 {
  sqlite = new DatabaseSync(":memory:");
  statements: string[] = [];
  private failure: ((sql: string) => boolean) | null = null;
  private hook: { index: number; fn: (db: DatabaseSync) => void } | null = null;
  constructor(through = 4) {
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    for (const name of readdirSync("drizzle").filter((name) => /^\d.*\.sql$/.test(name)).sort()) {
      if (Number(name.slice(0, 4)) <= through) this.migrate(name);
    }
  }
  migrate(name: string) {
    for (const sql of readFileSync(`drizzle/${name}`, "utf8").split("--> statement-breakpoint")) if (sql.trim()) this.sqlite.exec(sql);
  }
  failOn(predicate: ((sql: string) => boolean) | null) { this.failure = predicate; }
  between(index: number, fn: (db: DatabaseSync) => void) { this.hook = { index, fn }; }
  prepare(sql: string) { return new Statement(this, sql); }
  execute(sql: string, values: SQLInputValue[], read: boolean) {
    this.statements.push(sql);
    if (this.failure?.(sql)) throw new Error("Injected D1 failure");
    const statement = this.sqlite.prepare(sql);
    if (read) return { results: statement.all(...values), success: true, meta: {} };
    const result = statement.run(...values);
    return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
  async batch(statements: Statement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement, index) => {
        const result = statement.execute(false);
        if (this.hook?.index === index) { const hook = this.hook; this.hook = null; hook.fn(this.sqlite); }
        return result;
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  get db() { return this as unknown as D1Database; }
  seed(state: unknown = {}, archived: number | null = null, key = "key", id = "glance-id") {
    this.sqlite.prepare("INSERT OR IGNORE INTO studies (id,account_id,title,slug,archived_at,created_at,updated_at) VALUES ('study','default','Study','study',?,1,1)").run(archived);
    this.sqlite.prepare("INSERT INTO glances (id,study_id,short_key,url_base,state,created_at,updated_at) VALUES (?,'study',?,'https://viewer.example',?,1,1)").run(id, key, JSON.stringify(state));
    return this;
  }
}
class Statement {
  constructor(private owner: TestD1, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.owner, this.sql, values); }
  execute(read: boolean) { return this.owner.execute(this.sql, this.values, read); }
  async first<T>() { return (this.execute(true).results[0] ?? null) as T | null; }
  async all<T>() { return this.execute(true) as unknown as { results: T[] }; }
  async run() { return this.execute(false); }
}
