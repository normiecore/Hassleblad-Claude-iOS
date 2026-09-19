import { Pipeline, LOOKS, LOOK_ORDER, cropRect } from './pipeline.js';
import { LENS_ORDER, LENS_META, classifyDevices, resolveLens, buildConstraints, formatZoom } from './lenses.js';
import * as store from './store.js';

const ASPECTS = [
  { id: '4:3', value: 4 / 3, label: '4:3' },
  { id: '3:2', value: 3 / 2, label: '3:2' },
  { id: '1:1', value: 1, label: '1:1' },
  { id: 'xpan', value: 65 / 24, label: 'XPan' },
];
const TIMERS = [0, 3, 10];
const MAX_DIGITAL_ZOOM = 4;
const IMPORT_MAX_EDGE = 6000;
const SETTINGS_KEY = 'hcs-cam.settings.v1';

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'),
  frame: $('frame'),
  viewfinder: $('viewfinder'),
  preview: $('preview'),
  grid: $('grid'),
  zoomBadge: $('zoom-badge'),
  lensNote: $('lens-note'),
  countdown: $('countdown'),
  flash: $('flash'),
  status: $('status'),
  torch: $('btn-torch'),
  timer: $('btn-timer'),
  timerTag: $('timer-tag'),
  aspect: $('btn-aspect'),
  gridBtn: $('btn-grid'),
  settingsBtn: $('btn-settings'),
  shutter: $('btn-shutter'),
  galleryBtn: $('btn-gallery'),
  thumbImg: $('thumb-img'),
  thumbCount: $('thumb-count'),
  fileInput: $('file-input'),
  lensButtons: [...document.querySelectorAll('.lenses button')],
  sheetSettings: $('sheet-settings'),
  sheetGallery: $('sheet-gallery'),
  lookPicker: $('look-picker'),
  lookDescription: $('look-description'),
  strength: $('strength'),
  strengthOut: $('strength-out'),
  evSoft: $('ev-soft'),
  evSoftOut: $('ev-soft-out'),
  evNativeRow: $('ev-native-row'),
  evNative: $('ev-native'),
  evNativeOut: $('ev-native-out'),
  facts: $('facts'),
  installHint: $('install-hint'),
  buildId: $('build-id'),
  galleryGrid: $('gallery-grid'),
  galleryEmpty: $('gallery-empty'),
  viewer: $('viewer'),
  viewerImg: $('viewer-img'),
  viewerMeta: $('viewer-meta'),
  viewerBack: $('viewer-back'),
  viewerShare: $('viewer-share'),
  viewerDelete: $('viewer-delete'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
};

const settings = loadSettings();

const state = {
  stream: null,
  track: null,
  caps: {},
  found: { virtual: [], unknown: [] },
  devicesResolved: false,
  lens: settings.lens,
  resolved: null,
  lensDigitalZoom: 1,     // extra crop applied when a lens is emulated (e.g. 4× on the main camera)
  nativeBaseZoom: 1,      // native zoom value the current lens starts at
  userZoom: 1,            // pinch zoom on top of the lens
  nativeZoom: false,      // whether pinch is applied through the camera's own zoom constraint
  mirror: false,
  torch: false,
  busy: false,
  frameHandle: 0,
  frameW: 0,
  frameH: 0,
  restartedForLabels: false,
  starting: null,
  galleryUrls: [],
  viewing: null,
};

let preview;
let capturePipeline;

/* ------------------------------------------------------------------ boot */

init().catch((e) => showStatus(describeError(e), true));

async function init() {
  el.buildId.textContent = buildIdFromSw() || 'dev';

  try {
    preview = new Pipeline(el.preview);
  } catch (e) {
    throw new Error(`This browser cannot run the colour pipeline. ${e.message}`);
  }

  buildLookPicker();
  applyLook(settings.look);
  setStrength(settings.strength);
  setSoftEv(settings.evSoft);
  setAspect(settings.aspect);
  setTimer(settings.timer);
  setGrid(settings.grid);
  bindUi();
  observeFrameSize();
  refreshThumb();
  registerServiceWorker();
  showInstallHintIfNeeded();

  if (!window.isSecureContext) {
    throw new Error('Camera access needs a secure (https) page.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose the camera to web apps.');
  }

  await startCamera(state.lens);
  requestWakeLock();
}

