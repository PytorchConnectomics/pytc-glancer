import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ACTOR, type Actor } from "../lib/accounts";
import { handleApi } from "../lib/api";
import { parseConfig } from "../lib/config";

interface StudyRecord {
  id: string;
  account_id: string;
  title: string;
  slug: string;
  description: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

class StudyDb {
  studies: StudyRecord[] = [];

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (sql.startsWith("INSERT INTO studies")) {
            const [id, accountId, title, slug, description, createdAt, updatedAt] = values as [string, string, string, string, string | null, number, number];
            // Slugs collide only within an account, matching idx_studies_account_slug.
            if (this.studies.some((study) => study.account_id === accountId && study.slug === slug)) throw new Error("UNIQUE constraint failed: studies.account_id, studies.slug");
            this.studies.push({ id, account_id: accountId, title, slug, description, archived_at: null, created_at: createdAt, updated_at: updatedAt });
            return { success: true };
          }
          if (sql.startsWith("UPDATE studies")) {
            const [title, description, archivedAt, updatedAt, id] = values as [string, string | null, number | null, number, string];
            const study = this.studies.find((candidate) => candidate.id === id)!;
            Object.assign(study, { title, description, archived_at: archivedAt, updated_at: updatedAt });
            return { success: true };
          }
          throw new Error(`Unexpected run query: ${sql}`);
        },
        first: async () => {
          if (sql === "SELECT * FROM studies WHERE account_id = ? AND (id = ? OR slug = ?)") {
            return this.studies.find((study) => study.account_id === values[0] && (study.id === values[1] || study.slug === values[2])) ?? null;
          }
          throw new Error(`Unexpected first query: ${sql}`);
        },
        all: async () => {
          if (sql.startsWith("SELECT * FROM glances WHERE study_id = ?")) return { results: [] };
          if (sql.includes("FROM studies s WHERE s.account_id = ?")) {
            const archived = !sql.includes("s.archived_at IS NULL");
            return { results: this.studies.filter((study) => study.account_id === values[0] && (archived || study.archived_at === null)).map((study) => ({ ...study, glance_count: 0 })) };
          }
          throw new Error(`Unexpected all query: ${sql}`);
        }
      })
    };
  }
}

async function api(db: StudyDb, path: string, method = "GET", body?: object, actor: Actor = DEFAULT_ACTOR) {
  return handleApi(new Request(`https://mind.example${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  }), db as unknown as D1Database, parseConfig({}), actor);
}

test("study descriptions round-trip at 2000 characters and reject 2001", async () => {
  const db = new StudyDb();
  const accepted = "a".repeat(2000);
  const created = await api(db, "/api/studies", "POST", { title: "Description boundary", description: accepted });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as StudyRecord;
  assert.equal(createdBody.description, accepted);

  const read = await api(db, `/api/studies/${createdBody.slug}`);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as StudyRecord).description, accepted);

  const patched = await api(db, `/api/studies/${createdBody.slug}`, "PATCH", { description: accepted });
  assert.equal(patched.status, 200);
  assert.equal(((await patched.json()) as StudyRecord).description, accepted);

  const rejected = await api(db, `/api/studies/${createdBody.id}`, "PATCH", { description: "b".repeat(2001) });
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), { error: "invalid_request", detail: "description must be at most 2000 characters." });
});

test("a study belongs to one account and is invisible to the others", async () => {
  const db = new StudyDb();
  const other: Actor = { id: "labb", label: "Lab B" };

  const mine = await api(db, "/api/studies", "POST", { title: "Pilot" });
  const record = await mine.json() as StudyRecord & { slug: string };
  assert.equal(record.account_id, DEFAULT_ACTOR.id);

  // The same title in another account takes the same slug, without collision.
  const theirs = await api(db, "/api/studies", "POST", { title: "Pilot" }, other);
  const theirRecord = await theirs.json() as StudyRecord & { slug: string };
  assert.equal(theirs.status, 201);
  assert.equal(theirRecord.slug, record.slug);
  assert.equal(theirRecord.account_id, "labb");

  // A slug resolves within the account that asked, and nowhere else.
  assert.equal(((await (await api(db, `/api/studies/${record.slug}`)).json()) as StudyRecord).id, record.id);
  assert.equal(((await (await api(db, `/api/studies/${record.slug}`, "GET", undefined, other)).json()) as StudyRecord).id, theirRecord.id);

  // An id from another account is not found, and cannot be written either.
  assert.equal((await api(db, `/api/studies/${record.id}`, "GET", undefined, other)).status, 404);
  assert.equal((await api(db, `/api/studies/${record.id}`, "PATCH", { title: "Taken" }, other)).status, 404);

  const listed = await (await api(db, "/api/studies", "GET", undefined, other)).json() as StudyRecord[];
  assert.deepEqual(listed.map((study) => study.id), [theirRecord.id]);
});

test("the session route names the account the request acts as", async () => {
  const db = new StudyDb();
  const response = await api(db, "/api/session", "GET", undefined, { id: "labb", label: "Lab B" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "labb", label: "Lab B" });
});
