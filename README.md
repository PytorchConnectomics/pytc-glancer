# pytc_glancer

pytc_glancer organizes named, permanent Neuroglancer views of OME-Zarr datasets into Studies. The app stores only Study metadata and Neuroglancer state JSON in Cloudflare D1. Image chunks never pass through pytc_glancer: Neuroglancer reads them directly from Google Cloud Storage through the configured `ngauth` broker.

The home page has two tabs. **Studies** is the workspace above; **Volumes** is a catalog of public volumetric datasets placed on the Allen Reference Atlas, described below, and is shown only to the account whose catalog it is.

## Accounts

Groups that share the deployment do not share Studies. Each account signs in with its own name and password, and sees only the Studies created under it: `default` is the workspace of a single-password or open deployment, and a further account such as `labb` starts from an empty workspace. The header names the account being read, and "Sign out" returns to the sign-in form.

Accounts are configured by the operator in `PYTC_GLANCER_ACCOUNTS` (below) and cannot be created from the app. A Glance's shareable `/ng/<short_key>` link stays readable by anyone holding the key, which is what makes it usable in the external viewer.

## Local setup

Requirements: Node.js 22.13 or newer, npm, and a local Cloudflare Workers runtime supplied by Wrangler.

```sh
npm install
npx drizzle-kit generate
npx wrangler d1 migrations apply pytc-glancer-local --local --config wrangler.jsonc --persist-to .wrangler/state
npm run build
npm run serve
```

The production-style server binds only `127.0.0.1` on port `3100` by default. Override it with `PORT`; override persistent local D1 state with `STATE_DIR`. Set `PYTC_GLANCER_ENV_FILE` to an absolute path when using a non-default Wrangler environment file:

```sh
PYTC_GLANCER_ENV_FILE="$PWD/.dev.vars" PORT=3100 npm run serve
```

Copy `.dev.vars.example` to the ignored `.dev.vars` file for local values. Its `PYTC_GLANCER_ACCOUNTS` entry shows the two-account shape; leave it out for an open local server. Never commit that file or a service-account key. Update the D1 `database_id` in `wrangler.jsonc` for the real deployment.

## Configuration

- `PYTC_GLANCER_ACCOUNTS`: JSON array of `{ "id", "label", "password" }`. Each account is a separate workspace: a Study belongs to the account that created it, and no other account can list, open, or change it. `id` matches `^[a-z0-9][a-z0-9_-]{0,62}$` and is what the sign-in form asks for; `label` is optional and defaults to the id. Unset or empty falls back to `PYTC_GLANCER_PASSWORD`.
- `PYTC_GLANCER_PASSWORD`: the single-password form, used only when `PYTC_GLANCER_ACCOUNTS` is unset. It signs in as the `default` account with a one-field login. When both are unset the app is open for local development and reads that same `default` workspace.
- A successful sign-in stores `<account-id>.<digest>` in an `HttpOnly`, `SameSite=Lax`, 30-day cookie, where the digest is SHA-256 of `pytc_glancer:<account-id>:<password>`. Changing one account's password invalidates that account's sessions and no others. `/__logout` clears the cookie.
- `PYTC_GLANCER_PUBLIC_STATE`: defaults to `true`; see Security below.
- `PYTC_GLANCER_SOURCES`: JSON array of `{ "id", "label", "bucket", "prefix", "ngauth_base" }`. Unset, empty, or `[]` enables paste-only mode. `path` values submitted in the app are relative to `prefix`.
- `PYTC_GLANCER_VIEWER_ORIGINS`: comma-separated HTTPS origin allowlist. It controls imported viewer URLs and `/ng/*` CORS. Default: `https://neuroglancer-demo.appspot.com`.
- `PYTC_GLANCER_DEFAULT_VIEWER_URL`: full viewer base used for path-created Glances. Its HTTPS origin must be allowlisted. Default: `https://neuroglancer-demo.appspot.com`.
- `GCS_SA_KEY`: service-account JSON used only for server-side OME-Zarr metadata reads. Set it as a Wrangler secret in deployment, for example `npx wrangler secret put GCS_SA_KEY`. Missing or invalid credentials leave URL import working and make path creation return `503 source_unavailable`.
- `PORT`: local loopback port, default `3100`.
- `STATE_DIR`: local Wrangler/D1 persistence directory, default `.wrangler/state`.
- `PYTC_GLANCER_ENV_FILE`: absolute path to a Wrangler environment file used by `npm run serve`.