/* ------------------------------------------------------------ settings */

function loadSettings() {
  const defaults = { look: 'natural', strength: 1, aspect: '4:3', timer: 0, grid: false, lens: 'wide', evSoft: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const merged = { ...defaults, ...saved };
    if (!LOOKS[merged.look]) merged.look = defaults.look;
    if (!ASPECTS.some((a) => a.id === merged.aspect)) merged.aspect = defaults.aspect;
    if (!LENS_ORDER.includes(merged.lens)) merged.lens = defaults.lens;
    if (!TIMERS.includes(merged.timer)) merged.timer = 0;
    return merged;
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

/* ------------------------------------------------------------------ UI */

function bindUi() {
  el.lensButtons.forEach((b) => b.addEventListener('click', () => selectLens(b.dataset.lens)));
  el.shutter.addEventListener('click', () => capture().catch((e) => toast(describeError(e))));
  el.aspect.addEventListener('click', () => {
    const i = ASPECTS.findIndex((a) => a.id === settings.aspect);
    setAspect(ASPECTS[(i + 1) % ASPECTS.length].id);
  });
  el.timer.addEventListener('click', () => setTimer(TIMERS[(TIMERS.indexOf(settings.timer) + 1) % TIMERS.length]));
  el.gridBtn.addEventListener('click', () => setGrid(!settings.grid));
  el.torch.addEventListener('click', () => setTorch(!state.torch).catch((e) => toast(describeError(e))));
  el.settingsBtn.addEventListener('click', () => { updateFacts(); el.sheetSettings.showModal(); });
  el.galleryBtn.addEventListener('click', () => openGallery().catch((e) => toast(describeError(e))));
  el.fileInput.addEventListener('change', () => {
    const file = el.fileInput.files?.[0];
    el.fileInput.value = '';
    if (file) importFile(file).catch((e) => toast(describeError(e)));
  });

  document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  for (const dialog of [el.sheetSettings, el.sheetGallery]) {
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  el.sheetGallery.addEventListener('close', releaseGalleryUrls);

  el.strength.addEventListener('input', () => setStrength(el.strength.valueAsNumber / 100));
  el.evSoft.addEventListener('input', () => setSoftEv(el.evSoft.valueAsNumber));
  el.evNative.addEventListener('input', () => applyNativeEv(el.evNative.valueAsNumber).catch(() => {}));

  el.viewerBack.addEventListener('click', () => el.viewer.close());
  el.viewer.addEventListener('close', () => {
    if (el.viewerImg.src) URL.revokeObjectURL(el.viewerImg.src);
    el.viewerImg.removeAttribute('src');
    state.viewing = null;
  });
  el.viewerShare.addEventListener('click', () => state.viewing && shareRecord(state.viewing));
  el.viewerDelete.addEventListener('click', async () => {
    if (!state.viewing) return;
    await store.deletePhoto(state.viewing.id);
    el.viewer.close();
    refreshThumb();
    if (el.sheetGallery.open) openGallery();
  });

  bindPinchZoom();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopStream();
    else startCamera(state.lens).catch((e) => showStatus(describeError(e), true));
  });
  window.addEventListener('pagehide', stopStream);

  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !e.repeat && document.activeElement?.tagName !== 'INPUT' && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      capture().catch((err) => toast(describeError(err)));
    }
  });
}

function buildLookPicker() {
  el.lookPicker.replaceChildren(...LOOK_ORDER.map((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.look = id;
    b.textContent = LOOKS[id].name;
    b.addEventListener('click', () => applyLook(id));
    return b;
  }));
}

