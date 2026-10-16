precision highp float;
uniform float uTime;
uniform float uDpr;
uniform vec3 uMoonDir;
uniform vec3 uSkyTop;
uniform vec3 uSkyHor;
uniform vec3 uLP[3];
uniform float uLI[3];
uniform vec3 uLCol;
uniform vec3 uFogCol;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uInk;
uniform float uMoss;
uniform float uDesat;
uniform float uSleep;
uniform float uAttn;
uniform float uShed;
uniform float uGlow;
uniform float uAlpha;
uniform float uTint;    // 0..1 lavender tint for traveling
uniform vec3 uRimCol;   // tier rim colour
uniform float uRimK;    // tier rim strength
uniform float uIri;     // iridescent rim strength
#ifdef EGG
uniform vec3 uShellA;
uniform vec3 uShellB;
uniform float uShellPat; // 0 plain, 1 speckle, 2 band, 3 zigzag, 4 dapple
uniform float uCrack;    // 0..1 crack progress
uniform float uCrackKind; // 0 veins, 1 spiral, 2 zigzag, 3 burst, 4 ring
#endif
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
varying float vEmit;
varying vec3 vObj;
varying float vPart;

// common.glsl is prepended

float hatchLine(vec2 p, float angle, float spacing, float thick, float seed) {
  float c = cos(angle), s = sin(angle);
  vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
  float wob = sin(q.y * 0.045 + seed + uTime * 0.35) * 0.9 + sin(q.y * 0.11 + seed * 2.3) * 0.35;
  float d = abs(fract((q.x + wob) / spacing) - 0.5) * spacing;
  return 1.0 - smoothstep(thick * 0.5 - 0.35, thick * 0.5 + 0.35, d);
}

void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  vec3 V = normalize(cameraPosition - vW);
  // Light: sky ambient, moon key, three flickering lanterns.
  float amb = mix(0.16, 0.34, n.y * 0.5 + 0.5);
  float key = max(dot(n, uMoonDir), 0.0) * 0.42;
  float lan = 0.0;
  vec3 lanCol = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    vec3 d = uLP[i] - vW;
    float dist = length(d);
    float l = max(dot(n, d / dist), 0.0) * uLI[i] * 1.6 / (1.0 + dist * dist * 0.06);
    lan += l;
  }
  float lit = clamp(amb + key + lan, 0.0, 1.0);
  float dark = 1.0 - lit;

  vec3 base = vC;
#ifdef EGG
  // The shell: its colour and pattern come from the extension (egg object space: centre y 0.3, radius about 0.24 x 0.31).
  vec3 q = vObj - vec3(0.0, 0.3, 0.0);
  float ang = atan(q.z, q.x);
  float mark = 0.0;
  if (uShellPat > 0.5 && uShellPat < 1.5) mark = step(0.78, vnoise(vObj * 26.0));
  else if (uShellPat < 2.5 && uShellPat > 1.5) mark = step(abs(q.y - 0.07), 0.03) + step(abs(q.y + 0.05), 0.018);
  else if (uShellPat < 3.5 && uShellPat > 2.5) mark = step(abs(q.y - abs(fract(ang * 0.955) - 0.5) * 0.12 + 0.02), 0.022);
  else if (uShellPat > 3.5) mark = smoothstep(0.6, 0.66, vnoise(vObj * 8.0 + 3.0));
  base = mix(uShellA, uShellB, clamp(mark, 0.0, 1.0));
  // Cracks grow with uCrack in one of five shapes and glow from inside.
  float cw = 0.012 + 0.006 * uCrack;
  float cl = 0.0;
  float yTop = q.y / 0.31;               // -1 bottom .. 1 top
  float a01 = ang / 6.2832 + 0.5;
  if (uCrackKind < 0.5) cl = step(abs(vnoise(vObj * 11.0) - 0.5), cw * 3.0) * step(1.0 - uCrack * 1.6, yTop);
  else if (uCrackKind < 1.5) cl = step(abs(fract(a01 * 2.0 + yTop * 1.5) - 0.5), cw * 5.0) * step(1.0 - uCrack * 2.0, yTop);
  else if (uCrackKind < 2.5) cl = step(abs(q.y - 0.02 - (abs(fract(a01 * 7.0) - 0.5) - 0.25) * 0.08), cw) * step(a01, uCrack * 1.05);
  else if (uCrackKind < 3.5) cl = step(abs(fract(a01 * 9.0) - 0.5), cw * 6.0) * step(1.0 - uCrack * 1.4, yTop) * step(0.0, yTop + 0.2);
  else cl = step(abs(q.y - 0.09), cw) * step(a01, uCrack * 1.05) + step(abs(q.y + 0.02), cw) * step(a01, uCrack * 1.05 - 0.4);
  cl = clamp(cl, 0.0, 1.0) * step(0.001, uCrack);
