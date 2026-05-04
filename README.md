# Evanline – Wheel Alignment

A **free, open-source** car wheel alignment web app for iPhone, running entirely in Safari.  
Uses the iPhone's built-in **gyroscope & accelerometer** (DeviceOrientation API) — no app install required.

---

## Features

| Feature | Details |
|---|---|
| **Camber mode** | Measure wheel camber angle (tilt relative to vertical) |
| **Toe mode** | Approximate toe-in / toe-out angle with a dedicated zero workflow |
| **Level mode** | Check if the vehicle or surface is left-right level |
| **Pitch mode** | Measure front-to-back pitch angle |
| **Sensor smoothing** | Smooths the live feed and averages recent samples before display |
| **Settled detection** | Shows when the phone is stable enough to trust the reading |
| **Per-mode calibration** | Keeps a separate zero offset for each mode |
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

---

## Accuracy

Phone sensors are **consumer-grade** (±0.1°–0.5° typical error).  
Evanline now smooths live data, waits for stable samples, and saves averaged readings to improve repeatability, but results remain indicative. Professional alignment still requires a calibrated laser rack.

---

## Tech stack

- Pure **HTML / CSS / JavaScript** — zero dependencies, zero build step
- [W3C DeviceOrientation API](https://www.w3.org/TR/orientation-event/)
- PWA manifest for "Add to Home Screen"

---

## License

MIT — see [LICENSE](LICENSE)
