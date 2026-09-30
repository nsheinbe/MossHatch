import { stream } from "./hash.ts";
import { sanitizeSpec, type CreatureSpec, type Hsl } from "./spec.ts";

const INK = "#131a33";
const CREAM = "#f1ead8";
const c = (x: Hsl, dl = 0) => `hsl(${x.h} ${Math.round(x.s * 100)}% ${Math.round(Math.min(95, Math.max(5, (x.l + dl) * 100)))}%)`;
const n = (v: number) => Math.round(v * 10) / 10;

/**
 * A flat SVG card portrait (512 x 640). Pure and deterministic, and drawn from the CreatureSpec only (never from a name), so a spec
 * from any source draws the same picture in the browser (which rasterises it for a published card) and in the hatchkind.com build.
 * Every value passes through sanitizeSpec, so the output holds numbers and fixed markup only: no text from the spec.
 */
export function portraitSvg(input: CreatureSpec): string {
  const s = sanitizeSpec(input);
  const body = c(s.body), dark = c(s.body, -0.22), accent = c(s.accent), coat = c(s.coat.color);
  const k = s.size, b = s.build;
  const rw = 84 * k * b, rh = 100 * k;
  const cx = 256, cy = 410 - (k - 1) * 20;
  const hy = cy - rh * 0.95, hr = 58 * k;
  const ear = 50 * s.earSize * k, tail = 60 * s.tailSize * k;
  const rnd = stream(s.seed);
  const out: string[] = [];
  const eyes = (y: number, gap = 22, r = 9) => `<circle cx="${n(cx - gap)}" cy="${n(y)}" r="${r}" fill="${INK}"/><circle cx="${n(cx + gap)}" cy="${n(y)}" r="${r}" fill="${INK}"/><circle cx="${n(cx - gap + 3)}" cy="${n(y - 3)}" r="2.5" fill="${CREAM}"/><circle cx="${n(cx + gap + 3)}" cy="${n(y - 3)}" r="2.5" fill="${CREAM}"/>`;
  const earShapes = (y: number, x: number) => {
    const lx = cx - x, rx = cx + x;
    switch (s.ears) {
      case "pointed": return `<path d="M${n(lx - 22)} ${n(y)} L${n(lx - 8)} ${n(y - ear * 1.3)} L${n(lx + 20)} ${n(y - 6)} Z" fill="${body}"/><path d="M${n(rx + 22)} ${n(y)} L${n(rx + 8)} ${n(y - ear * 1.3)} L${n(rx - 20)} ${n(y - 6)} Z" fill="${body}"/>`;
      case "tufted": return `<path d="M${n(lx - 20)} ${n(y)} L${n(lx - 18)} ${n(y - ear * 1.2)} L${n(lx - 4)} ${n(y - ear * 0.9)} L${n(lx + 18)} ${n(y - 4)} Z" fill="${body}"/><path d="M${n(rx + 20)} ${n(y)} L${n(rx + 18)} ${n(y - ear * 1.2)} L${n(rx + 4)} ${n(y - ear * 0.9)} L${n(rx - 18)} ${n(y - 4)} Z" fill="${body}"/>`;
      case "lop": return `<ellipse cx="${n(lx - 26)}" cy="${n(y + ear * 0.35)}" rx="16" ry="${n(ear * 0.8)}" transform="rotate(25 ${n(lx - 26)} ${n(y + ear * 0.35)})" fill="${body}"/><ellipse cx="${n(rx + 26)}" cy="${n(y + ear * 0.35)}" rx="16" ry="${n(ear * 0.8)}" transform="rotate(-25 ${n(rx + 26)} ${n(y + ear * 0.35)})" fill="${body}"/>`;
      default: return `<circle cx="${n(lx - 6)}" cy="${n(y - ear * 0.3)}" r="${n(ear * 0.45)}" fill="${body}"/><circle cx="${n(rx + 6)}" cy="${n(y - ear * 0.3)}" r="${n(ear * 0.45)}" fill="${body}"/>`;
    }
  };
  const tailPath = (count = 1) => {
    let t = "";
    for (let i = 0; i < count; i++) {
      const a = (i - (count - 1) / 2) * 34;
      const tipX = cx + rw * 0.9 + tail * 0.9, tipY = cy - tail * (s.tail === "curl" ? 1.2 : 0.8);
      const w = s.tail === "plume" ? 40 : s.tail === "stub" ? 26 : 32;
      const len = s.tail === "stub" ? 0.35 : 1;
      t += `<g transform="rotate(${a} ${n(cx + rw * 0.7)} ${n(cy + 20)})"><path d="M${n(cx + rw * 0.7)} ${n(cy + 20)} Q${n(cx + rw + tail * len)} ${n(cy + 10)} ${n(cx + rw * 0.7 + (tipX - cx - rw * 0.7) * len)} ${n(cy + 20 + (tipY - cy - 20) * len)}" stroke="${body}" stroke-width="${w}" fill="none" stroke-linecap="round"/>`
        + (s.tail === "stub" ? "" : `<circle cx="${n(cx + rw * 0.7 + (tipX - cx - rw * 0.7) * len)}" cy="${n(cy + 20 + (tipY - cy - 20) * len)}" r="${w / 2}" fill="${CREAM}"/>`) + "</g>";
    }
    return t;
  };

  switch (s.species) {
    case "fox": case "spiritfox": {
      out.push(tailPath(s.species === "spiritfox" ? 3 : 1));
      out.push(`<ellipse cx="${cx}" cy="${n(cy)}" rx="${n(rw)}" ry="${n(rh)}" fill="${body}"/><ellipse cx="${cx}" cy="${n(cy + rh * 0.25)}" rx="${n(rw * 0.55)}" ry="${n(rh * 0.6)}" fill="${CREAM}"/>`);
      out.push(earShapes(hy - hr * 0.5, hr * 0.55));
      out.push(`<circle cx="${cx}" cy="${n(hy)}" r="${n(hr)}" fill="${body}"/><path d="M${cx - 30} ${n(hy + 10)} L${cx} ${n(hy + hr + 12)} L${cx + 30} ${n(hy + 10)} Z" fill="${CREAM}"/><circle cx="${cx}" cy="${n(hy + hr + 8)}" r="7" fill="${INK}"/>`);
      out.push(eyes(hy - 6));
      break;
    }
    case "hare": {
      out.push(`<circle cx="${n(cx + rw * 0.9)}" cy="${n(cy + 30)}" r="${n(22 * s.tailSize)}" fill="${CREAM}"/>`);
      out.push(`<ellipse cx="${cx}" cy="${n(cy)}" rx="${n(rw)}" ry="${n(rh * 0.95)}" fill="${body}"/>`);
      const e = s.ears === "lop" ? earShapes(hy - hr * 0.3, hr * 0.6) : `<ellipse cx="${n(cx - 24)}" cy="${n(hy - hr - ear * 0.7)}" rx="15" ry="${n(ear * 1.2)}" transform="rotate(-8 ${n(cx - 24)} ${n(hy - hr)})" fill="${body}"/><ellipse cx="${n(cx + 24)}" cy="${n(hy - hr - ear * 0.7)}" rx="15" ry="${n(ear * 1.2)}" transform="rotate(8 ${n(cx + 24)} ${n(hy - hr)})" fill="${body}"/><ellipse cx="${n(cx - 24)}" cy="${n(hy - hr - ear * 0.6)}" rx="7" ry="${n(ear * 0.9)}" transform="rotate(-8 ${n(cx - 24)} ${n(hy - hr)})" fill="${accent}"/><ellipse cx="${n(cx + 24)}" cy="${n(hy - hr - ear * 0.6)}" rx="7" ry="${n(ear * 0.9)}" transform="rotate(8 ${n(cx + 24)} ${n(hy - hr)})" fill="${accent}"/>`;
      out.push(e, `<circle cx="${cx}" cy="${n(hy)}" r="${n(hr)}" fill="${body}"/><circle cx="${cx}" cy="${n(hy + hr * 0.45)}" r="6" fill="${accent}"/>`, eyes(hy - 4, 24));
      break;
    }
    case "hedgehog": {
      let spikes = "";
      for (let i = 0; i <= 14; i++) {
        const a = Math.PI * (1.05 + (i / 14) * 0.9), r1 = rw * 1.05, r2 = rw * 1.35;
        const x1 = cx + Math.cos(a - 0.1) * r1, y1 = cy + Math.sin(a - 0.1) * rh * 0.95, x2 = cx + Math.cos(a) * r2, y2 = cy + Math.sin(a) * rh * 1.25, x3 = cx + Math.cos(a + 0.1) * r1, y3 = cy + Math.sin(a + 0.1) * rh * 0.95;
        spikes += `<path d="M${n(x1)} ${n(y1)} L${n(x2)} ${n(y2)} L${n(x3)} ${n(y3)} Z" fill="${dark}"/>`;
      }
      out.push(spikes, `<ellipse cx="${cx}" cy="${n(cy)}" rx="${n(rw * 1.1)}" ry="${n(rh)}" fill="${dark}"/><ellipse cx="${cx}" cy="${n(cy + rh * 0.3)}" rx="${n(rw * 0.75)}" ry="${n(rh * 0.6)}" fill="${body}"/>`);
      out.push(earShapes(cy - rh * 0.35, hr * 0.5), `<ellipse cx="${cx}" cy="${n(cy - rh * 0.1)}" rx="${n(hr * 0.9)}" ry="${n(hr * 0.8)}" fill="${body}"/><ellipse cx="${cx}" cy="${n(cy + hr * 0.5)}" rx="14" ry="10" fill="${INK}"/>`, eyes(cy - rh * 0.15, 20, 8));
      break;
    }
    case "owl": {
      const wing = s.wings === "swallow" ? 1.2 : s.wings === "round" ? 0.9 : 1;
      out.push(`<ellipse cx="${n(cx - rw * 0.95)}" cy="${n(cy + 10)}" rx="${n(34 * wing)}" ry="${n(rh * 0.8)}" fill="${dark}"/><ellipse cx="${n(cx + rw * 0.95)}" cy="${n(cy + 10)}" rx="${n(34 * wing)}" ry="${n(rh * 0.8)}" fill="${dark}"/>`);
      out.push(`<ellipse cx="${cx}" cy="${n(cy - 20)}" rx="${n(rw * 1.05)}" ry="${n(rh * 1.2)}" fill="${body}"/><ellipse cx="${cx}" cy="${n(cy + 20)}" rx="${n(rw * 0.7)}" ry="${n(rh * 0.75)}" fill="${CREAM}" opacity="0.7"/>`);
      if (s.ears === "tufted") out.push(`<path d="M${n(cx - rw * 0.8)} ${n(cy - rh * 1.05)} L${n(cx - rw * 0.9)} ${n(cy - rh * 1.05 - ear)} L${n(cx - rw * 0.4)} ${n(cy - rh * 1.15)} Z" fill="${body}"/><path d="M${n(cx + rw * 0.8)} ${n(cy - rh * 1.05)} L${n(cx + rw * 0.9)} ${n(cy - rh * 1.05 - ear)} L${n(cx + rw * 0.4)} ${n(cy - rh * 1.15)} Z" fill="${body}"/>`);
      const ey = cy - rh * 0.7;
      out.push(`<circle cx="${cx - 34}" cy="${n(ey)}" r="30" fill="${accent}"/><circle cx="${cx + 34}" cy="${n(ey)}" r="30" fill="${accent}"/>`, eyes(ey, 34, 14), `<path d="M${cx - 10} ${n(ey + 22)} L${cx} ${n(ey + 44)} L${cx + 10} ${n(ey + 22)} Z" fill="#c8a35a"/>`);
      break;
    }
    case "beetle": {
      out.push(`<path d="M${n(cx - rw * 1.2)} ${n(cy + 30)} A${n(rw * 1.2)} ${n(rh * 1.1)} 0 0 1 ${n(cx + rw * 1.2)} ${n(cy + 30)} Z" fill="${body}"/><line x1="${cx}" y1="${n(cy + 30 - rh * 1.1)}" x2="${cx}" y2="${n(cy + 30)}" stroke="${INK}" stroke-width="4"/>`);
      out.push(`<ellipse cx="${cx}" cy="${n(cy + 58)}" rx="${n(rw * 0.55)}" ry="36" fill="${dark}"/>`, `<path d="M${cx - 16} ${n(cy + 80)} Q${cx - 40} ${n(cy + 80 + ear)} ${cx - 60} ${n(cy + 90 + ear)}" stroke="${INK}" stroke-width="7" fill="none"/><path d="M${cx + 16} ${n(cy + 80)} Q${cx + 40} ${n(cy + 80 + ear)} ${cx + 60} ${n(cy + 90 + ear)}" stroke="${INK}" stroke-width="7" fill="none"/>`);
      out.push(`<circle cx="${cx}" cy="${n(cy - rh * 0.45)}" r="26" fill="none" stroke="#c8a35a" stroke-width="12" stroke-dasharray="8 6"/>`, `<circle cx="${cx - 18}" cy="${n(cy + 58)}" r="6" fill="${CREAM}"/><circle cx="${cx + 18}" cy="${n(cy + 58)}" r="6" fill="${CREAM}"/>`);
      break;
    }
    case "koi": {
      const fin = s.tail === "plume" ? 1.4 : s.tail === "curl" ? 1.1 : 1;
      out.push(`<ellipse cx="256" cy="560" rx="200" ry="30" fill="#3a9a98" opacity="0.5"/>`);
      out.push(`<path d="M${n(cx + rw * 1.4)} ${n(cy)} L${n(cx + rw * 1.4 + 80 * fin)} ${n(cy - 60 * fin)} L${n(cx + rw * 1.4 + 60 * fin)} ${n(cy)} L${n(cx + rw * 1.4 + 80 * fin)} ${n(cy + 60 * fin)} Z" fill="${accent}"/>`);
      out.push(`<ellipse cx="${cx}" cy="${n(cy)}" rx="${n(rw * 1.6)}" ry="${n(rh * 0.6)}" fill="${body}"/><path d="M${cx - 20} ${n(cy - rh * 0.55)} Q${cx + 20} ${n(cy - rh * 1.0)} ${cx + 60} ${n(cy - rh * 0.5)} Z" fill="${accent}"/>`);
      out.push(`<circle cx="${n(cx - rw * 1.1)}" cy="${n(cy - 12)}" r="9" fill="${INK}"/><circle cx="${n(cx - 10)}" cy="${n(cy - rh * 0.45)}" r="12" fill="none" stroke="#c8a35a" stroke-width="6"/>`);
      break;
    }
    case "moth": {
      const w = s.wings === "swallow" ? [1.3, 0.7] : s.wings === "round" ? [1, 1] : [1.15, 0.85];
      for (const sx of [-1, 1]) {
        out.push(`<ellipse cx="${n(cx + sx * 110 * w[0]!)}" cy="${n(cy - 60)}" rx="${n(100 * w[0]!)}" ry="${n(90 * w[1]!)}" transform="rotate(${sx * -18} ${n(cx + sx * 110 * w[0]!)} ${n(cy - 60)})" fill="${accent}" opacity="0.9"/>`);
        out.push(`<ellipse cx="${n(cx + sx * 80)}" cy="${n(cy + 50)}" rx="${n(60 * w[0]!)}" ry="${n(56 * w[1]!)}" fill="${c(s.accent, -0.14)}" opacity="0.9"/><circle cx="${n(cx + sx * 110 * w[0]!)}" cy="${n(cy - 60)}" r="20" fill="${CREAM}" opacity="0.6"/>`);
      }
      out.push(`<ellipse cx="${cx}" cy="${n(cy)}" rx="30" ry="${n(rh * 0.95)}" fill="${body}"/><circle cx="${cx}" cy="${n(cy - rh * 0.9)}" r="32" fill="${body}"/>`, `<path d="M${cx - 10} ${n(cy - rh * 1.1)} Q${cx - 40} ${n(cy - rh * 1.1 - ear)} ${cx - 60} ${n(cy - rh * 1.1 - ear)}" stroke="${dark}" stroke-width="5" fill="none"/><path d="M${cx + 10} ${n(cy - rh * 1.1)} Q${cx + 40} ${n(cy - rh * 1.1 - ear)} ${cx + 60} ${n(cy - rh * 1.1 - ear)}" stroke="${dark}" stroke-width="5" fill="none"/>`, eyes(cy - rh * 0.9, 14, 8));
      break;
    }
    case "salamander": {
      out.push(`<path d="M${n(cx + rw)} ${n(cy + 20)} Q${n(cx + rw + tail * 1.6)} ${n(cy + 60)} ${n(cx + rw + tail * 1.2)} ${n(cy - 10)}" stroke="${body}" stroke-width="30" fill="none" stroke-linecap="round"/>`);
      for (const [lx, ly] of [[-0.8, 1], [0.8, 1], [-0.5, 0.2], [0.5, 0.2]] as const) out.push(`<ellipse cx="${n(cx + lx * rw * 1.4)}" cy="${n(cy + ly * 40 + 40)}" rx="20" ry="12" fill="${dark}"/>`);
      out.push(`<ellipse cx="${cx}" cy="${n(cy + 30)}" rx="${n(rw * 1.4)}" ry="${n(rh * 0.5)}" fill="${body}"/><ellipse cx="${n(cx - rw * 1.3)}" cy="${n(cy + 10)}" rx="${n(hr)}" ry="${n(hr * 0.7)}" fill="${body}"/>`);
      if (s.ears === "tufted") out.push(`<path d="M${n(cx - rw * 1.3)} ${n(cy - hr * 0.6)} l-30 -24 l10 30 l-30 -6 l30 22 Z" fill="${accent}"/>`);
      out.push(`<circle cx="${n(cx - rw * 1.3 - 20)}" cy="${n(cy - 4)}" r="9" fill="${INK}"/><circle cx="${n(cx - rw * 1.3 + 20)}" cy="${n(cy - 4)}" r="9" fill="${INK}"/>`);
      break;
    }
  }

  // Coat pattern on the body.
  switch (s.coat.pattern) {
    case "stripes": for (let i = 0; i < s.coat.count; i++) { const y = cy - rh * 0.6 + (i / Math.max(1, s.coat.count - 1)) * rh * 1.0; out.push(`<path d="M${n(cx - rw * 0.7)} ${n(y)} Q${cx} ${n(y - 14)} ${n(cx + rw * 0.7)} ${n(y)}" stroke="${coat}" stroke-width="9" fill="none" stroke-linecap="round" opacity="0.85"/>`); } break;
    case "speckles": for (let i = 0; i < s.coat.count; i++) out.push(`<circle cx="${n(cx + (rnd() - 0.5) * rw * 1.2)}" cy="${n(cy + (rnd() - 0.5) * rh * 1.1)}" r="${n(6 + rnd() * 6)}" fill="${coat}"/>`); break;
    case "socks": for (const sx of [-1, 1]) out.push(`<ellipse cx="${n(cx + sx * rw * 0.55)}" cy="${n(cy + rh * 0.92)}" rx="24" ry="16" fill="${coat}"/>`); break;
    case "mask": out.push(`<ellipse cx="${cx}" cy="${n(s.species === "owl" ? cy - rh * 0.7 : s.species === "hedgehog" ? cy - rh * 0.15 : hy - 6)}" rx="${n(hr * 0.95)}" ry="${n(hr * 0.32)}" fill="${coat}" opacity="0.8"/>`); break;
    case "twotone": out.push(`<path d="M${n(cx - rw * 0.98)} ${n(cy)} A${n(rw * 0.98)} ${n(rh * 0.98)} 0 0 0 ${n(cx + rw * 0.98)} ${n(cy)} Z" fill="${coat}" opacity="0.75"/>`); break;
    default: break;
  }

  // Extension charm on the chest, then accessories.
  const chY = s.species === "koi" ? cy + 20 : s.species === "salamander" ? cy + 10 : cy - rh * 0.55;
  const chX = s.species === "salamander" ? cx - rw * 1.1 : cx;
  const charm = c({ h: s.charm.hue, s: 0.6, l: 0.62 });
  const charms: Record<string, string> = {
    bell: `<circle cx="${n(chX)}" cy="${n(chY)}" r="11" fill="${charm}"/>`,
    star: `<path d="M${n(chX)} ${n(chY - 13)} L${n(chX + 4)} ${n(chY - 3)} L${n(chX + 13)} ${n(chY - 3)} L${n(chX + 6)} ${n(chY + 4)} L${n(chX + 9)} ${n(chY + 13)} L${n(chX)} ${n(chY + 7)} L${n(chX - 9)} ${n(chY + 13)} L${n(chX - 6)} ${n(chY + 4)} L${n(chX - 13)} ${n(chY - 3)} L${n(chX - 4)} ${n(chY - 3)} Z" fill="${charm}"/>`,
    gear: `<circle cx="${n(chX)}" cy="${n(chY)}" r="10" fill="none" stroke="${charm}" stroke-width="7" stroke-dasharray="4 3"/>`,
    drop: `<path d="M${n(chX)} ${n(chY - 14)} Q${n(chX + 12)} ${n(chY + 2)} ${n(chX)} ${n(chY + 10)} Q${n(chX - 12)} ${n(chY + 2)} ${n(chX)} ${n(chY - 14)} Z" fill="${charm}"/>`,
    ring: `<circle cx="${n(chX)}" cy="${n(chY)}" r="10" fill="none" stroke="${charm}" stroke-width="5"/>`,
    none: "",
  };
  out.push(charms[s.charm.shape] ?? "");
  const topY = s.species === "owl" ? cy - rh * 1.2 : s.species === "hedgehog" ? cy - rh * 1.1 : s.species === "beetle" ? cy + 30 - rh * 1.1 : s.species === "koi" ? cy - rh * 0.6 : s.species === "moth" ? cy - rh * 0.9 - 30 : s.species === "salamander" ? cy - hr * 0.6 : hy - hr;
  const topX = s.species === "salamander" ? cx - rw * 1.3 : cx;
  for (const a of s.accessories) {
    if (a === "scarf") out.push(`<path d="M${n(cx - rw * 0.8)} ${n(chY - 18)} Q${cx} ${n(chY + 4)} ${n(cx + rw * 0.8)} ${n(chY - 18)}" stroke="${accent}" stroke-width="18" fill="none" stroke-linecap="round"/><path d="M${n(cx + rw * 0.5)} ${n(chY - 10)} l14 44 l14 -6 Z" fill="${accent}"/>`);
    if (a === "leaf") out.push(`<path d="M${n(topX + 6)} ${n(topY + 4)} Q${n(topX + 40)} ${n(topY - 40)} ${n(topX + 70)} ${n(topY - 20)} Q${n(topX + 40)} ${n(topY + 10)} ${n(topX + 6)} ${n(topY + 4)} Z" fill="#6f9a3d"/>`);
    if (a === "flower") out.push(`<g fill="#f4a9c0">${[0, 72, 144, 216, 288].map((d) => `<circle cx="${n(topX - 30 + Math.cos((d * Math.PI) / 180) * 10)}" cy="${n(topY + 6 + Math.sin((d * Math.PI) / 180) * 10)}" r="8"/>`).join("")}</g><circle cx="${n(topX - 30)}" cy="${n(topY + 6)}" r="6" fill="#ffd36b"/>`);
    if (a === "lantern") out.push(`<line x1="${n(cx - rw - 10)}" y1="${n(cy - 20)}" x2="${n(cx - rw - 10)}" y2="${n(cy + 30)}" stroke="${INK}" stroke-width="3"/><circle cx="${n(cx - rw - 10)}" cy="${n(cy + 46)}" r="30" fill="#ffb257" opacity="0.25"/><rect x="${n(cx - rw - 24)}" y="${n(cy + 30)}" width="28" height="32" rx="8" fill="#ffb257"/>`);
    if (a === "acorn") out.push(`<ellipse cx="${n(cx + rw * 0.9)}" cy="${n(cy + rh * 0.8)}" rx="14" ry="18" fill="#a8743f"/><path d="M${n(cx + rw * 0.9 - 16)} ${n(cy + rh * 0.8 - 8)} Q${n(cx + rw * 0.9)} ${n(cy + rh * 0.8 - 26)} ${n(cx + rw * 0.9 + 16)} ${n(cy + rh * 0.8 - 8)} Z" fill="#6b4a2a"/>`);
  }

  // Tier effect: nothing, a moonlit rim, an iridescent ring, or a glow with motes.
  const fx: string[] = [];
  if (s.effect === "moonrim") fx.push(`<ellipse cx="${cx}" cy="${n(cy - 30)}" rx="${n(rw * 1.5)}" ry="${n(rh * 1.7)}" fill="none" stroke="#b9c8ff" stroke-width="3" opacity="0.5"/>`);
  if (s.effect === "iridescent") fx.push(`<ellipse cx="${cx}" cy="${n(cy - 30)}" rx="${n(rw * 1.55)}" ry="${n(rh * 1.75)}" fill="none" stroke="${c(s.accent, 0.1)}" stroke-width="5" opacity="0.7"/><ellipse cx="${cx}" cy="${n(cy - 30)}" rx="${n(rw * 1.45)}" ry="${n(rh * 1.65)}" fill="none" stroke="${c({ h: (s.accent.h + 120) % 360, s: 0.7, l: 0.7 })}" stroke-width="3" opacity="0.6"/>`);
  if (s.effect === "glow") {
    fx.push(`<circle cx="${cx}" cy="${n(cy - 40)}" r="${n(rh * 1.9)}" fill="${c(s.accent, 0.15)}" opacity="0.18"/>`);
    for (let i = 0; i < 9; i++) fx.push(`<circle cx="${n(60 + rnd() * 392)}" cy="${n(140 + rnd() * 340)}" r="${n(3 + rnd() * 4)}" fill="#ffe7b0" opacity="0.8"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 640" width="512" height="640">
<rect width="512" height="640" fill="${INK}"/>
<circle cx="400" cy="110" r="46" fill="${CREAM}" opacity="0.9"/>
${fx.join("")}
<ellipse cx="256" cy="560" rx="220" ry="46" fill="#2f5d3a"/>
${out.join("\n")}
</svg>
`;
}
