# Evanline – Wheel Alignment

A **free, open-source** car wheel alignment web app for iPhone, running entirely in Safari.  
Uses the iPhone's built-in **gyroscope & accelerometer** (DeviceOrientation API) — no app install required.

---

## Features

| Feature | Details |
|---|---|
| **Camber mode** | Measure wheel-face camber angle (tilt relative to vertical) |
| **Toe (experimental)** | Toe is **not** a sensor reading — a gravity sensor is blind to rotation about vertical and has no centerline reference. The app links to the geometric method (string lines, turn plates, or `atan(rim offset / rim length)`) instead of reporting a fake toe angle |
| **Level mode** | Check if the vehicle or surface is left-right level |
| **Pitch mode** | Measure front-to-back pitch angle |
| **Sensor smoothing** | Smooths the live feed and averages recent samples before display |
| **Settled detection** | Shows when the phone is stable enough to trust the reading |
| **Per-mode calibration** | Keeps a separate zero offset for each mode |
| **Two-point scale calibration** | Optionally capture a known reference angle so readings are scaled as `(raw − zero) × gain`, correcting a sensor that under/over-reports. Defaults to unity gain (no-op) until set |
| **4-corner plane fit** | Fits a least-squares plane to the FL/FR/RL/RR Level baseline and reports per-corner residuals, so a non-coplanar (bad/mis-placed) datum is flagged instead of silently averaged. Level/pitch compensation, and the camber left-right projection, come from the plane slopes |
| **Per-corner save history** | Each save keeps a small rolling history per side and stamps the active zero, scale, orientation/pose, device reference, and fixture. Left-right / front-rear deltas warn when computed across mismatched calibration contexts |
| **Compass awareness** | Reads the absolute compass heading (and Safari accuracy) and warns "heading not trusted" under indoor magnetic distortion; raw `alpha` is never used as a yaw reference |
| **Quick / Precision workflows** | Fast single-save mode or a deeper session with baseline, fixture, and repeatability checks |
| **Device reference** | Capture a trusted device bias reference and reuse it across modes |
| **Fixture profiles** | Save named jig / fixture setups locally, including whether the fixture is reversible |
| **Around-car baseline** | Capture FL / FR / RL / RR level points to establish a session baseline plane |
| **Reversal capture sets** | Pair forward and reversed jig placements to expose mounting bias |
| **Trueness self-test** | Guided 180° flip test: read, flip, read again — a healthy inclinometer is equal-and-opposite, so the residual bias `(a+b)/2` should be near zero |
| **Repeatability scoring** | Score repeated capture sets before accepting a precision measurement (repeatability is *not* trueness) |
| **Saved side readings** | Store FL / FR / RL / RR readings locally and compare deltas |
| **Advanced data** | Hide raw sensor values in an expandable debug section |
| **PWA** | Add to iPhone Home Screen for full-screen experience |

---

## Usage

### Option 1 — GitHub Pages (recommended)

1. Enable GitHub Pages for this repo (Settings → Pages → branch `main`, root `/`).
2. Open the published URL in **Safari** on your iPhone.
3. Tap **"Enable Sensors & Start"** and allow motion access when prompted.

### Option 2 — Local server

```bash
# Any simple HTTP server works, e.g.:
npx serve .
# Then open http://<your-ip>:3000 in Safari on your iPhone
```

> **Note:** DeviceOrientation permission requires a user gesture and HTTPS (or localhost).  
> Loading the file directly via `file://` will not work on iOS 13+.

---

## Better measurement workflow

1. Use **Level** mode first to verify the car or floor is close to level.
2. Switch to the mode you want and tap **Zero This Mode** on a known reference.
3. Match the preferred orientation shown in the app.
4. Hold the phone still until the reading becomes **Settled**.
5. Tap **Save Avg** for FL, FR, RL, or RR and compare the left/right delta.

### Precision workflow

1. Switch from **Quick workflow** to **Precision workflow**.
2. Capture a trusted **device reference** on a known surface.
3. Save or select a named **fixture profile** for your jig or phone mount.
4. In **Level** mode, capture baseline points at **FL, FR, RL, and RR**.
5. For each wheel reading, capture repeated **forward** readings, then repeated **reversed** readings if the fixture is reversible.
6. Save the measurement only after the app reports good **repeatability**, acceptable **reversal bias**, and a trustworthy **baseline**.

---

## Measurement methodology

Honest measurement matters more than a precise-looking digit. Follow these rules every time:

1. **Verify the surface is actually level first.** Use **Level** mode to confirm the floor or car is level before any alignment reading — a tilted reference contaminates every downstream angle.
2. **Register to a defined plane every time.** Camber registers to the machined **wheel face** (clear of the curved lip and decorative spokes — wheel-face camber is *not* tire camber); level/pitch register to a fixed body datum. Re-use the exact same surface on every corner.
3. **Hold quasi-static.** Let the reading **settle**; the app rejects captures while the phone is moving, pressed, or spinning so motion noise cannot leak into the number.
4. **Do the flip test.** Run the **180° flip self-test** before trusting a value: read, flip the phone 180° about the measurement axis, read again. A true inclinometer reads equal-and-opposite, so the residual bias `(a + b) / 2` should be near zero. Repeatability alone is **not** trueness.
5. **Toe is geometric.** The phone cannot measure toe. Use string lines, turn plates, or `atan(front-vs-rear rim offset / rim length)`.
6. **Read the band, not the digit.** Every saved value carries a `± Y.YY° (95%)` confidence band. Treat the band — not the single displayed digit — as the real result.
7. **Scale-calibrate against a known angle (optional).** After zeroing, if you have a machined reference wedge, tap **Set scale**, hold the phone on it, and enter the true angle. The app derives `gain = true / measured` and scales every later reading, correcting a sensor that under/over-reports. Left unset, the gain stays `1.00×` (no change).

---

## Accuracy

Phone sensors are **consumer-grade** (±0.1°–0.5° typical error).  
Evanline now smooths live data, waits for stable samples, and saves averaged readings to improve repeatability, but results remain indicative. Professional alignment still requires a calibrated laser rack.

For higher-accuracy DIY work, design the physical jig around **rigid 3-point wheel-face contact**, avoid using the tire sidewall as the primary datum, and prefer a **symmetric or reversible** phone mount so the precision workflow can cancel mounting bias.

---

## Tech stack

- Pure **HTML / CSS / JavaScript** with modularized app and domain scripts
- [W3C DeviceOrientation API](https://www.w3.org/TR/orientation-event/)
- PWA manifest for "Add to Home Screen"
- Service Worker cache for offline access after first load

---

## Project structure

- `./index.html` — app markup
- `./assets/css/styles.css` — styling
- `./assets/js/app.js` — UI + app orchestration
- `./assets/js/domain.js` — reusable measurement/math logic
- `./service-worker.js` — offline caching

---

## Quality checks

```bash
npm run lint
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full verification checklist and device matrix.

---

## License

MIT — see [LICENSE](LICENSE)