function applyLook(id) {
  const look = LOOKS[id] || LOOKS.natural;
  settings.look = look.id;
  saveSettings();
  preview.setLook(look);
  el.lookDescription.textContent = look.description;
  for (const b of el.lookPicker.children) b.setAttribute('aria-checked', String(b.dataset.look === look.id));
}

function setStrength(v) {
  settings.strength = Math.min(1, Math.max(0, v));
  saveSettings();
  preview.setStrength(settings.strength);
  el.strength.value = String(Math.round(settings.strength * 100));
  el.strengthOut.textContent = `${Math.round(settings.strength * 100)}%`;
}

function setSoftEv(ev) {
  settings.evSoft = Math.round(ev * 3) / 3;
  saveSettings();
  preview.setExposureOffset(settings.evSoft);
  el.evSoft.value = String(settings.evSoft);
  el.evSoftOut.textContent = formatEv(settings.evSoft);
}

function setAspect(id) {
  settings.aspect = id;
  saveSettings();
  el.aspect.textContent = currentAspect().label;
  layoutFrame();
}

function setTimer(seconds) {
  settings.timer = seconds;
  saveSettings();
  el.timer.dataset.value = String(seconds);
  el.timer.setAttribute('aria-pressed', String(seconds > 0));
  el.timerTag.hidden = seconds === 0;
  el.timerTag.textContent = `${seconds}s`;
  el.timer.setAttribute('aria-label', seconds ? `Self timer, ${seconds} seconds` : 'Self timer, off');
}

function setGrid(on) {
  settings.grid = !!on;
  saveSettings();
  el.grid.hidden = !settings.grid;
  el.gridBtn.setAttribute('aria-pressed', String(settings.grid));
}

function currentAspect() {
  return ASPECTS.find((a) => a.id === settings.aspect) || ASPECTS[0];
}

/** The aspect to crop to, oriented to match the incoming frames (portrait frames get a portrait crop). */
function effectiveAspect() {
  const a = currentAspect().value;
  const w = el.video.videoWidth || 3;
  const h = el.video.videoHeight || 4;
  return w < h ? 1 / a : a;
}

function shaderZoom() {
  return state.lensDigitalZoom * (state.nativeZoom ? 1 : state.userZoom);
}

function displayedZoom() {
  return LENS_META[state.lens].base * state.userZoom;
}

function updateZoomBadge() {
  el.zoomBadge.textContent = formatZoom(displayedZoom());
  el.zoomBadge.hidden = false;
}

/* --------------------------------------------------------------- layout */

function observeFrameSize() {
  const ro = new ResizeObserver(layoutFrame);
  ro.observe(el.viewfinder);
  layoutFrame();
}

function layoutFrame() {
  const box = el.viewfinder.getBoundingClientRect();
  const aspect = effectiveAspect();
  let w = box.width;
  let h = w / aspect;
  if (h > box.height) { h = box.height; w = h * aspect; }
  w = Math.floor(w);
  h = Math.floor(h);
  el.frame.style.width = `${w}px`;
  el.frame.style.height = `${h}px`;
  el.frame.style.aspectRatio = 'auto';
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  state.frameW = Math.round(w * dpr);
  state.frameH = Math.round(h * dpr);
}

/* --------------------------------------------------------------- camera */

