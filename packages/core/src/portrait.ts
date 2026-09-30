import { deriveTraits, type Family } from "./traits.ts";

/**
 * A flat SVG card portrait (512 x 640). Pure and deterministic: the same name gives the same picture in the browser (which rasterises
 * it to the PNG a published card carries) and in the hatchkind.com build (sample cards). Drawn from the same derived traits as the
 * grove's creatures, so the colours match; the shapes are a simple emblem per family, not the 3D model.
 */
export function portraitSvg(domain: string, familyOverride?: Family): string {
  const t = deriveTraits(domain);
  const family = familyOverride ?? t.family;
  const body = `hsl(${t.hue} ${Math.round(t.sat * 100)}% ${Math.round(t.light * 100)}%)`;
  const accent = `hsl(${t.accentHue} 60% 70%)`;
  const ear = 60 + Math.round(t.earLength * 40);
  const tail = 50 + Math.round(t.tailLength * 50);
  const parts: Record<Family, string> = {
    fox: `<path d="M196 300 L176 ${300 - ear} L236 280 Z" fill="${body}"/><path d="M316 300 L336 ${300 - ear} L276 280 Z" fill="${body}"/>
<path d="M340 420 Q${400 + tail / 2} 380 ${380 + tail / 3} ${330 - tail / 4}" stroke="${body}" stroke-width="34" fill="none" stroke-linecap="round"/>`,
    moth: `<ellipse cx="170" cy="340" rx="${50 + ear / 3}" ry="90" fill="${accent}" opacity="0.85"/><ellipse cx="342" cy="340" rx="${50 + ear / 3}" ry="90" fill="${accent}" opacity="0.85"/>`,
    beetle: `<path d="M226 270 Q206 ${270 - ear / 2} 186 ${260 - ear / 2}" stroke="${body}" stroke-width="8" fill="none"/><path d="M286 270 Q306 ${270 - ear / 2} 326 ${260 - ear / 2}" stroke="${body}" stroke-width="8" fill="none"/>
<line x1="256" y1="300" x2="256" y2="470" stroke="#131a33" stroke-width="4"/>`,
    koi: `<path d="M256 470 L${226 - tail / 4} ${470 + tail / 2} L${286 + tail / 4} ${470 + tail / 2} Z" fill="${accent}"/>`,
  };
  const spots = Array.from({ length: t.spots }, (_, i) => `<circle cx="${220 + (i % 3) * 36}" cy="${380 + Math.floor(i / 3) * 34}" r="9" fill="${accent}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 640" width="512" height="640">
<rect width="512" height="640" fill="#131a33"/>
<circle cx="400" cy="110" r="46" fill="#f1ead8" opacity="0.9"/>
<ellipse cx="256" cy="560" rx="220" ry="46" fill="#2f5d3a"/>
${parts[family]}
<ellipse cx="256" cy="${400 - t.size * 10}" rx="${86 * t.size}" ry="${110 * t.size}" fill="${body}"/>
${spots}
<circle cx="230" cy="330" r="10" fill="#131a33"/><circle cx="282" cy="330" r="10" fill="#131a33"/>
</svg>
`;
}
