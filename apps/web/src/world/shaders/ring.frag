precision mediump float;
uniform float uTime;
varying vec2 vUv;
varying vec3 vCol;
varying float vPhase;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = 0.0;
  for (int i = 0; i < 2; i++) {
    float ph = fract(uTime * 0.45 + vPhase + float(i) * 0.5);
    a += smoothstep(0.06, 0.0, abs(r - ph)) * (1.0 - ph);
  }
  a *= step(r, 1.0);
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * a, a);
}
