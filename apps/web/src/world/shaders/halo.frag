precision mediump float;
varying vec2 vUv;
uniform vec3 uCol;
uniform float uI;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = pow(clamp(1.0 - d, 0.0, 1.0), 2.2) * uI;
  gl_FragColor = vec4(uCol * a, a);
}
