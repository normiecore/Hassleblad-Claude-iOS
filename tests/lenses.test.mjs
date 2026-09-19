import assert from 'node:assert/strict';
import { classifyDevices, resolveLens, formatZoom } from '../js/lenses.js';

const iphone = [
  { deviceId: 'f', kind: 'videoinput', label: 'Front Camera' },
  { deviceId: 'b', kind: 'videoinput', label: 'Back Camera' },
  { deviceId: 'uw', kind: 'videoinput', label: 'Back Ultra Wide Camera' },
  { deviceId: 't', kind: 'videoinput', label: 'Back Telephoto Camera' },
  { deviceId: 'dw', kind: 'videoinput', label: 'Back Dual Wide Camera' },
  { deviceId: 'tr', kind: 'videoinput', label: 'Back Triple Camera' },
  { deviceId: 'dv', kind: 'videoinput', label: 'Desk View Camera' },
];
let f = classifyDevices(iphone);
assert.equal(f.front.deviceId, 'f');
assert.equal(f.wide.deviceId, 'b');
assert.equal(f.uw.deviceId, 'uw');
assert.equal(f.tele.deviceId, 't');
assert.deepEqual(f.virtual.map((d) => d.deviceId), ['dw', 'tr', 'dv']);
for (const k of ['uw', 'wide', 'tele', 'front']) assert.equal(resolveLens(k, f).exact, true, k);

// Two-camera phone: telephoto falls back to the main camera at 4x, ultra wide falls back to main.
f = classifyDevices(iphone.filter((d) => ['f', 'b'].includes(d.deviceId)));
const tele = resolveLens('tele', f);
assert.equal(tele.exact, false);
assert.equal(tele.deviceId, 'b');
assert.equal(tele.nativeZoomWanted, 4);
assert.equal(tele.digitalZoom, 4);
const uw = resolveLens('uw', f);
assert.equal(uw.exact, false);
assert.equal(uw.deviceId, 'b');

// Before permission: labels are empty. Everything is unknown; wide picks the first, front uses facingMode.
f = classifyDevices([{ deviceId: 'a', kind: 'videoinput', label: '' }, { deviceId: 'b', kind: 'videoinput', label: '' }]);
assert.equal(f.wide.deviceId, 'a');
assert.equal(f.front.deviceId, 'b');
f = classifyDevices([{ deviceId: 'a', kind: 'videoinput', label: '' }]);
assert.equal(resolveLens('front', f).facing, 'user');
assert.equal(resolveLens('front', f).deviceId, undefined);

// Android-style labels.
f = classifyDevices([
  { deviceId: '0', kind: 'videoinput', label: 'camera2 0, facing back' },
  { deviceId: '1', kind: 'videoinput', label: 'camera2 1, facing front' },
  { deviceId: '2', kind: 'videoinput', label: 'camera2 2, facing back (ultrawide)' },
]);
assert.equal(f.wide.deviceId, '0');
assert.equal(f.front.deviceId, '1');
assert.equal(f.uw.deviceId, '2');

assert.equal(formatZoom(1), '1×');
assert.equal(formatZoom(0.5), '0.5×');
assert.equal(formatZoom(1.34), '1.3×');
assert.equal(formatZoom(4.02), '4×');
console.log('lenses.test.mjs: ok');