Configured data-source rows are synchronized into D1. Sources absent from the current environment are marked inactive, never deleted, so historical Glances still retain their source references. Invalid source configuration prevents the Worker from starting and names the offending entry.

## The glance viewer

`/study/<slug>/glance/<short_key>` frames the configured Neuroglancer viewer in an iframe and puts a tool panel beside it, so a saved view can carry widgets that Neuroglancer itself has no place for. The panel opens with an icon rail, ordered as the work runs: glance details, the report's semantic classes with their proofreading, quality control of each structure, the glance's saved state, and the study's published figures.

The frame is pointed at the glance's state inline in the `#!` fragment rather than at its `/ng/<short_key>` URL. A fragment never reaches the viewer's server, so a long segment list costs nothing on the wire, and the panel can hand the viewer a modified state without touching the stored one. The stored state is never rewritten by the panel; a glance still resolves unchanged at `/ng/<short_key>` and through its shareable link.

Because the viewer is cross-origin, the panel cannot drive a running instance. Selecting a morphology class re-navigates the frame to a fresh state whose segmentation layer lists that class's segments. Clearing the selection returns the frame to the stored state.

## How a report reaches a panel

Three stages, each owned by a different system, which is why a number in the panel can always be traced back to the run that produced it.

**1 — Compute.** The segmentation-evaluation pipeline (`pytc.nogt`) measures the segmentation and writes `error_analysis.json` beside it, carrying per-segment records under `segment.profile`; older runs wrote the larger `merge_correction/segments_detailed.json` catalog instead. pytc_glancer computes none of this and never runs on the GPU host.

**2 — Publish.** The pipeline uploads its artifacts to the same GCS bucket the volumes live in, which must belong to a configured `PYTC_GLANCER_SOURCES` entry. Three objects matter, in the order `push_report.py` prefers them:

| Object | Where |
| --- | --- |
| `error_report.json` | `<prefix>/<dataset>_nogt_eval/` — the panel's own format, pushed as-is |
| `error_analysis.json` | beside the segmentation layer — the pipeline's current output, reduced to the five semantic classes; each segment's class is read from the analysis when it carries `semantic_class`, otherwise joined by id from `semantic_segmentation.json` in the same directory |
| `merge_correction/segments_detailed.json` | `<prefix>/<dataset>_nogt_eval/` — the older catalog, reduced the same way |

Figures a report names are read from the `_nogt_eval` directory and stay in the bucket; only the JSON is ingested.

**3 — Ingest.** `scripts/push_report.py --glance <short_key>` pulls whichever of those the bucket now carries, reduces it to the panel's schema through `scripts/make_error_report.py` when it is a raw analysis or catalog, and `PUT`s the result to `/api/glances/<short_key>/report`. The Worker validates it against the report schema before storing it, so a malformed upload fails once, at ingest, rather than on every read. The stored body lands in D1 as `glance_reports.body`, keyed to the glance and gzipped (a `gz:` prefix, then base64), because a report of every analysed segment runs to a few MiB of JSON and a D1 row holds 2 MB; uploads may be up to 16 MiB of JSON. The script names the report's `segmentation` after the layer directory the analysis came from, so the viewer drives that layer on a glance carrying two variants, and it reads the report back through the app afterwards so a stored-but-unreadable body cannot pass silently. The panel's own **Upload report** button is the same `PUT` with a file picker in front of it, for a report already on disk.

