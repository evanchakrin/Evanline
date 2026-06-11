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
