/**
 * head-pose-layer.js — NeuralAdaptive Head Pose Compensation v1.0
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * TECHNICAL DESIGN DOCUMENT — Architecture Overview
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PROBLEM
 * ───────
 * WebGazer maps eye-crop images → screen (x, y) via ridge regression.
 * Calibration is valid only at the exact head position where it was performed.
 * Any movement introduces systematic error:
 *
 *   Movement type           │ Error mode
 *   ────────────────────────┼────────────────────────────────────────────
 *   Lean closer (↑ IPD)     │ Gaze over-reports toward screen edges
 *   Lean back   (↓ IPD)     │ Gaze clusters near screen center
 *   Yaw (turn L/R)          │ Gaze drifts opposite to turn direction
 *   Pitch (nod up/down)     │ Gaze drifts opposite to nod direction
 *   Roll (head tilt)        │ Gaze rotates around screen centre
 *
 *
 * HOOK ARCHITECTURE — zero-cost FaceMesh access
 * ─────────────────────────────────────────────
 * WebGazer's TFFacemesh tracker internally calls:
 *   tracker.predict(video) → { eyeFeatures, positions: [{x,y,z} × 468] }
 *
 * We monkey-patch tracker.predict() to intercept the 468-landmark result as a
 * pure side-effect, extract what we need, then return it unchanged.
 * This costs zero extra CPU — the model runs exactly once per frame.
 *
 *   hookWebGazerTracker()   ← call once, right after webgazer.begin() resolves
 *
 *
 * CORRECTION PIPELINE (applied per frame, before KalmanGaze)
 * ────────────────────────────────────────────────────────────
 *
 *   WebGazer raw (x,y)  +  MediaPipe landmarks (side-channel)
 *         │
 *   ┌─────▼──────────────────────────────────────────────┐
 *   │ [1] DepthCompensator  — Z-axis IPD scaling          │  Feature 1
 *   │     corrected = center + (raw - center) * (B/ipd)  │
 *   └─────┬───────────────────────────────────────────────┘
 *         │  depth-corrected (x,y)
 *   ┌─────▼──────────────────────────────────────────────┐
 *   │ [2] PoseEstimator  — yaw, pitch, roll from mesh     │  Feature 2
 *   │     + PoseCompensator applies inverse angular offset│
 *   └─────┬───────────────────────────────────────────────┘
 *         │  pose-corrected (x,y)  +  angles
 *   ┌─────▼──────────────────────────────────────────────┐
 *   │ [3] SensorFusion  — pupil micro + head macro blend  │  Feature 3
 *   │     weight = f(head angular velocity)               │
 *   └─────┬───────────────────────────────────────────────┘
 *         │  fused (x,y)
 *   ┌─────▼──────────────────────────────────────────────┐
 *   │ [4] DegradationMonitor  — isTrackerDegraded flag    │  Feature 4
 *   └─────┬───────────────────────────────────────────────┘
 *         │
 *   → KalmanGaze → GazeSnap → ReadingPattern → emit
 *
 *
 * INTEGRATION WITH gaze-pipeline.js
 * ───────────────────────────────────
 * In GazePipeline.onRawGaze, before Stage 1 (KalmanGaze), insert:
 *
 *   if (rawX !== null && rawY !== null && HeadPoseLayer.isReady()) {
 *       var c = HeadPoseLayer.compensate(rawX, rawY)
 *       rawX = c.x
 *       rawY = c.y
 *   }
 *
 * Lifecycle calls in content.js:
 *   • HeadPoseLayer.init()          — after webgazer.begin()
 *   • HeadPoseLayer.setBaseline()   — at end of calibration wizard
 *   • HeadPoseLayer.destroy()       — in stopNeuralAdaptive()
 */

'use strict'


// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MediaPipe FaceMesh landmark indices used by this module.
 * Reference: https://github.com/google/mediapipe/blob/master/mediapipe/modules/face_geometry/data/canonical_face_model_uv_visualization.png
 */
var HP_LANDMARKS = {
    LEFT_EYE_OUTER:   33,   // left outer canthus
    RIGHT_EYE_OUTER:  263,  // right outer canthus
    NOSE_TIP:         1,    // tip of nose
    LEFT_FACE_EDGE:   234,  // left zygoma (widest face point)
    RIGHT_FACE_EDGE:  454,  // right zygoma
    CHIN:             152,  // chin tip
    FOREHEAD:         10,   // forehead centre
    LEFT_MOUTH:       61,   // left mouth corner
    RIGHT_MOUTH:      291,  // right mouth corner
}

/** All tunable constants in one place. */
var HP_CONFIG = {
    // ── Feature 1: Depth compensation ─────────────────────────────────────
    DEPTH_IPD_BASELINE_FRAMES: 20,    // frames averaged to establish baseline IPD
    DEPTH_MIN_RATIO:           0.45,  // below → too far from camera
    DEPTH_MAX_RATIO:           2.10,  // above → too close to camera
    DEPTH_BLEND_ALPHA:         0.08,  // IIR smoothing on depth scale factor

    // ── Feature 2: Pose estimation ────────────────────────────────────────
    YAW_MAX_DEG:       45,    // maximum yaw the geometric model can represent
    PITCH_MAX_DEG:     40,
    ROLL_NEUTRAL_DEG:  0,     // expected roll at neutral pose (camera level)

    // Pixels of gaze offset produced per degree of head rotation.
    // Derivation: at 60 cm viewing distance, a 24" 1080p monitor subtends ~48°
    // horizontally → 1920px / 48° ≈ 40 px/°.  Roll/lean can adjust this.
    YAW_PX_PER_DEG:   38,
    PITCH_PX_PER_DEG: 36,
    YAW_GAIN:          0.80,  // how aggressively to correct yaw (0=off, 1=full)
    PITCH_GAIN:        0.75,  // slightly softer than yaw (pitch estimation noisier)
    ROLL_GAIN:         0.60,

    POSE_SMOOTH_ALPHA: 0.12,  // IIR smoothing on yaw/pitch/roll

    // ── Feature 3: Sensor fusion ──────────────────────────────────────────
    // HEAD_WEIGHT: how much the head-direction macro vector contributes.
    // Interpolated between MIN (head still) and MAX (head moving fast).
    FUSION_HEAD_WEIGHT_MIN: 0.12,   // still: 12% head / 88% pupil
    FUSION_HEAD_WEIGHT_MAX: 0.60,   // fast: 60% head / 40% pupil
    FUSION_HEAD_SPEED_MAX:  3.5,    // deg/frame threshold for max head weight

    // Head-as-macro-pointer scale: 1 degree of yaw/pitch maps to this many px
    // from screen centre.  Typically ≈ YAW_PX_PER_DEG.
    FUSION_HEAD_SCALE: 38,

    FUSION_SMOOTH_ALPHA: 0.10,      // IIR on the fused output (extra layer)

    // ── Feature 4: Degradation ────────────────────────────────────────────
    DEGRADE_YAW_LIMIT:    30,   // degrees — beyond this, accuracy falls off a cliff
    DEGRADE_PITCH_LIMIT:  24,
    DEGRADE_ROLL_LIMIT:   18,
    DEGRADE_IPD_MIN:      0.55, // ratio — user >45% further away than calibration
    DEGRADE_IPD_MAX:      1.80, // ratio — user >80% closer
    DEGRADE_WARN_SCORE:   0.70, // 0–1 score that triggers the soft warning
}


