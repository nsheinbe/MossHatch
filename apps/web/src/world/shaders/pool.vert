varying vec3 vW;
varying vec2 vLocal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  vLocal = position.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
