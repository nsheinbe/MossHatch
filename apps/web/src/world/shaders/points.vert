uniform float uTime;
uniform float uScale;   // pixel scale (dpr * viewport factor)
uniform float uCalm;
attribute vec4 aSeed;   // 4 random numbers
attribute float aKind;
varying float vA;
varying float vKind;
varying vec3 vCol;
void main() {
  float t = uTime * (0.05 + aSeed.w * 0.08) * (1.0 - 0.6 * uCalm);
  vec3 p = position;
  p.x += sin(t * 6.283 + aSeed.x * 12.0) * (0.8 + aSeed.y);
  p.z += cos(t * 6.283 * 0.8 + aSeed.y * 9.0) * (0.8 + aSeed.z);
  p.y += sin(t * 6.283 * 1.3 + aSeed.z * 7.0) * 0.5 + aKind * 0.0;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.55 + 0.45 * sin(uTime * (1.2 + aSeed.x * 2.0) + aSeed.w * 30.0);
  vA = aKind > 0.5 ? 0.35 + 0.25 * tw : tw;
  vKind = aKind;
  vCol = aKind > 0.5 ? vec3(0.945, 0.918, 0.847) : vec3(1.0, 0.698, 0.341);
  float size = aKind > 0.5 ? 0.035 : 0.05 + aSeed.z * 0.05;
  gl_PointSize = size * uScale / max(-mv.z, 0.5);
}