async function startCamera(lensKey) {
  if (state.starting) await state.starting.catch(() => {});
  state.starting = (async () => {
    stopStream();
    setLensButtons(lensKey);
    showStatus('Starting camera…');
    el.lensNote.hidden = true;

    let resolved = resolveLens(lensKey, state.found);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(buildConstraints(resolved));
    } catch (e) {
      if (resolved.deviceId && e.name !== 'NotAllowedError') {
        resolved = { ...resolved, deviceId: undefined, exact: false };
        stream = await navigator.mediaDevices.getUserMedia(buildConstraints(resolved));
      } else {
        throw e;
      }
    }

    // Labels are only revealed after permission. Re-classify once, and reopen if a better match exists.
    if (!state.devicesResolved) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.found = classifyDevices(devices.filter((d) => d.kind === 'videoinput'));
      state.devicesResolved = true;
      markLensAvailability();
      const better = resolveLens(lensKey, state.found);
      if (better.exact && !resolved.exact && !state.restartedForLabels) {
        state.restartedForLabels = true;
        stream.getTracks().forEach((t) => t.stop());
        state.starting = null;
        return startCamera(lensKey);
      }
    }

    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    state.lens = lensKey;
    state.resolved = resolved;
    settings.lens = lensKey;
    saveSettings();

    const track = state.track;
    track.addEventListener('ended', () => {
      // Only react if this track is still the live one (stopping a track during a lens switch must not restart it).
      if (state.track === track && !document.hidden) {
        startCamera(state.lens).catch((e) => showStatus(describeError(e), true));
      }
    });

    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    await waitForVideoSize(el.video);

    state.caps = safeCapabilities(state.track);
    const trackSettings = state.track.getSettings?.() || {};
    state.mirror = trackSettings.facingMode === 'user' || (lensKey === 'front' && trackSettings.facingMode !== 'environment');

    // Zoom handling for the lens.
    state.userZoom = 1;
    state.lensDigitalZoom = 1;
    state.nativeZoom = false;
    state.nativeBaseZoom = 1;
    if (state.caps.zoom && Number.isFinite(state.caps.zoom.min) && Number.isFinite(state.caps.zoom.max)) {
      const wanted = resolved.nativeZoomWanted;
      const base = Math.min(Math.max(wanted, state.caps.zoom.min), state.caps.zoom.max);
      const usableRange = state.caps.zoom.max / base >= 1.2;
      state.nativeZoom = usableRange;
      state.nativeBaseZoom = base;
      if (base < wanted - 0.01) state.lensDigitalZoom = wanted / base;
      await applyConstraint({ zoom: base }).catch(() => { state.nativeZoom = false; state.lensDigitalZoom = resolved.digitalZoom; });
    } else {
      state.lensDigitalZoom = resolved.digitalZoom;
    }

    setupTorch();
    setupNativeEv();
    if (resolved.note) { el.lensNote.textContent = resolved.note; el.lensNote.hidden = false; }
    updateZoomBadge();
    layoutFrame();
    hideStatus();
    startFrames();
  })();
  try {
    await state.starting;
  } finally {
    state.starting = null;
  }
}

function stopStream() {
  stopFrames();
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    state.track = null;
  }
  el.video.srcObject = null;
  state.torch = false;
  el.torch.setAttribute('aria-pressed', 'false');
}

async function selectLens(key) {
  if (key === state.lens && state.stream) return;
  try {
    await startCamera(key);
  } catch (e) {
    showStatus(describeError(e), true);
  }
}

function setLensButtons(active) {
  for (const b of el.lensButtons) b.setAttribute('aria-pressed', String(b.dataset.lens === active));
}

function markLensAvailability() {
  for (const b of el.lensButtons) {
    const key = b.dataset.lens;
    const r = resolveLens(key, state.found);
    b.dataset.fallback = String(!r.exact);
    b.title = r.exact ? LENS_META[key].title : (r.note || `${LENS_META[key].title} (not available)`);
  }
}

function safeCapabilities(track) {
  try { return track.getCapabilities ? track.getCapabilities() : {}; } catch { return {}; }
}

let pendingConstraint = null;
async function applyConstraint(values) {
  if (!state.track) return;
  // Coalesce rapid pinch updates into one in-flight applyConstraints call.
  pendingConstraint = values;
  if (applyConstraint.inflight) return applyConstraint.inflight;
  applyConstraint.inflight = (async () => {
    while (pendingConstraint) {
      const v = pendingConstraint;
      pendingConstraint = null;
      await state.track.applyConstraints({ advanced: [v] });
    }
  })().finally(() => { applyConstraint.inflight = null; });
  return applyConstraint.inflight;
}

function waitForVideoSize(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('loadedmetadata', done); video.removeEventListener('resize', done); resolve(); };
    video.addEventListener('loadedmetadata', done);
    video.addEventListener('resize', done);
    setTimeout(done, 2000);
  });
}