// ─── Utility ──────────────────────────────────────────────────────────────────

function medianOf(arr) {
    if (!arr || !arr.length) return null
    var s = arr.slice().sort(function (a, b) { return a - b })
    var m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Depth Compensator (Z-axis / IPD scaling)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * WHY IPD WORKS AS A DEPTH PROXY
 * ────────────────────────────────
 * The camera produces larger inter-pupillary distance in pixels when the user
 * is closer and smaller when they are further away.  Since:
 *
 *   IPD_px ∝ 1 / Z    (where Z is the user–camera distance)
 *
 * we can estimate relative depth change:
 *
 *   depth_ratio = IPD_current / IPD_baseline = Z_baseline / Z_current
 *
 * WebGazer's regression was fitted at Z_baseline.  At a different depth,
 * the "apparent" gaze appears stretched or compressed relative to the screen
 * center.  Correcting it:
 *
 *   scale = 1 / depth_ratio = IPD_baseline / IPD_current
 *
 *   corrected_x = Cx + (raw_x - Cx) * scale
 *   corrected_y = Cy + (raw_y - Cy) * scale
 *
 * where (Cx, Cy) is the screen centre (the natural origin of the calibration).
 *
 *   • User moved closer  → IPD_current > baseline → scale < 1 → gaze compressed ✓
 *   • User moved further → IPD_current < baseline → scale > 1 → gaze expanded  ✓
 */
var DepthCompensator = (function () {
    var baselineIPD   = null   // established during / right after calibration
    var currentIPD    = null
    var smoothedScale = 1.0    // IIR-smoothed scale factor
    var ipdRatio      = 1.0    // current / baseline (public read)

    /** Euclidean distance between two {x,y} landmarks (2-D camera pixels). */
    function dist2(a, b) {
        var dx = a.x - b.x
        var dy = a.y - b.y
        return Math.sqrt(dx * dx + dy * dy)
    }

    /** Extract IPD in camera-pixel units from a 468-landmark array. */
    function measureIPD(lm) {
        var L = lm[HP_LANDMARKS.LEFT_EYE_OUTER]
        var R = lm[HP_LANDMARKS.RIGHT_EYE_OUTER]
        if (!L || !R) return null
        return dist2(L, R)
    }

    // ── Public ────────────────────────────────────────────────────────────────
    return {
        /** Call with the current FaceMesh landmarks every frame. */
        update: function (lm) {
            var ipd = measureIPD(lm)
            if (!ipd || ipd < 5) return   // degenerate frame
            currentIPD = ipd
            if (!baselineIPD) return      // no baseline yet
            ipdRatio      = currentIPD / baselineIPD
            var rawScale  = baselineIPD / currentIPD  // = 1/ipdRatio
            var alpha     = HP_CONFIG.DEPTH_BLEND_ALPHA
            smoothedScale = smoothedScale * (1 - alpha) + rawScale * alpha
        },

        /**
         * Capture the current IPD as the depth baseline.
         * Called once at the end of calibration when the user is in their
         * natural seated position.
         * @param {Array} lm  FaceMesh landmarks
         */
        setBaseline: function (lm) {
            var ipd = measureIPD(lm)
            if (ipd && ipd > 5) {
                baselineIPD   = ipd
                smoothedScale = 1.0
                ipdRatio      = 1.0
                console.log('[HeadPose] Baseline IPD set:', Math.round(ipd), 'px')
            }
        },

        /**
         * Apply depth correction to a raw WebGazer (x, y) point.
         * @param {number} x  raw gaze X (CSS pixels)
         * @param {number} y  raw gaze Y
         * @returns {{x, y}}
         */
        compensate: function (x, y) {
            if (!baselineIPD || smoothedScale === 1.0) return { x: x, y: y }
            var cx = window.innerWidth  / 2
            var cy = window.innerHeight / 2
            return {
                x: cx + (x - cx) * smoothedScale,
                y: cy + (y - cy) * smoothedScale,
            }
        },

        getIPDRatio:    function () { return ipdRatio },
        getScale:       function () { return smoothedScale },
        hasBaseline:    function () { return baselineIPD !== null },

        /** Directly set the baseline IPD (used by calibration from accumulated samples). */
        setBaselineIPD: function (ipd) {
            if (ipd && ipd > 5) {
                baselineIPD   = ipd
                smoothedScale = 1.0
                ipdRatio      = 1.0
            }
        },

        /** Extract IPD from a landmark array without side-effects. */
        extractIPD: function (lm) { return measureIPD(lm) },

        reset: function () {
            baselineIPD = null; currentIPD = null
            smoothedScale = 1.0; ipdRatio = 1.0
        },
    }
}())


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Lightweight Head Pose Estimator + Compensator
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * FULL solvePnP is expensive in JavaScript.  Instead we use the geometric
 * symmetry of the face to derive three rotation angles from the 2-D landmark
 * projections.  At angles ≤ ±30° these approximations are accurate to ±3–5°.
 *
 *
 * YAW  (turning left / right, rotation around Y-axis)
 * ────────────────────────────────────────────────────
 * A frontal face has bilateral symmetry about the nose tip.  When the head
 * yaws, one cheek becomes visible and the other shrinks.  The asymmetry ratio
 * between the nose-to-left-cheek and nose-to-right-cheek horizontal distances
 * encodes yaw:
 *
 *   d_L  = nose.x  - left_zygoma.x     (pixels, should be +ve)
 *   d_R  = right_zygoma.x - nose.x     (pixels, should be +ve)
 *   asym = (d_R - d_L) / (d_R + d_L)  ∈ [-1, +1]
 *
 *   asym > 0 → head turned right   asym < 0 → head turned left
 *
 * Convert to degrees:
 *   yaw_deg ≈ asym × YAW_MAX_DEG
 *
 * This is a linear approximation of sin⁻¹(asym × sin(MAX)).
 * Error is < 3° for |yaw| < 30°.
 *
 *
 * PITCH  (nodding up / down, rotation around X-axis)
 * ────────────────────────────────────────────────────
 * The nose tip sits at a fixed anatomical distance from the eye line and chin.
 * When the head pitches, the nose appears to move along the eye–chin axis
 * as seen by the camera.
 *
 *   eye_mid_y  = (left_eye.y + right_eye.y) / 2
 *   face_h     = chin.y - eye_mid_y              (should be > 0)
 *   nose_norm  = (nose_tip.y - eye_mid_y) / face_h   ∈ [0, 1]
 *
 * At neutral: nose_norm ≈ NEUTRAL_NOSE_RATIO  (calibrated; typically 0.46–0.50).
 * Positive Δ (nose moved toward chin in camera view) → pitched down (nodding).
 * Negative Δ → pitched up.
 *
 *   pitch_ratio = nose_norm - neutral_nose_ratio
 *   pitch_deg   ≈ pitch_ratio × PITCH_MAX_DEG
 *
 *
 * ROLL  (head tilt, rotation around Z-axis)
 * ──────────────────────────────────────────
 * The inter-ocular line (line between the two outer canthi) should be
 * horizontal at neutral.  Any tilt directly encodes roll:
 *
 *   roll_rad = atan2(right_eye.y - left_eye.y,  right_eye.x - left_eye.x)
 *   roll_deg = roll_rad × (180 / π) − ROLL_NEUTRAL_DEG
 *
 *
 * GAZE OFFSET COMPENSATION
 * ─────────────────────────
 * Head yaw / pitch introduce a systematic translation in gaze space.  When
 * the head turns right by θ°, the pupils shift leftward relative to the face,
 * causing WebGazer to underestimate the true rightward gaze.  The correction:
 *
 *   offset_x = −yaw_deg × YAW_PX_PER_DEG × YAW_GAIN
 *   offset_y = −pitch_deg × PITCH_PX_PER_DEG × PITCH_GAIN
 *
 * For roll, we rotate the gaze point around the screen centre by −roll:
 *
 *   Let (u, v) = (raw_x − Cx,  raw_y − Cy)
 *   cos_r = cos(−roll_rad),   sin_r = sin(−roll_rad)
 *   corrected_x = u·cos_r − v·sin_r + Cx
 *   corrected_y = u·sin_r + v·cos_r + Cy
 */
var PoseEstimator = (function () {
    var neutralNoseRatio = 0.47   // calibrated in setBaseline(), sane default
    var neutralRollRad   = 0.0

    // IIR-smoothed angles
    var _yaw   = 0
    var _pitch = 0
    var _roll  = 0

    // ── Angle derivation ─────────────────────────────────────────────────────

    function computeYaw(lm) {
        var nose  = lm[HP_LANDMARKS.NOSE_TIP]
        var leftC = lm[HP_LANDMARKS.LEFT_FACE_EDGE]
        var rightC = lm[HP_LANDMARKS.RIGHT_FACE_EDGE]
        if (!nose || !leftC || !rightC) return 0
        var dL = nose.x - leftC.x
        var dR = rightC.x - nose.x
        var sum = dL + dR
        if (sum < 1) return 0
        var asym = (dR - dL) / sum   // [-1, +1]
        return asym * HP_CONFIG.YAW_MAX_DEG
    }

    function computePitch(lm) {
        var leftE  = lm[HP_LANDMARKS.LEFT_EYE_OUTER]
        var rightE = lm[HP_LANDMARKS.RIGHT_EYE_OUTER]
        var nose   = lm[HP_LANDMARKS.NOSE_TIP]
        var chin   = lm[HP_LANDMARKS.CHIN]
        if (!leftE || !rightE || !nose || !chin) return 0
        var eyeMidY  = (leftE.y + rightE.y) / 2
        var faceH    = chin.y - eyeMidY
        if (faceH < 5) return 0
        var noseNorm  = (nose.y - eyeMidY) / faceH
        var pitchRatio = noseNorm - neutralNoseRatio
        return pitchRatio * HP_CONFIG.PITCH_MAX_DEG
    }

    function computeRoll(lm) {
        var leftE  = lm[HP_LANDMARKS.LEFT_EYE_OUTER]
        var rightE = lm[HP_LANDMARKS.RIGHT_EYE_OUTER]
        if (!leftE || !rightE) return 0
        var rad = Math.atan2(rightE.y - leftE.y, rightE.x - leftE.x)
        return (rad - neutralRollRad) * (180 / Math.PI)
    }

    // ── Public ────────────────────────────────────────────────────────────────
    return {
        /**
         * Ingest a new landmark frame. Updates the IIR-smoothed angles.
         * @param {Array} lm  468-element landmark array from FaceMesh
         */
        update: function (lm) {
            var rawYaw   = computeYaw(lm)
            var rawPitch = computePitch(lm)
            var rawRoll  = computeRoll(lm)
            var a = HP_CONFIG.POSE_SMOOTH_ALPHA
            _yaw   = _yaw   * (1 - a) + rawYaw   * a
            _pitch = _pitch * (1 - a) + rawPitch * a
            _roll  = _roll  * (1 - a) + rawRoll  * a
        },

        /**
         * Store the neutral nose ratio and roll from the current face mesh.
         * Call at the end of calibration (head is in natural resting position).
         */
        setBaseline: function (lm) {
            var leftE  = lm[HP_LANDMARKS.LEFT_EYE_OUTER]
            var rightE = lm[HP_LANDMARKS.RIGHT_EYE_OUTER]
            var nose   = lm[HP_LANDMARKS.NOSE_TIP]
            var chin   = lm[HP_LANDMARKS.CHIN]
            if (leftE && rightE && nose && chin) {
                var eyeMidY = (leftE.y + rightE.y) / 2
                var faceH   = chin.y - eyeMidY
                if (faceH > 5) {
                    neutralNoseRatio = (nose.y - eyeMidY) / faceH
                }
                neutralRollRad = Math.atan2(rightE.y - leftE.y, rightE.x - leftE.x)
                _yaw = 0; _pitch = 0; _roll = 0
                console.log('[HeadPose] Neutral pose set — nose ratio:', neutralNoseRatio.toFixed(3))
            }
        },

        /**
         * Apply pose-inverse offsets to a depth-corrected gaze point.
         *
         * @param {number} x  depth-corrected gaze X
         * @param {number} y  depth-corrected gaze Y
         * @returns {{x, y}}
         */
        compensate: function (x, y) {
            // ── Yaw + Pitch: translate ────────────────────────────────────────
            var ox = -_yaw   * HP_CONFIG.YAW_PX_PER_DEG   * HP_CONFIG.YAW_GAIN
            var oy = -_pitch * HP_CONFIG.PITCH_PX_PER_DEG * HP_CONFIG.PITCH_GAIN
            var px = x + ox
            var py = y + oy

            // ── Roll: rotate around screen centre ─────────────────────────────
            // Let φ = −roll_rad (undo the roll)
            var rollRad = _roll * Math.PI / 180
            var phi     = -rollRad * HP_CONFIG.ROLL_GAIN
            var cx = window.innerWidth  / 2
            var cy = window.innerHeight / 2
            var u  = px - cx
            var v  = py - cy
            var cosP = Math.cos(phi)
            var sinP = Math.sin(phi)
            return {
                x: u * cosP - v * sinP + cx,
                y: u * sinP + v * cosP + cy,
            }
        },

        getYaw:   function () { return _yaw   },
        getPitch: function () { return _pitch },
        getRoll:  function () { return _roll  },

        /** Read nose norm ratio from landmarks without updating internal state. */
        extractNoseNorm: function (lm) {
            var leftE  = lm[HP_LANDMARKS.LEFT_EYE_OUTER]
            var rightE = lm[HP_LANDMARKS.RIGHT_EYE_OUTER]
            var nose   = lm[HP_LANDMARKS.NOSE_TIP]
            var chin   = lm[HP_LANDMARKS.CHIN]
            if (!leftE || !rightE || !nose || !chin) return null
            var eyeMidY = (leftE.y + rightE.y) / 2
            var faceH   = chin.y - eyeMidY
            if (faceH < 5) return null
            return (nose.y - eyeMidY) / faceH
        },

        /** Read roll in radians from landmarks without updating internal state. */
        extractRollRad: function (lm) {
            var leftE  = lm[HP_LANDMARKS.LEFT_EYE_OUTER]
            var rightE = lm[HP_LANDMARKS.RIGHT_EYE_OUTER]
            if (!leftE || !rightE) return null
            return Math.atan2(rightE.y - leftE.y, rightE.x - leftE.x)
        },

        /** Directly set the neutral pose from calibration medians. */
        setBaselineNeutral: function (noseNorm, rollRadVal) {
            if (noseNorm !== null && noseNorm !== undefined) neutralNoseRatio = noseNorm
            if (rollRadVal !== null && rollRadVal !== undefined) neutralRollRad = rollRadVal
            _yaw = 0; _pitch = 0; _roll = 0
            console.log('[HeadPose] Neutral set — nose ratio:', (noseNorm || 0).toFixed(3),
                        'roll:', ((rollRadVal || 0) * 180 / Math.PI).toFixed(1) + '°')
        },

        reset: function () { _yaw = 0; _pitch = 0; _roll = 0 },
    }
}())


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 3 — Sensor Fusion (Pupil micro + Head macro)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * HEAD POSE AS A MACRO POINTER
 * ─────────────────────────────
 * After pose correction the pupil signal is the "micro" pointer — high spatial
 * resolution but noisy and lagged during fast saccades.
 *
 * The head orientation independently encodes a "macro" pointer — where the
 * nose is roughly pointing on the screen:
 *
 *   head_x = Cx + yaw_deg   × FUSION_HEAD_SCALE   (turns right → points right)
 *   head_y = Cy − pitch_deg × FUSION_HEAD_SCALE   (pitches up  → points up)
 *
 * (Note the sign: yaw right → positive head_x offset from centre.
 *  This is opposite to the compensation offset because here we are using the
 *  angle as an absolute pointer, not an error corrector.)
 *
 *
 * ADAPTIVE WEIGHTING
 * ───────────────────
 * During fast head movement:
 *   • The pupil tracker lags due to model inference latency.
 *   • The head vector captures the large movement immediately.
 *   → Blend more head vector in.
 *
 * During slow / stationary head:
 *   • Pupil tracker is highly precise (reading fine text, following sentences).
 *   • Head vector adds noise (small angle errors → many pixels of offset).
 *   → Blend mostly pupil.
 *
 *   head_speed  = √(Δyaw² + Δpitch²)          degrees / frame at ~30 fps
 *   t           = clamp(head_speed / SPEED_MAX, 0, 1)
 *   head_weight = lerp(HEAD_WEIGHT_MIN, HEAD_WEIGHT_MAX, t)
 *   pupil_weight = 1 − head_weight
 *
 *   fused_x = pupil_weight × corrected_pupil_x + head_weight × head_x
 *   fused_y = pupil_weight × corrected_pupil_y + head_weight × head_y
 *
 * A final IIR (α = FUSION_SMOOTH_ALPHA) tames any residual noise on the
 * fused output without adding meaningful lag.
 */
var SensorFusion = (function () {
    var _prevYaw    = 0
    var _prevPitch  = 0
    var _fusedX     = null
    var _fusedY     = null
    var _headWeight = 0

    function lerp(a, b, t) { return a + (b - a) * t }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)) }

    return {
        /**
         * Fuse corrected pupil gaze with the current head-pose vector.
         *
         * @param {number} px   pose-corrected pupil X
         * @param {number} py   pose-corrected pupil Y
         * @param {number} yaw   degrees — from PoseEstimator
         * @param {number} pitch degrees
         * @returns {{x, y, headWeight}}
         */
        fuse: function (px, py, yaw, pitch) {
            // ── Head macro pointer ────────────────────────────────────────────
            var cx = window.innerWidth  / 2
            var cy = window.innerHeight / 2
            var scale = HP_CONFIG.FUSION_HEAD_SCALE
            var headX =  cx + yaw   * scale
            var headY =  cy - pitch * scale

            // ── Adaptive weight ───────────────────────────────────────────────
            var dYaw   = yaw   - _prevYaw
            var dPitch = pitch - _prevPitch
            var speed  = Math.sqrt(dYaw * dYaw + dPitch * dPitch)
            _prevYaw   = yaw
            _prevPitch = pitch

            var t = clamp(speed / HP_CONFIG.FUSION_HEAD_SPEED_MAX, 0, 1)
            _headWeight = lerp(
                HP_CONFIG.FUSION_HEAD_WEIGHT_MIN,
                HP_CONFIG.FUSION_HEAD_WEIGHT_MAX, t
            )
            var pupilWeight = 1 - _headWeight

            var rawFusedX = pupilWeight * px + _headWeight * headX
            var rawFusedY = pupilWeight * py + _headWeight * headY

            // ── IIR output smoothing ──────────────────────────────────────────
            if (_fusedX === null) { _fusedX = rawFusedX; _fusedY = rawFusedY }
            var alpha = HP_CONFIG.FUSION_SMOOTH_ALPHA
            _fusedX = _fusedX * (1 - alpha) + rawFusedX * alpha
            _fusedY = _fusedY * (1 - alpha) + rawFusedY * alpha

            return { x: _fusedX, y: _fusedY, headWeight: _headWeight }
        },

        getHeadWeight: function () { return _headWeight },
        reset: function () {
            _prevYaw = 0; _prevPitch = 0
            _fusedX  = null; _fusedY = null
            _headWeight = 0
        },
    }
}())


// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — Degradation Monitor + Non-intrusive UI
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * FAILURE STATE DETECTION
 * ────────────────────────
 * Compensation math is polynomial/linear; it breaks down at large angles.
 * We need to flag when posture has drifted beyond the correctable zone BEFORE
 * it causes confusing UI behaviour for the user.
 *
 * Per-dimension normalised stress score:
 *   s_yaw   = |yaw|   / YAW_LIMIT          (> 1 = over limit)
 *   s_pitch = |pitch| / PITCH_LIMIT
 *   s_roll  = |roll|  / ROLL_LIMIT
 *   s_near  = max(0, ipdRatio / IPD_MAX − 1)   (too close)
 *   s_far   = max(0, 1 − ipdRatio / IPD_MIN)   (too far)
 *
 * Composite degradation score:
 *   degradationScore = max(s_yaw, s_pitch, s_roll, s_near, s_far)
 *
 * States:
 *   score < WARN_SCORE    → nominal
 *   WARN_SCORE ≤ score < 1 → warn (soft orange ring on cursor)
 *   score ≥ 1              → degraded (trigger recalibration prompt)
 *
 *
 * NON-INTRUSIVE VISUAL FEEDBACK
 * ──────────────────────────────
 * • Gaze cursor ring colour interpolates:
 *     nominal  → #E77500 (Princeton orange)
 *     warning  → #FF9900 (amber)
 *     degraded → #FF3300 (red) + gentle pulse
 * • At full degradation a compact badge appears near the cursor:
 *     "↺ Sit back to baseline"
 *   It disappears 2 s after score drops back below WARN_SCORE.
 */
