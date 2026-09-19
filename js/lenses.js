/**
 * Lens discovery. iOS Safari exposes the physical cameras as separate video inputs with labels such as
 * "Back Ultra Wide Camera", "Back Camera", "Back Telephoto Camera" and "Front Camera" (labels are only
 * available after camera permission has been granted). This module maps those to the four selectable
 * lenses and provides fallbacks for devices that expose fewer cameras.
 */

export const LENS_ORDER = ['uw', 'wide', 'tele', 'front'];

export const LENS_META = {
  uw:    { key: 'uw',    label: '0.5',   title: 'Ultra wide',      facing: 'environment', base: 0.5, targetZoom: 1 },
  wide:  { key: 'wide',  label: '1',     title: 'Main',            facing: 'environment', base: 1,   targetZoom: 1 },
  tele:  { key: 'tele',  label: '4',     title: 'Telephoto',       facing: 'environment', base: 4,   targetZoom: 4 },
  front: { key: 'front', label: 'Front', title: 'Front',           facing: 'user',        base: 1,   targetZoom: 1 },
};

/**
 * Classify MediaDeviceInfo video inputs by label.
 * @param {Array<{deviceId: string, label: string, kind: string}>} devices
 * @returns {{uw?: object, wide?: object, tele?: object, front?: object, virtual: object[], unknown: object[]}}
 */
export function classifyDevices(devices) {
  const found = { virtual: [], unknown: [] };
  for (const d of devices) {
    if (d.kind && d.kind !== 'videoinput') continue;
    const l = (d.label || '').toLowerCase();
    if (!l) { found.unknown.push(d); continue; }
    if (/front|user|facetime|selfie/.test(l)) { found.front ??= d; continue; }
    if (/ultra|0\.5x|ultrawide/.test(l)) { found.uw ??= d; continue; }
    if (/tele|zoom/.test(l)) { found.tele ??= d; continue; }
    if (/dual|triple|desk view|virtual|continuity/.test(l)) { found.virtual.push(d); continue; }
    if (/back|rear|environment|wide|main/.test(l)) { found.wide ??= d; continue; }
    found.unknown.push(d);
  }
  if (!found.wide) {
    found.wide = found.unknown[0] || found.virtual[0];
  }
  if (!found.front && found.unknown.length > 1) {
    found.front = found.unknown[1];
  }
  return found;
}

/**
 * Decide how to open a lens given what the device exposes.
 * @returns {{deviceId?: string, facing: string, digitalZoom: number, nativeZoomWanted: number, note?: string, exact: boolean}}
 */
export function resolveLens(key, found) {
  const meta = LENS_META[key];
  const device = found[key];
  if (device) {
    return { deviceId: device.deviceId, facing: meta.facing, digitalZoom: 1, nativeZoomWanted: 1, exact: true };
  }
  if (key === 'tele') {
    // No dedicated telephoto exposed: use the main camera and ask for 4x. If the track supports a native
    // zoom range that covers 4x we use it (on multi-camera devices this switches lenses), otherwise we crop.
    return {
      deviceId: found.wide?.deviceId,
      facing: 'environment',
      digitalZoom: 4,
      nativeZoomWanted: 4,
      exact: false,
      note: 'No telephoto camera exposed. Using the main camera at 4×.',
    };
  }
  if (key === 'uw') {
    return {
      deviceId: found.wide?.deviceId,
      facing: 'environment',
      digitalZoom: 1,
      nativeZoomWanted: 1,
      exact: false,
      note: 'No ultra wide camera exposed. Using the main camera.',
    };
  }
  return { deviceId: undefined, facing: meta.facing, digitalZoom: 1, nativeZoomWanted: 1, exact: false };
}

/** Build getUserMedia constraints for a resolved lens. */
export function buildConstraints(resolved, opts = {}) {
  const video = {
    width: { ideal: opts.width || 4032 },
    height: { ideal: opts.height || 3024 },
    frameRate: { ideal: 30, max: 60 },
  };
  if (resolved.deviceId) video.deviceId = { exact: resolved.deviceId };
  else video.facingMode = { ideal: resolved.facing };
  return { video, audio: false };
}

/** Format a zoom factor the way the iOS Camera app does (0.5×, 1×, 1.3×, 4×). */
export function formatZoom(z) {
  if (Math.abs(z - Math.round(z)) < 0.05) return `${Math.round(z)}×`;
  return `${z.toFixed(1)}×`;
}
