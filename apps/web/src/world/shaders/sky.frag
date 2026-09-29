precision highp float;
uniform float uTime;
uniform vec3 uSkyTop;
uniform vec3 uSkyHor;
uniform vec3 uMoonDir;
uniform vec3 uFogCol;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -0.2, 1.0);
  float t = pow(clamp(h, 0.0, 1.0), 0.55);
  vec3 col = mix(uSkyHor, uSkyTop, t);
  // Warm horizon glow low in the west.
  float glow = pow(clamp(1.0 - abs(d.y - 0.03) * 4.5, 0.0, 1.0), 2.0) * (0.5 + 0.5 * d.x);
  col += vec3(0.75, 0.42, 0.28) * glow * 0.32;
  // Soft clouds
  vec2 cp = d.xz / (d.y + 0.35) * 1.4 + vec2(uTime * 0.004, 0.0);
  float cl = smoothstep(0.52, 0.85, fbm2(cp * 1.6)) * smoothstep(0.02, 0.3, d.y) * (1.0 - smoothstep(0.5, 0.9, d.y));
  col = mix(col, uSkyHor * 1.35 + vec3(0.06, 0.03, 0.05), cl * 0.55);
  // Stars: hash cells with twinkle
  vec3 sp = d * 90.0;
  vec3 cell = floor(sp);
  float hs = hash31(cell);
  vec3 f = fract(sp) - 0.5;
  float star = step(0.985, hs) * smoothstep(0.32, 0.0, length(f)) * smoothstep(0.08, 0.4, d.y);
  star *= 0.55 + 0.45 * sin(uTime * (1.0 + hs * 3.0) + hs * 50.0);
  col += vec3(0.95, 0.93, 0.85) * star * (1.0 - cl);
  // Moon
  float md = dot(d, normalize(uMoonDir));
  float disc = smoothstep(0.9975, 0.9985, md);
  float halo = pow(clamp(md, 0.0, 1.0), 60.0) * 0.35;
  vec3 mc = vec3(0.945, 0.918, 0.847);
  float crater = vnoise(d * 55.0) * 0.5 + vnoise(d * 130.0) * 0.25;
  col += mc * halo * 0.6;
  col = mix(col, mc * (0.86 + 0.18 * crater), disc);
  // Below horizon blends into fog colour
  col = mix(col, uFogCol, smoothstep(0.02, -0.1, d.y));
  gl_FragColor = vec4(col, 1.0);
}
