/**
 * OpenSRS OPS envelope codec (XML over HTTPS; docs/research/reg-opensrs.md 2: "Body = OPS XML envelope (protocol=XCP, action, object, attributes)").
 * UNVERIFIED against a real response: the element names (`OPS_envelope`, `dt_assoc`, `dt_array`, `item key=`) come from the OPS DTD and the
 * OpenSRS toolkit convention, which the dossier refers to ("message must be valid OPS DTD", S10) but does not quote. Confirm in Horizon.
 * This is a small purpose-built reader, not a general XML parser: it refuses DOCTYPE internal subsets and ENTITY declarations.
 */
export type OpsValue = string | number | boolean | null | OpsValue[] | { [k: string]: OpsValue };
export type OpsObject = { [k: string]: OpsValue };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// XML 1.0 forbids most control characters; refusing them also stops request smuggling through attribute values.
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function encodeValue(v: OpsValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return `<dt_array>${v.map((x, i) => `<item key="${i}">${encodeValue(x)}</item>`).join("")}</dt_array>`;
  if (typeof v === "object") return `<dt_assoc>${Object.entries(v).map(([k, x]) => `<item key="${esc(k)}">${encodeValue(x)}</item>`).join("")}</dt_assoc>`;
  if (typeof v === "boolean") return v ? "1" : "0";
  const s = String(v);
  if (BAD_CHARS.test(s)) throw new Error("control character in request value");
  return esc(s);
}

export function encodeOps(action: string, object: string, attributes: OpsObject): string {
  const body: OpsObject = { protocol: "XCP", action, object, attributes };
  return `<?xml version='1.0' encoding='UTF-8' standalone='no' ?>\n<!DOCTYPE OPS_envelope SYSTEM 'ops.dtd'>\n<OPS_envelope><header><version>0.9</version></header><body><data_block>${encodeValue(body)}</data_block></body></OPS_envelope>`;
}

function unesc(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === "amp") return "&"; if (e === "lt") return "<"; if (e === "gt") return ">"; if (e === "quot") return '"'; if (e === "apos") return "'";
    const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
  });
}

type Frame = { key: string; container?: OpsObject | OpsValue[]; text: string };

export function decodeOps(xml: string): OpsObject {
  if (/<!ENTITY/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error("entity declarations are refused");
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w-]*)([^>]*?)(\/?)>|([^<]+)/g;
  const frames: Frame[] = [];
  const containers: (OpsObject | OpsValue[])[] = [];
  let root: OpsObject | null = null;
  const attach = (parent: OpsObject | OpsValue[] | undefined, key: string, value: OpsValue) => {
    if (!parent) return;
    if (Array.isArray(parent)) parent[Number(key)] = value; else parent[key] = value;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, close, name, attrs, selfClose, text] = m;
    if (text !== undefined) { const top = frames[frames.length - 1]; if (top && !top.container) top.text += text; continue; }
    if (!name) continue;
    if (name === "item") {
      if (close) {
        const f = frames.pop(); if (!f) throw new Error("unbalanced item");
        attach(containers[containers.length - 1], f.key, f.container ?? unesc(f.text.trim() === "" ? "" : f.text));
      } else {
        const k = /key\s*=\s*"([^"]*)"|key\s*=\s*'([^']*)'/.exec(attrs ?? "");
        const f: Frame = { key: unesc(k?.[1] ?? k?.[2] ?? ""), text: "" };
        if (selfClose) attach(containers[containers.length - 1], f.key, ""); else frames.push(f);
      }
    } else if (name === "dt_assoc" || name === "dt_array") {
      if (close) { containers.pop(); continue; }
      const c: OpsObject | OpsValue[] = name === "dt_array" ? [] : {};
      const top = frames[frames.length - 1];
      if (top) top.container = c; else if (!root && !Array.isArray(c)) root = c;
      if (!selfClose) containers.push(c);
    }
  }
  if (!root) throw new Error("no data block");
  return root;
}

export const str = (v: OpsValue | undefined): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
export const obj = (v: OpsValue | undefined): OpsObject | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
export const arr = (v: OpsValue | undefined): OpsValue[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);
export const flag = (v: OpsValue | undefined): boolean => v === "1" || v === 1 || v === true || v === "true" || v === "Y" || v === "y";
