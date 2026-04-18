//Webcam + MediaPipe, stress score
// offscreen.js — MediaPipe Pose Engine
//
// Runs inside offscreen.html (the hidden document).
// Responsibilities:
//   1. Listen for START_CAMERA from background.js
//   2. Open the webcam via getUserMedia
//   3. Feed frames into MediaPipe Pose
//   4. Extract landmarks and compute a stress score (0.0 – 1.0)
//   5. Send the score to background.js every 2 seconds
//   6. Handle SET_BASELINE to reset the resting position reference

// ─── State ─────────────────────────────────────────────────────────────────────

const state = {
    cameraRunning: false,
    baseline: null,           // Snapshot of resting landmarks {nose_y, shoulder_width}
    noseYBuffer: [],          // Rolling buffer of nose Y positions for fixation detection
    BUFFER_MAX: 180,          // ~3 minutes at 1 sample/sec; adjust if sampling faster
    lastSendTime: 0,          // Throttle: only message background.js every N ms
    SEND_INTERVAL: 2000,      // ms between messages to background.js
}

// MediaPipe landmark indices (from the 33-point pose model)
const LM = {
    NOSE: 0,
    LEFT_EAR: 7,
    RIGHT_EAR: 8,
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
}

// DOM references
const video = document.getElementById('webcam-feed')
const canvas = document.getElementById('pose-canvas')
const debug = document.getElementById('debug-status')

function log(msg) {
    console.log(`[offscreen] ${msg}`)
    if (debug) debug.textContent = `[NeuralAdaptive] ${msg}`
}

// ─── Message Listener ──────────────────────────────────────────────────────────
//
// background.js sends commands here. We can't initiate anything ourselves —
// we wait to be told what to do.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    if (message.type === 'START_CAMERA') {
        log('START_CAMERA received — initializing...')
        initCamera()
            .then(() => sendResponse({ ok: true }))
            .catch(err => {
                log(`Camera init failed: ${err.message}`)
                sendResponse({ ok: false, error: err.message })
            })
        return true // keep channel open for async response
    }

    if (message.type === 'SET_BASELINE') {
        // Reset baseline — called when user clicks Calibrate in the side panel.
        // The next valid frame will be snapshotted as the new resting position.
        state.baseline = null
        state.noseYBuffer = []
        log('Baseline cleared — will reset on next valid frame')
        sendResponse({ ok: true })
        return false
    }
})

// ─── Camera Initialization ─────────────────────────────────────────────────────

async function initCamera() {
    if (state.cameraRunning) {
        log('Camera already running')
        return
    }

    // Request webcam access.
    // The browser will show a permission prompt the first time.
    // After Allow, Chrome remembers and won't ask again.
    let stream
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'user'   // front-facing camera
            },
            audio: false
        })
    } catch (err) {
        // Common errors:
        //   NotAllowedError  — user denied permission
        //   NotFoundError    — no camera on this device
        //   NotReadableError — camera in use by another app
        throw new Error(`getUserMedia failed: ${err.name} — ${err.message}`)
    }

    video.srcObject = stream
    await video.play()

    log('Webcam stream active — initializing MediaPipe Pose...')
    initMediaPipe()
}

// ─── MediaPipe Pose Setup ──────────────────────────────────────────────────────

