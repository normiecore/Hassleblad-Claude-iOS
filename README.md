# HCS Cam

A camera web app for iPhone that renders the live feed with a colour pipeline modelled on the character of
Hasselblad's Natural Colour Solution (HNCS), as seen on the X2D II 100C. It installs from Safari as a Progressive
Web App and runs on the device's own cameras: 0.5×, 1×, 4× and Front.

This is an independent project. It is not Hasselblad software and is not affiliated with or endorsed by
Hasselblad.

## Install on an iPhone

1. Open the GitHub Pages URL for this repository in Safari:
   `https://normiecore.github.io/Hassleblad-Claude-iOS/`
2. Tap **Share**, then **Add to Home Screen**.
3. Open HCS Cam from the Home Screen and allow camera access.

The app works offline once installed. Photos are kept in an on-device camera roll until you tap
**Save to Photos**, which opens the iOS share sheet so you can save to the Photos library.

## What it does

- **Four selectable cameras**: 0.5× ultra wide, 1× main, 4× telephoto and Front. Safari exposes each physical
  camera as a separate device; the app picks them by label. On phones without a dedicated telephoto it uses the
  main camera at 4× (native zoom if the track supports it, otherwise a crop) and marks the lens with a dot.
- **Native camera options** wherever Safari exposes them through the media track: zoom (pinch, double-tap to
  reset), torch, and exposure compensation. Controls that the current camera does not support are hidden.
- **Looks**: Natural (default), Portrait and Neutral, plus a strength slider to blend against the untouched
  frame and a software exposure offset.
- **Framing**: 4:3 (the X2D's native ratio), 3:2, 1:1 and 65:24 XPan, with a rule-of-thirds grid and a 3 s or
  10 s timer.
- **Full-resolution capture**: the same shader that drives the preview is run on the full camera frame
  (Safari delivers up to 4032×3024 on recent iPhones) and encoded as JPEG.
- **Import**: grade a photo taken with the built-in Camera app (including HEIC) so you can combine Apple's
  computational capture with this rendering.

## How the colour pipeline works

Everything runs on the GPU in a single WebGL2 fragment shader (`js/pipeline.js`), on the preview and on every
capture, so what you see is what you get.

1. **Linearise** the sRGB frame and apply white balance and exposure.
2. **Convert to Oklab**, a perceptual space where lightness, chroma and hue can be adjusted independently.
3. **Per-hue refinements**: seven overlapping hue bands adjust chroma, hue and lightness. The Natural look
   deepens reds slightly and steers them away from orange, keeps skin natural with a small pull toward pink
   rather than yellow, mutes greens toward olive, leans blues toward cyan so skies do not go purple, and
   restrains magentas. Adjustments fade out at low chroma, so neutrals stay neutral.
4. **Tone curve** on lightness: a medium contrast pivoted on 18% grey with a long, smooth highlight shoulder
   and a gentle toe. Black and white are anchored exactly.
5. **Chroma roll-off** in the deepest shadows and brightest highlights, as a good sensor pipeline does rather
   than clipping to saturated colour.
6. **Gamut mapping** by reducing chroma while holding hue and lightness, so nothing clips to a different hue.
7. **Encode** back to sRGB.

The result is a deliberately restrained rendering: accurate hues, no extra saturation, pleasant skin, smooth
highlights.

### On accuracy

Hasselblad's colour comes from characterising its own sensors and rendering through a proprietary profile.
That data is not public, and an iPhone sensor, lens and image signal processor are different hardware.
What this app can do is reproduce the *character* of that rendering on top of the iPhone's frame, based on
public descriptions and published comparisons. It cannot make the phone measure colour the way a 100 MP
medium-format back does. Two limits worth knowing:

- Safari gives web apps the video pipeline, not the photo pipeline. Frames are already tone-mapped and
  8-bit, and Deep Fusion, Smart HDR and ProRAW are not available. For the best starting point, shoot with the
  Camera app and use **Import**.
- iOS Safari reports the stream as sRGB; wide-gamut (Display P3) information from the camera is not preserved
  in the browser.

Look parameters are in `LOOKS` at the top of `js/pipeline.js` and can be tuned without touching GLSL.

## Development

No build step. Serve the folder over HTTP and open it:

```sh
npm start          # http://localhost:8080
npm run icons      # regenerate icons/ with tools/make-icons.mjs
npm test           # unit tests plus a headless Chromium smoke test (needs `npm i -D playwright`)
```

The smoke test drives the app with Chromium's fake camera, checks the shader compiles, captures a photo, runs
the import path, and verifies the colour pipeline on reference patches (neutrals stay neutral, black and white
are anchored, skin hue moves less than 5°, greens are restrained, blues lean cyan).

Camera access requires a secure context: `localhost` or HTTPS.

## Deployment

`.github/workflows/pages.yml` deploys the repository root to GitHub Pages with the official Pages actions on
every push to `main`, and can also be run manually from the Actions tab. It stamps the commit SHA into the
service worker and page so installed apps pick up new versions (a toast offers to reload).

**One-time setup**: the Actions token is not allowed to create the Pages site itself, so before the first
deploy open **Settings → Pages** and set **Source** to **GitHub Actions**. Then re-run the failed
"Deploy to GitHub Pages" run from the Actions tab (or push again). Every later push deploys automatically.

## Project layout

```
index.html               App shell and dialogs
css/app.css              Styles (dark, safe-area aware, phone-first)
js/app.js                Camera control, UI, capture, import, camera roll
js/pipeline.js           WebGL2 colour pipeline and look definitions
js/lenses.js             Camera discovery and lens fallbacks
js/store.js              IndexedDB camera roll
sw.js                    Service worker (offline app shell)
manifest.webmanifest     PWA manifest
icons/                   Generated icons (tools/make-icons.mjs)
tests/                   Unit and smoke tests
.github/workflows/       GitHub Pages deployment
```

## Licence

MIT.