```
GPU pipeline              GCS bucket                            pytc_glancer (D1)
error_analysis.json  -->  beside the segmentation  ------------> glance_reports.body
  (pytc.nogt)             <dataset>_nogt_eval/ (+ figures)       (validated on write)
                                              push_report.py
```

Bucket, prefix, and dataset are all derived from the glance's own image layer — the same derivation the Worker uses — so nothing about the path is configured twice. Re-ingesting is how a republished analysis reaches the app: the pipeline rewriting the bucket does not change what a glance loads until a report is pushed in.

Ingest is a pull, not a subscription. Nothing watches the bucket, so a glance keeps serving the report it was last given until someone runs the script.

A glance with no stored report still falls back to reading `error_report.json` straight from the bucket at request time, which is what the next section describes; ingest exists because that fallback needs the pipeline to publish the panel's own format, and because a stored report is what proofreading corrects.

What a reader then decides about an ingested report does not travel back up this chain: human edits land in a separate D1 row and are merged on read; the stored pipeline report and bucket are never rewritten by proofreading. See Where a review is stored.

## The published error report

The error analysis panel reads numbers that the segmentation-evaluation pipeline publishes to the cloud; pytc_glancer computes nothing itself. For a glance whose image layer is `gs://<bucket>/<prefix>/<dataset>.zarr`, the report is expected at:

```
gs://<bucket>/<prefix>/<dataset>_nogt_eval/error_report.json
```

The Worker reads it through `GET /api/glances/<short_key>/report` with the same get-only `GCS_SA_KEY` credential the OME-Zarr metadata reads use, and answers `404 report_unavailable` when no report is published. When no key is configured the read falls back to an anonymous one, so a deployment may publish reports openly instead of holding a credential; see Published reports without a key below. `GET /api/glances/<short_key>/report/figures/<index>` streams a figure the report names, capped at 8 MiB and typed from the report's own extension allowlist rather than the object's stored `Content-Type`.

The bucket must belong to a configured `PYTC_GLANCER_SOURCES` entry. Glances imported from a pasted viewer URL can name any bucket, so without that check the report route would turn the service-account credential into a general fetcher.

`scripts/error_report.example.json` is a complete example. Only `classes[].label` and `classes[].voxels` are required; everything else is optional:

| Field | Meaning |
| --- | --- |
| `version` | `1` when present |
| `dataset`, `generated_at`, `segmentation` | provenance shown above the chart |
| `voxel_volume_um3`, `total_voxels`, `notes` | headline context; `total_voxels` defaults to the sum of the classes |
| `classes[].id` | stable key; defaults to the position, must be unique |
| `classes[].label`, `.voxels` | **required** — the pie's identity and magnitude |
| `classes[].volume_um3`, `.labels`, `.note` | shown in the table and on selection |
| `classes[].segment_ids` | segments loaded into the viewer when the class is selected; decimal strings or safe integers, at most 20,000 |
| `figures[].path` | relative to the `_nogt_eval` directory, `.png`/`.jpg`/`.jpeg`/`.webp`/`.svg`, no `..` segment |
| `figures[].label`, `.caption` | shown under the image |
| `classes[].segments[]` | reviewable members: `id` (required), `voxels`, `volume_um3`, `centroid_um` as `[z, y, x]` µm, `radius_um`, `length_um`, `margin`, and `quality`, the pipeline's starting call (`complete`, `false_split`, `false_merge`, `unknown`, or an index into the report's top-level `qualities` list, which names each code once); at most 200,000 per class. Present records supersede `segment_ids`, which older reports still carry on their own |
| `classes[].margin_label` | what `margin` measures, shown when ordering by it |
| `axons[].id` | **required** per record — the segment the measurements describe |
| `axons[].length_um`, `.radius_um`, `.axis`, `.class`, `.continuity` | per-axon measurements; `axis` is `z`, `y`, or `x`; at most 20,000 records. Validated and stored, but no panel reads them since quality control took over the axon panel |