function initMediaPipe() {
    // Pose is loaded globally by the <script> tags in offscreen.html.
    // If you see "Pose is not defined" here, the CDN script failed to load.
    // Check your internet connection or switch to local /lib files.
    const pose = new Pose({
        locateFile: (file) => {
            // PHASE 1: Using CDN. For production/demo, change this to:
            // return chrome.runtime.getURL(`lib/${file}`)
            return `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        }
    })

    pose.setOptions({
        modelComplexity: 1,       // 0=lite (fastest), 1=full, 2=heavy. 1 is the sweet spot.
        smoothLandmarks: true,    // Reduces jitter between frames — important for our deltas
        enableSegmentation: false, // We don't need body segmentation, skip the cost
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
    })

    // onResults fires every frame with the landmark data
    pose.onResults(onPoseResults)

    // MediaPipe's Camera utility handles the frame loop.
    // It reads from the video element and feeds frames to the pose model.
    const camera = new Camera(video, {
        onFrame: async () => {
            await pose.send({ image: video })
        },
        width: 640,
        height: 480,
    })

    camera.start()
    state.cameraRunning = true
    log('MediaPipe Pose running')
}

// ─── Per-Frame Processing ──────────────────────────────────────────────────────

function onPoseResults(results) {
    // results.poseLandmarks is null if no person detected in frame
    if (!results.poseLandmarks) {
        log('No pose detected in frame')
        return
    }

    const lm = results.poseLandmarks

    // Extract the landmarks we care about
    // Each landmark: { x: 0–1, y: 0–1, z: depth, visibility: 0–1 }
    // x=0 is left edge, x=1 is right edge, y=0 is top, y=1 is bottom
    const nose = lm[LM.NOSE]
    const leftShoulder = lm[LM.LEFT_SHOULDER]
    const rightShoulder = lm[LM.RIGHT_SHOULDER]

    // Skip if key landmarks aren't visible enough (e.g. user turned away)
    if (nose.visibility < 0.5 || leftShoulder.visibility < 0.5 || rightShoulder.visibility < 0.5) {
        log('Key landmarks occluded — skipping frame')
        return
    }

    // Snapshot baseline on first valid frame (or after calibration reset)
    if (!state.baseline) {
        state.baseline = {
            nose_y: nose.y,
            shoulder_width: Math.abs(rightShoulder.x - leftShoulder.x),
        }
        log(`Baseline set — nose_y: ${nose.y.toFixed(3)}, shoulder_width: ${state.baseline.shoulder_width.toFixed(3)}`)
        return
    }

    // ── Signal 1: Frustration Slump ──────────────────────────────────────────────
    // In MediaPipe's coordinate system, Y increases downward (0=top, 1=bottom).
    // When the user slumps or leans in, their nose moves DOWN → nose.y INCREASES.
    // delta is positive when the user has dropped from baseline.
    const slumpDelta = nose.y - state.baseline.nose_y
    // Normalize: 0.15 of vertical screen space = max slump (tune this)
    const slumpScore = Math.min(slumpDelta / 0.15, 1.0)

    // ── Signal 2: Strain Lean-In ──────────────────────────────────────────────────
    // When the user leans toward the screen, their shoulders appear wider in frame.
    // We compare current shoulder width to baseline width.
    const currentShoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x)
    const widthRatio = currentShoulderWidth / state.baseline.shoulder_width
    // Ratio > 1.0 means leaning in. Normalize: 1.25 = max lean (25% wider)
    const leanScore = Math.min(Math.max(widthRatio - 1.0, 0) / 0.25, 1.0)

    // ── Signal 3: Static Fixation ─────────────────────────────────────────────────
    // Low movement variance over time = zombie stare = cognitive overload
    state.noseYBuffer.push(nose.y)
    if (state.noseYBuffer.length > state.BUFFER_MAX) {
        state.noseYBuffer.shift() // remove oldest sample
    }

    let fixationScore = 0
    if (state.noseYBuffer.length >= 10) { // need at least 10 samples
        const mean = state.noseYBuffer.reduce((a, b) => a + b, 0) / state.noseYBuffer.length
        const variance = state.noseYBuffer.reduce((sum, y) => sum + Math.pow(y - mean, 2), 0) / state.noseYBuffer.length
        // Very low variance (< 0.0001) → fixation. Normalize inversely.
        // Clamp variance to [0, 0.001] range, then invert
        fixationScore = Math.min(Math.max(1 - (variance / 0.0005), 0), 1.0)
    }

    // ── Weighted Stress Score ─────────────────────────────────────────────────────
    // Weights represent how much each signal contributes to the final score.
    // Tune these based on testing — slump and lean are the strongest signals.
    const stressScore = Math.min(
        (slumpScore * 0.4) + (leanScore * 0.4) + (fixationScore * 0.2),
        1.0
    )

    // Throttle: only send to background.js every SEND_INTERVAL ms
    const now = Date.now()
    if (now - state.lastSendTime < state.SEND_INTERVAL) return
    state.lastSendTime = now

    const signals = {
        slump: parseFloat(slumpScore.toFixed(3)),
        leanIn: parseFloat(leanScore.toFixed(3)),
        fixation: parseFloat(fixationScore.toFixed(3)),
    }

    log(`Score: ${stressScore.toFixed(2)} | slump: ${signals.slump} lean: ${signals.leanIn} fix: ${signals.fixation}`)

    // Send to background.js — it will route to the active tab's content.js
    chrome.runtime.sendMessage({
        type: 'STRESS_SCORE',
        score: parseFloat(stressScore.toFixed(3)),
        signals,
    }).catch(err => {
        // Background service worker may be sleeping — not an error, just wake lag
        console.warn('[offscreen] sendMessage failed (SW may be sleeping):', err.message)
    })
}