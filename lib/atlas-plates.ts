/* Allen Reference Atlas plates vendored into public/atlas by scripts/build_atlas.py.
 *
 * The Volumes map draws real anatomy: each plate is a set of CCF structures with
 * their outline, their major division (used for the base fill) and, where one
 * applies, the catalog region the structure belongs to. Geometry is fetched on
 * demand so the Studies tab never pays for it. */

export interface PlateStructure {
  sid: number;
  acr: string;
  name: string;
  color: string;
  division: string | null;
  /** The catalog region this structure sits inside, when it sits inside one. */
  region: string | null;
  d: string;
  /** Centroid of the structure's largest ring, in plate units. */
  c: [number, number];
  a: number;
}

export interface Plate {
  id: string;
  label: string;
  note: string;
  orientation: "coronal" | "sagittal";
  section: number;
  atlasImageId: number;
  viewBox: [number, number, number, number];
  /** x of the cut edge. The P56 coronal atlas annotates one hemisphere, which
   * the map reflects about this line; null for the sagittal locator. */
  midline: number | null;
  attribution: string;
  structures: PlateStructure[];
}

export interface PlateSummary {
  id: string;
  label: string;
  note: string;
  orientation: "coronal" | "sagittal";
  section: number;
  file: string;
  regions: string[];
}

export interface AtlasManifest { attribution: string; source: string; plates: PlateSummary[] }

/** The viewBox a plate is drawn in, widened to include the mirrored hemisphere. */
export function fullViewBox(plate: Plate): [number, number, number, number] {
  const [x, y, width, height] = plate.viewBox;
  if (plate.midline === null) return [x, y, width, height];
  const half = x + width - plate.midline;
  return [plate.midline - half, y, half * 2, height];
}

/** Area-weighted centre of every structure belonging to `region` on this plate. */
export function regionCentre(plate: Plate, region: string): [number, number] | null {
  const parts = plate.structures.filter((structure) => structure.region === region);
  const weight = parts.reduce((total, structure) => total + structure.a, 0);
  if (!weight) return null;
  return [
    parts.reduce((total, structure) => total + structure.c[0] * structure.a, 0) / weight,
    parts.reduce((total, structure) => total + structure.c[1] * structure.a, 0) / weight,
  ];
}

const cache = new Map<string, Promise<Plate>>();

export function loadPlate(file: string): Promise<Plate> {
  const existing = cache.get(file);
  if (existing) return existing;
  const pending = fetch(file, { cache: "force-cache" }).then(async (response) => {
    if (!response.ok) throw new Error(`Could not load atlas plate (${response.status}).`);
    return await response.json() as Plate;
  });
  // A rejected fetch must not poison the cache, or the tab could never recover.
  pending.catch(() => cache.delete(file));
  cache.set(file, pending);
  return pending;
}