var DegradationMonitor = (function () {
    var _score    = 0
    var _degraded = false
    var _badgeEl  = null
    var _hideTimeout = null

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(v, hi)) }

    function scoreDimension(value, limit) {
        return Math.max(0, Math.abs(value) / limit)
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    function showBadge(x, y) {
        if (_badgeEl) return
        _badgeEl = document.createElement('div')
        _badgeEl.id = 'na-pose-badge'
        _badgeEl.textContent = '↺ Sit back to baseline'
        Object.assign(_badgeEl.style, {
            position:   'fixed',
            left:       clamp(x + 16, 0, window.innerWidth  - 200) + 'px',
            top:        clamp(y + 16, 0, window.innerHeight - 40)  + 'px',
            background: 'rgba(255,51,0,0.88)',
            color:      '#fff',
            fontSize:   '11px',
            fontWeight: '600',
            padding:    '4px 10px',
            borderRadius: '6px',
            pointerEvents: 'none',
            zIndex:     '2147483646',
            fontFamily: 'system-ui, sans-serif',
            boxShadow:  '0 2px 8px rgba(0,0,0,0.4)',
        })
        document.body.appendChild(_badgeEl)
    }

    function hideBadge() {
        if (_hideTimeout) { clearTimeout(_hideTimeout); _hideTimeout = null }
        _hideTimeout = setTimeout(function () {
            if (_badgeEl) { _badgeEl.remove(); _badgeEl = null }
        }, 2000)
    }

    function updateCursorColor(score) {
        var cursor = document.getElementById('na-gaze-cursor')
        if (!cursor) return
        if (score < HP_CONFIG.DEGRADE_WARN_SCORE) {
            cursor.style.borderColor = '#E77500'
            cursor.style.animation   = ''
        } else if (score < 1.0) {
            // Interpolate orange → amber
            cursor.style.borderColor = '#FF9900'
            cursor.style.animation   = ''
        } else {
            cursor.style.borderColor = '#FF3300'
            cursor.style.animation   = 'na-cal-pulse 0.6s ease-in-out infinite'
        }
    }

    // ── Public ────────────────────────────────────────────────────────────────
    return {
        /**
         * @param {number} yaw      degrees
         * @param {number} pitch    degrees
         * @param {number} roll     degrees
         * @param {number} ipdRatio current/baseline
         * @param {number} gazeX    current gaze X (for badge placement)
         * @param {number} gazeY    current gaze Y
         */
        update: function (yaw, pitch, roll, ipdRatio, gazeX, gazeY) {
            var sYaw   = scoreDimension(yaw,   HP_CONFIG.DEGRADE_YAW_LIMIT)
            var sPitch = scoreDimension(pitch, HP_CONFIG.DEGRADE_PITCH_LIMIT)
            var sRoll  = scoreDimension(roll,  HP_CONFIG.DEGRADE_ROLL_LIMIT)
            var sNear  = Math.max(0, ipdRatio / HP_CONFIG.DEGRADE_IPD_MAX - 1)
            var sFar   = Math.max(0, 1 - ipdRatio / HP_CONFIG.DEGRADE_IPD_MIN)
            _score     = Math.max(sYaw, sPitch, sRoll, sNear, sFar)
            _degraded  = _score >= 1.0

            updateCursorColor(_score)

            if (_degraded) {
                showBadge(gazeX, gazeY)
            } else if (_score < HP_CONFIG.DEGRADE_WARN_SCORE) {
                hideBadge()
            }
        },

        isTrackerDegraded: function () { return _degraded },
        getDegradationScore: function () { return _score },

        destroy: function () {
            if (_badgeEl) { _badgeEl.remove(); _badgeEl = null }
            if (_hideTimeout) clearTimeout(_hideTimeout)
            _degraded = false; _score = 0
        },
    }
}())


// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION — HeadPoseLayer
// Single public entry point wiring all four modules together.
// ═══════════════════════════════════════════════════════════════════════════════

var HeadPoseLayer = (function () {

    var _ready         = false
    var _latestLM      = null    // most recent 468-landmark array (from hook)
    var _calibSampling = false   // true while calibration wizard is collecting samples
    var _calibSamples  = []      // {ipd, noseNorm, rollRad} — one entry per frame

    // ── Private: compute baselines from accumulated calibration samples ────────
    function _setBaselineFromSamples() {
        if (!_calibSamples.length) {
            if (_latestLM) {
                DepthCompensator.setBaseline(_latestLM)
                PoseEstimator.setBaseline(_latestLM)
            }
            return
        }
        var ipds      = _calibSamples.map(function (s) { return s.ipd })
        var noseNorms = _calibSamples.map(function (s) { return s.noseNorm })
        var rollRads  = _calibSamples.map(function (s) { return s.rollRad })
        DepthCompensator.setBaselineIPD(medianOf(ipds))
        PoseEstimator.setBaselineNeutral(medianOf(noseNorms), medianOf(rollRads))
        console.log('[HeadPose] Baseline from', _calibSamples.length, 'samples —',
                    'IPD:', Math.round(medianOf(ipds)), 'px',
                    'nose:', medianOf(noseNorms).toFixed(3))
    }

    // ── Internal per-frame processing ─────────────────────────────────────────

    function onLandmarks(lm) {
        _latestLM = lm
        DepthCompensator.update(lm)
        PoseEstimator.update(lm)

        // Accumulate derived metrics during calibration phase
        if (_calibSampling) {
            var ipd      = DepthCompensator.extractIPD(lm)
            var noseNorm = PoseEstimator.extractNoseNorm(lm)
            var rollRad  = PoseEstimator.extractRollRad(lm)
            if (ipd && noseNorm !== null && rollRad !== null) {
                _calibSamples.push({ ipd: ipd, noseNorm: noseNorm, rollRad: rollRad })
            }
        }
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    return {
        /**
         * init()
         * Call once after webgazer.begin() resolves.
         * Installs the tracker hook so landmark data flows into this module.
         */
        init: function () {
            if (_ready) return
            var hooked = hookWebGazerTracker(onLandmarks)
            if (hooked) {
                _ready = true
                console.log('[HeadPose] Layer initialised — tracker hook active')
            } else {
                console.warn('[HeadPose] Tracker hook failed — pose correction inactive')
            }
        },

        /**
         * setBaseline()
         * Capture the current pose as the calibration reference.
         * Call at the end of the calibration wizard (user is in natural seated
         * position, looking at the centre dot).
         */
        setBaseline: function () {
            var lm = _latestLM
            if (!lm) {
                console.warn('[HeadPose] setBaseline called before any landmark data')
                return
            }
            DepthCompensator.setBaseline(lm)
            PoseEstimator.setBaseline(lm)
            _baselineLMBuf = null  // stop accumulating
            console.log('[HeadPose] Baseline captured')
        },

        /**
         * compensate(rawX, rawY)
         * Apply the full four-stage correction pipeline to a raw WebGazer point.
         * Returns the fused, corrected gaze point + health state.
         *
         * @param {number} rawX
         * @param {number} rawY
         * @returns {{ x, y, yaw, pitch, roll, ipdRatio, headWeight, isTrackerDegraded, degradationScore }}
         */
        compensate: function (rawX, rawY) {
            if (!_ready) return { x: rawX, y: rawY, isTrackerDegraded: false, degradationScore: 0 }

            // Stage 1 — depth (Z) scale
            var d1 = DepthCompensator.compensate(rawX, rawY)

            // Stage 2 — head pose inverse offset (yaw + pitch translation, roll rotation)
            var d2 = PoseEstimator.compensate(d1.x, d1.y)

            // Stage 3 — sensor fusion
            var yaw   = PoseEstimator.getYaw()
            var pitch = PoseEstimator.getPitch()
            var roll  = PoseEstimator.getRoll()
            var fused = SensorFusion.fuse(d2.x, d2.y, yaw, pitch)

            // Stage 4 — degradation check
            var ipdRatio = DepthCompensator.getIPDRatio()
            DegradationMonitor.update(yaw, pitch, roll, ipdRatio, fused.x, fused.y)

            return {
                x: fused.x,
                y: fused.y,
                yaw:               yaw,
                pitch:             pitch,
                roll:              roll,
                ipdRatio:          ipdRatio,
                headWeight:        fused.headWeight,
                isTrackerDegraded: DegradationMonitor.isTrackerDegraded(),
                degradationScore:  DegradationMonitor.getDegradationScore(),
            }
        },

        isReady: function () { return _ready },

        /**
         * startCalibrationSampling()
         * Call at the START of the calibration wizard.
         * Begins accumulating {ipd, noseNorm, rollRad} samples every frame.
         */
        startCalibrationSampling: function () {
            _calibSamples  = []
            _calibSampling = true
        },

        /**
         * finalizeCalibration(onProgress)
         * Call AFTER all calibration dots have been clicked.
         * Stops sample accumulation, waits for the user's pose to stabilise,
         * then computes robust median baselines from the collected samples.
         *
         * @param {function({yaw, pitch, roll, ipdRatio, progress, stable}): void} onProgress
         *   Called every 100 ms.  progress ∈ [0, 1] — fill a progress bar with this.
         * @returns {Promise<void>}  resolves when baseline is captured.
         */
        finalizeCalibration: function (onProgress) {
            _calibSampling = false   // stop accumulating new samples

            var recentYaws    = []
            var recentPitches = []
            var stableStart   = null
            var STABLE_MS     = 1800    // hold still for 1.8 s
            var STABLE_RANGE  = 5       // degrees — max range across rolling window
            var TIMEOUT_MS    = 30000   // auto-finalize after 30 s regardless

            var startedAt = Date.now()

            return new Promise(function (resolve) {
                var timer = setInterval(function () {
                    var yaw   = PoseEstimator.getYaw()
                    var pitch = PoseEstimator.getPitch()
                    var roll  = PoseEstimator.getRoll()
                    var ratio = DepthCompensator.hasBaseline()
                              ? DepthCompensator.getIPDRatio() : 1.0

                    recentYaws.push(yaw)
                    recentPitches.push(pitch)
                    if (recentYaws.length    > 15) recentYaws.shift()
                    if (recentPitches.length > 15) recentPitches.shift()

                    var yawRange   = Math.max.apply(null, recentYaws)    - Math.min.apply(null, recentYaws)
                    var pitchRange = Math.max.apply(null, recentPitches) - Math.min.apply(null, recentPitches)
                    var stable = recentYaws.length >= 8 &&
                                 yawRange   < STABLE_RANGE &&
                                 pitchRange < STABLE_RANGE

                    // Timeout failsafe — capture whatever we have
                    if (Date.now() - startedAt > TIMEOUT_MS) { stable = true; stableStart = stableStart || Date.now() - STABLE_MS }

                    if (stable) {
                        if (!stableStart) stableStart = Date.now()
                        var progress = Math.min((Date.now() - stableStart) / STABLE_MS, 1.0)
                        if (onProgress) onProgress({ yaw: yaw, pitch: pitch, roll: roll, ipdRatio: ratio, progress: progress, stable: true })
                        if (progress >= 1.0) {
                            clearInterval(timer)
                            _setBaselineFromSamples()
                            _calibSamples = []
                            resolve()
                        }
                    } else {
                        stableStart = null
                        if (onProgress) onProgress({ yaw: yaw, pitch: pitch, roll: roll, ipdRatio: ratio, progress: 0, stable: false })
                    }
                }, 100)
            })
        },

        getState: function () {
            return {
                yaw:               PoseEstimator.getYaw(),
                pitch:             PoseEstimator.getPitch(),
                roll:              PoseEstimator.getRoll(),
                ipdRatio:          DepthCompensator.getIPDRatio(),
                depthScale:        DepthCompensator.getScale(),
                headWeight:        SensorFusion.getHeadWeight(),
                isTrackerDegraded: DegradationMonitor.isTrackerDegraded(),
                degradationScore:  DegradationMonitor.getDegradationScore(),
            }
        },

        applyCalibrationProfile: function (profile) {
            if (!profile) return
            if (typeof profile.yawLimit === 'number' && isFinite(profile.yawLimit)) {
                HP_CONFIG.DEGRADE_YAW_LIMIT = Math.max(12, Math.min(50, profile.yawLimit))
            }
            if (typeof profile.pitchLimit === 'number' && isFinite(profile.pitchLimit)) {
                HP_CONFIG.DEGRADE_PITCH_LIMIT = Math.max(10, Math.min(40, profile.pitchLimit))
            }
            if (typeof profile.rollLimit === 'number' && isFinite(profile.rollLimit)) {
                HP_CONFIG.DEGRADE_ROLL_LIMIT = Math.max(8, Math.min(30, profile.rollLimit))
            }
            console.log('[HeadPose] Applied calibration profile',
                'yawLimit=' + HP_CONFIG.DEGRADE_YAW_LIMIT.toFixed(1),
                'pitchLimit=' + HP_CONFIG.DEGRADE_PITCH_LIMIT.toFixed(1),
                'rollLimit=' + HP_CONFIG.DEGRADE_ROLL_LIMIT.toFixed(1)
            )
        },

        destroy: function () {
            _ready         = false
            _calibSampling = false
            _calibSamples  = []
            _latestLM      = null
            // Stop direct-model detection loop if it was started
            if (typeof this._stopDirectDetection === 'function') {
                this._stopDirectDetection()
                this._stopDirectDetection = null
            }
            DepthCompensator.reset()
            PoseEstimator.reset()
            SensorFusion.reset()
            DegradationMonitor.destroy()
            console.log('[HeadPose] Layer destroyed')
        },
    }
}())


// ═══════════════════════════════════════════════════════════════════════════════
// TRACKER HOOK — zero-cost FaceMesh landmark interception
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * hookWebGazerTracker(callback)
 *
 * HOW IT WORKS
 * ─────────────
 * WebGazer's setTracker('TFFacemesh') installs an object at webgazer.tracker
 * (internal; not part of the documented API, but stable across v2.x).
 * Its predict() method is called every video frame and returns:
 *
 *   { eyeFeatures: { left, right }, positions: Array<{x,y,z}> }
 *
 * where positions[i] is the i-th MediaPipe FaceMesh landmark in *video pixel*
 * coordinates (not normalised).
 *
 * We wrap predict() to fire callback(positions) as a pure side-effect, then
 * return the original result unchanged.  WebGazer never knows we were here.
 *
 * Fallback strategy
 * ──────────────────
 * If the tracker object or its predict function cannot be located we log a
 * warning and return false.  HeadPoseLayer.isReady() then returns false and
 * compensate() is a pass-through — the extension continues functioning without
 * pose correction rather than crashing.
 *
 * @param {function(Array): void} callback  called every frame with 468 landmarks
 * @returns {boolean}  true if hook was installed successfully
 */
/**
 * Three-strategy hook chain.
 *
 * ROOT CAUSE of common failure:
 *   window.webgazer.tracker  →  the NAMESPACE of tracker constructors
 *                                ({ TFFacemesh: fn, clmtrackr: fn, … })
 *                                NOT the active instance — has no predict().
 *   window.webgazer.getTracker()  →  the active INSTANCE with predict().
 *
 * Strategy A — wrap tracker.predict (cheapest, zero extra inference)
 *   If the return value includes landmarks (some WebGazer forks), fire callback.
 *   Even if it doesn't, the wrap is still installed and ready.
 *
 * Strategy B — direct model.estimateFaces on the WebGazer video element (~10 fps)
 *   Reuses the already-loaded FaceLandmarksDetector model from the tracker instance.
 *   No second model download; minimal CPU (10 fps is plenty for pose tracking).
 *
 * Strategy C — fail gracefully
 *   HeadPoseLayer.isReady() returns false → compensate() is a pass-through.
 *   Extension continues working without pose correction.
 */
function hookWebGazerTracker(callback) {
    if (!window.webgazer) {
        console.warn('[HeadPose] webgazer not found on window')
        return false
    }

    // ── Resolve the tracker INSTANCE ─────────────────────────────────────────
    // getTracker() returns the active instance; webgazer.tracker is only the namespace.
    var inst = null
    if (typeof window.webgazer.getTracker === 'function') {
        inst = window.webgazer.getTracker()
    }
    // Fallback: some forks store the instance under .params.trackerObj or ._tracker
    if (!inst && window.webgazer.params) {
        inst = window.webgazer.params.trackerObj || window.webgazer.params._tracker || null
    }

    if (!inst) {
        console.warn('[HeadPose] Could not resolve tracker instance from webgazer.getTracker()')
        return false
    }

    // ── Strategy A: wrap predict() ────────────────────────────────────────────
    if (typeof inst.predict === 'function') {
        var _orig = inst.predict.bind(inst)
        var predictWrapped = false   // becomes true once we confirm predict yields landmarks

        inst.predict = async function () {
            var result = await _orig.apply(inst, arguments)
            if (result) {
                // Try every landmark field name used across WebGazer v2.x forks
                var lm = result.positions    ||   // original v2.0 fork
                         result.keypoints    ||   // face-landmarks-detection v1
                         result.rawCoordinates || // some custom forks
                         result.mesh         || null
                if (lm && lm.length >= 50) {
                    predictWrapped = true
                    try { callback(lm) } catch (e) { /* never crash webgazer */ }
                }
            }
            return result   // unmodified — WebGazer uses this for eye crops
        }

        // Give Strategy A 2 seconds to fire; if it never delivers landmarks,
        // escalate to Strategy B which calls the model directly.
        setTimeout(function () {
            if (!predictWrapped && inst.model) {
                console.log('[HeadPose] predict() yields no landmarks → escalating to direct model')
                _startDirectDetection(inst.model, callback)
            }
        }, 2000)

        console.log('[HeadPose] Hook installed via tracker.predict wrapper')
        return true
    }

    // ── Strategy B: direct model.estimateFaces ────────────────────────────────
    if (inst.model) {
        var ok = _startDirectDetection(inst.model, callback)
        if (ok) return true
    }

    console.warn('[HeadPose] No viable hook point found — pose correction inactive')
    return false
}

/**
 * Runs face-landmarks-detection model directly on the WebGazer video element
 * at ~10 fps.  Reuses the already-loaded model; no second download.
 *
 * Stores a stop function at HeadPoseLayer._stopDirectDetection for cleanup.
 *
 * @param {object} faceModel  FaceLandmarksDetector instance (inst.model)
 * @param {function} callback
 * @returns {boolean}
 */
function _startDirectDetection(faceModel, callback) {
    // WebGazer creates a video element with this ID
    var videoEl = document.getElementById('webgazerVideoFeed') ||
                  document.querySelector('video[id*="webgazer"]') ||
                  document.querySelector('video')
    if (!videoEl) {
        console.warn('[HeadPose] WebGazer video element not found for direct detection')
        return false
    }

    var active  = true
    var timerId = null

    function tick() {
        if (!active) return
        if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
            faceModel.estimateFaces(videoEl, { flipHorizontal: false })
                .then(function (faces) {
                    if (!active) return
                    if (faces && faces.length > 0) {
                        // face-landmarks-detection v1 stores landmarks in .keypoints
                        var lm = faces[0].keypoints || faces[0].scaledMesh || faces[0].mesh
                        if (lm && lm.length >= 50) {
                            try { callback(lm) } catch (e) {}
                        }
                    }
                    timerId = setTimeout(tick, 100)   // 10 fps
                })
                .catch(function () {
                    if (active) timerId = setTimeout(tick, 300)
                })
        } else {
            timerId = setTimeout(tick, 300)   // video not ready yet
        }
    }

    tick()

    // Expose stop handle so HeadPoseLayer.destroy() can clean up
    if (typeof HeadPoseLayer !== 'undefined') {
        HeadPoseLayer._stopDirectDetection = function () {
            active  = false
            if (timerId) clearTimeout(timerId)
        }
    }

    console.log('[HeadPose] Direct model.estimateFaces hook active at ~10 fps')
    return true
}
