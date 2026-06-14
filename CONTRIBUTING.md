# Contributing

## Local development

1. Serve the repository root over HTTP (for example `npx serve .`).
2. Open the URL in Safari on iPhone for sensor testing.
3. For desktop sanity checks, open in a modern browser and verify UI interactions.

## Validation

Run lightweight automated checks before submitting changes:

```bash
npm run lint
npm test
```

## Release checklist (cache busting)

**Every release that changes any asset MUST bump the cache version in lockstep**, or PWA users who already installed the app will keep running stale modules from the service-worker cache:

1. Bump `CACHE_NAME` in `service-worker.js` (e.g. `evanline-v8` → `evanline-v9`).
2. Update the `?v=` querystrings to the same number in:
   - `service-worker.js` (`./assets/css/styles.css?v=N`, `./assets/js/app.js?v=N`)
   - `index.html` (the `styles.css?v=N` stylesheet link and the `app.js?v=N` module script tag)
3. Note that `domain.js` and `precision.js` are imported by `app.js` **without** a `?v=` querystring, so they are versioned *only* by `CACHE_NAME`. If you change `domain.js`/`precision.js` but forget to bump `CACHE_NAME`, installed PWA users will silently load the old pure-logic modules against new app code — bump `CACHE_NAME` even for pure-logic-only changes.

## Browser / device matrix

- **Primary target:** iPhone Safari (iOS 16+)
- **Secondary checks:** Safari macOS, Chromium latest (UI only)
- DeviceOrientation behavior and permission prompts must be verified on physical iPhone hardware.

## Manual verification checklist

- [ ] Start screen opens and “Enable Sensors & Start” enters main screen
- [ ] Sensor permission denied flow shows warning banner
- [ ] Quick workflow: zero, settle, and save for at least one side
- [ ] Precision workflow: fixture save/select, baseline captures, forward/reverse captures, precision save gating
- [ ] Mode switches (Camber/Toe/Level/Pitch) update orientation guidance and readings
- [ ] Saved side deltas update after new readings
- [ ] App loads offline after first successful visit
