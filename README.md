# Evanline – Wheel Alignment

A **free, open-source** car wheel alignment web app for iPhone, running entirely in Safari.  
Uses the iPhone's built-in **gyroscope & accelerometer** (DeviceOrientation API) — no app install required.

---

## Features

| Feature | Details |
|---|---|
| **Camber mode** | Measure wheel camber angle (tilt relative to vertical) |
| **Toe mode** | Approximate toe-in / toe-out angle |
| **Level mode** | Check if the vehicle or surface is left-right level |
| **Pitch mode** | Measure front-to-back pitch angle |
| **Bubble level** | Animated visual level indicator |
| **Arc gauge** | Live needle gauge with ±30° range |
| **Calibration** | Zero/calibrate on any reference position |
| **Lock reading** | Freeze the current reading to note it down |
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

## How to measure camber

1. Park on level ground. Use **Level** mode to verify the surface.
2. Switch to **Camber** mode.
3. Place the phone flat against the wheel face (hub area), screen facing outward.
4. Tap **Zero / Calibrate** if you want to zero on a known reference first.
5. Read the angle. Typical spec: **−0.5° to −1.5°** negative camber for most road cars.
6. Tap **⏸ Lock** to freeze the reading while you record it.

---

## Accuracy

Phone sensors are **consumer-grade** (±0.1°–0.5° typical error).  
Results are indicative and suitable for DIY reference. Professional alignment requires a calibrated laser rack.

---

## Tech stack

- Pure **HTML / CSS / JavaScript** — zero dependencies, zero build step
- [W3C DeviceOrientation API](https://www.w3.org/TR/orientation-event/)
- PWA manifest for "Add to Home Screen"

---

## License

MIT — see [LICENSE](LICENSE)
