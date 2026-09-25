# scripts

Operator scripts. Not part of the Worker build.

## Which account a script writes as

A study belongs to the account that created it, so every script here takes
`--account <id>` and signs in as it, reading that account's password from
`PYTC_GLANCER_ACCOUNTS` in the environment file. Without the flag they sign in
as the first configured account, which is the workspace they have always
written to. Naming the wrong account is not dangerous, only fruitless: another
account's study answers `404` by slug, and its glances answer `404` by short
key.

## add_glances.py

Bulk-adds glances to a study from OME-Zarr volumes in GCS. Discovers
`<name>.zarr` images under a bucket prefix, pairs each with its unique
`<name>_seg_*` precomputed segmentation, derives the viewer state from that
volume's own metadata, and posts it through the running app's API.

```sh
# preview
scripts/add_glances.py --prefix lab/project/exp99 --study project-exp99 \
    --match 'Exp99_*cerebellum*' --dry-run

# create
scripts/add_glances.py --prefix lab/project/exp99 --study project-exp99 \
    --match 'Exp99_*cerebellum*'

# one volume
scripts/add_glances.py --prefix lab/project/exp99 --study project-exp99 \
    --dataset Exp99_32x_1_cerebellum
```

`--prefix` is the experiment root. Images and segmentations sit in sibling
directories beneath it -- `<prefix>/image/<name>.zarr` and
`<prefix>/mip1_eb2/<name>_seg_*` -- which are the `--image-dir` and `--seg-dir`
defaults. Point `--seg-dir` at another variant to pair against it instead, or
set both to the same value (`--image-dir "" --seg-dir ""`) for a bucket that
keeps images and segmentations in one directory.

Requires `gcloud` authenticated with read access to the bucket, plus the app
running (`npm run serve`) and its password in
`~/.config/pytc_glancer/pytc_glancer.env`. Override with `--base` and
`--env-file`. `--bucket` and `--ngauth` (the broker origin that serves the
bucket) are required; they are omitted from the examples above. Run `--help`
for the full flag list.

### Why it derives state per volume

Sibling volumes in one study are not interchangeable. The Exp99 cerebellum
set mixes 12.5/5.078 nm and 22.22/9.028 nm voxels, and segmentation thresholds
are per-dataset (`mt0600`, `mt0650`, `mt0590`, `mt0585`) rather than a shared
suffix. Copying one glance's state onto a sibling produces a misscaled view or
a dead link, so scale, shape, and segmentation name are always read from the
bucket.

The script checks that each segmentation covers the same physical box as its
image and warns when it does not. Segmentations commonly sit at a coarser mip
than the image, so voxel counts differ legitimately; only extent must agree.

### Camera pose

`crossSectionScale` and `projectionScale` are in canonical voxel units, so a
saved camera transfers between volumes only when they share XY voxel counts.
The script copies the camera from the study's first existing glance when the
counts match and auto-fits when they do not. `--no-camera` always auto-fits.

### Notes

- Re-running is safe; volumes already in the study are skipped.
- Only zarr v2 (`.zattrs` / `.zarray`) is read. Volumes with no metadata --
  empty prefixes or interrupted uploads -- are reported and skipped, one line
  each, and the rest of the run proceeds.
- The app's own path-based creation needs `GCS_SA_KEY`; this script does not,
  because it builds state itself and uses the URL-import route.
- Shareable links printed when posting to `127.0.0.1` carry the loopback
  origin. The stored state is host-independent, and the app emits the public
  host when reached through the tunnel.

## add_precomputed_glances.py

Adds glances for Neuroglancer precomputed volumes that are already served over
public HTTPS, which `add_glances.py` does not cover: the image is someone
else's public volume on S3 and the segmentation computed from it sits in a
public GCS bucket of ours, so neither layer goes through `ngauth`.

```sh
# preview
scripts/add_precomputed_glances.py --study microct --account labb \
    --image-root s3://bossdb-open-data/mittone2026 --image-dir microct \
    --seg-root gs://example-bucket --seg-dir bvmask_hyst --dry-run

# create
scripts/add_precomputed_glances.py --study microct --account labb \
    --image-root s3://bossdb-open-data/mittone2026 --image-dir microct \
    --seg-root gs://example-bucket --seg-dir bvmask_hyst
```

Datasets are discovered under `--image-root` and paired by name: dataset `X`
takes its image from `<image-root>/X/<image-dir>` and its segmentation from
`<seg-root>/X/<seg-dir>`. The two roots are separate because the image and the
segmentation belong to different owners. A dataset whose segmentation is not
published yet still gets an image-only glance, reported as such, so the study
shows the volumes that exist rather than only the ones already analysed; re-run
after publishing one and `--dataset` that name to add the paired glance.

State comes from each volume's own `info`. The camera is always left to
Neuroglancer's auto-fit, unlike `add_glances.py`: the microCT set runs from a
2 mm cortical block to a whole hemisphere, so no saved pose transfers between
siblings. Image and segmentation extents are checked against each other for the
same reason as everywhere else -- a segmentation is often published at a
coarser mip, and only the physical box has to agree.

