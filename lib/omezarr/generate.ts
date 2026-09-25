import type { Readable } from "zarrita";
import { determineLayerType, generateNeuroglancerStateForOmeZarr, getOmeZarrMetadata } from "./omezarr-helper";

export async function generateStateFromStore(layerSource: string, store: Readable) {
  const metadata = await getOmeZarrMetadata(layerSource, store);
  const multiscale = metadata.multiscales?.[0];
  if (!multiscale) throw new Error("OME-Zarr multiscales metadata is required.");
  const layerType = metadata.isLabel ? "segmentation" : await determineLayerType(true, null);
  const encoded = generateNeuroglancerStateForOmeZarr(layerSource, metadata.zarrVersion, layerType, multiscale, metadata.arr, metadata.labels, metadata.omero, true);
  if (!encoded) throw new Error("OME-Zarr state generation returned no state.");
  return JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
}