/* -------------------------------------------------------- native options */

function setupTorch() {
  const supported = !!state.caps.torch;
  el.torch.hidden = !supported;
  state.torch = false;
  el.torch.setAttribute('aria-pressed', 'false');
}

async function setTorch(on) {
  if (!state.caps.torch) return;
  await state.track.applyConstraints({ advanced: [{ torch: on }] });
  state.torch = on;
  el.torch.setAttribute('aria-pressed', String(on));
}

function setupNativeEv() {
  const c = state.caps.exposureCompensation;
  const ok = c && Number.isFinite(c.min) && Number.isFinite(c.max) && c.max > c.min;
  el.evNativeRow.hidden = !ok;
  if (!ok) return;
  el.evNative.min = String(c.min);
  el.evNative.max = String(c.max);
  el.evNative.step = String(c.step || 0.333);
  const current = state.track.getSettings?.().exposureCompensation ?? 0;
  el.evNative.value = String(current);
  el.evNativeOut.textContent = formatEv(current);
}

async function applyNativeEv(v) {
  el.evNativeOut.textContent = formatEv(v);
  await applyConstraint({ exposureCompensation: v });
}

/* ---------------------------------------------------------- pinch zoom */

function bindPinchZoom() {
  const pointers = new Map();
  let startDist = 0;
  let startZoom = 1;
  let lastTap = 0;

  el.frame.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, e);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      startDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      startZoom = state.userZoom;
    } else if (pointers.size === 1 && e.pointerType === 'touch') {
      const now = performance.now();
      if (now - lastTap < 300) { setUserZoom(1); lastTap = 0; } else lastTap = now;
    }
  });
  el.frame.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, e);
    if (pointers.size === 2 && startDist > 0) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setUserZoom(startZoom * (dist / startDist));
    }
  });
  const up = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) startDist = 0; };
  el.frame.addEventListener('pointerup', up);
  el.frame.addEventListener('pointercancel', up);
  el.frame.addEventListener('pointerleave', up);
  el.frame.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setUserZoom(state.userZoom * Math.exp(-e.deltaY * 0.01));
  }, { passive: false });
}

function setUserZoom(z) {
  let max = MAX_DIGITAL_ZOOM;
  if (state.nativeZoom && state.caps.zoom) max = state.caps.zoom.max / state.nativeBaseZoom;
  state.userZoom = Math.min(max, Math.max(1, z));
  if (state.nativeZoom) applyConstraint({ zoom: state.nativeBaseZoom * state.userZoom }).catch(() => {});
  updateZoomBadge();
}

/* --------------------------------------------------------------- frames */

