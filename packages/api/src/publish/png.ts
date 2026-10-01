import zlib from "node:zlib";

/**
 * Card portrait intake. The browser renders the creature and uploads a PNG; the server never trusts those bytes as they come.
 * It parses the file strictly (signature, chunk order, CRCs, one image header, 8-bit RGB or RGBA, no interlace, no animation),
 * inflates the pixels with a hard output cap, and writes a NEW file holding only IHDR, IDAT and IEND. Every ancillary chunk the
 * upload carried (text, EXIF, ICC profiles, timestamps: anything that could hold personal data or a payload) is gone.
 */

export const CARD_SIZES: readonly { w: number; h: number }[] = [{ w: 512, h: 640 }, { w: 256, h: 320 }];
/** The upload travels in a JSON body capped at 256,000 characters, so the decoded file must stay well under it. */
export const MAX_UPLOAD_BYTES = 180_000;
export const MAX_STORED_BYTES = 400_000;

export class PngError extends Error {
  constructor(public code: "not_png" | "bad_chunk" | "bad_crc" | "unsupported" | "bad_dimensions" | "too_large" | "bad_pixels") { super(code); }
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Ancillary chunks we accept in an upload (and drop). Anything else ancillary is dropped too; unknown critical chunks are refused. */
const ANIMATION = new Set(["acTL", "fcTL", "fdAT"]);

export interface Decoded { width: number; height: number; rgba: Buffer }

function crc(type: string, data: Buffer): number {
  return zlib.crc32(data, zlib.crc32(Buffer.from(type, "latin1")));
}

export function decodePng(buf: Buffer): Decoded {
  if (buf.length > MAX_UPLOAD_BYTES) throw new PngError("too_large");
  if (buf.length < SIG.length + 12 || !buf.subarray(0, 8).equals(SIG)) throw new PngError("not_png");
  let off = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  let seenIdat = false, idatEnded = false, ended = false;
  while (off < buf.length) {
    if (ended) throw new PngError("bad_chunk");                       // bytes after IEND
    if (off + 12 > buf.length) throw new PngError("bad_chunk");
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || len > buf.length) throw new PngError("bad_chunk");
    const end = off + 12 + len;
    if (end > buf.length) throw new PngError("bad_chunk");
    const data = buf.subarray(off + 8, off + 8 + len);
    if (crc(type, data) !== buf.readUInt32BE(off + 8 + len)) throw new PngError("bad_crc");
    if (ihdr === null && type !== "IHDR") throw new PngError("bad_chunk");
    if (type === "IHDR") {
      if (ihdr !== null || len !== 13) throw new PngError("bad_chunk");
      ihdr = Buffer.from(data);
    } else if (type === "IDAT") {
      if (idatEnded) throw new PngError("bad_chunk");                 // IDAT chunks must be consecutive
      seenIdat = true; idat.push(data);
    } else if (type === "IEND") {
      if (len !== 0 || !seenIdat) throw new PngError("bad_chunk");
      ended = true;
    } else {
      if (seenIdat) idatEnded = true;
      if (ANIMATION.has(type)) throw new PngError("unsupported");
      // Critical chunk we do not handle (PLTE included: palette images are refused).
      if (type[0]! === type[0]!.toUpperCase()) throw new PngError("unsupported");
    }
    off = end;
  }
  if (!ended || !ihdr) throw new PngError("bad_chunk");
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const [depth, colour, compression, filter, interlace] = [ihdr[8]!, ihdr[9]!, ihdr[10]!, ihdr[11]!, ihdr[12]!];
  if (depth !== 8 || (colour !== 2 && colour !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) throw new PngError("unsupported");
  if (!CARD_SIZES.some((s) => s.w === width && s.h === height)) throw new PngError("bad_dimensions");
  const bpp = colour === 6 ? 4 : 3;
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw: Buffer;
  try { raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); } catch { throw new PngError("bad_pixels"); }
  if (raw.length !== expected) throw new PngError("bad_pixels");
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    unfilter(ft, line, prev, bpp);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = line[x * bpp]!; rgba[o + 1] = line[x * bpp + 1]!; rgba[o + 2] = line[x * bpp + 2]!;
      rgba[o + 3] = bpp === 4 ? line[x * bpp + 3]! : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(ft: number, line: Buffer, prev: Buffer, bpp: number): void {
  for (let i = 0; i < line.length; i++) {
    const a = i >= bpp ? line[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
    switch (ft) {
      case 0: break;
      case 1: line[i] = (line[i]! + a) & 255; break;
      case 2: line[i] = (line[i]! + b) & 255; break;
      case 3: line[i] = (line[i]! + ((a + b) >> 1)) & 255; break;
      case 4: line[i] = (line[i]! + paeth(a, b, c)) & 255; break;
      default: throw new PngError("bad_pixels");
    }
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc(type, data), 8 + data.length);
  return out;
}

/** A clean RGBA PNG: IHDR, one IDAT, IEND. Each row uses the filter with the smallest sum of absolute values. */
export function encodePng(d: Decoded): Buffer {
  const { width, height, rgba } = d;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    let best = 0, bestSum = Infinity;
    for (let ft = 0; ft < 5; ft++) {
      const outRow = cand[ft]!;
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4]! : 0, b = prev[i]!, c = i >= 4 ? prev[i - 4]! : 0;
        const pred = ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i]! - pred) & 255;
        outRow[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = ft; }
    }
    raw[y * (stride + 1)] = best;
    cand[best]!.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
  if (png.length > MAX_STORED_BYTES) throw new PngError("too_large");
  return png;
}

/** Validate an upload and return the re-encoded file that is stored and served. */
export function sanitizePng(upload: Buffer): { png: Buffer; width: number; height: number } {
  const d = decodePng(upload);
  return { png: encodePng(d), width: d.width, height: d.height };
}
