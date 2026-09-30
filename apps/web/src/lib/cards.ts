import { portraitSvg } from "@mosshatch/core";
import { api } from "./api";
import { gated } from "./domains";

/** The owner's view of a domain's public card on hatchkind.com. Nothing here is persisted. */
export interface CardInfo {
  card: { slug: string; url: string; species: string; rarity: string; traits: string[]; hatched_on: string; indexable: boolean; published_at: string } | null;
  eligible: boolean;
  address: string;
}
const P = (id: string) => `/api/v1/domains/${encodeURIComponent(id)}/card`;
export const getCard = (id: string) => api<CardInfo>("GET", P(id));
export const unpublishCard = (id: string) => api("DELETE", P(id));
export const publishCard = (id: string, png: string, indexable: boolean, actionId: string) => api<{ card: CardInfo["card"] }>("POST", P(id), { png, indexable }, gated(actionId));

/** The portrait, rasterised in this browser to a 256 x 320 PNG. Returns base64 and its SHA-256 (the hash the passkey signs). */
export async function renderPortrait(fqdn: string): Promise<{ png: string; sha256: string }> {
  const url = URL.createObjectURL(new Blob([portraitSvg(fqdn)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = 256; cv.height = 320;
    cv.getContext("2d")!.drawImage(img, 0, 0, 256, 320);
    const blob = await new Promise<Blob>((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("encode"))), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { png: btoa(bin), sha256: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") };
  } finally { URL.revokeObjectURL(url); }
}
