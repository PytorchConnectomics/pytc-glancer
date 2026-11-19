import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/* A study belongs to one account. The column carries the pre-account default
 * so the 0003 migration backfills the existing studies without a data step of
 * its own. Slugs are unique per account:
 * two groups may each have a `pilot` study, and neither can learn of the
 * other's by watching a slug collide. */
export const studies = sqliteTable("studies", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().default("default"),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  archivedAt: integer("archived_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [uniqueIndex("idx_studies_account_slug").on(table.accountId, table.slug), index("idx_studies_account").on(table.accountId)]);

export const dataSources = sqliteTable("data_sources", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  kind: text("kind").notNull().default("gcs"),
  bucket: text("bucket").notNull(),
  prefix: text("prefix").notNull().default(""),
  ngauthBase: text("ngauth_base").notNull(),
  active: integer("active").notNull().default(1),
  updatedAt: integer("updated_at").notNull()
});

export const glances = sqliteTable("glances", {
  id: text("id").primaryKey(),
  studyId: text("study_id").notNull().references(() => studies.id),
  sourceId: text("source_id").references(() => dataSources.id),
  shortKey: text("short_key").notNull(),
  shortName: text("short_name"),
  title: text("title"),
  urlBase: text("url_base").notNull(),
  state: text("state").notNull(),
  sourcePath: text("source_path"),
  position: integer("position").notNull().default(0),
  archivedAt: integer("archived_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  uniqueIndex("idx_glances_short_key").on(table.shortKey),
  index("idx_glances_study_position").on(table.studyId, table.position)
]);

/* A glance's error report, uploaded to pytc_glancer rather than read from the
 * bucket: GCS carries the volumes and the GPU pipeline's outputs, while the
 * app owns reports, figures, and saved views. Kept in its own table so a
 * multi-hundred-KiB body never rides along with a glance state read. */
export const glanceReports = sqliteTable("glance_reports", {
  glanceId: text("glance_id").primaryKey().references(() => glances.id),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

/* A glance's review: the verdicts a reader produced in the proofread and
 * structure panels. Separate from glance_reports because the two have
 * different authors — re-uploading a regenerated report must not discard a
 * morning of judgements, and the overlay never rewrites the pipeline report. */
export const glanceReviews = sqliteTable("glance_reviews", {
  glanceId: text("glance_id").primaryKey().references(() => glances.id),
  body: text("body").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

/* Current rows answer ordinary reads; versions retain the state after each
 * operation. A two-kind correction or restore shares one operation id. */
export const glanceVersions = sqliteTable("glance_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  glanceId: text("glance_id").notNull().references(() => glances.id),
  operation: text("operation").notNull(),
  kind: text("kind").notNull(),
  source: text("source").notNull(),
  author: text("author").notNull(),
  present: integer("present").notNull(),
  body: text("body").notNull(),
  summary: text("summary"),
  restoredFrom: integer("restored_from"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  index("idx_glance_versions_glance_id").on(table.glanceId, table.id),
  index("idx_glance_versions_operation").on(table.glanceId, table.operation)
]);

/* A roadmap is a shared tldraw canvas owned by one account, addressed like a
 * study. `seq` counts its writes; `schema` is the tldraw schema of the browser
 * that wrote last, kept so a later tldraw can migrate the records on load. */
export const roadmaps = sqliteTable("roadmaps", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  seq: integer("seq").notNull().default(0),
  schema: text("schema"),
  /* The plan a project's repository pushed for this roadmap, and how many
   * times it has been replaced; open canvases redraw when the count moves. */
  plan: text("plan"),
  planRev: integer("plan_rev").notNull().default(0),
  archivedAt: integer("archived_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, (table) => [uniqueIndex("idx_roadmaps_account_slug").on(table.accountId, table.slug)]);

/* One row per tldraw record, so concurrent edits to different shapes do not
 * collide. A removed record stays as a tombstone (`deleted`) until every open
 * browser has heard of the removal. `client` names the browser session that
 * wrote the row, which is how a browser is not sent its own changes back. */
export const roadmapRecords = sqliteTable("roadmap_records", {
  roadmapId: text("roadmap_id").notNull().references(() => roadmaps.id),
  recordId: text("record_id").notNull(),
  kind: text("kind").notNull(),
  body: text("body").notNull(),
  seq: integer("seq").notNull(),
  deleted: integer("deleted").notNull().default(0),
  client: text("client").notNull()
}, (table) => [primaryKey({ columns: [table.roadmapId, table.recordId] }), index("idx_roadmap_records_seq").on(table.roadmapId, table.seq)]);