The chart draws one slice per class in report order, so a class keeps its colour whatever its size. Past eight classes the tail folds into a single neutral `Other` slice rather than inventing a ninth hue. Every slice is also a legend row, so identity never rests on colour alone. A class holding no voxels is not drawn, and is named beneath the legend instead: blood vessel and glia stay empty until the pipeline assesses them, and zero there is not a measurement. Colours are assigned before empty classes are dropped, so a class keeps its colour either way.

The **Semantic classes** panel puts this chart above the proofreading stepper: selecting a class there chooses which class the stepper walks, and **Show N in the viewer** loads the class's segments into the framed viewer as its own action, so the stepper's one-segment view does not immediately replace it. **Segments shown** is editable: a class can carry hundreds of ids and Neuroglancer draws every one, so the count is the reader's dial rather than a fixed cap. Lowering it reloads the frame with that many, largest-first in the order the report lists them.

## Proofreading a class

The proofread panel steps through one class's members one segment at a time. Loading a whole class at once is the wrong shape for review — you then have to hunt for each member — so the panel loads exactly one segment and moves the viewer's `position` to its centroid. A centroid arrives in microns and Neuroglancer counts voxels of the glance state's own dimensions, so the conversion happens in the client, where the voxel size lives.

Three orderings. **Closest to the cutoff** sorts by `margin`, the segment's distance to the boundary of the screen that admitted it: for the dendrite-like class that is radius above the 0.35 µm axon cutoff, so the members most likely to be thick axons filed as dendrites come first. Five borderline segments say more about a class than seventeen arbitrary ones. **Largest first** sorts by voxel count, for the segments a mistake costs the most on. **Report order** leaves the list alone. Segments with no `margin` sink to the end rather than sorting as though they sat on the boundary.

`margin` is computed upstream, in `scripts/make_error_report.py`, against each screen's published thresholds — the axon cutoffs of 0.35 µm radius and 3.00 elongation, and the fragment screen's own bounds. The panel only sorts by it, so no threshold is duplicated in the app, and a class with no defensible single boundary reports `margin: null` and falls back to report order.

The stepper offers **Keep**, **Reject**, and **Reassign**. Keep pins the effective class even if a later pipeline report changes it. Reject removes the segment immediately from classes and totals; the **Rejected (N)** class list keeps it reachable for undo. Reassign focuses the class selector without recording an unfinished edit. Choose a target to move the segment immediately. The option marked **(pipeline)** removes its edit; **Use the pipeline's class** does the same for any existing edit. Edits show their time, and a drifted Keep pin explains what the pipeline now says. Keyboard: `←`/`→` to step, `K` to keep, `R` to reject, `A` to focus the selector. With **Show at a time** above one, operations apply to the loaded page. Each decision is saved as it is made.

**Change the class of many** takes a pasted list — bare ids separated by spaces, commas, or newlines, or a Neuroglancer link or `{}` state, whose switched-on segments are the list — and a target class, and writes a reassignment for each, exactly as choosing them one at a time would. It says how many moved, how many were already there, and which ids the report does not describe, which it leaves alone. The quality control tab's per-segment and per-group moves go through the same helper, `reassignIds` in `corrections.ts`, so there is one way a move is recorded.

The shared overlay in `lib/edits.ts` merges pipeline classes with human decisions for both panels, the pie, and API readers. Moves carry voxels, volume, and label counts; rejections also lower total voxels. Missing voxel counts are reported as approximate. There is no apply step and edits remain undoable. The permanent status line reports applied edits, edits the pipeline now agrees with, and inactive edits. All inactive edits are listed with reasons and a Remove action, 50 at a time.

`GET /api/glances/<short_key>/report` returns the merged view by default; `?raw=1` returns the parsed pipeline report without the overlay. The client fetches raw and merges once. Ingest and upload replace only the pipeline report and create a history version; the review remains untouched. Missing segment ids and missing target classes keep their edits inactive. Segmentation remapping is outside this model.

A class that listed only `segment_ids` gains records for them before anything is added, because records supersede bare ids when a report is read back — without that step, reassigning into such a class would drop the ids it already held.

