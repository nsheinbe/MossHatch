uniform float uScale;
attribute vec4 aData;   // life 0..1 (0 = dead), size, kind, unused
attribute vec3 aCol;
varying float vLife;
varying vec3 vCol;
varying float vKind;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vLife = aData.x;
  vKind = aData.z;
  vCol = aCol;
  gl_PointSize = aData.x > 0.0 ? aData.y * uScale / max(-mv.z, 0.5) : 0.0;
}
