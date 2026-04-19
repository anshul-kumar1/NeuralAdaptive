# NeuralAdaptive

**Eye-tracking responsive reading interface for students with dyslexia, ADHD, and general reading fatigue.**

NeuralAdaptive is a Chrome extension (Manifest V3) that watches how your eyes move across a web page, derives a real-time cognitive-load signal from that motion, and quietly adjusts the page — typography, dimming, sentence highlight, AI-rewritten paragraphs, a border halo — when it detects you're starting to struggle. It ships with an optional companion server (`spectrum-server`) that, at the end of a reading session, runs a tool-calling LLM coach over the session's telemetry and sends you a personalized debrief over iMessage.

It's built for people who find a normal page of text harder than it should be — dyslexic readers, ADHD readers, language learners, anyone who has had to re-read the same paragraph three times and not known why — and for researchers who want to prototype adaptive reading interventions on live web content.

Hackathon project — HackPrinceton 2026.

---

## Table of contents

- [What it actually does](#what-it-actually-does)
- [Who it's for](#who-its-for)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Features](#features)
- [Repository layout](#repository-layout)
- [Install — Chrome extension](#install--chrome-extension)
- [Install — Spectrum companion server](#install--spectrum-companion-server)
- [Daily usage](#daily-usage)
- [Configuration reference](#configuration-reference)
- [Privacy model](#privacy-model)
- [Accuracy and limits](#accuracy-and-limits)
- [Development notes](#development-notes)
- [Tech stack](#tech-stack)
- [License / credits](#license--credits)

---

## What it actually does

You turn on NeuralAdaptive, calibrate once (you look at 9 dots), and then read the web normally. In the background:

1. The content script captures the webcam (via an offscreen document) and runs MediaPipe Face Mesh + custom iris/head-pose logic to estimate where on the page your gaze is landing, ~15–30 times per second.
2. It derives three reading-stress signals from the gaze stream:
   - **Fixation stress** — how long you're fixating in one spot.
   - **Saccade stress** — how disorganized your jumps are (high-velocity micro-saccades).
   - **Regression stress** — how often you jump _backward_ (re-reading).
3. A weighted blend (`0.45·fixation + 0.35·saccade + 0.20·regression`) collapses those into a single 0–1 stress score, bucketed every ~600 ms into one of three tiers: `CALM`, `ELEVATED`, `OVERLOAD`.
4. When the tier or a smoothed "readability struggle" signal crosses thresholds, it applies interventions on the page itself (detail below).
5. When you click **Finish & Text Summary**, the extension posts the full session — tier timeline, per-paragraph samples, reading pace, tier transitions — to the local `spectrum-server`, which runs a Dedalus/Claude-Haiku tool-calling agent and texts you a short coaching note via iMessage.

Nothing about your gaze, your reading text, or your session telemetry leaves your machine unless _you_ configure an LLM key or Photon Spectrum cloud relay. By default, the only network calls are: (a) your own LLM provider for on-page simplify/summarize, and (b) localhost → iMessage via AppleScript.

---

## Who it's for

- **Students with dyslexia.** The Dyslexia Mode toggle remaps the paragraph you're currently reading to OpenDyslexic / Lexend / Atkinson Hyperlegible, increases line-height and letter-spacing, and narrows the measure to ~72 ch — per-paragraph, not page-wide, so the rest of the page still looks like the page.
- **Readers with ADHD or attention fatigue.** The peripheral-movement overlay and "where you left off" breadcrumb re-anchor you after a distraction; the screen-border halo is a passive "you just spiked" cue.
- **Language learners.** The 10-second long-dwell auto-summarize fires a Gemini-style bullet summary of a paragraph when you stop making progress on it.
- **People who read technical prose all day.** The AI simplify-on-OVERLOAD replaces dense paragraphs with a 6th-grade rewrite, with a **Show original** toggle so you never lose the source.
- **Educators / accessibility researchers.** The extension exposes a live metrics panel (reading score, measurement ratio, tracker degradation, false-trigger rate) and a 3000-sample stress history in every session payload — easy to log or export.

If you just want a focus extension with a progress bar, the eye-tracking is optional — every intervention can be toggled off individually in the popup.

---

## How it works

### Gaze pipeline

The extension uses an MV3 **offscreen document** (`offscreen.html` + `offscreen.js`) to hold the `getUserMedia` stream, because content scripts can't keep a camera open and the service worker can't touch DOM. The offscreen document runs MediaPipe Face Mesh over 320×240 frames, and a custom `head-pose-layer.js` / `iris-tracker.js` pair refines the eye-socket geometry into a stable gaze point. That point is streamed to the active tab's content script, where a Kalman-ish smoother (`smoothedPoint`) and a DOM-level `DwellGrid` map it onto actual `<p>` elements.

Per-frame, `content.js` also computes:

- **Measurement ratio** — how many of the last N frames had a valid face/iris detection. Drops when you look away, cover the camera, or move out of frame.
- **Reading score** — a heuristic that looks for left-to-right sweeps with short backtracks, i.e. actual reading as opposed to glancing.
- **Degradation score** — tracker-quality penalty (lighting, jitter, head pose). Interventions are _blocked_ when this exceeds a threshold to avoid firing on bad data.

### Stress tiers and intervention gating

```
score = 0.45·fixation + 0.35·saccade + 0.20·regression      // 0..1
tier  = score < 0.3 ? 'CALM'
      : score < 0.6 ? 'ELEVATED'
      :               'OVERLOAD'
```

`applyInterventionStable` applies hysteresis (an intervention must be _candidate_ for several consecutive frames before it fires) and a gate: it won't fire if `readingScore < INTERVENTION_MIN_READING_SCORE (0.42)`, if the tracker is degraded, or if we're inside a recent-fired cool-down. Every blocked vs fired count feeds the false-trigger-rate metric in the popup.

### Session aggregation

From the moment you enable NeuralAdaptive on a tab, `content.js` keeps a rolling session log: a cap-3000 stress-score timeline, per-tier duration totals, tier transitions, paragraphs-read ratchet (monotonically forward-only), approximate reading pace (words / minute on paragraphs you actually dwelled on). `buildSessionSummary()` serializes that into a JSON payload the `spectrum-server` consumes.

### Companion server + agent

`spectrum-server/server.js` is a small Express app on `localhost:3847`. On `POST /session-complete` it:

1. Runs a tool-calling agent against **Dedalus** (which routes to Claude Haiku 4.5 by default). The agent has 5 tools: `get_stress_timeline`, `get_paragraph_samples`, `get_tier_transitions`, `get_reading_pace`, `get_recent_sessions` (rolling history of the last 5 completed sessions), and `finalize_message`.
2. Takes the agent's blurb and wraps it with template stats (duration, paragraphs read, peak tier, interventions fired).
3. Delivers it as an iMessage via one of three modes: **applescript** (default, drives Messages.app via `osascript`), **local** (`@photon-ai/imessage-kit`, needs Full Disk Access), or **cloud** (Photon Spectrum — requires project credentials + recipient allowlist).
4. Appends the session to a rolling history file so the next session's agent can reference longitudinal patterns ("third session this week where dense technical text hit you hardest").

If `DEDALUS_API_KEY` isn't configured, the server falls back to a stats-only template and still delivers.

---

## Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │  Chrome tab (any https page)                │
                        │                                             │
         webcam ───┐    │  content.js  ────┐                          │
                   │    │     ▲            │ stress tier, reading     │
                   ▼    │     │            ▼ score, etc.              │
         ┌─────────────────┐  │        page DOM (typography,          │
         │ offscreen.html  │──┘        sentence highlight, halo,      │
         │  face_mesh.js   │           dimming, AI-simplified <p>)    │
         │  iris-tracker   │                                          │
         └─────────────────┘                                          │
                                                                      │
                                                                      │ chrome.runtime
                                                                      ▼
                                                        ┌─────────────────────────────┐
                                                        │  background.js (MV3 SW)     │
                                                        │  - Dedalus API calls        │
                                                        │  - SUMMARIZE_PARAGRAPH      │
                                                        │  - SIMPLIFY_PARAGRAPH       │
                                                        │  - BREADCRUMB_SUMMARY       │
                                                        └──────────────┬──────────────┘
                                                                       │
                    ┌──────────────────────────────────────────────────┤
                    │                                                  │
                    ▼                                                  ▼
           Dedalus / Claude                                   http://localhost:3847
           (simplify + summarize)                                      │
                                                                       ▼
                                                        ┌─────────────────────────────┐
                                                        │  spectrum-server            │
                                                        │  - tool-calling agent       │
                                                        │  - rolling history          │
                                                        │  - AppleScript / Photon     │
                                                        └──────────────┬──────────────┘
                                                                       ▼
                                                                  iMessage to you
```

---

## Features

Every bullet below is a toggle or a responsive behavior that's actually wired up in the code — not a roadmap item.

### Gaze-driven reading

- **9-point calibration** (`iris_v2` schema) plus a separate **nose + head-pose baseline** (`iris_pose_v1`). Calibration is versioned — a version bump forces a re-calibrate, not a silent "the numbers look weird now."
- **Precision / Balanced accuracy modes** in the popup. Precision runs tighter smoothing and stricter gating at the cost of responsiveness.
- Live metrics panel surfaces `measurementRatio`, `readingScore`, `degradationScore`, `snapDistancePx`, and whether interventions are currently blocked — useful for debugging setup.

### Adaptive interventions (on-page)

- **Dynamic typography (`na-readability-focus`)** — the paragraph you're reading smoothly scales font-size, letter-spacing, word-spacing, and line-height with a smoothed "struggle" score. Per-paragraph, not global. Gated by the **Text Enlarge** toggle.
- **Tier-ratchet typography (`na-elevated`, `na-overload`)** — once you ratchet into ELEVATED or OVERLOAD, line-height and letter-spacing on the reading container persist until manual reset. Also gated by Text Enlarge.
- **Screen-border halo (`#na-overload-halo`)** — soft amber inset glow on ELEVATED, pulsing brighter on OVERLOAD. Dismisses itself the moment the AI auto-summary kicks in so feedback doesn't double up.
- **Dimming surround (`.na-dim-surround`)** — fades every paragraph _except_ the current focus while in OVERLOAD.
- **Sentence highlight** — brightens only the sentence you're currently on.
- **AI simplify-on-OVERLOAD** — on sustained OVERLOAD, the paragraph closest to gaze is rewritten at a ~6th-grade level by Dedalus. Badge + **Show original** toggle on every rewrite. Cached per paragraph text.
- **Long-dwell auto-summarize** — if your gaze rests on the same paragraph for ≥ 10 s, a Gemini-style bullet summary appears in a bottom-right tooltip. Once per paragraph per page load.
- **Dyslexia Mode** — per-paragraph font/spacing/color preset (OpenDyslexic → Lexend → Atkinson Hyperlegible) on the current paragraph only.
- **Reading Progress bar** — top-of-page bar showing farthest-paragraph-reached (ratchets forward, never snaps back).

### Distraction recovery

- **Visual Anchor** — on gaze re-entry after an absence, the last-known-good paragraph pulses with an orange left-bar and scrolls itself into view.
- **Peripheral Movement overlay** — at 15 s away, thin slide-in panels at both screen edges pull attention back; dismiss button included.
- **Contextual Breadcrumb** — at 20 s away, the last ~900 characters of context are sent to Dedalus and returned as a "Where you left off" toast the next time you look at the page.

### Session debrief

- **Finish & Text Summary** (popup button) → full session JSON posted to `localhost:3847` → tool-calling agent runs over it → iMessage delivered via AppleScript by default.
- Rolling history (last 5 sessions) is injected into the agent's context so it can reference patterns longitudinally.

### Configuration toggles in the popup

| Toggle           | Storage key          | Default  | Effect                                                                   |
| ---------------- | -------------------- | -------- | ------------------------------------------------------------------------ |
| Tracking ON/OFF  | `enabled`            | OFF      | Master switch; enables gaze loop + calibration.                          |
| Reading Progress | `readingProgress`    | OFF      | Top-of-page progress bar.                                                |
| Dyslexia Mode    | `dyslexiaMode`       | OFF      | Per-paragraph OpenDyslexic/Lexend preset.                                |
| Text Enlarge     | `textEnlargeEnabled` | ON       | Turns off _all_ dynamic type scaling and tier-based typography ratchets. |
| Accuracy mode    | `accuracyMode`       | balanced | `balanced` or `precision`.                                               |
| Dedalus API key  | `dedalusApiKey`      | —        | Enables AI simplify / summarize / breadcrumb.                            |

Storage is always `chrome.storage.local`. No cloud sync.

---

## Repository layout

```
hackprinceton26/
├── manifest.json                # MV3 manifest — action popup, content script, offscreen, icons
├── background.js                # Service worker. Routes LLM calls to Dedalus.
├── offscreen.html / offscreen.js# Camera + MediaPipe Face Mesh in an offscreen document
├── content.js                   # The big one. Gaze pipeline + stress scoring + all interventions.
├── iris-tracker.js              # Iris / eye-socket geometry refinement.
├── head-pose-layer.js           # Head-pose-corrected gaze math.
├── gaze-pipeline.js             # Smoothing, fixation detection, DwellGrid.
├── webgazer.js                  # Historical fallback — kept for offline dev.
├── numeric_pregenerated.js      # Pre-computed numeric lookup used by the pipeline.
├── popup.html / popup.js / popup.css   # Extension popup UI.
├── sidepanel.html               # Optional Chrome side-panel surface.
├── mediapipe/face_mesh/         # Bundled Face Mesh WASM + assets (web_accessible_resources).
├── models/blazeface, models/facemesh/  # TFJS models shipped inline.
├── icons/                       # 16 / 48 / 128 px action icons.
├── spectrum-server/
│   ├── server.js                # Express + tool-calling agent + iMessage delivery.
│   ├── .env.example             # Credential template.
│   └── package.json             # `spectrum-ts`, `express`, `cors`.
├── gaze_tracking_prd_prompt.md
├── posture_headpose_prd_prompt.md
└── .gitignore
```

No `node_modules/` in the extension root is actually required at runtime — the extension bundles everything it needs in `mediapipe/` and `models/`. `package.json` at the root is there for type hints and IDE tooling.

---

## Install — Chrome extension

Prereqs: Chrome (or any Chromium with MV3 support, recent Edge works), a working webcam, macOS or Linux for full parity with the companion server (the server's default AppleScript mode is macOS-only; the extension itself is cross-platform).

1. **Clone:**

   ```bash
   git clone https://github.com/anshul-kumar1/hackprinceton26.git
   cd hackprinceton26
   ```

2. **Load unpacked:**
   - `chrome://extensions` → toggle **Developer mode** on.
   - **Load unpacked** → select the repo root (the folder that contains `manifest.json`).
   - The NeuralAdaptive icon should appear in the toolbar. Pin it.

3. **First-run calibration:**
   - Open any normal https page (`chrome://` and `file://` pages are excluded by MV3).
   - Click the NeuralAdaptive icon → **Turn ON**.
   - Grant camera permission at the prompt.
   - A full-screen 9-dot calibration overlay appears. Follow each dot with your eyes for ~1 s each.
   - Click **Calibrate Nose + Pose** after you sit in your natural posture — this gives the head-pose layer a baseline.

4. **(Optional) Paste a Dedalus key** in the popup's API-key section to enable AI simplify, summarize, and breadcrumb features. Without it, every non-AI intervention still works.

Re-calibrate any time via the popup's **Recalibrate** button. Calibrations are versioned — if we ship a new pipeline schema, the popup will tell you to re-calibrate.

---

## Install — Spectrum companion server

The server is only required for the **Finish & Text Summary → iMessage** flow. The extension works standalone without it.

```bash
cd spectrum-server
cp .env.example .env        # fill in at minimum RECIPIENT_PHONE + DEDALUS_API_KEY
npm install
npm start
```

You should see:

```
[spectrum-server] Listening on http://localhost:3847
[spectrum-server] iMessage mode: applescript
[spectrum-server] Reading-coach agent: enabled (anthropic/claude-haiku-4-5-20251001)
```

### iMessage delivery modes

Set `IMESSAGE_MODE` in `.env`:

| Mode          | Requires                                                                   | Notes                                                                           |
| ------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `applescript` | macOS. One-time "allow Terminal to control Messages" prompt on first send. | **Default.** No Full Disk Access needed.                                        |
| `local`       | macOS + Full Disk Access granted to your terminal app.                     | Uses `@photon-ai/imessage-kit`.                                                 |
| `cloud`       | Photon Spectrum project credentials + recipient on your project allowlist. | Routes via Spectrum Cloud. Set `PHOTON_PROJECT_ID` and `PHOTON_PROJECT_SECRET`. |

The extension's **Finish & Text Summary** button POSTs to `http://localhost:3847/session-complete`. Confirm the server is reachable with `curl http://localhost:3847/health`.

---

## Daily usage

1. **Open any https page you want to read.** News article, arxiv PDF viewer rendered as HTML, Wikipedia, Substack — all fine.
2. **Click the NeuralAdaptive icon → Turn ON** if it's not already.
3. **Read normally.** Don't try to stare at the camera or perform for the tracker. The more natural your reading, the better the signals.
4. **Watch for cues:**
   - Screen edges glow amber → you just climbed into elevated stress.
   - A paragraph quietly enlarges / loosens → the dynamic typography is helping you through it.
   - A paragraph gets replaced with a "Simplified for focus" card → AI rewrite on OVERLOAD. Click **Show original** to get the source back.
   - A bottom-right tooltip appears with bullets → you dwelled on that paragraph for 10+ s and the auto-summarize kicked in.
5. **When you're done, click Finish & Text Summary.** If you haven't been reading for at least 15 s, the popup will decline (anti-spam guard). Otherwise you'll get an iMessage within a few seconds.

---

## Configuration reference

### Chrome storage keys (`chrome.storage.local`)

| Key                           | Type    | Meaning                                                               |
| ----------------------------- | ------- | --------------------------------------------------------------------- |
| `enabled`                     | boolean | Master on/off for gaze tracking.                                      |
| `accuracyMode`                | string  | `'balanced'` or `'precision'`.                                        |
| `readingProgress`             | boolean | Show top-of-page progress bar.                                        |
| `dyslexiaMode`                | boolean | Per-paragraph dyslexia-friendly preset.                               |
| `textEnlargeEnabled`          | boolean | If false, suppresses all dynamic font-size & tier-ratchet typography. |
| `dedalusApiKey`               | string  | Paste from the popup. Needed for AI simplify/summarize/breadcrumb.    |
| `calibrationVersion`          | string  | Schema tag (`iris_v2`). Bump to force re-calibrate.                   |
| `calibrationMedianErrorPx`    | number  | Median pixel error from last 9-point calibration.                     |
| `poseCalibrationVersion`      | string  | Head-pose schema tag (`iris_pose_v1`).                                |
| `poseCalibrationQualityScore` | number  | Pose baseline quality %.                                              |

### Spectrum server `.env`

| Variable                | Required             | Default                               | Purpose                                            |
| ----------------------- | -------------------- | ------------------------------------- | -------------------------------------------------- |
| `IMESSAGE_MODE`         | no                   | `applescript`                         | `applescript` / `local` / `cloud`.                 |
| `RECIPIENT_PHONE`       | yes                  | —                                     | Where the session summary iMessage goes.           |
| `DEDALUS_API_KEY`       | for agent features   | —                                     | Without it the server sends a stats-only template. |
| `DEDALUS_MODEL`         | no                   | `anthropic/claude-haiku-4-5-20251001` | Any Dedalus-routable model id.                     |
| `PHOTON_PROJECT_ID`     | only in `cloud` mode | —                                     | Photon Spectrum project.                           |
| `PHOTON_PROJECT_SECRET` | only in `cloud` mode | —                                     | Photon Spectrum secret.                            |
| `PORT`                  | no                   | `3847`                                | Server listen port (keep in sync with extension).  |

### HTTP endpoints

| Method | Path                | Body                 | Purpose                                                  |
| ------ | ------------------- | -------------------- | -------------------------------------------------------- |
| `GET`  | `/health`           | —                    | Config snapshot: mode, agent on/off, model, history len. |
| `POST` | `/session-complete` | session-summary JSON | Runs the coach agent + delivers the iMessage.            |

---

## Privacy model

- **Camera frames never leave the machine.** MediaPipe runs locally in an offscreen document. Only the _derived_ gaze points (x/y pairs and derived stress scalars) ever flow across the extension's internal message bus.
- **Page text never leaves the machine** _unless_ you've pasted a Dedalus key and triggered an AI simplify / summarize / breadcrumb. In that case, the specific paragraph text being simplified or summarized is sent to the LLM provider you configured.
- **Session summaries** are posted to `http://localhost:3847` — never to a third-party host directly from the extension. The companion server, if you enabled the agent, posts those summaries to Dedalus.
- **iMessage delivery** uses AppleScript by default — the message never traverses an external API; it's injected into the local Messages.app.
- **No telemetry, analytics, or crash reporters.** This is a hackathon project — there is no home phone to call.
- **No cloud sync.** All persistence is `chrome.storage.local`, which is scoped to your Chrome profile on your device.

---

## Accuracy and limits

- Webcam gaze tracking, even with Face Mesh + iris refinement + head-pose correction, is fundamentally less precise than a dedicated IR tracker. Expect ~25–60 px median error after a clean 9-point calibration in even lighting.
- **Lighting matters.** Harsh backlighting, glasses glare, or sub-40-lux ambient will inflate `degradationScore` and NeuralAdaptive will (correctly) refuse to fire interventions until conditions improve.
- **Head movement matters.** The head-pose baseline assumes you sit roughly where you calibrated. Leaning far forward or turning ≥ 30° off-axis will degrade quality; re-calibrate pose if you've changed setup.
- The stress tiers are _heuristic_, not medical. They're tuned to what "a reader who's struggling" typically looks like in eye-tracking literature (long fixations, disorganized saccades, backward regressions), but they don't diagnose anything. They just drive soft UI nudges.
- The AI simplify rewrites are ~6th-grade-target. For highly technical or legal text, always keep **Show original** one click away — the rewrite is a _scaffold_, not a replacement.

---

## Development notes

### Running the extension in dev

- Edit any extension source file → open `chrome://extensions` → click **Reload** on the NeuralAdaptive card → refresh the tab you're testing on.
- The content script logs to the page's DevTools console with the prefix `[NeuralAdaptive]`. Background-worker logs live in the extension's service-worker inspector (accessible from `chrome://extensions`).
- `content.js`, `iris-tracker.js`, `head-pose-layer.js`, and `gaze-pipeline.js` can be edited individually; only `content.js` is auto-injected at `document_idle`.

### Running the server in watch mode

```bash
cd spectrum-server
npm run dev    # node --watch server.js
```

### Manifest permissions

Minimal by design:

```json
"permissions":       ["activeTab", "scripting", "storage"],
"host_permissions":  ["<all_urls>"]
```

No `tabs`, no `webRequest`, no `history`. The `<all_urls>` host permission is required because NeuralAdaptive is page-agnostic — it has to be able to decorate any article you open.

### Storage migration

When a calibration schema changes, bump `CALIBRATION_VERSION` or `POSE_CALIBRATION_VERSION` in `content.js`. The next extension load will notice the version mismatch and prompt a re-calibrate on the next tab activation.

### Extending the coach agent

The agent's toolset is defined in `spectrum-server/server.js` in the `TOOLS` constant. Adding a new tool is three steps: add its schema to `TOOLS`, implement the handler in `executeAgentTool`, and (optionally) mention it in the `AGENT_SYSTEM_PROMPT`. The agent already has structured access to the full stress timeline, tier transitions, per-paragraph samples, reading pace, and the rolling 5-session history.

---

## Tech stack

- **Chrome Extension MV3** — manifest v3, service worker, offscreen document, content scripts.
- **MediaPipe Face Mesh** (`@mediapipe/face_mesh`) + BlazeFace + FaceMesh TFJS models shipped locally under `models/`.
- **Custom gaze pipeline** — Kalman-ish smoothing, velocity-based fixation detection, DOM-level `DwellGrid` for paragraph-snapping.
- **WebGazer.js** — kept around as an offline fallback / comparison baseline; the primary pipeline is the custom iris + head-pose stack.
- **Dedalus** — LLM gateway, routing to Anthropic's **Claude Haiku 4.5** by default. OpenAI-compatible chat/completions endpoint, used by both the extension (simplify / summarize / breadcrumb) and the server (tool-calling coach agent).
- **Spectrum** / `spectrum-ts` — iMessage delivery primitive, with AppleScript as the default backend for zero-friction local use.
- **Express 4** — the companion server's HTTP surface.

---

## License / credits

Built at **HackPrinceton 2026** by the team that would like to keep reading.

Typography defaults respectfully borrow from **OpenDyslexic**, **Lexend**, and **Atkinson Hyperlegible** — all open-licensed typefaces; we ship no font binaries, only fallbacks in the system font stack.