## Quality control

The quality panel asks whether each structure's segments are whole. It has three sub-tabs — **Axon**, **Dendrite**, and **BV · Glia · Unclassified**, the last switching between blood vessel, glia, and unclassified — and every segment has one of four qualities: **complete**, **false split**, **false merge**, or **unknown**. The two failure modes are kept apart rather than folded into one "incomplete" because they call for opposite repairs: a false split is this object cut short, with the rest of it living under other ids, while a false merge is two objects wearing one id. A segment starts from the `quality` its report record carries. `make_error_report.py` takes it from the pipeline catalog's end check when present — complete when every skeleton end is at the volume border, a surface spur, or an axon terminal (so a branched axon can be complete), a false split when an end site lies inside the volume — and otherwise from the axon screen: good is complete, broken a false split, anything else unknown. A report whose records carry no quality falls back to reading the same call off the class name. Nothing upstream screens for merges at all, so **false merge is only ever the reader's call** — a `good_axon_candidate` has never been checked for one. The reader's call overrides the pipeline's. Keyboard: `←`/`→` to step, `C`/`S`/`M`/`U` to set the quality; pressing the reader's own call again returns the segment to the pipeline's. These structures are the app's own vocabulary, declared once in `lib/structures.ts`, and they are the report's five semantic classes by id; only the reviewing hints are local to `cell-panel.tsx`.

The axon and dendrite tabs draw a histogram of skeleton length (`length_um`); a vessel or glial cell has no length that says whether it is whole, so the third tab has none. Bins are nice-width, sized from the 98th percentile so one long outlier cannot squeeze every segment into the first bar, and empty bins are trimmed off both ends; interior empties stay, because a gap in the distribution is a fact about it. Every tab draws a pie of the four qualities, sized by volume like the semantic pie rather than by segment count -- counting would let a thousand crumbs outweigh the one merged object that actually costs the reconstruction. Both pies label a slice the same way, share of volume with the segment count beside it: `15% (2,300)`. A glance whose report carries no voxel counts falls back to counting segments, since a pie of zeros shows nothing. Clicking a bar steps through that length range only, clicking a slice through that quality only — to look again at everything still split, say — and the pie counts the chosen bin, so the two read together. Under a quality filter, a changed call takes the segment out of the list and the next one slides into place. The stepper orders **largest first** by default, or longest first, closest to the cutoff, or in report order.

Whatever the filters leave is walked by the same **Show at a time** dial as the semantic panel. At 1 it shows a single segment, centred. Above 1 it loads that many into the viewer at once — any size up to 1000 — with **← Previous group** and **Next group →** walking the rest; the header says which segments the group covers and which group it is of how many. A group has no single centre, since its members are scattered and their mean is nowhere in particular, so the frame keeps the glance's own position rather than jumping somewhere arbitrary. In group mode a quality call applies to the whole loaded group and the buttons say so ("All 100 false split"); pressing a call the whole group already holds returns them all to the pipeline's, and `←`/`→` change group rather than step. The ceiling of 1000 is well under the report schema's per-class cap because Neuroglancer draws every segment it is given.

**Change many**, below the stepper, takes a pasted list the way the semantic panel's does — bare ids, or a Neuroglancer link or `{}` state, whose switched-on segments are the list — and offers two independent actions. **Move to** a semantic class writes the same reassignments as the semantic panel, through the same `reassignIds`. **Set quality** sets one call on every listed segment, each filed under the class it now sits in, after any move; an id the report does not describe is set only if it was added to the current structure by hand. Each says what it did and which ids it left alone, and neither reloads the viewer, so the reader can keep picking segments there.

A structure's members are its effective semantic class plus hand-added ids. Rejection hides even a hand-added member until undone, without deleting the hand-added record. Quality calls follow the effective class on read: a call stored there wins, otherwise the latest call for that id from another category is used. Setting a call stores it in the effective category and clears duplicates; clearing it removes the id from every category so a fallback cannot resurface. Hand-added ids remain reviewable without a report.

