uniform float uTime;
attribute vec3 iCol;
attribute float iPhase;
varying vec2 vUv;
varying vec3 vCol;
varying float vPhase;
void main() {
  vUv = uv;
  vCol = iCol;
  vPhase = iPhase;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