No credentials are needed: both buckets are read anonymously over their public
HTTPS endpoints, and the layer keeps the `s3://` or `gs://` URI, which
Neuroglancer resolves itself. The app must be running, and the account's
password readable in the environment file.

Re-running is safe; a dataset whose image volume is already in the study is
skipped.

## add_seg_layer.py

Puts a second segmentation variant on a glance, as another Neuroglancer layer
tab over the same image. The pipeline segments one volume more than once --
`mip1_eb2` and `mip1_eb8` are two such runs under `lab/project` -- and reading
one against the other means carrying both on one glance.

```sh
scripts/add_seg_layer.py --variant mip1_eb8 --glance <short_key> --dry-run
scripts/add_seg_layer.py --variant mip1_eb8 --glance <short_key>
scripts/add_seg_layer.py --variant mip1_eb8 --study project-exp96   # every glance in a study
```

The dataset comes from the glance's own image layer, and the variant directory
is looked for beside the directories the glance already points at, so there is
no prefix to keep in step by hand. Before writing, it checks the new
segmentation against the image's physical extent -- the same check
`relink_glances.py` makes, and for the same reason: a variant can be published
at a different mip.

The layer arrives unloaded, so links already shared open exactly as they did;
tick it in *Saved state -> What to load*, or in Neuroglancer's layer bar.
`--visible` adds it loaded instead. When the variant's directory has the same
name as the segmentation already on the glance, the new layer's name is
suffixed with the variant, because Neuroglancer needs distinct layer names.

Re-running is safe: a glance already carrying the variant is reported and
skipped.

Because the ids in an error report name objects in the segmentation the report
was computed on, the viewer drives only that layer when a class or segment is
selected; a sibling variant keeps whatever segments it was stored with.

## error_report.example.json

A complete example of the error report the glance viewer's analysis panel reads
from `<prefix>/<dataset>_nogt_eval/error_report.json` in the bucket. The schema,
and which fields are required, are documented in the repository README under
"The published error report". This file is a reference for whatever publishes
the report; nothing in the app reads it.

## push_report.py

Refreshes a glance's error report in pytc_glancer from what the bucket now
carries. The pipeline republishes its artifacts to GCS while pytc_glancer stores
reports in D1, so a republished analysis has to be pulled down and pushed in.

```sh
# see what would be pushed, fetch nothing into D1
scripts/push_report.py --glance <short_key> --dry-run

# fetch and push
scripts/push_report.py --glance <short_key>

# push a report you already have on disk
scripts/push_report.py --glance <short_key> --report /tmp/error_report.json
```

Bucket, prefix, and dataset come from the glance's own image layer -- the same
derivation the Worker uses -- so there is nothing to keep in step by hand. It
prefers a published `<dataset>_nogt_eval/error_report.json` and falls back to
reducing `<dataset>_nogt_eval/merge_correction/segments_detailed.json` through
`make_error_report.py`.

An `error_analysis.json` becomes a five-class semantic report: one class per
structure in `lib/structures.ts`, a record for every analysed segment, largest
first, with the pipeline's starting quality as an index into the report's
`qualities`. Each segment's semantic class is the pipeline's own
(`classify_semantic_candidate`): read from the analysis when it writes
`semantic_class` per segment, otherwise joined by id from the
`semantic_segmentation.json` it publishes beside the analysis. Nothing here
repeats the rule. `make_error_report.py --morphology` still produces the older
seven-class report. After pushing it reads the report back through the app,
so a stored-but-unreadable body cannot pass silently.

Needs `gcloud` authenticated for the bucket. A read that fails on credentials
says so and points at `gcloud auth login`.

## relink_glances.py

Repoints glance layers after a bucket reorganisation.

```sh
scripts/relink_glances.py --bucket my-bucket --search-root lab/project --prefer mip1_eb2 --dry-run   # preview
scripts/relink_glances.py --bucket my-bucket --search-root lab/project --prefer mip1_eb2             # apply
```

It matches each layer's dataset by directory leaf name anywhere under
`--search-root`, rather than rewriting a known prefix, so it survives a reorg
whose shape nobody predicted. `--prefer` breaks ties when one name appears
under several variant folders. Only `gs+ngauth+` layers in `--bucket` are
touched, so glances pointing at another bucket are left alone.

Before writing, it re-reads the new locations and checks that image and
segmentation still cover the same physical box, because a reorg can quietly
swap in a different mip level. Re-running is safe: layers already current are
reported and skipped.

A move from `clip_percentile_1_99/<dataset>` to
`<exp>/image/<dataset>.zarr` and `<exp>/mip1_eb2/<dataset>_seg_*`, and
needed no rules beyond `--prefer mip1_eb2`.

## sync_gcs.py

Checks the bucket for new image volumes and segmentations and brings the
studies up to date, keeping a local record of what it saw.

