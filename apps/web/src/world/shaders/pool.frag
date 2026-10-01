precision highp float;
uniform float uTime;
uniform vec4 uRip[8];       // x, z, start time, strength
uniform vec3 uSkyTop;
uniform vec3 uSkyHor;
uniform vec3 uMoonDir;
uniform vec3 uLP[3];
uniform vec3 uLCol;
uniform vec3 uFogCol;
uniform float uFogNear;
uniform float uFogFar;
uniform float uRadius;
varying vec3 vW;
varying vec2 vLocal;

float height(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 r = uRip[i];
    float t = uTime - r.z;
    if (r.w > 0.0 && t > 0.0 && t < 4.0) {
      float dist = length(p - r.xy);
      float front = t * 1.5;
      float env = smoothstep(front, front - 0.5, dist) * exp(-t * 0.9) * exp(-dist * 0.35);
      h += sin((dist - front) * 11.0) * env * r.w * 0.05;
    }
  }
  // gentle idle swell
  h += sin(p.x * 2.1 + uTime * 0.6) * sin(p.y * 1.7 - uTime * 0.5) * 0.004;
  return h;
}

vec3 skyAt(vec3 d) {
  float t = pow(clamp(d.y, 0.0, 1.0), 0.55);
  vec3 c = mix(uSkyHor, uSkyTop, t);
  float md = dot(d, normalize(uMoonDir));
  c += vec3(0.94, 0.92, 0.85) * (smoothstep(0.9975, 0.9985, md) + pow(clamp(md, 0.0, 1.0), 60.0) * 0.3);
  return c;
}

void main() {
  vec2 p = vLocal;
  float e = 0.03;
  float h0 = height(p);
  vec3 n = normalize(vec3(-(height(p + vec2(e, 0.0)) - h0) / e, 1.0, -(height(p + vec2(0.0, e)) - h0) / e));
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 refl = skyAt(R);
  vec3 deep = vec3(0.07, 0.24, 0.26);
  vec3 shallow = vec3(0.227, 0.604, 0.596);
  float r = length(p);
  float edge = smoothstep(uRadius * 0.55, uRadius, r);
  vec3 body = mix(deep, shallow, edge * 0.7);
  // caustic shimmer
  float c1 = vnoise(vec3(p * 2.6, uTime * 0.35));
  float c2 = vnoise(vec3(p * 2.6 + 5.0, uTime * 0.31 + 3.0));
  float caust = pow(1.0 - abs(c1 - c2) * 2.2, 6.0);
  body += vec3(0.4, 0.75, 0.7) * caust * 0.10;
  vec3 col = mix(body, refl, clamp(fres * 0.85 + 0.12, 0.0, 1.0));
  // lantern glints
  for (int i = 0; i < 3; i++) {
    vec3 L = normalize(uLP[i] - vW);
    float g = pow(max(dot(reflect(-L, n), V), 0.0), 90.0);
    col += uLCol * g * 0.8;
  }
  float mg = pow(max(dot(reflect(-normalize(uMoonDir), n), V), 0.0), 220.0);
  col += vec3(0.95, 0.92, 0.85) * mg * 0.7;
  // shore foam
  float foam = smoothstep(uRadius - 0.22, uRadius - 0.02, r + (vnoise(vec3(p * 5.0, uTime * 0.4)) - 0.5) * 0.14);
  col = mix(col, vec3(0.945, 0.918, 0.847), foam * 0.35);
  float dist = length(cameraPosition - vW);
  col = mix(col, uFogCol, smoothstep(uFogNear, uFogFar, dist));
  float alpha = clamp(mix(0.58, 0.92, fres) + foam * 0.25, 0.0, 0.96);
  alpha *= smoothstep(uRadius, uRadius - 0.05, r);
  gl_FragColor = vec4(col, alpha);
}
