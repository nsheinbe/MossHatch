import { sha256 } from "../util/bytes.ts";

/**
 * Where card portraits live. The `cards` build downloads each published portrait into its own static output, so hatchkind.com
 * serves them from its origin; this store only has to hold the file between publish and the next cards build, and forget it on unpublish.
 */
export interface CardStoragePort {
  readonly kind: "memory" | "vercel-blob";
  /** Store a PNG under a key the caller chose. Returns the reference to keep and the URL the cards build fetches. */
  put(key: string, png: Buffer): Promise<{ ref: string; url: string }>;
  /** Delete by reference. Deleting something already gone succeeds. */
  delete(ref: string): Promise<void>;
}

/**
 * The key never carries the domain name or an owner id: a hash of a random id for this one upload and the image hash. One key per
 * upload, so a request that fails can delete its own file and never another request's (two requests replaying one action).
 */
export const portraitKey = (uploadId: string, imageSha256: string): string => `cards/${sha256(`${uploadId}:${imageSha256}`).toString("hex").slice(0, 32)}.png`;

/** A faithful in-memory fake for tests and local development. */
export class MemoryCardStorage implements CardStoragePort {
  readonly kind = "memory" as const;
  readonly files = new Map<string, Buffer>();
  deletes: string[] = [];
  failNextDelete = false;
  constructor(private base = "https://blob.local.test/") {}
  async put(key: string, png: Buffer) { this.files.set(key, Buffer.from(png)); return { ref: key, url: this.base + key }; }
  async delete(ref: string) {
    if (this.failNextDelete) { this.failNextDelete = false; throw new Error("storage_unavailable"); }
    this.deletes.push(ref); this.files.delete(ref);
  }
}

/**
 * Vercel Blob over its HTTP API. NEVER CALLED in this repository: no token exists here, and the request shapes below come from
 * Vercel's documentation and the @vercel/blob client source as read, not from a live call. Unverified details:
 *   - PUT https://blob.vercel-storage.com/<pathname> with `authorization: Bearer <BLOB_READ_WRITE_TOKEN>`, `x-api-version`,
 *     `x-content-type`, `x-add-random-suffix: 0` and `x-cache-control-max-age`; the JSON answer carries `url` and `pathname`.
 *   - POST https://blob.vercel-storage.com/delete with `{ "urls": [...] }` deletes, and deleting a missing blob is not an error.
 *   - Blob URLs are public and unguessable-by-suffix only when a random suffix is added; we add none and rely on the hashed key.
 */
export class VercelBlobStorage implements CardStoragePort {
  readonly kind = "vercel-blob" as const;
  constructor(private o: { token: string; apiVersion?: string; endpoint?: string; fetch?: typeof fetch }) {
    if (!o.token || !o.token.startsWith("vercel_blob_rw_")) throw new Error("blob_token_not_configured");
  }
  private get f() { return this.o.fetch ?? fetch; }
  private get base() { return this.o.endpoint ?? "https://blob.vercel-storage.com"; }
  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.o.token}`, "x-api-version": this.o.apiVersion ?? "7", ...extra };
  }
  async put(key: string, png: Buffer) {
    const res = await this.f(`${this.base}/${key}`, {
      method: "PUT", body: new Uint8Array(png),
      headers: this.headers({ "x-content-type": "image/png", "x-add-random-suffix": "0", "x-cache-control-max-age": "60" }),
    });
    if (!res.ok) throw new Error(`blob_put_${res.status}`);
    const j = (await res.json()) as { url?: unknown };
    if (typeof j.url !== "string" || !j.url.startsWith("https://")) throw new Error("blob_put_bad_answer");
    return { ref: j.url, url: j.url };
  }
  async delete(ref: string) {
    const res = await this.f(`${this.base}/delete`, { method: "POST", body: JSON.stringify({ urls: [ref] }), headers: this.headers({ "content-type": "application/json" }) });
    if (!res.ok) throw new Error(`blob_delete_${res.status}`);
  }
}

/**
 * Tells the `cards` project to rebuild after a publish or unpublish. The real adapter posts to a Vercel deploy hook (a URL that
 * is itself the credential, so it lives in the `web` project's environment and never in `cards`). NEVER CALLED here.
 */
export interface CardsSitePort { rebuild(): Promise<void> }
export class MemoryCardsSite implements CardsSitePort { calls = 0; async rebuild() { this.calls++; } }
export class VercelDeployHook implements CardsSitePort {
  constructor(private url: string, private f: typeof fetch = fetch) {
    if (!/^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\//.test(url)) throw new Error("deploy_hook_not_configured");
  }
  async rebuild() { const r = await this.f(this.url, { method: "POST" }); if (!r.ok) throw new Error(`deploy_hook_${r.status}`); }
}