## Where a review is stored

Verdicts are the reader's, not the pipeline's, so they live in their own `glance_reviews` row rather than inside the report: re-uploading a regenerated report leaves them standing. Reports are never baked with these decisions.

```
GET  /api/glances/<short_key>/review    # the record, or an empty one for an unreviewed glance
PUT  /api/glances/<short_key>/review    # the whole record, validated and normalised before storage
```

The body holds `class_review` (an absolute class pin, rejection, or reassignment target per segment, plus timestamp), `cell_review` (a quality per segment — `complete`, `false_split`, `false_merge`, or `unknown` — stored by structure and resolved across classes on read; a segment with no entry takes the pipeline's quality), and `cell_members` (each category's chosen classes and hand-added ids). Segment ids are normalised to unsigned decimal strings on the way in, a record that says nothing deletes its row rather than storing an empty one, and the body is capped at 512 KiB. Each verdict is one `PUT` of the whole record; the page chains those writes, so two quick keystrokes cannot land out of order.

Three things are therefore stored in three different places: the glance's own state — its name and which layers load — in `glances.state`, its report in `glance_reports.body`, and its review in `glance_reviews.body`. All three are D1 rows keyed to the glance, so every link to it opens with them.

### History and rollback

The glance's **History** panel lists timed restore points for reports and
proofreading, newest first. Select a point to see the report class counts and
review counts it will restore, then choose **Roll back**. A rollback records a
new operation, so selecting the point before it undoes it. The migration seeds
each existing glance's current report and review, including their absence, as
its starting point. Saved Neuroglancer state and layer edits are not versioned.

Report uploads, GCS ingests, empty reviews, and restores each keep
a separate point. Ordinary non-empty proofreading writes by the same account
within ten minutes keep only the last state in that window, provided no other
operation or author intervenes. Earlier clicks inside that window cannot be
recovered individually. History is otherwise retained without pruning; packed
report copies will increase local storage use.

Upload and rollback wait for queued writes and refresh both the report and
review. If refreshing fails, editing stays disabled until **Reload** succeeds.
Reload any other open tab of the glance after rolling back: another tab can
still submit its old review. Old report segment ids are not remapped or checked
against changed segmentation layers, so check the saved layers before restoring
an older report.

To recover a hand-made report backup, use
`scripts/push_report.py --glance <key> --report <backup.json>`; this records an
ordinary upload, changes the current report, and keeps the preceding state in
history. History is scoped to the signed-in account, which is also the author
shown in the panel.

## GCS metadata credential

Create a dedicated service account, ideally in a different GCP project from the existing `ngauth` service. Grant it a custom IAM role containing only `storage.objects.get` on the required bucket. Do not grant `roles/storage.objectViewer`, because that also grants bucket listing, and do not reuse the App Engine service account used by `ngauth`.

The same credential backs the error-report panel; without it the panel falls back to an anonymous read, so it works only for reports that are published openly. Store the JSON key in `GCS_SA_KEY` as a Wrangler secret. Rotate the key on an operator-defined schedule and immediately after suspected exposure. A future deployment should prefer Workload Identity Federation so the Worker does not hold a long-lived private key.

The Worker mints short-lived OAuth tokens with an RS256 service-account JWT. Its Zarr store accepts only `zarr.json`, `.zattrs`, `.zgroup`, and `.zarray`, caps each response at 1 MiB, and refuses chunk keys before making a request.

## Published reports without a key

Some organisations enforce `constraints/iam.disableServiceAccountKeyCreation`, which makes `GCS_SA_KEY` impossible to mint. Reports can then be published openly instead: the report route reads anonymously whenever no key is configured.

Uniform bucket-level access rules out per-object ACLs, so scope the exposure with a managed folder over the one report directory rather than opening the bucket:

```sh
FOLDER=gs://<bucket>/<prefix>/<dataset>_nogt_eval/
gcloud storage managed-folders create "$FOLDER"
gcloud storage managed-folders add-iam-policy-binding "$FOLDER" \
  --member=allUsers --role=roles/storage.legacyObjectReader
```

