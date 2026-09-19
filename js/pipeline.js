/**
 * Hasselblad-inspired colour pipeline, executed on the GPU with WebGL2.
 *
 * Every frame (and every full-resolution capture) goes through the same shader:
 *
 *   sRGB frame → linear light → white balance / exposure
 *     → Oklab (perceptual lightness / chroma / hue)
 *     → per-hue chroma, hue and lightness refinements (the "look")
 *     → tone curve on lightness with a soft highlight shoulder and a gentle toe
 *     → highlight / shadow chroma roll-off
 *     → gamut mapping by chroma reduction (hue is preserved, never clipped)
 *     → linear → sRGB
 *
 * The look parameters live in LOOKS below so they can be tuned without touching GLSL.
 */

const DEG = Math.PI / 180;

/** A hue band: centre and width in degrees (Oklab hue), chroma multiplier, hue shift in degrees, lightness offset. */
const band = (centre, width, chroma, hueShift = 0, dL = 0) => ({ centre, width, chroma, hueShift, dL });

/**
 * Oklab hue reference (approx.): red 25°, orange/skin 55–70°, yellow 100°, green 140°,
 * teal 195°, blue 260°, magenta 325°.
 */
export const LOOKS = {
  natural: {
    id: 'natural',
    name: 'Natural',
    description: 'Default. Hasselblad Natural Colour Solution inspired: faithful hues, restrained saturation, smooth highlight roll-off.',
    exposure: 0,
    wb: [1, 1, 1],
    contrast: 1.08,
    toe: 0.22,
    toeSlope: 0.35,
    shoulder: 0.70,
    shoulderSlope: 0.28,
    chroma: 0.95,
    highlightDesat: 0.22,
    shadowDesat: 0.18,
    bands: [
      band(25, 24, 1.02, -3, -0.010),   // reds: deeper, less orange
      band(62, 24, 0.93, -2,  0.010),   // skin / orange: natural, slightly pink rather than orange
      band(100, 22, 0.95, 0,   0.000),  // yellows
      band(142, 30, 0.86, 6,  -0.012),  // greens: muted olive foliage, not neon
      band(198, 26, 0.96, 0,   0.000),  // teal / cyan
      band(262, 28, 0.98, -4, -0.020),  // blues: deep, leaning cyan, not purple
      band(322, 26, 0.90, 0,   0.000),  // magenta / purple
    ],
  },
  portrait: {
    id: 'portrait',
    name: 'Portrait',
    description: 'Softer tonality and gentler skin saturation for people.',
    exposure: 0,
    wb: [1, 1, 1],
    contrast: 1.04,
    toe: 0.20,
    toeSlope: 0.45,
    shoulder: 0.64,
    shoulderSlope: 0.30,
    chroma: 0.93,
    highlightDesat: 0.32,
    shadowDesat: 0.20,
    bands: [
      band(25, 24, 1.00, -2, -0.005),
      band(62, 26, 0.90, -3,  0.015),
      band(100, 22, 0.94, 0,   0.000),
      band(142, 30, 0.84, 6,  -0.010),
      band(198, 26, 0.95, 0,   0.000),
      band(262, 28, 0.96, -4, -0.015),
      band(322, 26, 0.88, 0,   0.000),
    ],
  },
  neutral: {
    id: 'neutral',
    name: 'Neutral',
    description: 'Flat, low contrast rendering with the same hue corrections. Intended as a starting point for editing.',
    exposure: 0,
    wb: [1, 1, 1],
    contrast: 1.0,
    toe: 0.0,
    toeSlope: 1.0,
    shoulder: 1.0,
    shoulderSlope: 1.0,
    chroma: 0.90,
    highlightDesat: 0.15,
    shadowDesat: 0.10,
    bands: [
      band(25, 24, 1.00, -3, 0),
      band(62, 24, 0.95, -2, 0),
      band(100, 22, 0.96, 0, 0),
      band(142, 30, 0.90, 6, 0),
      band(198, 26, 0.97, 0, 0),
      band(262, 28, 0.98, -4, 0),
      band(322, 26, 0.92, 0, 0),
    ],
  },
};

export const LOOK_ORDER = ['natural', 'portrait', 'neutral'];
const BAND_COUNT = 7;

const VERTEX_SRC = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  // One triangle that covers the whole clip space; uv is [0,1] over the visible quad.
  vec2 p = vec2(float((gl_VertexID & 1) * 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_color;

uniform sampler2D u_tex;
uniform vec2  u_scale;
uniform float u_mirror;
uniform float u_strength;

uniform float u_exposure;
uniform vec3  u_wb;
uniform float u_contrast;
uniform float u_toe;
uniform float u_toeSlope;
uniform float u_shoulder;
uniform float u_shoulderSlope;
uniform float u_chroma;
uniform float u_hiDesat;
uniform float u_shDesat;
uniform vec4  u_band[${BAND_COUNT}];   // centre (rad), width (rad), chroma mul, hue shift (rad)
uniform float u_bandL[${BAND_COUNT}];  // lightness offset

const float PI = 3.141592653589793;
const float TWO_PI = 6.283185307179586;

vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(0.0031308, c));
}

