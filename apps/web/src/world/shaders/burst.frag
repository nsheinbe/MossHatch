precision mediump float;
varying float vLife;
varying vec3 vCol;
varying float vKind;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a;
  if (vKind > 3.5) {            // bubble: a thin bright ring
    a = smoothstep(0.08, 0.0, abs(d - 0.38)) * vLife + 0.15 * smoothstep(0.4, 0.0, d) * vLife;
  } else if (vKind > 2.5) {     // petal: a leaning ellipse
    vec2 q = vec2(c.x * 0.8 + c.y * 0.6, -c.x * 0.6 + c.y * 0.8);
    a = smoothstep(0.5, 0.4, length(q * vec2(1.0, 2.2))) * vLife;
  } else if (vKind > 1.5) {     // z glyph
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
