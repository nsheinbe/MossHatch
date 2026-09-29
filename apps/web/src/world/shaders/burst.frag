precision mediump float;
varying float vLife;
varying vec3 vCol;
varying float vKind;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a;
  if (vKind > 1.5) {            // z glyph
    vec2 q = c * 2.0;
    float top = step(abs(q.y - 0.7), 0.16) * step(abs(q.x), 0.7);
    float bot = step(abs(q.y + 0.7), 0.16) * step(abs(q.x), 0.7);
    float dia = step(abs(q.x + q.y), 0.2) * step(abs(q.y), 0.75);
    a = max(top, max(bot, dia)) * smoothstep(0.0, 0.3, vLife);
  } else if (vKind > 0.5) {     // shard: hard-edged square
    a = step(max(abs(c.x), abs(c.y)), 0.42) * vLife;
  } else {
    a = pow(smoothstep(0.5, 0.0, d), 1.6) * vLife;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * a, a);
}
