uniform float uTime;
attribute vec3 aColor;
attribute float aSway;
attribute float aEmit;
#ifdef CREATURE
attribute float aPart;
attribute vec3 aPivot;
uniform vec4 uPose;   // tail sway, head yaw, ear flap, wing flap
uniform vec4 uPose2;  // leg swing, blink, breath, curl
uniform float uWave;  // koi body wave strength
uniform vec4 uPose3;  // head pitch, squash, body tilt, lift
uniform vec3 uHeadPivot;
#endif
varying vec3 vN;
varying vec3 vW;
varying vec3 vC;
varying float vEmit;
varying vec3 vObj;
varying float vPart;

vec3 rot(vec3 v, vec3 axis, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

void main() {
  vec3 p = position;
  vec3 n = normal;
  vC = aColor;
  vEmit = aEmit;
  vPart = 0.0;
#ifdef CREATURE
  vPart = aPart;
  float side = aPivot.x >= 0.0 ? 1.0 : -1.0;
  if (aPart < 0.5) {                       // body: breathe
    float b = 1.0 + uPose2.z * 0.03;
    p.y = p.y * b; 
  } else if (aPart < 1.5) {                // head: turned below with the ears and eyes
  } else if (aPart < 2.5) {                // ear
    vec3 r = p - aPivot; r = rot(r, vec3(0.0,0.0,1.0), uPose.z * -side); p = aPivot + r; n = rot(n, vec3(0.0,0.0,1.0), uPose.z * -side);
  } else if (aPart < 3.5) {                // tail: sway grows toward the tip
    float k = clamp(length(p - aPivot) * 0.9, 0.0, 1.6);
    vec3 r = p - aPivot; r = rot(r, vec3(0.0,1.0,0.0), uPose.x * (0.4 + k)); p = aPivot + r; n = rot(n, vec3(0.0,1.0,0.0), uPose.x * (0.4 + k));
  } else if (aPart < 4.5) {                // wing: flap about the body axis
    vec3 r = p - aPivot; r = rot(r, vec3(0.0,0.0,1.0), uPose.w * side); p = aPivot + r; n = rot(n, vec3(0.0,0.0,1.0), uPose.w * side);
  } else if (aPart < 5.5) {                // leg: swing
    float ph = (aPivot.x * aPivot.z > 0.0) ? 1.0 : -1.0;
    vec3 r = p - aPivot; r = rot(r, vec3(1.0,0.0,0.0), uPose2.x * ph); p = aPivot + r; n = rot(n, vec3(1.0,0.0,0.0), uPose2.x * ph);
  } else if (aPart < 6.5) {                // eye: blink squashes y
    p.y = aPivot.y + (p.y - aPivot.y) * uPose2.y;
  } else if (aPart < 7.5) {                // koi segment: lateral wave along the spine
    p.x += sin(uTime * 3.0 - aPivot.z * 2.2) * uWave * (0.25 + abs(aPivot.z) * 0.35);
  } else if (aPart < 8.5) {                // gear: turns slowly
    vec3 r = p - aPivot; r = rot(r, vec3(0.0,1.0,0.0), uTime * 0.9); p = aPivot + r; n = rot(n, vec3(0.0,1.0,0.0), uTime * 0.9);
  }
  // Head, ears and eyes turn together about the head pivot: yaw, then pitch.
  if ((aPart > 0.5 && aPart < 2.5) || (aPart > 5.5 && aPart < 6.5)) {
    vec3 r = p - uHeadPivot;
    r = rot(r, vec3(1.0,0.0,0.0), uPose3.x); n = rot(n, vec3(1.0,0.0,0.0), uPose3.x);
    r = rot(r, vec3(0.0,1.0,0.0), uPose.y); n = rot(n, vec3(0.0,1.0,0.0), uPose.y);
    p = uHeadPivot + r;
  }
  // Squash and stretch about the feet, then a forward or back tilt.
  p.y *= 1.0 + uPose3.y; p.xz *= 1.0 - uPose3.y * 0.5;
  p = rot(p, vec3(1.0,0.0,0.0), uPose3.z); n = rot(n, vec3(1.0,0.0,0.0), uPose3.z);
  p.y += uPose3.w;
  // Curl: sleeping bodies sink and roll into a ball.
  p.y -= uPose2.w * 0.18 * (1.0 - clamp(p.y, 0.0, 1.0));
#endif
  vObj = p;
#ifdef USE_INSTANCING
  mat4 M = modelMatrix * instanceMatrix;
#else
  mat4 M = modelMatrix;
#endif
  vec4 wp = M * vec4(p, 1.0);
  // Foliage sway, strongest at the top of each mesh (aSway carries the height weight).
  wp.x += sin(uTime * 0.9 + wp.z * 0.35 + wp.y * 0.2) * 0.07 * aSway;
  wp.z += cos(uTime * 0.7 + wp.x * 0.3) * 0.05 * aSway;
  vW = wp.xyz;
  vN = normalize(mat3(M) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