`roles/storage.legacyObjectReader` is `storage.objects.get` alone, so the folder's contents stay unlistable; the app names every object it reads. Repeat per dataset, since managed folders take no wildcard. Image chunks are unaffected and still require `ngauth`.

This publishes the report JSON, its figures, and anything else under that directory to anyone who knows the path. Use it only where the evaluation output is not sensitive. A private object read anonymously answers `502` naming the missing access rather than `404`, which distinguishes "not published" from "not readable".

## Security

1. `/ng/<short_key>` is public by default when `PYTC_GLANCER_PUBLIC_STATE=true`. This exception is required because the external Neuroglancer viewer fetches state cross-site without the `SameSite=Lax` login cookie. Set it to `false` for a strictly closed origin, understanding that Glances will then work only in a viewer served from the same origin and not in the external demo viewer.
2. Public state URLs are protected by unguessable 160-bit keys. A leaked state exposes dataset paths and view parameters, not pixels; reading GCS data still requires the visitor to authenticate through `ngauth`.
3. Every other route, including `/api/*` and static assets, is covered by the sign-in gate when any account is configured.
4. Studies are scoped to the signed-in account in the query itself, not merely in the listing: another account's Study answers `404` by slug and by id, and its Glances, reports, and reviews answer `404` by short key. Sharing a Glance across accounts is deliberately not possible; `/ng/<short_key>` stays a capability held by whoever has the key, as in points 1 and 2. The sign-in form neither lists accounts nor distinguishes a wrong account name from a wrong password.
5. An account is a group credential, not a person: there is no attribution within an account, and an operator holding the environment file can read every account.
6. Published reports and their figures are read server-side with the same get-only credential, only from buckets named by a configured source, and only under the volume's own `_nogt_eval` directory. Figures are served with `nosniff` and a `default-src 'none'` CSP, so a scripted SVG would stay inert.
7. OME-Zarr metadata is fetched server-side with the get-only credential. Pixel chunks are fetched directly by the browser through `zarr://gs+ngauth+…`; pytc_glancer never proxies, mounts, or caches them.
8. The existing `ngauth` `allowed_origins.txt` is not widened for pytc_glancer. Bucket browsing and `storage.objects.list` remain intentionally out of scope.
9. Archiving changes listings only. There are no delete endpoints, short keys are never reused, and archived Glances continue to resolve at `/ng/<short_key>`.

## Cloudflare tunnel

Keep the application bound to loopback and point a named Cloudflare Tunnel at it. A minimal origin target is:

```yaml
ingress:
  - hostname: pytc-glancer.example.org
    service: http://127.0.0.1:3100
  - service: http_status:404
```

Run the app under the host's service manager, then run `cloudflared tunnel run <tunnel-name>`. TLS terminates at Cloudflare; the loopback-only Worker origin is never directly exposed. Set all production variables and secrets in the Worker/tunnel operator environment, not in this repository.

### Running it as a service

Keep the D1 state directory (`STATE_DIR`) outside the checkout so rebuilding or cleaning the working tree never discards Studies and Glances, and keep the environment file (`PYTC_GLANCER_ENV_FILE`) at mode 600 outside the repository. workerd can abort when its V8 heap fills while the parent npm process stays alive, so a supervisor that only watches the main PID will not restart it; an HTTP health probe that restarts the service when the port stops answering covers that case. Any HTTP status counts as healthy, because an unauthenticated request correctly gets a 401.

When creating the DNS record, pass the tunnel's own configuration file:

```sh
cloudflared --config ~/.cloudflared/pytc_glancer.yml tunnel route dns <tunnel-name> pytc-glancer.example.org
```

Without `--config`, `cloudflared` resolves the tunnel from the default `~/.cloudflared/config.yml` and silently points the CNAME at whatever tunnel that file names, ignoring the tunnel argument. Add `--overwrite-dns` to correct a record that was created that way.