#endif
  // Moss: noise x upward normal x age.
  float mn = vnoise(vObj * 3.2 + vec3(3.1, 0.0, 7.7)) * 0.65 + vnoise(vObj * 9.0) * 0.35;
  float mossMask = uMoss * smoothstep(0.25, 0.85, n.y) * smoothstep(0.35, 0.7, mn + uMoss * 0.25);
  base = mix(base, vec3(0.616, 0.733, 0.333), mossMask * 0.85);
  // Speckle
  vec2 sp = floor(gl_FragCoord.xy / uDpr / 3.0);
  base *= 1.0 - 0.06 * step(0.93, hash21(sp));
  // Desaturation (transfers) and lavender tint
  float g = dot(base, vec3(0.3, 0.55, 0.15));
  base = mix(base, vec3(g), uDesat);
  base = mix(base, vec3(0.725, 0.655, 1.0) * g * 1.6, uTint * 0.5);
  base *= 1.0 - 0.38 * uSleep;

  // Tone: lit paper colour with flat bands, then ink layers on top.
  float tone = mix(0.42, 1.08, lit);
  vec3 col = base * tone;

  vec2 sc = gl_FragCoord.xy / uDpr;
  float sp1 = 5.0 + 1.5 * hash21(floor(vObj.xz * 2.0));
  float thick = 1.2 + 0.3 * smoothstep(0.5, 1.0, dark);
  float l1 = hatchLine(sc, 0.7854, 5.2, thick, 1.0) * smoothstep(0.22 - uSleep * 0.08, 0.30, dark);
  float l2 = hatchLine(sc, -0.6109, 5.8, thick, 2.7) * smoothstep(0.47 - uSleep * 0.08, 0.55, dark);
  float l3 = hatchLine(sc, 1.3439, 6.5, thick, 4.1) * smoothstep(0.72 - uSleep * 0.08, 0.80, dark);
  float ink = max(l1, max(l2, l3));

  // Fog first so distant hatching dissolves into dusk blue.
  float dist = length(cameraPosition - vW);
  float fog = smoothstep(uFogNear, uFogFar, dist);
  ink *= 1.0 - fog;

  // Rim light: warm from lanterns, cool from the moon.
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  col += rim * (uLCol * 0.22 * clamp(lan, 0.0, 1.0) + vec3(0.35, 0.45, 0.75) * 0.14);
  // Tier looks: a moonlit or lantern rim, and a slow rainbow sheen for iridescent coats.
  float rimT = pow(1.0 - max(dot(n, V), 0.0), 2.0);
  col += rimT * uRimCol * uRimK;
  vec3 iri = 0.5 + 0.5 * cos(6.2832 * (vec3(0.0, 0.33, 0.67) + vObj.y * 1.6 + dot(n, V) * 1.2 + uTime * 0.08));
  col += rimT * iri * uIri * 0.6;

  // Attention pulse and shedding shimmer
  float pulse = 0.5 + 0.5 * sin(uTime * 3.2);
  col += vec3(1.0, 0.604, 0.494) * uAttn * pulse * 0.18;
  float band = smoothstep(0.55, 1.0, sin(vObj.y * 6.0 - uTime * 2.4 + vObj.x * 2.0));
  col = mix(col, vec3(0.227, 0.604, 0.596) * 1.35, uShed * band * 0.55);

  // Creatures and eggs take a lighter ink than the grove, so a small creature on a phone reads as itself, not through a screen.
#if defined(CREATURE) || defined(EGG)
  col = mix(col, uInk, ink * 0.5);
#else
  col = mix(col, uInk, ink * 0.88);
#endif
  col += vEmit * uLCol * 0.9 + uGlow * vec3(1.0, 0.72, 0.36);
#ifdef EGG
  col = mix(col, uLCol * (1.2 + uCrack), cl);
#endif
  col = mix(col, uFogCol, fog);
  gl_FragColor = vec4(col, uAlpha);
}