```sh
scripts/sync_gcs.py --dry-run                  # what has changed
scripts/sync_gcs.py                            # bring the studies up to date
scripts/sync_gcs.py --experiment exp107      # one experiment
scripts/sync_gcs.py --quiet                    # silent unless something changed
```

Each run also takes the required `--bucket`, `--root`, and `--ngauth`, omitted above.

Where the other scripts each do one job on a named target, this one walks
`gs://<bucket>/<root>`, reads it against every study, and closes the gap: an
experiment prefix with no study gets one (`--no-create-studies` to hold off),
an image and segmentation with no glance gets a glance, a segmentation variant
missing from a glance is added as an unloaded layer, an image whose
segmentation is not published yet is reported and picked up on a later run, and
a volume that has left the bucket is reported. It only ever adds: moves belong
to `relink_glances.py` and removals to a person, so an unattended run cannot
lose work, and because added layers arrive unloaded a link already shared opens
exactly as it did.

### Layouts

Experiments are not laid out alike and none of them is wrong. exp96 and
exp99 keep images under `image/` and segmentations under `mip1_eb2/` and its
siblings; exp108 adds one segmentation directly under the experiment prefix;
exp71 keeps every segmentation there. So the images directory is used where
it exists, the experiment prefix itself counts as a variant — printed as
`(root)` — and every other directory under it is a candidate variant.

Where one directory holds a segmentation and something derived from it, as
`..._seg_abiss_mt0600` and `..._seg_abiss_mt0600_nogt_adapted_strict` do, the
shorter name is that directory's segmentation and each longer one becomes a
variant of its own, keyed `mip1_eb2:nogt_adapted_strict`, so a glance carries
both as separate layers rather than one of them being called an ambiguity.
Names that merely collide are still reported and left alone.

`--prefer` names the variant a new glance's first segmentation comes from
(default `mip1_eb2`); the rest ride along unloaded unless `--no-extra-layers`.
A created study is titled from `--study-title`, `project {experiment}` by
default, which gives slugs such as `project-exp99`. Studies
are only created for experiments that have a glance to put in them.

### The record

`~/.config/pytc_glancer/gcs_sync.json` (`--record`, or `--no-record`) holds the
inventory the last run saw — first and last sighting, image and segmentation
paths, and which study and glance each dataset landed in — plus the last 50
runs. It is what lets a scheduled run say *what is new* instead of reprinting
the bucket, and `--quiet` then prints nothing at all on a quiet day, which is
what makes this worth running on a timer.

It is a record, not an authority. What the app holds is re-read from the app
every run, so deleting the record costs the history and duplicates nothing: the
next run re-learns the inventory and reports it all as new once.

Requires `gcloud` authenticated with read access to the bucket, plus the app
running and the account's password in the environment file, like its
neighbours.

`push_report.py` marks GCS refreshes as `ingest` in the glance's History panel.
With `--glance <key> --report <backup.json>`, it restores a hand-made report
backup as an ordinary `upload`: the report becomes current, its previous state
stays restorable, and the review is left as it was.


## Move baked corrections into human edits

Reports stay as ingested; human edits are applied on read and survive every
upload or ingest. `push_report.py` prints applied / agree / inactive edit counts
and verifies through `/report?raw=1`. Ordinary `/report` readers get the merged
view. The app's permanent status line lists inactive edits and supports removal;
**Use the pipeline's class** removes an edit, while Keep pins a class.

`unbake_corrections.py` is dry-run by default. Plan all glances, read the saved
JSON files and printed edits, then apply one glance while nobody is editing it:

```sh
python3 scripts/unbake_corrections.py --all
python3 scripts/unbake_corrections.py --glance KEY --apply PLAN_FILE
# Only after reviewing differences in an unclean plan:
python3 scripts/unbake_corrections.py --glance KEY --apply PLAN_FILE --accept
```

`--base`, `--account`, and `--env-file` select the app and account. A plan is bound
to that app, account and glance. `--plan-dir` changes the default local backup
folder. `--base-file PIPELINE.json` takes precedence for a single glance.
Otherwise the newest ingest/upload report version is compared by unpacked JSON
content with the current report version. Equal content means nothing to unbake;
an older pipeline is never selected in that case. A differing newest eligible
version is the base. Baseline, correct and restore versions are not bases.
With no eligible version, a fresh GCS fetch is **unverified**: changes in pipeline
classification since correction cannot be distinguished from human decisions.
Every derived edit and view difference is printed for inspection.

Planning changes no report or review; listing versions may cache baseline
summaries. The plan stores exact pipeline text, derivation time and deterministic
state/candidate tokens. The server validates both resources and atomically writes
them with two `source=ingest` version rows sharing an operation. Existing edits
win over derived ones. Every apply verifies the candidate token; `--accept`
additionally acknowledges visible differences. A changed glance requires a new
plan. History restores report and edits together; the preceding point is the
rollback. Legacy baked points can be migrated again after restoring them.

A transport failure can leave completion uncertain even though the database
operation is atomic. Check the History panel (or `GET …/versions`) for the ingest
point before retrying. If the first request committed, the same plan returns
409 `changed`. No compensating write is needed.