// Oklab (Björn Ottosson, public domain)
vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  vec3 lms = vec3(l, m, s);
  lms = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
  return vec3(
    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,
    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,
    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z
  );
}
vec3 oklabToLinear(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  vec3 lms = vec3(l_, m_, s_);
  lms = lms * lms * lms;
  return vec3(
     4.0767416621 * lms.x - 3.3077115913 * lms.y + 0.2309699292 * lms.z,
    -1.2684380046 * lms.x + 2.6097574011 * lms.y - 0.3413193965 * lms.z,
    -0.0041960863 * lms.x - 0.7034186147 * lms.y + 1.7076147010 * lms.z
  );
}

float hueWeight(float h, float centre, float width) {
  float d = mod(h - centre + PI, TWO_PI) - PI;
  return exp(-(d * d) / (width * width));
}

// Cubic Hermite segment: maps x in [x0,x1] to [y0,y1] with end slopes m0, m1.
float hermite(float x, float x0, float x1, float y0, float y1, float m0, float m1) {
  float h = x1 - x0;
  float t = clamp((x - x0) / h, 0.0, 1.0);
  float t2 = t * t, t3 = t2 * t;
  return (2.0 * t3 - 3.0 * t2 + 1.0) * y0
       + (t3 - 2.0 * t2 + t) * h * m0
       + (-2.0 * t3 + 3.0 * t2) * y1
       + (t3 - t2) * h * m1;
}

// Tone curve on Oklab lightness. Pivot 0.56 ≈ 18% grey. Black and white are preserved exactly;
// contrast > 1 steepens the midtones and the overshoot is absorbed by a smooth shoulder and toe.
float toneCurve(float L) {
  const float pivot = 0.56;
  float t = pivot + (L - pivot) * u_contrast;
  float tMax = pivot + (1.0 - pivot) * u_contrast;
  float tMin = pivot - pivot * u_contrast;
  if (u_shoulder < tMax - 1e-4 && t > u_shoulder) {
    t = hermite(t, u_shoulder, tMax, u_shoulder, 1.0, 1.0, u_shoulderSlope);
  } else if (u_toe > tMin + 1e-4 && t < u_toe) {
    t = hermite(t, tMin, u_toe, 0.0, u_toe, u_toeSlope, 1.0);
  }
  return clamp(t, 0.0, 1.0);
}

bool inGamut(vec3 rgb) {
  return all(greaterThanEqual(rgb, vec3(-0.0005))) && all(lessThanEqual(rgb, vec3(1.0005)));
}

