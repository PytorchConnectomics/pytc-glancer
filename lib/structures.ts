/** The five structures both panels are about, declared once.
 *
 * Composition says how much of the foreground each one holds; quality control
 * judges whether its members are whole. Same five things, two jobs, and they
 * drifted apart once already -- one panel called a vessel `bv` while the other
 * called it `blood_vessel`, which no reader would notice and no code could
 * cross-reference. Declaring them here means the next category the pipeline
 * splits out is added in one place rather than two.
 *
 * The two labels differ on purpose. A composition row reports what the
 * pipeline's geometry suggests, so it hedges: `Axon-like`. A review category is
 * what the reader is asserting the object is, so it does not: `Axon`. Writing
 * both here keeps that distinction deliberate instead of accidental.
 */

export interface Structure {
  id: string;
  /** Composition panel: a share of foreground the pipeline measured. */
  composition: string;
  /** Quality control panel: what the reader judges the object to be. */
  review: string;
  /** Published `semantic_class` values that count toward this structure. */
  from: string[];
}

export const STRUCTURES: Structure[] = [
  { id: "blood_vessel", composition: "Blood vessel", review: "Blood vessel", from: ["blood_vessel", "vessel", "bv"] },
  // The pipeline publishes one `glia_or_soma` bucket covering glia and neurons
  // with a soma. Until it splits them, a neuron with a soma stays where the
  // pipeline put it; nothing here invents the distinction.
  { id: "glia", composition: "Glia-like (incl. soma)", review: "Glia", from: ["glia_or_soma", "glia", "glia_like"] },
  { id: "dendrite", composition: "Dendrite-like (incl. neuron with soma)", review: "Dendrite", from: ["dendrite", "dendrite_like", "neuron_with_soma"] },
  { id: "axon", composition: "Axon-like", review: "Axon", from: ["axon", "axon_like"] },
  { id: "unclassified", composition: "Unclassified", review: "Unclassified", from: ["unclassified"] }
];

/* Composition order is the order a false merge is assigned: an object that is
 * two things at once counts once, as the first it matches. Vessels and glia
 * sit at the top because a merge that touches one is that one. */
export const COMPOSITION_ORDER = ["blood_vessel", "glia", "dendrite", "axon", "unclassified"] as const;

/* Review order is the order the work is done: the two process types carry a
 * length screen and are judged first, and the rest share one sub-panel. */
export const REVIEW_ORDER = ["axon", "dendrite", "blood_vessel", "glia", "unclassified"] as const;

export function structure(id: string) {
  const found = STRUCTURES.find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown structure: ${id}`);
  return found;
}

export function inOrder(order: readonly string[]) { return order.map(structure); }