After changing the checkout, rebuild with `npm run build` and restart the service. New migrations apply against the persistent state directory:

```sh
npx wrangler d1 migrations apply pytc-glancer-local --local --config wrangler.jsonc --persist-to "$STATE_DIR"
```

## The Volumes tab

`Volumes` is an inventory of public volumetric mouse-brain datasets. It is a reading surface only: the records live in `lib/atlas-data.ts`, nothing about them is written to D1, and the "Launch Neuroglancer" button frames a fixed public viewer with a state taken from the record. A Volumes dataset is not a glance and carries no `ngauth` credential.

The tab lives in the URL fragment (`/#volumes`), so a view is linkable and survives reload without the server needing to know which tab is open. Its component tree is not mounted, and no atlas geometry is fetched, until the tab is first opened.

The catalog is one hand-written list, describing the volumes the `default` account reads, so only that account is offered the tab; `VOLUMES_ACCOUNTS` in `app/home-client.tsx` says which, and an account joins it once its volumes are described. An account without entries would otherwise open a tab that is wrong about its data rather than merely empty, and `/#volumes` from such an account opens Studies instead. The page asks `/api/session` which account it is reading, and withholds the tab until the answer arrives rather than showing one that then disappears.

### Atlas plates

The map draws real anatomy from the Allen Reference Atlas rather than a schematic. `scripts/build_atlas.py` downloads annotated plate geometry from the Allen Brain Atlas API, simplifies it, and writes `public/atlas/`. Run it only when the plate selection changes; the app makes no runtime call to brain-map.org.

```sh
python3 scripts/build_atlas.py
```

Plates come from `atlas=1` ("Mouse, P56, Coronal") in preference to `atlas=602630314` ("Mouse, Adult, 3D Coronal"). The P56 atlas draws bezier outlines at ~113 KB per plate and resolves the ontology down to cortical layers, hippocampal strata (`CA1so/sp/sr/slm`) and barrel cortex (`SSp-bfd`). The CCFv3-registered 3D atlas is 6.2 MB per plate — 574k polyline vertices — and resolves less structure at the levels this map uses.

No single coronal plate contains every region the catalog files datasets under; the regions occupy disjoint anterior-posterior bands. Three plates cover all eight, and a midline sagittal plate serves as a whole-brain locator:

| plate | regions |
|-------|---------|
| Coronal §250 | striatum, somatosensory, amygdala, hippocampus, thalamus |
| Coronal §326 | visual, amygdala, hippocampus, thalamus |
| Coronal §409 | cerebellum, auditory (cochlear nuclei), visual, hippocampus |
| Sagittal §145 | whole-brain locator, all twelve divisions |

Selecting a region moves the map to a plate that contains it; choosing a plate by hand pins it until the region changes. The P56 coronal atlas annotates one hemisphere, so the map reflects it about the midline to read as a whole section. Retina and whole-brain records have no single CCF structure and are marked as undrawable rather than silently omitted.

Structure outlines are from the Allen Reference Atlas — Mouse Brain, Allen Institute for Brain Science, available from `atlas.brain-map.org` and used under the Allen Institute Terms of Use. Attribution is carried in `public/atlas/manifest.json` and shown beneath the map.

## License provenance

`lib/omezarr/omezarr-helper.ts` is derived from Fileglancer code copyright © 2025 Howard Hughes Medical Institute and used under BSD-3-Clause. See `NOTICE` for the retained license text and disclaimer. No institutional name is used to endorse pytc_glancer.


### Moving old baked corrections into edits

Use `scripts/unbake_corrections.py --all` to plan, then read each saved plan and
apply individually with `--glance KEY --apply PLAN_FILE`. See `scripts/README.md`
for base provenance and acceptance. Migration uses one atomic endpoint and one
paired `ingest` history point. History rollback always restores report and edits
together. Old `correct` entries retain their label; old points with unapplied
rejections now hide those segments. A restored baked report remains baked until
migrated again, and a later ingest replaces it.