function startFrames() {
  stopFrames();
  const video = el.video;
  const useVfc = typeof video.requestVideoFrameCallback === 'function';
  const tick = () => {
    state.frameHandle = 0;
    renderPreview();
    schedule();
  };
  const schedule = () => {
    if (!state.stream) return;
    state.frameHandle = useVfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  state.frameUsesVfc = useVfc;
  schedule();
}

function stopFrames() {
  if (!state.frameHandle) return;
  if (state.frameUsesVfc) el.video.cancelVideoFrameCallback?.(state.frameHandle);
  else cancelAnimationFrame(state.frameHandle);
  state.frameHandle = 0;
}

function renderPreview() {
  const video = el.video;
  if (video.readyState < 2 || !state.frameW) return;
  if (!preview.upload(video)) return;
  preview.render({ aspect: effectiveAspect(), zoom: shaderZoom(), mirror: state.mirror, width: state.frameW, height: state.frameH });
}

/* -------------------------------------------------------------- capture */

function ensureCapturePipeline() {
  if (!capturePipeline) capturePipeline = new Pipeline(document.createElement('canvas'), { preserveDrawingBuffer: true });
  capturePipeline.setLook(LOOKS[settings.look]);
  capturePipeline.setStrength(settings.strength);
  capturePipeline.setExposureOffset(settings.evSoft);
  return capturePipeline;
}

async function capture() {
  if (state.busy || !state.stream || el.video.readyState < 2) return;
  state.busy = true;
  el.shutter.disabled = true;
  try {
    if (settings.timer > 0) await countdown(settings.timer);
    flash();
    const pipe = ensureCapturePipeline();
    const w = el.video.videoWidth;
    const h = el.video.videoHeight;
    const aspect = effectiveAspect();
    const zoom = shaderZoom();
    const crop = cropRect(w, h, aspect, zoom);
    const scale = Math.min(1, pipe.maxTextureSize / Math.max(w, h));
    pipe.upload(el.video);
    pipe.render({ aspect, zoom, mirror: false, width: crop.w * scale, height: crop.h * scale });
    const blob = await pipe.toBlob('image/jpeg', 0.94);
    const record = await store.addPhoto({
      blob,
      width: pipe.canvas.width,
      height: pipe.canvas.height,
      lens: state.lens,
      look: settings.look,
      name: fileName(),
    });
    refreshThumb(record);
    toast('Saved to camera roll', 'Save to Photos', () => shareRecord(record));
  } finally {
    state.busy = false;
    el.shutter.disabled = false;
  }
}

function countdown(seconds) {
  return new Promise((resolve) => {
    let n = seconds;
    el.countdown.hidden = false;
    el.countdown.textContent = String(n);
    const id = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(id); el.countdown.hidden = true; resolve(); }
      else el.countdown.textContent = String(n);
    }, 1000);
  });
}

function flash() {
  el.flash.classList.remove('on');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
}

function fileName(prefix = 'HCS') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

/* --------------------------------------------------------------- import */