void main() {
  vec2 uv = v_uv;
  uv.x = mix(uv.x, 1.0 - uv.x, u_mirror);
  uv = 0.5 + (uv - 0.5) * u_scale;

  vec3 srgb = texture(u_tex, uv).rgb;
  vec3 lin = srgbToLinear(srgb) * u_wb * exp2(u_exposure);
  lin = max(lin, vec3(0.0));

  vec3 lab = linearToOklab(lin);
  float L = lab.x;
  float C = length(lab.yz);
  float h = atan(lab.z, lab.y);

  // Neutral tones keep their neutrality: band adjustments fade out at low chroma.
  float satW = smoothstep(0.006, 0.045, C);

  float chromaMul = 1.0;
  float hueShift = 0.0;
  float dL = 0.0;
  for (int i = 0; i < ${BAND_COUNT}; i++) {
    float w = hueWeight(h, u_band[i].x, u_band[i].y) * satW;
    chromaMul += w * (u_band[i].z - 1.0);
    hueShift  += w * u_band[i].w;
    dL        += w * u_bandL[i];
  }

  L = toneCurve(clamp(L + dL, 0.0, 1.0));

  chromaMul *= u_chroma;
  chromaMul *= 1.0 - u_hiDesat * smoothstep(0.86, 1.0, L);
  chromaMul *= 1.0 - u_shDesat * (1.0 - smoothstep(0.0, 0.30, L));

  C *= max(chromaMul, 0.0);
  h += hueShift;

  vec3 rgb = oklabToLinear(vec3(L, C * cos(h), C * sin(h)));

  // Gamut map by reducing chroma (bisection), which keeps hue and lightness intact.
  if (!inGamut(rgb)) {
    float lo = 0.0, hi = C;
    for (int i = 0; i < 6; i++) {
      float mid = 0.5 * (lo + hi);
      vec3 test = oklabToLinear(vec3(L, mid * cos(h), mid * sin(h)));
      if (inGamut(test)) lo = mid; else hi = mid;
    }
    rgb = oklabToLinear(vec3(L, lo * cos(h), lo * sin(h)));
  }
  rgb = clamp(rgb, 0.0, 1.0);

  vec3 graded = linearToSrgb(rgb);
  o_color = vec4(mix(srgb, graded, u_strength), 1.0);
}`;

/**
 * Crop geometry: how much of the source (as a fraction, centred) is visible for a target aspect and zoom,
 * plus the resulting pixel size.
 */
export function cropRect(srcW, srcH, aspect, zoom = 1) {
  const sa = srcW / srcH;
  let sx = 1;
  let sy = 1;
  if (aspect) {
    if (aspect > sa) sy = sa / aspect;
    else sx = aspect / sa;
  }
  sx /= zoom;
  sy /= zoom;
  return { sx, sy, w: Math.max(2, Math.round(srcW * sx)), h: Math.max(2, Math.round(srcH * sy)) };
}

export class Pipeline {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{preserveDrawingBuffer?: boolean}} [options]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: !!options.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    this.program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    gl.useProgram(this.program);
    this.u = {};
    const names = [
      'u_tex', 'u_scale', 'u_mirror', 'u_strength', 'u_exposure', 'u_wb', 'u_contrast', 'u_toe', 'u_toeSlope',
      'u_shoulder', 'u_shoulderSlope', 'u_chroma', 'u_hiDesat', 'u_shDesat', 'u_band', 'u_bandL',
    ];
    for (const n of names) this.u[n] = gl.getUniformLocation(this.program, n);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(this.u.u_tex, 0);

    this.srcW = 0;
    this.srcH = 0;
    this.strength = 1;
    this.exposureOffset = 0;
    this.setLook(LOOKS.natural);
  }

  /** Upload look parameters. */
  setLook(look) {
    const gl = this.gl;
    this.look = look;
    gl.useProgram(this.program);
    gl.uniform3f(this.u.u_wb, look.wb[0], look.wb[1], look.wb[2]);
    gl.uniform1f(this.u.u_contrast, look.contrast);
    gl.uniform1f(this.u.u_toe, look.toe);
    gl.uniform1f(this.u.u_toeSlope, look.toeSlope);
    gl.uniform1f(this.u.u_shoulder, look.shoulder);
    gl.uniform1f(this.u.u_shoulderSlope, look.shoulderSlope);
    gl.uniform1f(this.u.u_chroma, look.chroma);
    gl.uniform1f(this.u.u_hiDesat, look.highlightDesat);
    gl.uniform1f(this.u.u_shDesat, look.shadowDesat);
    const bands = new Float32Array(BAND_COUNT * 4);
    const bandL = new Float32Array(BAND_COUNT);
    for (let i = 0; i < BAND_COUNT; i++) {
      const b = look.bands[i] || band(0, 1, 1, 0, 0);
      bands[i * 4 + 0] = b.centre * DEG;
      bands[i * 4 + 1] = b.width * DEG;
      bands[i * 4 + 2] = b.chroma;
      bands[i * 4 + 3] = b.hueShift * DEG;
      bandL[i] = b.dL;
    }
    gl.uniform4fv(this.u.u_band, bands);
    gl.uniform1fv(this.u.u_bandL, bandL);
    this._updateExposure();
  }

  /** 0 = untouched camera frame, 1 = full look. */
  setStrength(v) {
    this.strength = Math.min(1, Math.max(0, v));
  }

  /** Additional exposure (EV) applied in software on top of the look. */
  setExposureOffset(ev) {
    this.exposureOffset = ev;
    this._updateExposure();
  }

  _updateExposure() {
    this.gl.useProgram(this.program);
    this.gl.uniform1f(this.u.u_exposure, (this.look?.exposure || 0) + this.exposureOffset);
  }

  /**
   * Upload a frame. Accepts HTMLVideoElement, HTMLImageElement, ImageBitmap or canvas.
   * Returns false when the source has no pixels yet.
   */
  upload(source) {
    const w = source.videoWidth || source.naturalWidth || source.width || 0;
    const h = source.videoHeight || source.naturalHeight || source.height || 0;
    if (!w || !h) return false;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.srcW = w;
    this.srcH = h;
    return true;
  }

  /**
   * Render the uploaded frame.
   * @param {{aspect?: number, zoom?: number, mirror?: boolean, width: number, height: number}} opts
   *   width/height: output size in device pixels (the canvas is resized to match).
   */
  render(opts) {
    const gl = this.gl;
    const { sx, sy } = cropRect(this.srcW || 4, this.srcH || 3, opts.aspect, opts.zoom || 1);
    const w = Math.max(1, Math.round(opts.width));
    const h = Math.max(1, Math.round(opts.height));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform2f(this.u.u_scale, sx, sy);
    gl.uniform1f(this.u.u_mirror, opts.mirror ? 1 : 0);
    gl.uniform1f(this.u.u_strength, this.strength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Encode the current canvas contents. */
  toBlob(type = 'image/jpeg', quality = 0.94) {
    return new Promise((resolve, reject) => {
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), type, quality);
    });
  }

  /** Read back pixels of the current canvas (used by tests). */
  readPixels() {
    const gl = this.gl;
    const out = new Uint8Array(this.canvas.width * this.canvas.height * 4);
    gl.readPixels(0, 0, this.canvas.width, this.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`Shader link failed: ${log}`);
  }
  return program;
}

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}
