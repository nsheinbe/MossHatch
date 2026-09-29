precision mediump float;
varying float vA;
varying float vKind;
varying vec3 vCol;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.0, d);
  a = pow(a, vKind > 0.5 ? 2.0 : 1.5) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * a, a);
}