async function importFile(file) {
  toast('Grading photo…');
  const source = await decodeImage(file);
  try {
    const pipe = ensureCapturePipeline();
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    const maxEdge = Math.min(IMPORT_MAX_EDGE, pipe.maxTextureSize);
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    let uploadSource = source;
    if (Math.max(w, h) > pipe.maxTextureSize) {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
      uploadSource = c;
    }
    pipe.upload(uploadSource);
    pipe.render({ aspect: null, zoom: 1, mirror: false, width: Math.round(w * scale), height: Math.round(h * scale) });
    const blob = await pipe.toBlob('image/jpeg', 0.94);
    const record = await store.addPhoto({
      blob, width: pipe.canvas.width, height: pipe.canvas.height, lens: 'import', look: settings.look, name: fileName('HCS_import'),
    });
    refreshThumb(record);
    hideToast();
    openViewer(record);
  } finally {
    if (typeof source.close === 'function') source.close();
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* fall through: HEIC or unsupported */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/* ------------------------------------------------------------- sharing */

async function shareRecord(record) {
  const file = new File([record.blob], record.name, { type: 'image/jpeg', lastModified: record.ts });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(record.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = record.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* -------------------------------------------------------------- gallery */

async function refreshThumb(latest) {
  const photos = latest ? null : await store.listPhotos();
  const first = latest || photos?.[0];
  const count = photos ? photos.length : await store.countPhotos();
  if (el.thumbImg.src) URL.revokeObjectURL(el.thumbImg.src);
  if (first) {
    el.thumbImg.src = URL.createObjectURL(first.blob);
    el.thumbImg.hidden = false;
  } else {
    el.thumbImg.removeAttribute('src');
    el.thumbImg.hidden = true;
  }
  el.thumbCount.hidden = count === 0;
  el.thumbCount.textContent = String(count);
}

async function openGallery() {
  releaseGalleryUrls();
  const photos = await store.listPhotos();
  el.galleryEmpty.hidden = photos.length > 0;
  el.galleryGrid.replaceChildren(...photos.map((p) => {
    const b = document.createElement('button');
    b.type = 'button';
    const img = document.createElement('img');
    const url = URL.createObjectURL(p.blob);
    state.galleryUrls.push(url);
    img.src = url;
    img.alt = `Photo ${new Date(p.ts).toLocaleString()}`;
    img.loading = 'lazy';
    b.append(img);
    b.addEventListener('click', () => openViewer(p));
    return b;
  }));
  if (!el.sheetGallery.open) el.sheetGallery.showModal();
}

function releaseGalleryUrls() {
  state.galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  state.galleryUrls = [];
}

function openViewer(record) {
  state.viewing = record;
  el.viewerImg.src = URL.createObjectURL(record.blob);
  const lens = record.lens === 'import' ? 'Imported' : `${LENS_META[record.lens]?.title || record.lens}`;
  el.viewerMeta.textContent = `${lens} · ${LOOKS[record.look]?.name || record.look} · ${record.width}×${record.height}`;
  if (!el.viewer.open) el.viewer.showModal();
}

/* --------------------------------------------------------------- facts */

function updateFacts() {
  const s = state.track?.getSettings?.() || {};
  const label = state.track?.label || '—';
  const rows = [
    ['Lens', `${LENS_META[state.lens].title}${state.resolved?.exact ? '' : ' (fallback)'}`],
    ['Device', label],
    ['Stream', s.width && s.height ? `${s.width}×${s.height}${s.frameRate ? ` @ ${Math.round(s.frameRate)} fps` : ''}` : '—'],
    ['Zoom', `${formatZoom(displayedZoom())}${state.nativeZoom ? ' (camera zoom)' : shaderZoom() > 1 ? ' (digital crop)' : ''}`],
    ['Controls', [state.caps.zoom && 'zoom', state.caps.torch && 'torch', state.caps.exposureCompensation && 'exposure', state.caps.focusMode && 'focus', state.caps.whiteBalanceMode && 'white balance'].filter(Boolean).join(', ') || 'auto only'],
    ['Installed', isStandalone() ? 'yes' : 'no (running in browser)'],
  ];
  el.facts.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

/* -------------------------------------------------------------- helpers */

function showStatus(text, isError = false) {
  el.status.textContent = text;
  el.status.hidden = false;
  el.status.classList.toggle('error', isError);
}
function hideStatus() { el.status.hidden = true; }

let toastTimer = 0;
function toast(text, actionLabel, action) {
  clearTimeout(toastTimer);
  el.toastText.textContent = text;
  el.toast.hidden = false;
  if (actionLabel && action) {
    el.toastAction.textContent = actionLabel;
    el.toastAction.hidden = false;
    el.toastAction.onclick = () => { hideToast(); action(); };
  } else {
    el.toastAction.hidden = true;
    el.toastAction.onclick = null;
  }
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2500);
}
function hideToast() { el.toast.hidden = true; }

function formatEv(v) {
  const r = Math.round(v * 3) / 3;
  if (Math.abs(r) < 0.01) return '0 EV';
  return `${r > 0 ? '+' : ''}${r.toFixed(1).replace(/\.0$/, '')} EV`;
}

function describeError(e) {
  const name = e?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera access was denied. Allow the camera for this site in Settings and reopen the app.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No suitable camera was found.';
  if (name === 'NotReadableError') return 'The camera is in use by another app.';
  return e?.message || String(e);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function showInstallHintIfNeeded() {
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  el.installHint.hidden = !(isIos && !isStandalone());
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    let lock = await navigator.wakeLock.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden && lock?.released) {
        try { lock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
      }
    });
  } catch { /* ignore, not critical */ }
}

function buildIdFromSw() {
  const b = document.documentElement.dataset.build;
  return b && !b.startsWith('__') ? b : null;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update ready', 'Reload', () => { sw.postMessage('skipWaiting'); });
          }
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
    } catch (e) {
      console.warn('Service worker registration failed', e);
    }
  });
}

/* Exposed for automated tests and debugging. */
window.__hcs = {
  state,
  settings,
  LOOKS,
  get preview() { return preview; },
  ensureCapturePipeline,
  renderPreview,
  applyLook,
  setStrength,
  cropRect,
};
