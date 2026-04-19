# NeuralAdaptive Progress Log

Repo root: `C:\Users\Moise\OneDrive\Documents\HackPrincton`  
Extension folder: `hackprinceton26\`

## Current Build Snapshot

- Manifest version: `MV3`
- Extension version: `3.0.0`
- Runtime model pathing: local extension assets only (no external CDN script loading in extension flow)
- Primary control surface: popup (`ON/OFF`, `Recalibrate`, `Accuracy mode`)
- Tracker stack: `WebGazer` + `TFFacemesh` + local model assets

## Completed Work (Added)

1. Broken script recovery and clean rewrites
- Rewrote previously corrupted files caused by Windows heredoc/comment-line corruption.
- Removed parser failures like `Unexpected identifier 'worker'` and `Unexpected identifier 'manipulation'`.

2. CSP-safe local MediaPipe/WebGazer setup
- Removed CDN dependency from extension runtime path.
- Moved FaceMesh assets to local extension folders.
- Exposed local assets in `web_accessible_resources`.

3. Injection and page-scope safety
- Added strict injection guard in background script.
- Injection now rejects non-`http(s)` pages (including `chrome://`).
- Added popup-side page validation before sending content messages.
- Added content-side protocol guard to skip startup on unsupported pages.

4. Startup and permission reliability
- Added camera permission state checks before tracker startup.
- Added explicit camera preflight with `getUserMedia` before `webgazer.begin()`.
- Improved startup diagnostics/logging around failed begin calls.
- Added auto-disable behavior on dismissed/denied camera permission to prevent retry spam loops.

5. Calibration and user controls
- Added two-stage calibration logic with outlier rejection.
- Added validation/error score storage path for calibration quality.
- Added popup controls:
- `Turn ON / Turn OFF`
- `Recalibrate`
- `Accuracy mode` (`balanced`, `precision`)

6. Active-path performance improvements
- Applied `willReadFrequently` context option in eye-patch readback path.
- Disabled default WebGazer prediction dot in favor of extension-managed cursor.

## Currently Being Added (In Progress)

1. Precision upgrades
- Tightening calibration quality and stability so the red gaze cursor is less jumpy.
- Continuing work on stronger filtering and better rejection of noisy samples.

2. Responsiveness/lag reduction
- Reducing runtime overhead while tracking is enabled.
- Optimizing hot loops so page interaction remains usable during tracking.

3. Failure handling hardening
- Expanding startup error classification around WebGazer begin failures.
- Improving recoverability after permission interruptions and partial initialization states.

## Files Updated In This Phase

- `hackprinceton26\manifest.json`
- `hackprinceton26\background.js`
- `hackprinceton26\content.js`
- `hackprinceton26\content.css`
- `hackprinceton26\popup.html`
- `hackprinceton26\popup.css`
- `hackprinceton26\popup.js`
- `hackprinceton26\sidepanel.html`
- `hackprinceton26\offscreen.html` & `offscreen.js`
- `hackprinceton26\webgazer.js`
- `hackprinceton26\gaze-pipeline.js`
- `hackprinceton26\head-pose-layer.js`
- `hackprinceton26\iris-tracker.js`
- `hackprinceton26\numeric_pregenerated.js` & `pregen_numeric.js`
- `hackprinceton26\mediapipe\face_mesh\*`
- `hackprinceton26\spectrum-server\*`
- `hackprinceton26\package.json`
- `hackprinceton26\gaze_tracking_prd_prompt.md` & `posture_headpose_prd_prompt.md`
- `hackprinceton26\icons\*`

## Error Notes and Meaning

- `webgazer inject failed: Cannot access a chrome:// URL`
- Trigger: trying to run tracking on Chrome internal pages.
- Status: guarded; expected behavior. Use normal `http(s)` pages.

- `Permission dismissed` / `camera permission denied`
- Trigger: camera prompt dismissed or denied.
- Status: handled; extension now auto-disables tracking after this failure.

- `movePinnableElement: destination container not found vector-toc-unpinned-container`
- Trigger: page-side Wikipedia UI behavior.
- Status: not extension-related.

## Verification Checklist

1. Open `chrome://extensions` and reload `NeuralAdaptive`.
2. Open a normal `https://` page (not `chrome://`).
3. Click extension icon and turn tracking on.
4. Accept camera permission when prompted.
5. Confirm console shows startup without CSP or non-injectable-page errors.
6. Confirm popup controls work: toggle, recalibrate, mode switch.
