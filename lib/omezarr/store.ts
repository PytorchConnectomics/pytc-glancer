import type { AbsolutePath, AsyncReadable, GetOptions } from "zarrita";

export const METADATA_NAMES = new Set(["zarr.json", ".zattrs", ".zgroup", ".zarray"]);
export const MAX_METADATA_BYTES = 1024 * 1024;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MetadataStoreOptions {
  bucket: string;
  rootPath: string;
  accessToken?: string;
  fetcher?: FetchLike;
  onRequest?: (key: string) => void;
}

function allowedKey(key: string) { return METADATA_NAMES.has(key.split("/").filter(Boolean).at(-1) ?? ""); }

async function cappedBytes(response: Response) {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_METADATA_BYTES) throw new Error("Metadata document exceeds the 1 MiB limit.");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_METADATA_BYTES) { await reader.cancel(); throw new Error("Metadata document exceeds the 1 MiB limit."); }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export class MetadataOnlyStore implements AsyncReadable {
  readonly requestedKeys: string[] = [];
  private fetcher: FetchLike;

  constructor(private options: MetadataStoreOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async get(key: AbsolutePath, opts?: GetOptions): Promise<Uint8Array | undefined> {
    if (!allowedKey(key)) throw new Error(`Refusing non-metadata Zarr key: ${key}`);
    this.requestedKeys.push(key);
    this.options.onRequest?.(key);
    const relative = key.replace(/^\/+/, "");
    const objectName = [this.options.rootPath.replace(/^\/+|\/+$/g, ""), relative].filter(Boolean).join("/");
    const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.options.bucket)}/o/${encodeURIComponent(objectName)}?alt=media`;
    const headers = this.options.accessToken ? { Authorization: `Bearer ${this.options.accessToken}` } : undefined;
    const response = await this.fetcher(url, { headers, signal: opts?.signal });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GCS metadata request failed (${response.status}) for ${key}`);
    return cappedBytes(response);
  }
}

export function isMetadataKey(key: string) { return allowedKey(key); }
