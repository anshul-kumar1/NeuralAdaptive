// content.js - NeuralAdaptive v3.0.0
// Gaze source: MediaPipe FaceMesh iris tracking in offscreen document (PDR v3).
// Receives GAZE_UPDATE from background; drives DwellGrid, stress scoring, interventions.

// Safety shim: head-pose-layer.js is no longer loaded. Declares HeadPoseLayer as null
// so legacy guarded references in runNosePoseCalibrationMode / runPoseStage don't throw.
var HeadPoseLayer = null

console.log('[NeuralAdaptive v3.0.0] content.js loaded')

var CONFIG = {
    SEND_INTERVAL_MS:              1000,
    FIXATION_THRESHOLD_PX:         60,
    FIXATION_STRESS_DURATION_MS:   1500,
    SACCADE_HIGH_VELOCITY:         500,
    SAMPLE_BUFFER_SIZE:            90,
    REGRESSION_WINDOW:             20,
    CALIBRATION_VERSION:           'iris_v2',
    POSE_CALIBRATION_VERSION:      'iris_pose_v1',
    CALIBRATION_CLICKS_PER_POINT:  5,
    VALIDATION_THRESHOLD_PX:       160,
    MAX_FORCED_RECALIBRATION_ATTEMPTS: 1,
    GAZE_SMOOTHING_FACTOR:         0.15,   // low-pass Î± â€” lower = smoother/slower
    DWELL_THRESHOLD_MS:            1500,   // ms in same grid sector to fire dwell event
    GRID_COLS:                     3,
    GRID_ROWS:                     4,
    INTERVENTION_MIN_READING_SCORE: 0.42,
    INTERVENTION_MAX_DEGRADATION:   0.80,
    INTERVENTION_MIN_MEAS_RATIO:    0.65,
    INTERVENTION_QUIET_MS:          2200,
    INTERVENTION_CONFIRM_TICKS:     2,
    // Blended readability boost: stress + disengagement + scroll/wheel churn
    READABILITY_W_STRESS:           0.22,
    READABILITY_W_DISENGAGE:        0.28,
    READABILITY_W_SCROLL:           0.12,
    READABILITY_SMOOTH_ALPHA:       0.10,
    READABILITY_WHEEL_WINDOW_MS:    2400,
    READABILITY_WHEEL_CAP:          900,
    READABILITY_MEAS_GATE:          0.42,
    READABILITY_ANCHOR_COOLDOWN_MS: 26000,
    READABILITY_ANCHOR_SPIKE_LO:    0.36,
    READABILITY_ANCHOR_SPIKE_HI:    0.58,
    // Cap visual effect — full struggle still computed but UI stays subtle
    READABILITY_STRUGGLE_CAP:       0.38,
    KALMAN_MEAS_NOISE_MIN:          15,
    KALMAN_MEAS_NOISE_MAX:          140,
    CAL_QUALITY_MAX_DEGRADATION:    0.65,
    CAL_QUALITY_MIN_MEAS_RATIO:     0.75,
    CAL_QUALITY_MAX_HEAD_SPEED:     9.0,
    CAL_POINT_STDDEV_BALANCED:      24,
    CAL_POINT_STDDEV_PRECISION:     16,
    LINE_SNAP_RADIUS_PX:            42,
    DRIFT_ANCHOR_BATCH:             12,
    DRIFT_ANCHOR_MAX_RESIDUAL_PX:   120,
    DRIFT_ANCHOR_QUALITY_READING:   0.60,
    DRIFT_ANCHOR_QUALITY_DEGRAD:    0.50,
    DRIFT_ANCHOR_QUALITY_MEAS:      0.80,
}

var ACCURACY_MODE = {
    balanced: {
        alpha:                0.15,   // retained for outlier/validation config lookups
        outlierThresholdPx:   220,
        validationThresholdPx: 160,
    },
    precision: {
        alpha:                0.10,
        outlierThresholdPx:   160,
        validationThresholdPx: 100,
    },
}

// 5-point Princeton calibration wizard (TL â†’ TR â†’ Center â†’ BL â†’ BR)
var CAL_POINTS_5 = [
    { x: 5,  y: 5,  label: 'Top Left'     },
    { x: 95, y: 5,  label: 'Top Right'    },
    { x: 50, y: 50, label: 'Center'       },
    { x: 5,  y: 95, label: 'Bottom Left'  },
    { x: 95, y: 95, label: 'Bottom Right' },
]

// Legacy validation points (kept for popup display)
var VALIDATION_POINTS = [
    { x: 20, y: 20 }, { x: 80, y: 20 }, { x: 50, y: 50 },
    { x: 20, y: 80 }, { x: 80, y: 80 },
]

var gazeBuffer = []
var lastSendTime = 0
var currentTier = 'CALM'
var tooltipEl = null
var highlightedSentence = null
var isBooting = false
var isRunning = false
var isCalibrating = false
var activeAccuracyMode = 'balanced'
var smoothedPoint = null       // legacy alias â€” kept so existing call-sites compile
var calibrationPromise = null
var _gazeSmoothed = null   // IIR-smoothed gaze from offscreen
var measurementHistory = []
var interventionBlockedUntil = 0
var degradationSpikeStreak = 0
var interventionCandidateTier = null
var interventionCandidateCount = 0
var activeFlags = null
var lastRawGaze = null
var lastHeadMeta = { yaw: 0, pitch: 0, roll: 0, ipdRatio: 1, degradationScore: 0, isTrackerDegraded: false }
var lastHeadMetaTs = 0
var latestPrecisionLive = {
    measurementRatio: 1,
    readingScore: 0,
    degradationScore: 0,
    snapDistancePx: 0,
    interventionBlocked: false,
    ts: 0
}
var sessionMetrics = {
    sessionId: String(Date.now()) + '_' + Math.floor(Math.random() * 1e6),
    sessionStartTs: Date.now(),
    jitterSamples: [],
    lastFinalPoint: null,
    lineSwitchTotal: 0,
    lineSwitchSuspicious: 0,
    interventionActivations: 0,
    interventionFalseTriggers: 0,
}
var calibQuality = {
    accepted: 0,
    rejected: 0,
    pointStddevs: [],
}
var lineSnapCache = { entries: [], ts: 0 }
var lastLineId = null
var lastSweepTs = 0
var driftMap = { enabled: false, anchors: [], model: null, exploded: false, residualHistory: [] }
var residualFusion = { sampleCount: 0, wx: null, wy: null, dim: 12, residualHistory: [] }
var kalmanAdaptive = null
var latestFrameState = null
var lastSessionMirrorTs = 0
var driftResetListenersBound = false

// â”€â”€â”€ Recovery Module state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
var LearningState = {
    isDistracted:     false,
    lastReadElement:  null,   // DOM node of last confirmed reading position
    lastReadText:     '',     // text of that element (for Gemini)
    pageTextHistory:  [],     // rolling array of viewport snapshots (max 3)
    breadcrumbText:   null,   // pending Gemini response awaiting re-entry
    distractionStart: null,
    level:            0,      // 0=focused 1=away>5s 2=away>15s 3=away>20s
}
var lastGazeTimestamp  = 0
var watchdogIntervalId = null
var lkcIntervalId      = null

// Smoothing is now handled by KalmanGaze inside GazePipeline (gaze-pipeline.js).

// â”€â”€â”€ GazeCursor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Princeton-orange ring that follows the smoothed gaze point.
// WebGazer's built-in red dot is hidden; this replaces it with a styled ring.
var GazeCursor = {
    el: null,

    create: function () {
        if (document.getElementById('na-gaze-cursor')) return
        var el = document.createElement('div')
        el.id = 'na-gaze-cursor'
        document.body.appendChild(el)
        this.el = el
    },

    move: function (x, y) {
        if (!this.el) return
        // left/top are centre-anchored via CSS transform: translate(-50%,-50%)
        this.el.style.left    = Math.round(x) + 'px'
        this.el.style.top     = Math.round(y) + 'px'
        this.el.style.display = 'block'
    },

    hide: function () {
        if (this.el) this.el.style.display = 'none'
    },

    destroy: function () {
        var el = document.getElementById('na-gaze-cursor')
        if (el) el.remove()
        this.el = null
    }
}

// â”€â”€â”€ DwellGrid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Divides the viewport into GRID_COLS Ã— GRID_ROWS sectors.
// Fires onDwell(sectorId, x, y) only when the smoothed gaze stays inside the
// same sector for DWELL_THRESHOLD_MS â€” eliminating spurious fixation signals.
var DwellGrid = {
    currentSector: null,
    dwellTimer:    null,
    onDwellCb:     null,

    /**
     * Call once per gaze frame.
     * @param {number} x  smoothed viewport X
     * @param {number} y  smoothed viewport Y
     */
    update: function (x, y) {
        var sector = this._sector(x, y)
        if (sector !== this.currentSector) {
            // Left the previous sector â€” cancel any pending dwell
            if (this.dwellTimer) { clearTimeout(this.dwellTimer); this.dwellTimer = null }
            this.currentSector = sector

            if (this.onDwellCb) {
                var self = this
                var capturedX = x
                var capturedY = y
                this.dwellTimer = setTimeout(function () {
                    self.dwellTimer = null
                    self.onDwellCb(sector, capturedX, capturedY)
                }, CONFIG.DWELL_THRESHOLD_MS)
            }
        }
    },

    /**
     * Returns the <p> element (if any) at viewport coordinates (x, y).
     * Useful for knowing which paragraph the student has dwelled on.
     */
    getParagraphAt: function (x, y) {
        var el = document.elementFromPoint(x, y)
        while (el && el !== document.body) {
            if (el.tagName === 'P') return el
            el = el.parentElement
        }
        return null
    },

    /**
     * Maps (x, y) â†’ integer sector ID  0 â€¦ (COLS Ã— ROWS âˆ’ 1),
     * column-major within each row.
     */
    _sector: function (x, y) {
        var col = Math.min(Math.floor(x / window.innerWidth  * CONFIG.GRID_COLS), CONFIG.GRID_COLS - 1)
        var row = Math.min(Math.floor(y / window.innerHeight * CONFIG.GRID_ROWS), CONFIG.GRID_ROWS - 1)
        return row * CONFIG.GRID_COLS + col
    },

    reset: function () {
        if (this.dwellTimer) { clearTimeout(this.dwellTimer); this.dwellTimer = null }
        this.currentSector = null
    }
}

function getModeConfig() {
    return ACCURACY_MODE[activeAccuracyMode] || ACCURACY_MODE.balanced
}

// â”€â”€â”€ Viewport text helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getViewportText() {
    var vh = window.innerHeight
    var chunks = []
    document.querySelectorAll('p, li, h1, h2, h3').forEach(function (el) {
        var r = el.getBoundingClientRect()
        if (r.top < vh && r.bottom > 0) {
            var t = el.textContent.trim()
            if (t.length > 20) chunks.push(t)
        }
    })
    return chunks.join(' ').slice(0, 600)
}

function toViewportPoint(p) {
    return {
        x: Math.round((p.x / 100) * window.innerWidth),
        y: Math.round((p.y / 100) * window.innerHeight),
    }
}

function median(values) {
    if (!values || values.length === 0) return null
    var arr = values.slice().sort(function (a, b) { return a - b })
    var mid = Math.floor(arr.length / 2)
    if (arr.length % 2 === 0) return (arr[mid - 1] + arr[mid]) / 2
    return arr[mid]
}

function mean(values) {
    if (!values || values.length === 0) return null
    return values.reduce(function (s, v) { return s + v }, 0) / values.length
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi))
}

function getDefaultFlags() {
    var m = chrome.runtime.getManifest()
    var isDev = !m.update_url
    return {
        adaptive_kalman_v1: isDev,
        intervention_hysteresis_v2: isDev,
        calibration_quality_gates_v1: false,
        line_aware_snap_v1: false,
        drift_map_v1: false,
        residual_fusion_v1: false,
    }
}

function mergeFlags(flags) {
    var d = getDefaultFlags()
    if (!flags || typeof flags !== 'object') return d
    Object.keys(d).forEach(function (k) {
        if (typeof flags[k] === 'boolean') d[k] = flags[k]
    })
    return d
}

async function loadFlagsFromStorage() {
    return await new Promise(function (resolve) {
        chrome.storage.local.get(['na_flags'], function (data) {
            if (chrome.runtime.lastError) {
                activeFlags = mergeFlags(null)
                resolve(activeFlags)
                return
            }
            activeFlags = mergeFlags(data && data.na_flags)
            resolve(activeFlags)
        })
    })
}

function getMeasurementRatio() {
    if (!measurementHistory.length) return 1
    var sum = measurementHistory.reduce(function (s, v) { return s + v }, 0)
    return sum / measurementHistory.length
}

function pushMeasurementFlag(hasMeasurement) {
    measurementHistory.push(hasMeasurement ? 1 : 0)
    if (measurementHistory.length > 60) measurementHistory.shift()
}

function medianCopy(values) {
    if (!values || values.length === 0) return null
    var arr = values.slice().sort(function (a, b) { return a - b })
    var mid = Math.floor(arr.length / 2)
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2
}

function stddev(values) {
    if (!values || values.length === 0) return 0
    var m = mean(values) || 0
    var variance = values.reduce(function (s, v) {
        var d = v - m
        return s + d * d
    }, 0) / values.length
    return Math.sqrt(variance)
}

function hashLineId(seed) {
    var h = 2166136261
    for (var i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i)
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)
    }
    return 'ln_' + (h >>> 0).toString(16)
}

function buildLineCandidates() {
    var now = Date.now()
    if (now - lineSnapCache.ts < 350) return lineSnapCache.entries
    lineSnapCache.ts = now
    var entries = []
    var els = document.querySelectorAll('p, li, h1, h2, h3, blockquote, td, th')
    for (var i = 0; i < els.length && entries.length < 400; i++) {
        var el = els[i]
        var rect = el.getBoundingClientRect()
        if (rect.width < 20 || rect.height < 8) continue
        if (rect.bottom < -20 || rect.top > window.innerHeight + 20) continue
        var style = window.getComputedStyle(el)
        var lineHeight = parseFloat(style.lineHeight)
        if (!isFinite(lineHeight) || lineHeight <= 0) {
            lineHeight = parseFloat(style.fontSize) * 1.4
        }
        lineHeight = Math.max(12, Math.min(48, lineHeight || 18))
        var lineCount = Math.max(1, Math.round(rect.height / lineHeight))
        for (var line = 0; line < lineCount; line++) {
            var y = rect.top + Math.min(rect.height - 1, lineHeight * (line + 0.5))
            var id = hashLineId(el.tagName + '|' + i + '|' + line + '|' + Math.round(rect.left) + '|' + Math.round(rect.top))
            entries.push({
                id: id,
                element: el,
                rect: rect,
                lineMidX: rect.left + rect.width / 2,
                lineMidY: y,
            })
        }
    }
    lineSnapCache.entries = entries
    return entries
}

function lineAwareSnap(x, y) {
    var entries = buildLineCandidates()
    var best = null
    var bestScore = Infinity
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i]
        var dx = x - e.lineMidX
        var dy = y - e.lineMidY
        var score = Math.sqrt((dx * dx) + (dy * dy * 1.8 * 1.8))
        if (score < bestScore) {
            bestScore = score
            best = e
        }
    }
    if (!best) {
        return { x: x, y: y, snapDistancePx: Infinity, lineId: null, lineSnapUsed: false, element: null }
    }
    if (bestScore <= CONFIG.LINE_SNAP_RADIUS_PX) {
        var sx = clamp(x, best.rect.left, best.rect.right)
        var sy = best.lineMidY
        return {
            x: sx,
            y: sy,
            snapDistancePx: Math.sqrt(Math.pow(sx - x, 2) + Math.pow(sy - y, 2)),
            lineId: best.id,
            lineSnapUsed: true,
            element: best.element,
            anchorX: sx,
            anchorY: sy,
        }
    }
    // Fallback: rectangle magnetism from prior behavior.
    var dx = Math.max(best.rect.left - x, 0, x - best.rect.right)
    var dy = Math.max(best.rect.top - y, 0, y - best.rect.bottom)
    var rectDist = Math.sqrt(dx * dx + dy * dy)
    if (rectDist <= 80) {
        var fx = clamp(x, best.rect.left, best.rect.right)
        var fy = clamp(y, best.rect.top, best.rect.bottom)
        return { x: fx, y: fy, snapDistancePx: rectDist, lineId: best.id, lineSnapUsed: false, element: best.element, anchorX: fx, anchorY: fy }
    }
    return { x: x, y: y, snapDistancePx: bestScore, lineId: best.id, lineSnapUsed: false, element: best.element }
}

function initAdaptiveKalman() {
    kalmanAdaptive = {
        x: { pos: 0, vel: 0, pp: 1000, pv: 0, vp: 0, vv: 100, lastT: null },
        y: { pos: 0, vel: 0, pp: 1000, pv: 0, vp: 0, vv: 100, lastT: null },
        q: 8,
        baseR: 40,
    }
}

function kalmanPredictAxis(axis, q, nowMs) {
    var dt = axis.lastT !== null ? (nowMs - axis.lastT) / 1000 : 0.033
    axis.lastT = nowMs
    dt = clamp(dt, 0.001, 0.2)
    axis.pos += axis.vel * dt
    var pp = axis.pp + dt * (axis.pv + axis.vp) + dt * dt * axis.vv + q * dt * dt * dt / 3
    var pv = axis.pv + dt * axis.vv + q * dt * dt / 2
    var vp = axis.vp + dt * axis.vv + q * dt * dt / 2
    var vv = axis.vv + q * dt
    axis.pp = pp; axis.pv = pv; axis.vp = vp; axis.vv = vv
}

function kalmanUpdateAxis(axis, measurement, r) {
    var S = axis.pp + r
    if (S <= 0) return
    var kp = axis.pp / S
    var kv = axis.vp / S
    var innov = measurement - axis.pos
    axis.pos += kp * innov
    axis.vel += kv * innov
    var pp = (1 - kp) * axis.pp
    var pv = (1 - kp) * axis.pv
    var vp = axis.vp - kv * axis.pp
    var vv = axis.vv - kv * axis.pv
    axis.pp = pp; axis.pv = pv; axis.vp = vp; axis.vv = vv
}

function computeAdaptiveMeasurementNoise(hasMeasurement, readingScore, degradationScore, measurementRatio) {
    var r = kalmanAdaptive.baseR
    if (!hasMeasurement) r *= 1.8
    r *= 1 + clamp(degradationScore, 0, 1.5) * 0.8
    if (readingScore < 0.55) r *= 1.2
    if (measurementRatio < 0.75) r *= 1.25
    if (readingScore >= 0.55 && degradationScore <= 0.4 && measurementRatio >= 0.85) r *= 0.8
    return clamp(r, CONFIG.KALMAN_MEAS_NOISE_MIN, CONFIG.KALMAN_MEAS_NOISE_MAX)
}

function adaptiveKalmanProcess(rawX, rawY, meta) {
    if (!kalmanAdaptive) initAdaptiveKalman()
    var now = Date.now()
    var hasMeasurement = !(meta && meta.hasMeasurement === false)
    var readingScore = meta && typeof meta.readingScore === 'number' ? meta.readingScore : 0.6
    var degradationScore = meta && typeof meta.degradationScore === 'number' ? meta.degradationScore : 0
    var measurementRatio = getMeasurementRatio()
    var r = computeAdaptiveMeasurementNoise(hasMeasurement, readingScore, degradationScore, measurementRatio)
    kalmanPredictAxis(kalmanAdaptive.x, kalmanAdaptive.q, now)
    kalmanPredictAxis(kalmanAdaptive.y, kalmanAdaptive.q, now)
    if (hasMeasurement) {
        kalmanUpdateAxis(kalmanAdaptive.x, rawX, r)
        kalmanUpdateAxis(kalmanAdaptive.y, rawY, r)
    }
    return { x: kalmanAdaptive.x.pos, y: kalmanAdaptive.y.pos, vx: kalmanAdaptive.x.vel, vy: kalmanAdaptive.y.vel, r: r }
}

function resetAdaptiveKalman() {
    kalmanAdaptive = null
}

function gatherResidualFeatures(point, meta, readingScore, degradationScore) {
    var x = point.x, y = point.y
    var vx = point.vx || 0, vy = point.vy || 0
    var regionBucket = 0
    var col = clamp(Math.floor((x / Math.max(window.innerWidth, 1)) * 3), 0, 2)
    var row = clamp(Math.floor((y / Math.max(window.innerHeight, 1)) * 3), 0, 2)
    regionBucket = row * 3 + col
    return [
        1,
        x / Math.max(window.innerWidth, 1),
        y / Math.max(window.innerHeight, 1),
        vx / 1000,
        vy / 1000,
        (meta.yaw || 0) / 45,
        (meta.pitch || 0) / 40,
        (meta.roll || 0) / 30,
        (meta.ipdRatio || 1) - 1,
        readingScore,
        degradationScore,
        regionBucket / 8,
    ]
}

function dot(weights, features) {
    var s = 0
    for (var i = 0; i < features.length; i++) s += weights[i] * features[i]
    return s
}

function norm(weights) {
    var s = 0
    for (var i = 0; i < weights.length; i++) s += weights[i] * weights[i]
    return Math.sqrt(s)
}

function initResidualFusion() {
    residualFusion.wx = new Array(residualFusion.dim).fill(0)
    residualFusion.wy = new Array(residualFusion.dim).fill(0)
    residualFusion.sampleCount = 0
    residualFusion.residualHistory = []
}

function trainResidualFusion(features, dx, dy) {
    if (!residualFusion.wx) initResidualFusion()
    var lr = 0.02
    var lambda = 0.001
    var px = dot(residualFusion.wx, features)
    var py = dot(residualFusion.wy, features)
    var ex = px - dx
    var ey = py - dy
    for (var i = 0; i < features.length; i++) {
        residualFusion.wx[i] -= lr * (ex * features[i] + lambda * residualFusion.wx[i])
        residualFusion.wy[i] -= lr * (ey * features[i] + lambda * residualFusion.wy[i])
    }
    var maxNorm = 10
    var nx = norm(residualFusion.wx)
    var ny = norm(residualFusion.wy)
    if (nx > maxNorm) {
        var sx = maxNorm / nx
        for (var j = 0; j < residualFusion.wx.length; j++) residualFusion.wx[j] *= sx
    }
    if (ny > maxNorm) {
        var sy = maxNorm / ny
        for (var k = 0; k < residualFusion.wy.length; k++) residualFusion.wy[k] *= sy
    }
    residualFusion.sampleCount += 1
}

function applyResidualFusion(point, meta, readingScore, degradationScore) {
    if (!residualFusion.wx) initResidualFusion()
    var features = gatherResidualFeatures(point, meta, readingScore, degradationScore)
    var predDx = dot(residualFusion.wx, features)
    var predDy = dot(residualFusion.wy, features)
    var confidence = clamp(residualFusion.sampleCount / 60, 0, 1) * clamp(1 - degradationScore, 0, 1)
    var residualMedian = medianCopy(residualFusion.residualHistory) || 0
    if (residualMedian > CONFIG.DRIFT_ANCHOR_MAX_RESIDUAL_PX) confidence = 0
    return {
        x: point.x + predDx * confidence,
        y: point.y + predDy * confidence,
        features: features,
        confidence: confidence,
        predDx: predDx,
        predDy: predDy,
    }
}

function fitAffineFromAnchors(anchors) {
    if (!anchors || anchors.length < 4) return null
    var s_rx2 = 0, s_rxry = 0, s_rx = 0, s_ry2 = 0, s_ry = 0
    var s_rxsx = 0, s_rysx = 0, s_sx = 0, s_rxsy = 0, s_rysy = 0, s_sy = 0
    for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i]
        var w = Math.max(0.2, Math.min(1, a.weight || 1))
        var rx = a.rawX, ry = a.rawY, sx = a.anchorX, sy = a.anchorY
        s_rx2 += w * rx * rx; s_rxry += w * rx * ry; s_rx += w * rx
        s_ry2 += w * ry * ry; s_ry += w * ry
        s_rxsx += w * rx * sx; s_rysx += w * ry * sx; s_sx += w * sx
        s_rxsy += w * rx * sy; s_rysy += w * ry * sy; s_sy += w * sy
    }
    var m = [s_rx2, s_rxry, s_rx, s_rxry, s_ry2, s_ry, s_rx, s_ry, anchors.length]
    var inv = inv3x3(m)
    if (!inv) return null
    var cx = mulMat3Vec(inv, [s_rxsx, s_rysx, s_sx])
    var cy = mulMat3Vec(inv, [s_rxsy, s_rysy, s_sy])
    return { a: cx[0], b: cx[1], c: cx[2], d: cy[0], e: cy[1], f: cy[2] }
}

function inv3x3(m) {
    var det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
    if (Math.abs(det) < 1e-12) return null
    var d = 1 / det
    return [
        (m[4] * m[8] - m[5] * m[7]) * d, (m[2] * m[7] - m[1] * m[8]) * d, (m[1] * m[5] - m[2] * m[4]) * d,
        (m[5] * m[6] - m[3] * m[8]) * d, (m[0] * m[8] - m[2] * m[6]) * d, (m[2] * m[3] - m[0] * m[5]) * d,
        (m[3] * m[7] - m[4] * m[6]) * d, (m[1] * m[6] - m[0] * m[7]) * d, (m[0] * m[4] - m[1] * m[3]) * d
    ]
}

function mulMat3Vec(m, v) {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
    ]
}

function applyAffine(model, x, y) {
    if (!model) return { x: x, y: y }
    return { x: model.a * x + model.b * y + model.c, y: model.d * x + model.e * y + model.f }
}

function maybeUpdateDriftModel() {
    if (driftMap.exploded) return
    if (driftMap.anchors.length < CONFIG.DRIFT_ANCHOR_BATCH) return
    driftMap.model = fitAffineFromAnchors(driftMap.anchors)
    if (!driftMap.model) return
    var residuals = driftMap.anchors.slice(-20).map(function (a) {
        var p = applyAffine(driftMap.model, a.rawX, a.rawY)
        return Math.sqrt(Math.pow(p.x - a.anchorX, 2) + Math.pow(p.y - a.anchorY, 2))
    })
    var med = medianCopy(residuals) || 0
    driftMap.residualHistory.push(med)
    if (driftMap.residualHistory.length > 40) driftMap.residualHistory.shift()
    if (med > CONFIG.DRIFT_ANCHOR_MAX_RESIDUAL_PX) {
        driftMap.exploded = true
        driftMap.model = null
    }
}

function resetDriftMap() {
    driftMap.anchors = []
    driftMap.model = null
    driftMap.exploded = false
    driftMap.residualHistory = []
}

function onMajorLayoutChange() {
    lineSnapCache.ts = 0
    resetDriftMap()
}

function bindDriftResetListeners() {
    if (driftResetListenersBound) return
    window.addEventListener('resize', onMajorLayoutChange, true)
    window.addEventListener('orientationchange', onMajorLayoutChange, true)
    window.addEventListener('pagehide', onMajorLayoutChange, true)
    driftResetListenersBound = true
}

function unbindDriftResetListeners() {
    if (!driftResetListenersBound) return
    window.removeEventListener('resize', onMajorLayoutChange, true)
    window.removeEventListener('orientationchange', onMajorLayoutChange, true)
    window.removeEventListener('pagehide', onMajorLayoutChange, true)
    driftResetListenersBound = false
}

function captureSessionJitter(point, hasMeasurement) {
    if (!hasMeasurement) return
    if (sessionMetrics.lastFinalPoint) {
        var dx = point.x - sessionMetrics.lastFinalPoint.x
        var dy = point.y - sessionMetrics.lastFinalPoint.y
        var d = Math.sqrt(dx * dx + dy * dy)
        sessionMetrics.jitterSamples.push(d)
        if (sessionMetrics.jitterSamples.length > 800) sessionMetrics.jitterSamples.shift()
    }
    sessionMetrics.lastFinalPoint = { x: point.x, y: point.y }
}

function buildSessionMetricsSnapshot() {
    var jitterMedian = medianCopy(sessionMetrics.jitterSamples) || 0
    var lineErr = sessionMetrics.lineSwitchTotal > 0
        ? (sessionMetrics.lineSwitchSuspicious / sessionMetrics.lineSwitchTotal)
        : 0
    var interventionErr = sessionMetrics.interventionActivations > 0
        ? (sessionMetrics.interventionFalseTriggers / sessionMetrics.interventionActivations)
        : 0
    return {
        sessionId: sessionMetrics.sessionId || null,
        sessionStartTs: sessionMetrics.sessionStartTs,
        medianJitterPx: parseFloat(jitterMedian.toFixed(2)),
        lineSwitchErrorRate: parseFloat(lineErr.toFixed(3)),
        interventionFalseTriggerRate: parseFloat(interventionErr.toFixed(3)),
        counts: {
            lineSwitchTotal: sessionMetrics.lineSwitchTotal,
            lineSwitchSuspicious: sessionMetrics.lineSwitchSuspicious,
            interventionActivations: sessionMetrics.interventionActivations,
            interventionFalseTriggers: sessionMetrics.interventionFalseTriggers,
            jitterSamples: sessionMetrics.jitterSamples.length,
        },
        ts: Date.now(),
    }
}

function mirrorSessionMetricsMaybe() {
    if (!chrome.storage || !chrome.storage.session || !chrome.storage.session.set) return
    var now = Date.now()
    if (now - lastSessionMirrorTs < 1500) return
    lastSessionMirrorTs = now
    try {
        chrome.storage.session.set({ na_session_metrics: buildSessionMetricsSnapshot() }, function () {
            if (chrome.runtime.lastError) { /* swallow */ }
        })
    } catch (_e) {}
}

function estimateReadingScoreFromBuffer() {
    if (gazeBuffer.length < 6) return 0.5
    var recent = gazeBuffer.slice(-20)
    var total = 0
    var rightward = 0
    var stableY = 0
    for (var i = 1; i < recent.length; i++) {
        var dt = Math.max(1, recent[i].t - recent[i - 1].t)
        var vx = (recent[i].x - recent[i - 1].x) / dt * 1000
        var vy = Math.abs((recent[i].y - recent[i - 1].y) / dt * 1000)
        if (Math.abs(vx) > 1200) continue
        total++
        if (vx > 50) rightward++
        if (vy < 280) stableY++
    }
    if (!total) return 0.5
    var s = (rightward / total) * 0.6 + (stableY / total) * 0.4
    return clamp(s, 0, 1)
}

function getCurrentHeadSpeedDegPerSec() {
    var now = Date.now()
    if (!lastHeadMetaTs || !sessionMetrics._prevHeadMeta) {
        sessionMetrics._prevHeadMeta = { yaw: lastHeadMeta.yaw || 0, pitch: lastHeadMeta.pitch || 0, t: now }
        return 0
    }
    var prev = sessionMetrics._prevHeadMeta
    var dt = Math.max(0.001, (now - prev.t) / 1000)
    var s = Math.sqrt(Math.pow((lastHeadMeta.yaw || 0) - prev.yaw, 2) + Math.pow((lastHeadMeta.pitch || 0) - prev.pitch, 2)) / dt
    sessionMetrics._prevHeadMeta = { yaw: lastHeadMeta.yaw || 0, pitch: lastHeadMeta.pitch || 0, t: now }
    return s
}

function getCalibrationVarianceThreshold() {
    return activeAccuracyMode === 'precision' ? CONFIG.CAL_POINT_STDDEV_PRECISION : CONFIG.CAL_POINT_STDDEV_BALANCED
}

function injectStyles() {
    if (document.getElementById('na-styles')) return
    var style = document.createElement('style')
    style.id = 'na-styles'
    style.textContent = [
        // Gaze cursor â€” Princeton orange ring, centre-anchored
        '#na-gaze-cursor {',
        '  position: fixed;',
        '  width: 22px; height: 22px;',
        '  border-radius: 50%;',
        '  border: 3px solid #E77500;',
        '  background: rgba(231, 117, 0, 0.18);',
        '  pointer-events: none;',
        '  z-index: 2147483645;',
        '  transform: translate(-50%, -50%);',
        '  display: none;',
        '  box-shadow: 0 0 8px rgba(231,117,0,0.5);',
        '}',

        // Princeton calibration wizard dots
        '@keyframes na-cal-pulse {',
        '  0%,100% { transform: translate(-50%,-50%) scale(1);   box-shadow: 0 0 0 0 rgba(231,117,0,0.7); }',
        '  50%      { transform: translate(-50%,-50%) scale(1.15); box-shadow: 0 0 0 12px rgba(231,117,0,0); }',
        '}',
        '.na-cal-dot {',
        '  position: fixed;',
        '  width: 30px; height: 30px;',
        '  border-radius: 50%;',
        '  background: #E77500;',
        '  border: 3px solid #fff;',
        '  transform: translate(-50%, -50%);',
        '  cursor: crosshair;',
        '  z-index: 2147483648;',
        '  animation: na-cal-pulse 1.2s ease-in-out infinite;',
        '  display: flex; align-items: center; justify-content: center;',
        '  font-size: 11px; font-weight: 700; color: #fff;',
        '}',
        '.na-cal-dot.na-cal-dot--done {',
        '  background: #3fb950;',
        '  animation: none;',
        '}',

        // Intervention classes
        '.na-elevated p { line-height: 1.9 !important; letter-spacing: 0.04em !important; transition: all 0.6s ease !important; }',
        '.na-overload p { line-height: 2.1 !important; letter-spacing: 0.12em !important; max-width: 66ch !important; transition: all 0.6s ease !important; }',
        '.na-sentence { transition: opacity 0.4s ease; display: inline; }',

        // Dyslexia mode: ONE focused paragraph (.na-dyslexia-focus) — not whole page.
        'p.na-dyslexia-focus {',
        '  font-family: "OpenDyslexic", "Lexend", "Atkinson Hyperlegible", "Arial", sans-serif !important;',
        '  font-size: 1.08em !important;',
        '  line-height: 1.72 !important;',
        '  letter-spacing: 0.045em !important;',
        '  word-spacing: 0.16em !important;',
        '  text-rendering: optimizeLegibility !important;',
        '  max-width: 72ch !important;',
        '  color: #121212 !important;',
        '  background: rgba(253, 247, 233, 0.88) !important;',
        '  border-radius: 6px !important;',
        '  padding: 0.35em 0.45em !important;',
        '  box-shadow: 0 2px 14px rgba(0,0,0,0.08) !important;',
        '  hyphens: none !important;',
        '  word-break: normal !important;',
        '  transition: font-size 0.45s ease, background 0.45s ease !important;',
        '}',

        // Blended struggle → dynamic type on ONE paragraph (.na-readability-focus, --na-struggle)
        'p.na-readability-focus {',
        '  font-size: calc(1em + var(--na-struggle, 0) * 0.22em) !important;',
        '  letter-spacing: calc(0.012em + var(--na-struggle, 0) * 0.08em) !important;',
        '  word-spacing: calc(0.04em + var(--na-struggle, 0) * 0.14em) !important;',
        '  line-height: calc(1.48 + var(--na-struggle, 0) * 0.28) !important;',
        '  transition: font-size 0.9s ease, letter-spacing 0.9s ease, word-spacing 0.9s ease, line-height 0.9s ease !important;',
        '}',

        // ── OVERLOAD screen-border halo ──────────────────────────────────────
        // Full-viewport, pointer-events:none overlay that pulses while the
        // current reading tier is OVERLOAD. Lets the student see "you just
        // spiked" without needing to look at any specific UI.
        '#na-overload-halo {',
        '  position: fixed !important;',
        '  inset: 0 !important;',
        '  pointer-events: none !important;',
        '  z-index: 2147483643 !important;',
        '  opacity: 0;',
        '  background: transparent;',
        '  box-shadow: inset 0 0 70px 14px rgba(231, 117, 0, 0.30);',
        '  transition: opacity 0.45s ease;',
        '}',
        '#na-overload-halo.na-halo-elevated {',
        '  opacity: 1;',
        '  box-shadow: inset 0 0 60px 10px rgba(231, 117, 0, 0.22);',
        '}',
        '#na-overload-halo.na-halo-overload {',
        '  opacity: 1;',
        '  animation: na-halo-pulse 2.2s ease-in-out infinite;',
        '}',
        '@keyframes na-halo-pulse {',
        '  0%, 100% { box-shadow: inset 0 0 80px 18px rgba(231, 117, 0, 0.55); }',
        '  50%      { box-shadow: inset 0 0 130px 32px rgba(231, 117, 0, 0.80); }',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  #na-overload-halo.na-halo-overload { animation: none; box-shadow: inset 0 0 90px 22px rgba(231, 117, 0, 0.65); }',
        '}',

        // ── Inline AI simplification (OVERLOAD tier) ─────────────────────────
        '.na-dim-surround p:not(.na-simplified) { opacity: 0.35 !important; filter: blur(0.3px); transition: opacity 0.6s ease, filter 0.6s ease !important; }',
        'p.na-simplified {',
        '  opacity: 1 !important;',
        '  filter: none !important;',
        '  position: relative !important;',
        '  font-size: 1.12em !important;',
        '  line-height: 2.0 !important;',
        '  letter-spacing: 0.02em !important;',
        '  background: linear-gradient(180deg, rgba(231,117,0,0.08), rgba(231,117,0,0.03)) !important;',
        '  border-left: 4px solid #E77500 !important;',
        '  padding: 14px 18px 14px 20px !important;',
        '  border-radius: 6px !important;',
        '  margin: 16px 0 !important;',
        '  transition: opacity 0.4s ease, background 0.4s ease !important;',
        '  font-family: "Atkinson Hyperlegible", "Lexend", system-ui, sans-serif !important;',
        '}',
        '.na-simplified-badge {',
        '  display: inline-flex; align-items: center; gap: 6px;',
        '  font-size: 10px; font-weight: 700; letter-spacing: 0.12em;',
        '  text-transform: uppercase; color: #E77500;',
        '  margin-bottom: 8px;',
        '}',
        '.na-simplified-badge::before {',
        '  content: ""; width: 6px; height: 6px; border-radius: 50%;',
        '  background: #E77500; box-shadow: 0 0 6px rgba(231,117,0,0.7);',
        '}',
        '.na-simplified-toggle {',
        '  background: transparent; border: 1px solid rgba(231,117,0,0.45);',
        '  color: #E77500; font-size: 11px; font-weight: 600;',
        '  padding: 3px 9px; border-radius: 4px; cursor: pointer;',
        '  margin-left: 8px; letter-spacing: 0.04em;',
        '  transition: background 0.2s ease !important;',
        '}',
        '.na-simplified-toggle:hover { background: rgba(231,117,0,0.12) !important; }',
        '@keyframes na-simplify-pulse {',
        '  0%,100% { background: rgba(231,117,0,0.05); }',
        '  50%     { background: rgba(231,117,0,0.18); }',
        '}',
        'p.na-simplified-pending {',
        '  opacity: 0.85 !important;',
        '  filter: none !important;',
        '  animation: na-simplify-pulse 1.4s ease-in-out infinite !important;',
        '  border-left: 3px solid rgba(231,117,0,0.55) !important;',
        '  padding-left: 14px !important;',
        '  transition: all 0.3s ease !important;',
        '}',

        // ── Coach agent: summary bullets card ────────────────────────────────
        'ul.na-coach-bullets {',
        '  list-style: none !important;',
        '  padding: 0 !important;',
        '  margin: 10px 0 0 0 !important;',
        '}',
        'ul.na-coach-bullets li {',
        '  position: relative !important;',
        '  padding: 4px 0 4px 22px !important;',
        '  font-size: 1.02em !important;',
        '  line-height: 1.7 !important;',
        '  color: inherit !important;',
        '}',
        'ul.na-coach-bullets li::before {',
        '  content: ""; position: absolute; left: 4px; top: 14px;',
        '  width: 8px; height: 8px; border-radius: 50%;',
        '  background: #E77500; box-shadow: 0 0 6px rgba(231,117,0,0.6);',
        '}',

        // ── Coach agent: define card ─────────────────────────────────────────
        'aside.na-coach-define {',
        '  position: relative !important;',
        '  margin: 14px 0 !important;',
        '  padding: 12px 16px 12px 18px !important;',
        '  background: linear-gradient(180deg, rgba(43,109,255,0.10), rgba(43,109,255,0.04)) !important;',
        '  border-left: 4px solid #2B6DFF !important;',
        '  border-radius: 6px !important;',
        '  font-family: "Atkinson Hyperlegible", "Lexend", system-ui, sans-serif !important;',
        '  opacity: 1 !important;',
        '  filter: none !important;',
        '}',
        '.na-coach-define-head {',
        '  font-size: 10px; font-weight: 700; letter-spacing: 0.14em;',
        '  text-transform: uppercase; color: #2B6DFF; margin-bottom: 6px;',
        '}',
        '.na-coach-define-body { font-size: 1.02em; line-height: 1.6; }',
        '.na-coach-define-foot {',
        '  margin-top: 6px; font-size: 11px; opacity: 0.55; letter-spacing: 0.02em;',
        '}',
        '.na-coach-define-close {',
        '  position: absolute; top: 6px; right: 8px;',
        '  background: none; border: none; cursor: pointer;',
        '  font-size: 14px; color: #2B6DFF; opacity: 0.55; line-height: 1;',
        '}',
        '.na-coach-define-close:hover { opacity: 1 !important; }',

        // ── Coach agent: breadcrumb banner ───────────────────────────────────
        '#na-breadcrumb {',
        '  position: fixed; top: 20px; left: 50%; transform: translate(-50%, -20px);',
        '  z-index: 2147483646; display: flex; align-items: center; gap: 12px;',
        '  padding: 10px 16px; border-radius: 999px;',
        '  background: rgba(10,10,16,0.94); color: #f1f1f1;',
        '  font-family: "Segoe UI", Tahoma, sans-serif; font-size: 13px;',
        '  border: 0.5px solid rgba(255,255,255,0.12);',
        '  box-shadow: 0 8px 24px rgba(0,0,0,0.35);',
        '  opacity: 0; transition: opacity 0.3s ease, transform 0.3s ease;',
        '}',
        '#na-breadcrumb.na-breadcrumb-visible {',
        '  opacity: 1; transform: translate(-50%, 0);',
        '}',
        '.na-breadcrumb-label {',
        '  font-size: 10px; font-weight: 700; letter-spacing: 0.14em;',
        '  text-transform: uppercase; color: #E77500;',
        '}',
        '.na-breadcrumb-text { line-height: 1.4; }',
        '.na-breadcrumb-close {',
        '  background: none; border: none; color: #f1f1f1;',
        '  cursor: pointer; font-size: 14px; opacity: 0.5; line-height: 1;',
        '}',
        '.na-breadcrumb-close:hover { opacity: 1 !important; }',

        // â”€â”€ Visual Anchor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        '@keyframes na-anchor-pulse {',
        '  0%,100% { background: rgba(245,128,37,0.15); box-shadow: inset 4px 0 0 #F58025; }',
        '  50%      { background: rgba(245,128,37,0.35); box-shadow: inset 4px 0 0 #F58025; }',
        '}',
        '.na-visual-anchor {',
        '  border-left: 4px solid #F58025 !important;',
        '  padding-left: 12px !important;',
        '  background: rgba(255,165,0,0.2) !important;',
        '  animation: na-anchor-pulse 3s ease-in-out !important;',
        '  transition: background 0.4s ease, border-left 0.4s ease !important;',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  .na-visual-anchor { animation: none !important; }',
        '}',

        // â”€â”€ Peripheral Movement (slides in from edges at 2 Hz) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        '@keyframes na-peripheral-slide-l {',
        '  0%   { transform: translateX(-100%); opacity: 0; }',
        '  40%  { transform: translateX(0);     opacity: 1; }',
        '  60%  { transform: translateX(0);     opacity: 1; }',
        '  100% { transform: translateX(-100%); opacity: 0; }',
        '}',
        '@keyframes na-peripheral-slide-r {',
        '  0%   { transform: translateX(100%);  opacity: 0; }',
        '  40%  { transform: translateX(0);     opacity: 1; }',
        '  60%  { transform: translateX(0);     opacity: 1; }',
        '  100% { transform: translateX(100%);  opacity: 0; }',
        '}',
        '#na-peripheral-left, #na-peripheral-right {',
        '  position: fixed; top: 0; width: 56px; height: 100vh;',
        '  pointer-events: none; z-index: 2147483640;',
        '}',
        '#na-peripheral-left {',
        '  left: 0;',
        '  background: linear-gradient(90deg, rgba(100,160,255,0.30), transparent);',
        '  animation: na-peripheral-slide-l 500ms ease-in-out infinite;',
        '}',
        '#na-peripheral-right {',
        '  right: 0; pointer-events: auto;',
        '  background: linear-gradient(270deg, rgba(100,160,255,0.30), transparent);',
        '  animation: na-peripheral-slide-r 500ms ease-in-out infinite;',
        '  display: flex; align-items: flex-end; justify-content: flex-end; padding: 12px;',
        '}',
        '#na-peripheral-dismiss {',
        '  background: rgba(0,0,0,0.55); color: #ccc; border: 1px solid #555;',
        '  border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer;',
        '  pointer-events: auto; z-index: 2147483641;',
        '}',
        '@media (prefers-reduced-motion: reduce) {',
        '  #na-peripheral-left { animation: none; opacity: 0.25; }',
        '  #na-peripheral-right { animation: none; opacity: 0.25; }',
        '}',

        // â”€â”€ Breadcrumb toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        '@keyframes na-toast-in {',
        '  from { transform: translateY(20px); opacity: 0; }',
        '  to   { transform: translateY(0);    opacity: 1; }',
        '}',
        '#na-breadcrumb-toast {',
        '  position: fixed; bottom: 24px; right: 24px; max-width: 300px;',
        '  background: rgba(10,10,16,0.94); color: #f0f6fc;',
        '  border-left: 4px solid #F58025; border-radius: 10px;',
        '  padding: 12px 36px 12px 14px;',
        '  font-family: "Segoe UI", system-ui, sans-serif; font-size: 13px;',
        '  box-shadow: 0 4px 20px rgba(0,0,0,0.45);',
        '  z-index: 2147483646;',
        '  animation: na-toast-in 0.3s ease;',
        '}',
        '.na-toast-label {',
        '  font-size: 10px; font-weight: 700; letter-spacing: 0.1em;',
        '  color: #F58025; text-transform: uppercase; margin-bottom: 6px;',
        '}',
        '.na-toast-body { line-height: 1.55; color: #e8e8e8; }',
        '.na-toast-close {',
        '  position: absolute; top: 8px; right: 10px;',
        '  background: none; border: none; color: rgba(255,255,255,0.35);',
        '  font-size: 15px; cursor: pointer; line-height: 1; padding: 0;',
        '}',
        '.na-toast-close:hover { color: rgba(255,255,255,0.8); }',
        '@media (prefers-reduced-motion: reduce) {',
        '  #na-breadcrumb-toast { animation: none; }',
        '}',

        // ── Ambient Reading Progress Bar ─────────────────────────────────────
        // Thin Princeton-orange bar pinned to the top of the viewport. Ratchets
        // forward (never backward) based on the furthest paragraph read so far.
        '#na-progress-bar {',
        '  position: fixed;',
        '  top: 0; left: 0;',
        '  width: 100%; height: 3px;',
        '  background: rgba(231, 117, 0, 0.08);',
        '  z-index: 2147483643;',
        '  pointer-events: none;',
        '  opacity: 0;',
        '  transition: opacity 0.4s ease;',
        '}',
        '#na-progress-bar.na-progress-visible { opacity: 1; }',
        '#na-progress-bar-fill {',
        '  height: 100%; width: 0%;',
        '  background: linear-gradient(90deg, #E77500 0%, #F2A254 100%);',
        '  box-shadow: 0 0 8px rgba(231, 117, 0, 0.5);',
        '  transition: width 0.6s cubic-bezier(0.22,0.61,0.36,1);',
        '}',
        '#na-progress-badge {',
        '  position: fixed;',
        '  top: 10px; right: 14px;',
        '  z-index: 2147483643;',
        '  padding: 4px 10px;',
        '  border-radius: 999px;',
        '  background: rgba(10, 10, 16, 0.68);',
        '  color: #E77500;',
        '  font-family: "Segoe UI", Tahoma, sans-serif;',
        '  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;',
        '  text-transform: uppercase;',
        '  pointer-events: none;',
        '  opacity: 0;',
        '  transition: opacity 0.4s ease;',
        '}',
        '#na-progress-badge.na-progress-visible { opacity: 0.85; }',
    ].join('\n')
    document.head.appendChild(style)
}

// ── Gaze update from offscreen FaceMesh ──────────────────────────────────────
// Receives GAZE_UPDATE from background, applies IIR smoothing, drives all UI.
var _GAZE_ALPHA = 0.30

function onGazeUpdate(data) {
    if (!isRunning || isCalibrating) return
    data = data || {}

    var now = Date.now()
    var hasMeasurement = !!(data && data.hasMeasurement !== false && typeof data.x === 'number' && typeof data.y === 'number')
    var rawX = hasMeasurement ? data.x : (lastRawGaze ? lastRawGaze.x : null)
    var rawY = hasMeasurement ? data.y : (lastRawGaze ? lastRawGaze.y : null)
    if (hasMeasurement) lastRawGaze = { x: rawX, y: rawY }

    var prevYaw = lastHeadMeta.yaw || 0
    var prevPitch = lastHeadMeta.pitch || 0
    lastHeadMeta = {
        yaw: typeof data.yaw === 'number' ? data.yaw : prevYaw,
        pitch: typeof data.pitch === 'number' ? data.pitch : prevPitch,
        roll: typeof data.roll === 'number' ? data.roll : (lastHeadMeta.roll || 0),
        ipdRatio: typeof data.ipdRatio === 'number' ? data.ipdRatio : (lastHeadMeta.ipdRatio || 1),
        degradationScore: typeof data.degradationScore === 'number' ? data.degradationScore : (hasMeasurement ? 0 : 1),
        isTrackerDegraded: !!data.isTrackerDegraded || !hasMeasurement,
    }
    var dtSec = lastHeadMetaTs ? Math.max(0.001, (now - lastHeadMetaTs) / 1000) : 0.033
    var headSpeed = Math.sqrt(
        Math.pow(lastHeadMeta.yaw - prevYaw, 2) +
        Math.pow(lastHeadMeta.pitch - prevPitch, 2)
    ) / dtSec
    lastHeadMetaTs = now

    pushMeasurementFlag(hasMeasurement)
    var measurementRatio = getMeasurementRatio()
    var readingScore = estimateReadingScoreFromBuffer()

    var filtered
    if (activeFlags && activeFlags.adaptive_kalman_v1) {
        if (!hasMeasurement && (rawX === null || rawY === null)) {
            latestPrecisionLive.readingScore = readingScore
            latestPrecisionLive.degradationScore = lastHeadMeta.degradationScore
            latestPrecisionLive.measurementRatio = measurementRatio
            latestPrecisionLive.snapDistancePx = 999
            latestPrecisionLive.interventionBlocked = Date.now() < interventionBlockedUntil
            latestPrecisionLive.ts = now
            mirrorSessionMetricsMaybe()
            return
        }
        filtered = adaptiveKalmanProcess(rawX, rawY, {
            hasMeasurement: hasMeasurement,
            readingScore: readingScore,
            degradationScore: lastHeadMeta.degradationScore,
        })
    } else {
        if (!hasMeasurement && !_gazeSmoothed) {
            latestPrecisionLive.readingScore = readingScore
            latestPrecisionLive.degradationScore = lastHeadMeta.degradationScore
            latestPrecisionLive.measurementRatio = measurementRatio
            latestPrecisionLive.snapDistancePx = 999
            latestPrecisionLive.interventionBlocked = Date.now() < interventionBlockedUntil
            latestPrecisionLive.ts = now
            mirrorSessionMetricsMaybe()
            return
        }
        var rx = rawX, ry = rawY
        if (hasMeasurement && _gazeSmoothed) {
            rx = _GAZE_ALPHA * rx + (1 - _GAZE_ALPHA) * _gazeSmoothed.x
            ry = _GAZE_ALPHA * ry + (1 - _GAZE_ALPHA) * _gazeSmoothed.y
        }
        if (!hasMeasurement && _gazeSmoothed) {
            rx = _gazeSmoothed.x
            ry = _gazeSmoothed.y
        }
        _gazeSmoothed = { x: rx, y: ry }
        filtered = { x: rx, y: ry, vx: 0, vy: 0, r: 40 }
    }

    var corrected = { x: filtered.x, y: filtered.y, vx: filtered.vx, vy: filtered.vy }
    if (activeFlags && activeFlags.drift_map_v1 && driftMap.model) {
        var d = applyAffine(driftMap.model, corrected.x, corrected.y)
        corrected.x = d.x
        corrected.y = d.y
    }

    var residualApplied = { x: corrected.x, y: corrected.y, confidence: 0, predDx: 0, predDy: 0, features: null }
    if (activeFlags && activeFlags.residual_fusion_v1) {
        residualApplied = applyResidualFusion(corrected, lastHeadMeta, readingScore, lastHeadMeta.degradationScore)
        corrected.x = residualApplied.x
        corrected.y = residualApplied.y
    }

    var snapped = { x: corrected.x, y: corrected.y, snapDistancePx: 0, lineId: null, lineSnapUsed: false, element: null }
    if (activeFlags && activeFlags.line_aware_snap_v1) {
        snapped = lineAwareSnap(corrected.x, corrected.y)
    }

    lastGazeTimestamp = now
    smoothedPoint = { x: snapped.x, y: snapped.y }
    GazeCursor.move(snapped.x, snapped.y)
    DwellGrid.update(snapped.x, snapped.y)

    if (snapped.lineId && lastLineId && snapped.lineId !== lastLineId) {
        sessionMetrics.lineSwitchTotal += 1
        var jump = Math.abs(snapped.y - (sessionMetrics.lastFinalPoint ? sessionMetrics.lastFinalPoint.y : snapped.y))
        var returnSweepLike = filtered.vx < -220 && filtered.vy > 5
        if (!returnSweepLike || jump > 90) sessionMetrics.lineSwitchSuspicious += 1
        if (returnSweepLike) lastSweepTs = now
    }
    if (snapped.lineId) lastLineId = snapped.lineId

    captureSessionJitter(snapped, hasMeasurement)
    latestPrecisionLive.readingScore = readingScore
    latestPrecisionLive.degradationScore = lastHeadMeta.degradationScore
    latestPrecisionLive.measurementRatio = measurementRatio
    latestPrecisionLive.snapDistancePx = isFinite(snapped.snapDistancePx) ? snapped.snapDistancePx : 999

    gazeBuffer.push({ x: snapped.x, y: snapped.y, t: now })
    if (gazeBuffer.length > CONFIG.SAMPLE_BUFFER_SIZE) gazeBuffer.shift()
    if (now - lastSendTime < CONFIG.SEND_INTERVAL_MS) return
    lastSendTime = now
    if (gazeBuffer.length < 10) return

    var signals = computeSignals(gazeBuffer)

    if (now - lastDwellBoost < CONFIG.SEND_INTERVAL_MS * 1.5) {
        signals.fixation = Math.min(signals.fixation + 0.25, 1.0)
    }

    var score = (signals.fixation * 0.45) + (signals.saccade * 0.35) + (signals.regression * 0.20)
    score = parseFloat(Math.min(Math.max(score, 0), 1.0).toFixed(3))

    updateReadabilityBlend(score, readingScore, measurementRatio, lastHeadMeta.degradationScore)

    chrome.runtime.sendMessage({
        type: 'STRESS_SCORE',
        score: score,
        signals: signals
    }).catch(function () {})

    var tier = score < 0.3 ? 'CALM' : score < 0.6 ? 'ELEVATED' : 'OVERLOAD'
    recordSessionSample(score, tier)
    var state = {
        isReading: readingScore >= CONFIG.INTERVENTION_MIN_READING_SCORE,
        readingScore: readingScore,
        degradationScore: lastHeadMeta.degradationScore,
        isTrackerDegraded: !!lastHeadMeta.isTrackerDegraded,
        lineId: snapped.lineId,
        lineSnapUsed: snapped.lineSnapUsed,
        snapDistancePx: latestPrecisionLive.snapDistancePx,
        measurementRatio: measurementRatio,
        rawX: rawX,
        rawY: rawY,
        preSnapX: corrected.x,
        preSnapY: corrected.y,
        headSpeed: headSpeed,
        residualFeatures: residualApplied.features,
        residualPredDx: residualApplied.predDx,
        residualPredDy: residualApplied.predDy,
        residualConfidence: residualApplied.confidence,
        anchorX: snapped.anchorX,
        anchorY: snapped.anchorY,
    }
    latestFrameState = state
    applyInterventionStable(tier, state)
    latestPrecisionLive.interventionBlocked = Date.now() < interventionBlockedUntil
    latestPrecisionLive.ts = now
    mirrorSessionMetricsMaybe()
}

// â”€â”€â”€ Princeton Calibration Wizard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Builds the full-screen overlay.  Returns { overlay, status, progressDots }.

function createPrincetonOverlay() {
    removeCalibrationOverlay()

    var overlay = document.createElement('div')
    overlay.id = 'na-cal-overlay'
    Object.assign(overlay.style, {
        position:   'fixed',
        inset:      '0',
        zIndex:     '2147483647',
        background: '#0d0d0d',
        color:      '#fff',
        fontFamily: '"Segoe UI", system-ui, sans-serif',
        userSelect: 'none',
    })

    // â”€â”€ Header bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var header = document.createElement('div')
    Object.assign(header.style, {
        position:       'fixed',
        top:            '0',
        left:           '0',
        right:          '0',
        padding:        '16px 24px',
        background:     'linear-gradient(90deg,#1a1a1a,#2a1a00)',
        borderBottom:   '2px solid #E77500',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        pointerEvents:  'none',
    })
    header.innerHTML = [
        '<div style="display:flex;align-items:center;gap:10px;">',
        '  <div style="width:28px;height:28px;border-radius:50%;background:#E77500;',
        '       display:flex;align-items:center;justify-content:center;',
        '       font-size:14px;font-weight:900;color:#fff;">N</div>',
        '  <span style="font-size:16px;font-weight:700;letter-spacing:0.04em;">NeuralAdaptive</span>',
        '  <span style="font-size:11px;color:#E77500;font-weight:600;',
        '       text-transform:uppercase;letter-spacing:0.12em;">Eye Setup</span>',
        '</div>',
        '<div id="na-cal-step" style="font-size:12px;color:#aaa;"></div>',
    ].join('')
    overlay.appendChild(header)

    // â”€â”€ Progress pip row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var pipRow = document.createElement('div')
    Object.assign(pipRow.style, {
        position:       'fixed',
        top:            '64px',
        left:           '50%',
        transform:      'translateX(-50%)',
        display:        'flex',
        gap:            '10px',
        pointerEvents:  'none',
    })
    var pips = CAL_POINTS_5.map(function () {
        var pip = document.createElement('div')
        Object.assign(pip.style, {
            width: '10px', height: '10px',
            borderRadius: '50%',
            background: '#333',
            border: '2px solid #555',
            transition: 'background 0.3s, border-color 0.3s',
        })
        pipRow.appendChild(pip)
        return pip
    })
    overlay.appendChild(pipRow)

    // â”€â”€ Center instructional card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var card = document.createElement('div')
    Object.assign(card.style, {
        position:     'fixed',
        top:          '50%',
        left:         '50%',
        transform:    'translate(-50%,-50%)',
        textAlign:    'center',
        pointerEvents:'none',
    })
    card.innerHTML = [
        '<div style="font-size:28px;font-weight:800;color:#E77500;margin-bottom:8px;">',
        '  Eye Tracking Setup',
        '</div>',
        '<div id="na-cal-instruction" style="font-size:15px;color:#ccc;max-width:420px;line-height:1.6;">',
        '  Stare directly at each <b style="color:#E77500">orange dot</b>',
        '  and click it <b style="color:#fff">5 times</b>.<br>',
        '  Keep your head still throughout.',
        '</div>',
    ].join('')
    overlay.appendChild(card)

    // â”€â”€ Status bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var status = document.createElement('div')
    status.id = 'na-cal-status'
    Object.assign(status.style, {
        position:   'fixed',
        bottom:     '22px',
        left:       '50%',
        transform:  'translateX(-50%)',
        fontSize:   '13px',
        color:      '#888',
        textAlign:  'center',
        minWidth:   '320px',
        pointerEvents: 'none',
    })
    status.textContent = 'Preparingâ€¦'
    overlay.appendChild(status)

    document.body.appendChild(overlay)
    return { overlay: overlay, status: status, pips: pips, stepEl: header.querySelector('#na-cal-step') }
}

// â”€â”€â”€ Pose Calibration Step â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Called after all 5 calibration dots are clicked.  Shows a live head-pose HUD
// inside the existing overlay and waits for a stable 1.8 s hold to compute
// median baselines for IPD, neutral nose ratio, and roll offset.
async function runPoseCalibrationStep(ui) {
    if (!HeadPoseLayer || !HeadPoseLayer.isReady()) return

    if (ui.stepEl) ui.stepEl.textContent = 'Pose Baseline'
    ui.status.textContent = 'Sit naturally and look straight aheadâ€¦'

    var panel = document.createElement('div')
    panel.id = 'na-pose-cal-panel'
    Object.assign(panel.style, {
        position: 'fixed', top: '50%', left: '50%',
        transform: 'translate(-50%,-50%)',
        width: '370px',
        background: 'rgba(16,8,0,0.94)',
        border: '1px solid rgba(231,117,0,0.35)', borderRadius: '14px',
        padding: '22px 26px',
        fontFamily: '"Segoe UI",system-ui,sans-serif', color: '#e8e8e8',
        zIndex: '2147483648', boxShadow: '0 8px 32px rgba(0,0,0,0.65)',
    })

    function gaugeRowHTML(label, id) {
        return [
            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:11px;">',
            '<span style="font-size:12px;color:#888;width:42px;flex-shrink:0;">' + label + '</span>',
            '<div style="flex:1;height:6px;background:#1e1e1e;border-radius:3px;position:relative;overflow:visible;">',
            '<div style="position:absolute;top:-1px;bottom:-1px;left:calc(50% - 1px);width:2px;background:#333;"></div>',
            '<div id="' + id + '-fill" style="position:absolute;top:0;bottom:0;height:100%;',
            'background:#3fb950;border-radius:3px;transition:left 0.1s,width 0.1s,background 0.2s;left:50%;width:0;"></div>',
            '</div>',
            '<span id="' + id + '-val" style="font-size:12px;font-weight:600;color:#ccc;width:34px;text-align:right;flex-shrink:0;">0Â°</span>',
            '</div>',
        ].join('')
    }

    panel.innerHTML = [
        '<div style="font-size:18px;font-weight:800;color:#E77500;margin-bottom:4px;">âŠ• Head Pose Baseline</div>',
        '<div style="font-size:12px;color:#999;margin-bottom:20px;">Sit naturally and look straight ahead.<br>Hold still while we measure.</div>',
        gaugeRowHTML('Yaw',   'na-pc-yaw'),
        gaugeRowHTML('Pitch', 'na-pc-pitch'),
        gaugeRowHTML('Roll',  'na-pc-roll'),
        '<div style="display:flex;align-items:center;gap:8px;margin:4px 0 20px;">',
        '<span style="font-size:12px;color:#888;width:42px;flex-shrink:0;">Dist</span>',
        '<div id="na-pc-dist-dot" style="width:9px;height:9px;border-radius:50%;background:#555;flex-shrink:0;transition:background 0.2s;"></div>',
        '<span id="na-pc-dist-lbl" style="font-size:12px;font-weight:600;color:#888;transition:color 0.2s;">Warming upâ€¦</span>',
        '</div>',
        '<div style="font-size:11px;color:#666;margin-bottom:5px;letter-spacing:0.06em;text-transform:uppercase;">Stability</div>',
        '<div style="height:7px;background:#1e1e1e;border-radius:4px;overflow:hidden;margin-bottom:9px;">',
        '<div id="na-pc-stab-fill" style="height:100%;width:0%;background:#E77500;border-radius:4px;transition:width 0.12s linear,background 0.3s;"></div>',
        '</div>',
        '<div id="na-pc-stab-lbl" style="font-size:12px;color:#888;">Hold stillâ€¦</div>',
    ].join('')
    ui.overlay.appendChild(panel)

    function setGauge(id, deg, maxDeg) {
        var fill = panel.querySelector('#' + id + '-fill')
        var val  = panel.querySelector('#' + id + '-val')
        if (!fill || !val) return
        var ratio = Math.min(Math.abs(deg) / maxDeg, 1.0)
        var pct   = ratio * 50
        var color = ratio < 0.30 ? '#3fb950' : ratio < 0.60 ? '#E77500' : '#f85149'
        fill.style.left = (deg >= 0 ? 50 : 50 - pct) + '%'
        fill.style.width = pct + '%'
        fill.style.background = color
        val.textContent = (deg >= 0 ? '+' : '') + Math.round(deg) + 'Â°'
        val.style.color = color
    }

    function setDist(ratio) {
        var dot = panel.querySelector('#na-pc-dist-dot')
        var lbl = panel.querySelector('#na-pc-dist-lbl')
        if (!dot || !lbl) return
        var text, color
        if      (ratio < 0.65)  { text = 'Too far';        color = '#f85149' }
        else if (ratio < 0.85)  { text = 'Slightly far';   color = '#E77500' }
        else if (ratio > 1.70)  { text = 'Too close';      color = '#f85149' }
        else if (ratio > 1.25)  { text = 'Slightly close'; color = '#E77500' }
        else                    { text = 'Good distance';  color = '#3fb950' }
        dot.style.background = color
        lbl.style.color = color; lbl.textContent = text
    }

    function setStability(progress, stable) {
        var fill = panel.querySelector('#na-pc-stab-fill')
        var lbl  = panel.querySelector('#na-pc-stab-lbl')
        if (!fill || !lbl) return
        fill.style.width = Math.round(progress * 100) + '%'
        fill.style.background = !stable ? '#555' : (progress >= 1.0 ? '#3fb950' : '#E77500')
        if (progress >= 1.0)   { lbl.textContent = 'âœ… Baseline captured!'; lbl.style.color = '#3fb950' }
        else if (!stable)      { lbl.textContent = 'Hold stillâ€¦';           lbl.style.color = '#888'    }
        else                   { lbl.textContent = 'Almost thereâ€¦';         lbl.style.color = '#E77500' }
    }

    await HeadPoseLayer.finalizeCalibration(function (s) {
        setGauge('na-pc-yaw',   s.yaw,   HP_CONFIG.DEGRADE_YAW_LIMIT)
        setGauge('na-pc-pitch', s.pitch, HP_CONFIG.DEGRADE_PITCH_LIMIT)
        setGauge('na-pc-roll',  s.roll,  HP_CONFIG.DEGRADE_ROLL_LIMIT)
        setDist(s.ipdRatio)
        setStability(s.progress, s.stable)
    })

    setStability(1.0, true)
    await new Promise(function (r) { setTimeout(r, 700) })
    panel.remove()
}

/**
 * Run the full 5-point Princeton calibration wizard.
 */
async function runPrincetonCalibration() {
    var ui = createPrincetonOverlay()
    calibQuality.accepted = 0
    calibQuality.rejected = 0
    calibQuality.pointStddevs = []

    // Begin accumulating pose samples for the head-pose baseline
    if (HeadPoseLayer && HeadPoseLayer.isReady()) {
        HeadPoseLayer.startCalibrationSampling()
    }

    for (var i = 0; i < CAL_POINTS_5.length; i++) {
        var pt      = CAL_POINTS_5[i]
        var vp      = toViewportPoint(pt)
        var clicks  = CONFIG.CALIBRATION_CLICKS_PER_POINT
        var accepted = 0
        var acceptedSamples = []

        // Update header step counter
        if (ui.stepEl) ui.stepEl.textContent = 'Point ' + (i + 1) + ' of ' + CAL_POINTS_5.length

        // Mark current pip orange
        ui.pips.forEach(function (p, idx) {
            if (idx < i)      { p.style.background = '#3fb950'; p.style.borderColor = '#3fb950' }
            else if (idx === i){ p.style.background = '#E77500'; p.style.borderColor = '#E77500' }
            else              { p.style.background = '#333';    p.style.borderColor = '#555'    }
        })

        ui.status.textContent = pt.label + ' â€” click the dot ' + clicks + ' times while staring at it'

        // Place the dot
        var dot = document.createElement('button')
        dot.type = 'button'
        dot.className = 'na-cal-dot'
        dot.textContent = String(clicks)
        dot.style.cssText = [
            'position:fixed',
            'left:' + pt.x + '%',
            'top:' + pt.y + '%',
            'width:36px', 'height:36px',
            'border-radius:50%',
            'background:#E77500',
            'border:3px solid #fff',
            'cursor:crosshair',
            'z-index:2147483649',
            'display:flex', 'align-items:center', 'justify-content:center',
            'font-size:13px', 'font-weight:700', 'color:#fff',
            'transform:translate(-50%,-50%)',
            'padding:0', 'margin:0', 'outline:none'
        ].join(';')
        ui.overlay.appendChild(dot)

        await new Promise(function (resolvePt) {
            dot.addEventListener('click', async function onClick() {
                if (activeFlags && activeFlags.calibration_quality_gates_v1) {
                    var headSpeed = getCurrentHeadSpeedDegPerSec()
                    var measurementRatio = getMeasurementRatio()
                    var degradation = latestPrecisionLive.degradationScore || 0
                    var gateFail = false
                    if (degradation > CONFIG.CAL_QUALITY_MAX_DEGRADATION) gateFail = true
                    if (measurementRatio < CONFIG.CAL_QUALITY_MIN_MEAS_RATIO) gateFail = true
                    if (headSpeed > CONFIG.CAL_QUALITY_MAX_HEAD_SPEED) gateFail = true
                    if (lastRawGaze) {
                        var ex = lastRawGaze.x - vp.x
                        var ey = lastRawGaze.y - vp.y
                        var dist = Math.sqrt(ex * ex + ey * ey)
                        if (dist > getModeConfig().outlierThresholdPx) gateFail = true
                    }
                    if (gateFail) {
                        calibQuality.rejected += 1
                        dot.style.background = '#f85149'
                        ui.status.textContent = 'Sample rejected: hold still and keep gaze centered.'
                        setTimeout(function () { dot.style.background = '#E77500' }, 220)
                        return
                    }
                }

                // Send iris calibration sample to iris-tracker (2 samples per click)
                document.dispatchEvent(new CustomEvent('na-cal-point', { detail: { screenX: vp.x, screenY: vp.y } }))
                document.dispatchEvent(new CustomEvent('na-cal-point', { detail: { screenX: vp.x, screenY: vp.y } }))
                accepted++
                calibQuality.accepted += 1
                if (lastRawGaze) acceptedSamples.push({ x: lastRawGaze.x, y: lastRawGaze.y })

                var remaining = clicks - accepted
                dot.textContent = remaining > 0 ? String(remaining) : 'âœ“'
                ui.status.textContent = pt.label + ' â€” ' + accepted + ' / ' + clicks + ' clicks'

                if (accepted >= clicks) {
                    if (activeFlags && activeFlags.calibration_quality_gates_v1) {
                        var dists = acceptedSamples.map(function (s) {
                            var dx = s.x - vp.x
                            var dy = s.y - vp.y
                            return Math.sqrt(dx * dx + dy * dy)
                        })
                        var pointStddev = stddev(dists)
                        var maxStddev = getCalibrationVarianceThreshold()
                        if (pointStddev > maxStddev) {
                            calibQuality.rejected += 1
                            accepted = Math.max(1, accepted - 1)
                            dot.textContent = String(clicks - accepted)
                            ui.status.textContent = 'Point unstable (stddev ' + Math.round(pointStddev) + 'px). Add one more stable click.'
                            dot.style.background = '#f85149'
                            setTimeout(function () { dot.style.background = '#E77500' }, 260)
                            return
                        }
                        calibQuality.pointStddevs.push(pointStddev)
                    }
                    dot.style.background = '#3fb950'
                    dot.classList.add('na-cal-dot--done')
                    dot.removeEventListener('click', onClick)
                    await new Promise(function (r) { setTimeout(r, 250) })
                    dot.remove()
                    resolvePt()
                }
            })
        })
    }

    // All pips green — signal offscreen to compute affine transform
    ui.pips.forEach(function (p) { p.style.background = '#3fb950'; p.style.borderColor = '#3fb950' })
    ui.status.textContent = 'Computing iris calibration\u2026'

    await new Promise(function (resolve) {
        var TIMEOUT = 6000
        var done = false
        var timer = setTimeout(function () {
            if (!done) { done = true; resolve() }
        }, TIMEOUT)
        function onCalReady() { if (!done) { done = true; clearTimeout(timer); resolve() } }
        function onCalError() { if (!done) { done = true; clearTimeout(timer); resolve() } }
        document.addEventListener('na-cal-ready',  onCalReady,  { once: true })
        document.addEventListener('na-cal-error',  onCalError,  { once: true })
        document.dispatchEvent(new CustomEvent('na-cal-complete'))
    })

    if (ui.stepEl) ui.stepEl.textContent = 'Complete'
    ui.status.textContent = '\u2705 All done! Starting tracking\u2026'
    await new Promise(function (r) { setTimeout(r, 500) })
    removeCalibrationOverlay()
}

async function runPoseStage(ui, stage) {
    var samples = []
    var start = Date.now()
    while (Date.now() - start < stage.durationMs) {
        var s = HeadPoseLayer && HeadPoseLayer.getState ? HeadPoseLayer.getState() : null
        if (s && typeof s.yaw === 'number' && typeof s.pitch === 'number' && typeof s.roll === 'number') {
            samples.push(s)
        }
        var elapsed = Date.now() - start
        var secsLeft = Math.max(0, Math.ceil((stage.durationMs - elapsed) / 1000))
        ui.status.textContent = stage.instruction + ' (' + secsLeft + 's)'
        await new Promise(function (r) { setTimeout(r, 120) })
    }
    return samples
}

function summarizePoseSamples(stageSamples) {
    var stats = {
        neutralYaw: 0,
        neutralPitch: 0,
        neutralRoll: 0,
        leftYawMax: 0,
        rightYawMax: 0,
        upPitchMax: 0,
        downPitchMax: 0,
        ipdMedian: 1.0,
        qualityScore: 0,
    }
    var neutral = stageSamples.neutral || []
    var left = stageSamples.left || []
    var right = stageSamples.right || []
    var up = stageSamples.up || []
    var down = stageSamples.down || []

    if (neutral.length > 0) {
        stats.neutralYaw = mean(neutral.map(function (s) { return s.yaw })) || 0
        stats.neutralPitch = mean(neutral.map(function (s) { return s.pitch })) || 0
        stats.neutralRoll = mean(neutral.map(function (s) { return s.roll })) || 0
        stats.ipdMedian = median(neutral.map(function (s) { return s.ipdRatio })) || 1.0
    }
    if (left.length > 0) {
        var leftYawMin = Math.min.apply(null, left.map(function (s) { return s.yaw }))
        stats.leftYawMax = Math.abs(leftYawMin)
    }
    if (right.length > 0) {
        var rightYawMax = Math.max.apply(null, right.map(function (s) { return s.yaw }))
        stats.rightYawMax = Math.abs(rightYawMax)
    }
    if (up.length > 0) {
        var upPitchMin = Math.min.apply(null, up.map(function (s) { return s.pitch }))
        stats.upPitchMax = Math.abs(upPitchMin)
    }
    if (down.length > 0) {
        var downPitchMax = Math.max.apply(null, down.map(function (s) { return s.pitch }))
        stats.downPitchMax = Math.abs(downPitchMax)
    }

    var yawStrength = Math.min((Math.max(stats.leftYawMax, stats.rightYawMax) || 0) / 14, 1)
    var pitchStrength = Math.min((Math.max(stats.upPitchMax, stats.downPitchMax) || 0) / 10, 1)
    stats.qualityScore = parseFloat(((yawStrength * 0.6 + pitchStrength * 0.4) * 100).toFixed(1))
    return stats
}

async function runNosePoseCalibrationMode() {
    if (!HeadPoseLayer || !HeadPoseLayer.isReady || !HeadPoseLayer.isReady()) {
        return { ok: false, reason: 'head_pose_not_ready' }
    }

    var ui = createPrincetonOverlay()
    var instructionEl = ui.overlay.querySelector('#na-cal-instruction')
    if (instructionEl) {
        instructionEl.innerHTML = [
            'Nose + head pose calibration.<br>',
            'Keep eyes on screen center while moving your head as instructed.',
        ].join('')
    }

    var stages = [
        { id: 'neutral', instruction: 'Hold head neutral and still', durationMs: 2000 },
        { id: 'left', instruction: 'Turn head left slightly', durationMs: 1800 },
        { id: 'right', instruction: 'Turn head right slightly', durationMs: 1800 },
        { id: 'up', instruction: 'Tilt chin up slightly', durationMs: 1600 },
        { id: 'down', instruction: 'Tilt chin down slightly', durationMs: 1600 },
    ]

    var stageSamples = {}
    for (var i = 0; i < stages.length; i++) {
        var stage = stages[i]
        if (ui.stepEl) ui.stepEl.textContent = 'Pose Step ' + (i + 1) + ' of ' + stages.length
        ui.pips.forEach(function (p, idx) {
            if (idx < i) { p.style.background = '#3fb950'; p.style.borderColor = '#3fb950' }
            else if (idx === i) { p.style.background = '#E77500'; p.style.borderColor = '#E77500' }
            else { p.style.background = '#333'; p.style.borderColor = '#555' }
        })
        stageSamples[stage.id] = await runPoseStage(ui, stage)
        // Baseline is now captured by runPoseCalibrationStep via finalizeCalibration()
    }

    var stats = summarizePoseSamples(stageSamples)
    var yawLimit = clamp(Math.max(stats.leftYawMax, stats.rightYawMax) * 0.8, 18, 40)
    var pitchLimit = clamp(Math.max(stats.upPitchMax, stats.downPitchMax) * 0.8, 14, 32)
    var rollLimit = clamp(Math.abs(stats.neutralRoll) + 12, 12, 24)

    if (HeadPoseLayer && HeadPoseLayer.applyCalibrationProfile) {
        HeadPoseLayer.applyCalibrationProfile({
            yawLimit: yawLimit,
            pitchLimit: pitchLimit,
            rollLimit: rollLimit,
        })
    }

    ui.pips.forEach(function (p) { p.style.background = '#3fb950'; p.style.borderColor = '#3fb950' })
    if (ui.stepEl) ui.stepEl.textContent = 'Complete'
    ui.status.textContent = 'Pose calibration complete (quality ' + stats.qualityScore + '%)'
    await new Promise(function (r) { setTimeout(r, 700) })
    removeCalibrationOverlay()

    return {
        ok: true,
        stats: stats,
        limits: {
            yawLimit: parseFloat(yawLimit.toFixed(2)),
            pitchLimit: parseFloat(pitchLimit.toFixed(2)),
            rollLimit: parseFloat(rollLimit.toFixed(2)),
        },
    }
}

// â”€â”€â”€ Legacy overlay helpers (used by stop / cleanup) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function createCalibrationOverlay(title, subtitle) {
    // Thin shim so any remaining call-sites don't break.
    // Full UI is now in createPrincetonOverlay().
    var overlay = document.createElement('div')
    overlay.id = 'na-cal-overlay'
    Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        background: 'rgba(8, 10, 16, 0.94)',
        color: '#f0f6fc',
        fontFamily: '"Segoe UI", Tahoma, sans-serif',
    })

    var header = document.createElement('div')
    header.innerHTML = [
        '<div style="font-size:18px;font-weight:700;margin-bottom:6px;">' + title + '</div>',
        '<div style="font-size:12px;color:#9ba7b4;line-height:1.5;">' + subtitle + '</div>',
    ].join('')
    Object.assign(header.style, {
        position: 'fixed', left: '50%', top: '18px',
        transform: 'translateX(-50%)', textAlign: 'center', pointerEvents: 'none',
    })
    overlay.appendChild(header)

    var status = document.createElement('div')
    status.id = 'na-cal-status'
    status.textContent = 'Focus each point and click.'
    Object.assign(status.style, {
        position: 'fixed',
        left: '50%',
        bottom: '18px',
        transform: 'translateX(-50%)',
        fontSize: '12px',
        color: '#9ba7b4',
        textAlign: 'center',
        minWidth: '280px',
    })
    overlay.appendChild(status)

    document.body.appendChild(overlay)
    return { overlay: overlay, status: status }
}

function removeCalibrationOverlay() {
    var old = document.getElementById('na-cal-overlay')
    if (old) old.remove()
}

async function runCalibrationStage(stageName, points, clicksPerPoint) {
    var ui = createCalibrationOverlay(
        'Calibration: ' + stageName,
        'Look at each green point and click ' + clicksPerPoint + ' times. Outlier clicks are rejected.'
    )

    for (var i = 0; i < points.length; i++) {
        var p = points[i]
        var target = toViewportPoint(p)
        var pointState = { accepted: 0 }

        var dot = document.createElement('button')
        dot.type = 'button'
        Object.assign(dot.style, {
            position: 'fixed',
            left: p.x + '%',
            top: p.y + '%',
            transform: 'translate(-50%, -50%)',
            width: '26px',
            height: '26px',
            borderRadius: '50%',
            border: '2px solid #2ea043',
            background: 'rgba(46, 160, 67, 0.25)',
            color: '#d9f99d',
            fontSize: '11px',
            fontWeight: '700',
            cursor: 'pointer',
            zIndex: '2147483648',
        })
        dot.textContent = String(clicksPerPoint)
        ui.overlay.appendChild(dot)

        ui.status.textContent = 'Point ' + (i + 1) + ' / ' + points.length + ' â€” accepted 0 / ' + clicksPerPoint

        await new Promise(function (resolvePoint) {
            dot.addEventListener('click', async function () {
                var result = await collectCalibrationSample(target.x, target.y, pointState)
                if (!result.accepted) {
                    dot.style.borderColor = '#f85149'
                    dot.style.background = 'rgba(248, 81, 73, 0.25)'
                    ui.status.textContent = 'Outlier rejected (' + result.errorPx + 'px). Keep head still and click again.'
                    setTimeout(function () {
                        dot.style.borderColor = '#2ea043'
                        dot.style.background = 'rgba(46, 160, 67, 0.25)'
                        ui.status.textContent = 'Point ' + (i + 1) + ' / ' + points.length + ' â€” accepted ' + pointState.accepted + ' / ' + clicksPerPoint
                    }, 500)
                    return
                }

                var left = clicksPerPoint - pointState.accepted
                dot.textContent = left > 0 ? String(left) : 'âœ“'
                ui.status.textContent = 'Point ' + (i + 1) + ' / ' + points.length + ' â€” accepted ' + pointState.accepted + ' / ' + clicksPerPoint
                if (pointState.accepted >= clicksPerPoint) {
                    dot.style.background = 'rgba(46, 160, 67, 0.75)'
                    dot.style.borderColor = '#3fb950'
                    dot.disabled = true
                    setTimeout(function () {
                        dot.remove()
                        resolvePoint()
                    }, 180)
                }
            })
        })
    }

    ui.status.textContent = stageName + ' complete.'
    await new Promise(function (r) { setTimeout(r, 300) })
    removeCalibrationOverlay()
}

async function runValidationStage(points) {
    var ui = createCalibrationOverlay(
        'Validation',
        'Look at each point and click once. This does not add training samples.'
    )

    var errors = []
    for (var i = 0; i < points.length; i++) {
        var p = points[i]
        var target = toViewportPoint(p)

        var dot = document.createElement('button')
        dot.type = 'button'
        Object.assign(dot.style, {
            position: 'fixed',
            left: p.x + '%',
            top: p.y + '%',
            transform: 'translate(-50%, -50%)',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            border: '2px solid #58a6ff',
            background: 'rgba(88, 166, 255, 0.25)',
            cursor: 'pointer',
            zIndex: '2147483648',
        })
        ui.overlay.appendChild(dot)

        ui.status.textContent = 'Validation point ' + (i + 1) + ' / ' + points.length

        await new Promise(function (resolvePoint) {
            dot.addEventListener('click', async function () {
                var pred = await getCurrentPredictionSafe()
                var err = 999
                if (pred) {
                    var dx = pred.x - target.x
                    var dy = pred.y - target.y
                    err = Math.sqrt(dx * dx + dy * dy)
                }
                errors.push(err)
                dot.style.background = 'rgba(88, 166, 255, 0.7)'
                dot.remove()
                resolvePoint()
            })
        })
    }

    var med = median(errors)
    var avg = errors.reduce(function (s, e) { return s + e }, 0) / Math.max(errors.length, 1)
    ui.status.textContent = 'Validation median error: ' + Math.round(med || 0) + 'px'
    await new Promise(function (r) { setTimeout(r, 600) })
    removeCalibrationOverlay()

    return {
        medianPx: med || 999,
        meanPx: avg || 999,
        samples: errors.length,
    }
}

async function clearWebGazerData() {
    try {
        await window.webgazer.clearData()
    } catch (e) {
        console.warn('[NeuralAdaptive] clearData() failed:', e && e.message ? e.message : e)
    }
}

async function runCalibrationAndValidation(_force) {
    if (calibrationPromise) return calibrationPromise

    calibrationPromise = (async function () {
        isCalibrating = true
        // Reset iris tracker calibration state before new calibration run
        document.dispatchEvent(new CustomEvent('na-cal-reset'))
        console.log('[NeuralAdaptive] Starting iris calibration wizard')
        await clearWebGazerData()
        await runPrincetonCalibration()
        var poseResult = await runNosePoseCalibrationMode()
        var poseStats = poseResult && poseResult.stats ? poseResult.stats : null
        var poseLimits = poseResult && poseResult.limits ? poseResult.limits : null
        var totalCalSamples = calibQuality.accepted + calibQuality.rejected
        var acceptRate = totalCalSamples > 0 ? (calibQuality.accepted / totalCalSamples) : 1
        var pointVarianceMedianPx = medianCopy(calibQuality.pointStddevs) || 0

        // Await the storage write so shouldForceCalibration never races against it
        await new Promise(function (resolve) {
            chrome.storage.local.set({
                calibrationVersion:  CONFIG.CALIBRATION_VERSION,
                calibrationUpdatedAt: Date.now(),
                calibQuality: {
                    acceptRate: parseFloat(acceptRate.toFixed(3)),
                    pointVarianceMedianPx: parseFloat(pointVarianceMedianPx.toFixed(2)),
                    rejectedCount: calibQuality.rejected,
                },
                poseCalibrationVersion: CONFIG.POSE_CALIBRATION_VERSION,
                poseCalibrationUpdatedAt: Date.now(),
                poseCalibrationQualityScore: poseStats ? poseStats.qualityScore : null,
                poseNeutralYaw: poseStats ? poseStats.neutralYaw : null,
                poseNeutralPitch: poseStats ? poseStats.neutralPitch : null,
                poseNeutralRoll: poseStats ? poseStats.neutralRoll : null,
                poseYawLeftMax: poseStats ? poseStats.leftYawMax : null,
                poseYawRightMax: poseStats ? poseStats.rightYawMax : null,
                posePitchUpMax: poseStats ? poseStats.upPitchMax : null,
                posePitchDownMax: poseStats ? poseStats.downPitchMax : null,
                poseIpdMedian: poseStats ? poseStats.ipdMedian : null,
                poseYawLimit: poseLimits ? poseLimits.yawLimit : null,
                posePitchLimit: poseLimits ? poseLimits.pitchLimit : null,
                poseRollLimit: poseLimits ? poseLimits.rollLimit : null,
            }, function () {
                if (chrome.runtime.lastError) {
                    console.warn('[NeuralAdaptive] calibration save failed:', chrome.runtime.lastError.message)
                }
                resolve()
            })
        })

        // Pose baseline already captured by runPoseCalibrationStep inside runPrincetonCalibration
        console.log('[NeuralAdaptive] Calibration saved â€” version', CONFIG.CALIBRATION_VERSION)
        isCalibrating = false
    })()

    try {
        await calibrationPromise
    } finally {
        calibrationPromise = null
        isCalibrating = false
    }
}

// Triggers camera permission prompt from the page context (where prompts are shown).
// Offscreen documents can't show the prompt, so we request it here first.
async function preflightCameraAccess() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API unavailable')
    }
    var stream = await navigator.mediaDevices.getUserMedia({ video: true })
    stream.getTracks().forEach(function (t) { try { t.stop() } catch (e) {} })
}

async function shouldForceCalibration(forceRequested) {
    if (forceRequested) return true
    return await new Promise(function (resolve) {
        chrome.storage.local.get(['calibrationVersion', 'poseCalibrationVersion'], function (data) {
            if (chrome.runtime.lastError) {
                resolve(true)
                return
            }
            // Only re-calibrate when the calibration schema version changes,
            // not when accuracy is below threshold — prevents re-entry loops.
            var hasVersion = data && data.calibrationVersion === CONFIG.CALIBRATION_VERSION
            var hasPoseVersion = data && data.poseCalibrationVersion === CONFIG.POSE_CALIBRATION_VERSION
            resolve(!hasVersion || !hasPoseVersion)
        })
    })
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// RECOVERY MODULE â€” Visual Anchor Â· Contextual Breadcrumb Â· Peripheral Movement
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€ LKC updater: store closest paragraph to gaze every 2 s while focused â”€â”€â”€â”€â”€â”€
function updateLKC() {
    var el = null
    if (smoothedPoint) el = DwellGrid.getParagraphAt(smoothedPoint.x, smoothedPoint.y)
    if (!el) {
        // Fallback: paragraph whose vertical centre is closest to viewport mid
        var mid = window.innerHeight / 2
        var best = Infinity
        document.querySelectorAll('p').forEach(function (p) {
            if (p.textContent.trim().length < 40) return
            var r = p.getBoundingClientRect()
            if (r.bottom < 0 || r.top > window.innerHeight) return
            var d = Math.abs((r.top + r.bottom) / 2 - mid)
            if (d < best) { best = d; el = p }
        })
    }
    if (!el) return
    LearningState.lastReadElement = el
    LearningState.lastReadText    = (el.innerText || el.textContent || '').slice(0, 400)
}

// â”€â”€ Visual Anchor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function applyVisualAnchor() {
    var el = LearningState.lastReadElement
    if (!el) return
    el.classList.add('na-visual-anchor')
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(function () { el.classList.remove('na-visual-anchor') }, 3500)
}

// â”€â”€ Peripheral Movement overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showPeripheralMovement() {
    if (document.getElementById('na-peripheral-left')) return
    var dismiss = document.createElement('button')
    dismiss.id = 'na-peripheral-dismiss'
    dismiss.textContent = 'âœ• Dismiss'
    dismiss.addEventListener('click', hidePeripheralMovement)

    var left  = document.createElement('div')
    left.id   = 'na-peripheral-left'
    var right = document.createElement('div')
    right.id  = 'na-peripheral-right'
    right.appendChild(dismiss)

    document.body.appendChild(left)
    document.body.appendChild(right)
}

function hidePeripheralMovement() {
    ;['na-peripheral-left', 'na-peripheral-right', 'na-peripheral-dismiss'].forEach(function (id) {
        var el = document.getElementById(id)
        if (el) el.remove()
    })
}

// â”€â”€ Breadcrumb toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showBreadcrumbToast(text) {
    hideBreadcrumbToast()
    var toast = document.createElement('div')
    toast.id = 'na-breadcrumb-toast'
    toast.innerHTML = [
        '<div class="na-toast-label">ðŸ“ Where you left off</div>',
        '<div class="na-toast-body">' + escapeHtml(text) + '</div>',
        '<button class="na-toast-close" aria-label="Dismiss">âœ•</button>',
    ].join('')
    toast.querySelector('.na-toast-close').addEventListener('click', hideBreadcrumbToast)
    document.body.appendChild(toast)
    // Auto-dismiss after 12 s
    setTimeout(hideBreadcrumbToast, 12000)
}

function hideBreadcrumbToast() {
    var el = document.getElementById('na-breadcrumb-toast')
    if (el) el.remove()
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// â”€â”€ Gemini breadcrumb request â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function requestBreadcrumb() {
    // Collect last 3 viewport snapshots + current LKC text
    var history = LearningState.pageTextHistory.slice(-3).join(' ')
    var text    = (history + ' ' + LearningState.lastReadText).trim().slice(0, 900)
    if (!text) return

    chrome.runtime.sendMessage({ type: 'BREADCRUMB_SUMMARY', text: text }, function (res) {
        if (chrome.runtime.lastError || !res || !res.summary) return
        // Store for display on re-entry (may arrive before gaze returns)
        LearningState.breadcrumbText = res.summary
        // If user already returned before Gemini responded, show immediately
        if (!LearningState.isDistracted) showBreadcrumbToast(res.summary)
    })
}

// â”€â”€ Gaze re-entry handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function onGazeReentry() {
    LearningState.isDistracted    = false
    LearningState.distractionStart = null
    LearningState.level            = 0

    hidePeripheralMovement()
    applyVisualAnchor()

    if (LearningState.breadcrumbText) {
        showBreadcrumbToast(LearningState.breadcrumbText)
        LearningState.breadcrumbText = null
    }
}

// â”€â”€ Watchdog â€” runs every 500 ms to advance distraction levels â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startRecoveryModule() {
    stopRecoveryModule()
    lastGazeTimestamp = Date.now()

    // LKC updater: store reading position every 2 s while focused
    lkcIntervalId = setInterval(function () {
        if (!isRunning || isCalibrating || LearningState.isDistracted) return
        updateLKC()
        checkLongDwellAutoSummarize()
        // Keep a rolling text history for the breadcrumb context
        var snap = getViewportText()
        if (snap) {
            LearningState.pageTextHistory.push(snap)
            if (LearningState.pageTextHistory.length > 3) LearningState.pageTextHistory.shift()
        }
    }, 2000)

    // Watchdog: detect absence and escalate distraction levels
    watchdogIntervalId = setInterval(function () {
        if (!isRunning || isCalibrating) return
        var away = Date.now() - lastGazeTimestamp

        if (away < 5000) {
            // Gaze is present â€” reset if recovering from distraction
            if (LearningState.isDistracted) onGazeReentry()
            return
        }

        // â”€â”€ First threshold: 5 s away â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (!LearningState.isDistracted) {
            LearningState.isDistracted    = true
            LearningState.distractionStart = Date.now() - away
            LearningState.level            = 1
            // Capture a fresh LKC snapshot right as they look away
            updateLKC()
        }

        var timeAway = Date.now() - LearningState.distractionStart

        // â”€â”€ Second threshold: 15 s â†’ Peripheral Movement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (timeAway >= 15000 && LearningState.level < 2) {
            LearningState.level = 2
            showPeripheralMovement()
        }

        // â”€â”€ Third threshold: 20 s â†’ request Gemini breadcrumb â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (timeAway >= 20000 && LearningState.level < 3) {
            LearningState.level = 3
            requestBreadcrumb()
        }
    }, 500)
}

function stopRecoveryModule() {
    if (watchdogIntervalId) { clearInterval(watchdogIntervalId); watchdogIntervalId = null }
    if (lkcIntervalId)      { clearInterval(lkcIntervalId);      lkcIntervalId      = null }
    LearningState.isDistracted    = false
    LearningState.distractionStart = null
    LearningState.level            = 0
    resetAutoSummarizeTracking()
    hidePeripheralMovement()
    hideBreadcrumbToast()
}

async function startNeuralAdaptive(options) {
    options = options || {}
    if (isBooting || isRunning) {
        if (options.forceRecalibrate && isRunning) {
            await runCalibrationAndValidation(true)
        }
        return
    }

    if (!/^https?:$/i.test(window.location.protocol)) {
        console.log('[NeuralAdaptive] Skipping tracking on unsupported page:', window.location.href)
        return
    }

    isBooting = true
    try {
        await loadFlagsFromStorage()
        injectStyles()
        DwellGrid.reset()
        GazeCursor.create()
        _gazeSmoothed = null
        smoothedPoint = null
        lineSnapCache.ts = 0
        lastLineId = null
        resetDriftMap()
        bindDriftResetListeners()
        initResidualFusion()
        resetAdaptiveKalman()
        sessionMetrics = {
            sessionId: String(Date.now()) + '_' + Math.floor(Math.random() * 1e6),
            sessionStartTs: Date.now(),
            jitterSamples: [],
            lastFinalPoint: null,
            lineSwitchTotal: 0,
            lineSwitchSuspicious: 0,
            interventionActivations: 0,
            interventionFalseTriggers: 0,
        }
        lastSessionMirrorTs = 0

        // Inject FaceMesh + iris-tracker into page's MAIN world (uses page camera permission)
        var trackResp = await chrome.runtime.sendMessage({ type: 'START_TRACKING' })
        if (trackResp && !trackResp.ok) throw new Error(trackResp.error || 'injection failed')

        var needCal = await shouldForceCalibration(!!options.forceRecalibrate)
        if (needCal) await runCalibrationAndValidation(!!options.forceRecalibrate)

        isRunning = true
        bindReadabilityWheel()
        scheduleReadingFocusLoop()
        startRecoveryModule()
        console.log('[NeuralAdaptive] Tracking enabled')
    } catch (err) {
        var msg = err && err.message ? err.message : String(err)
        console.error('[NeuralAdaptive] Failed to start tracking:', msg)
        if (/permission dismissed|notallowed|camera api unavailable/i.test(msg)) {
            console.error('[NeuralAdaptive] Camera permission blocked — allow camera and try again.')
            chrome.storage.local.set({ enabled: false }, function () {
                if (chrome.runtime.lastError) { /* swallow */ }
            })
        }
        isRunning = false
    } finally {
        isBooting = false
    }
}

function stopNeuralAdaptive() {
    chrome.runtime.sendMessage({ type: 'STOP_TRACKING' }).catch(function () {})

    unbindReadabilityWheel()
    clearReadabilityStruggleDom()

    DwellGrid.reset()
    GazeCursor.hide()
    stopRecoveryModule()
    unbindDriftResetListeners()

    isRunning = false
    isBooting = false
    isCalibrating = false
    gazeBuffer = []
    measurementHistory = []
    lastSendTime = 0
    lastDwellBoost = 0
    interventionBlockedUntil = 0
    degradationSpikeStreak = 0
    interventionCandidateTier = null
    interventionCandidateCount = 0
    currentTier = 'CALM'
    smoothedPoint = null
    _gazeSmoothed = null
    lastSessionMirrorTs = 0
    clearAllInterventions()
    removeCalibrationOverlay()
    console.log('[NeuralAdaptive] Tracking disabled')
}

function clearAllInterventions() {
    removeTooltip()
    highlightedSentence = null
    maxTypographyTier = 'CALM'
    document.querySelectorAll('.na-elevated, .na-overload, .na-dim-surround').forEach(function (el) {
        el.classList.remove('na-elevated', 'na-overload', 'na-dim-surround')
    })
    document.querySelectorAll('.na-sentence').forEach(function (span) {
        span.style.opacity = ''
    })
    setOverloadHalo('CALM')
}

// Full-viewport halo that pulses at the edges while the user's current tier
// is elevated or overloaded. Creates the overlay lazily and removes it on CALM.
function setOverloadHalo(tier) {
    if (tier !== 'OVERLOAD' && tier !== 'ELEVATED') {
        var existing = document.getElementById('na-overload-halo')
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        return
    }
    injectStyles()
    var halo = document.getElementById('na-overload-halo')
    if (!halo) {
        halo = document.createElement('div')
        halo.id = 'na-overload-halo'
        halo.setAttribute('aria-hidden', 'true')
        ;(document.body || document.documentElement).appendChild(halo)
    }
    halo.classList.remove('na-halo-elevated', 'na-halo-overload')
    if (tier === 'OVERLOAD') halo.classList.add('na-halo-overload')
    else halo.classList.add('na-halo-elevated')
}

// Dwell callback â€” fires when gaze stays in one grid sector for DWELL_THRESHOLD_MS
DwellGrid.onDwellCb = function (sector, x, y) {
    if (!isRunning || isCalibrating) return
    var para = DwellGrid.getParagraphAt(x, y)
    console.log('[NeuralAdaptive] Dwell sector', sector, para ? 'on <' + para.tagName + '>' : '(no para)')
    // Dwell on a paragraph counts as a heavy fixation signal â€” boost the next score flush
    if (para) lastDwellBoost = Date.now()

    if (!latestFrameState) return
    if (!(activeFlags && (activeFlags.drift_map_v1 || activeFlags.residual_fusion_v1))) return
    var qualityOk = (latestFrameState.readingScore >= CONFIG.DRIFT_ANCHOR_QUALITY_READING) &&
        (latestFrameState.degradationScore <= CONFIG.DRIFT_ANCHOR_QUALITY_DEGRAD) &&
        (latestFrameState.measurementRatio >= CONFIG.DRIFT_ANCHOR_QUALITY_MEAS)
    if (!qualityOk) return
    if (!latestFrameState.lineSnapUsed || typeof latestFrameState.anchorX !== 'number' || typeof latestFrameState.anchorY !== 'number') return

    var rawX = latestFrameState.preSnapX
    var rawY = latestFrameState.preSnapY
    var anchorX = latestFrameState.anchorX
    var anchorY = latestFrameState.anchorY
    var residual = Math.sqrt(Math.pow(anchorX - rawX, 2) + Math.pow(anchorY - rawY, 2))
    var huberK = 50
    var w = residual <= huberK ? 1 : (huberK / residual)
    driftMap.anchors.push({ rawX: rawX, rawY: rawY, anchorX: anchorX, anchorY: anchorY, weight: w, ts: Date.now() })
    if (driftMap.anchors.length > 160) driftMap.anchors.shift()

    if (activeFlags.drift_map_v1) maybeUpdateDriftModel()
    if (activeFlags.residual_fusion_v1 && latestFrameState.residualFeatures) {
        var dx = anchorX - rawX
        var dy = anchorY - rawY
        trainResidualFusion(latestFrameState.residualFeatures, dx, dy)
        residualFusion.residualHistory.push(Math.sqrt(dx * dx + dy * dy))
        if (residualFusion.residualHistory.length > 80) residualFusion.residualHistory.shift()
    }
}

var lastDwellBoost = 0   // timestamp of most recent dwell event

// onGazeState retained as no-op stub; gaze is now driven by onGazeUpdate via GAZE_UPDATE messages.
function onGazeState(state) { onGazeUpdate(state) }

function computeSignals(buffer) {
    var recent = buffer.slice(-30)
    var avgX = recent.reduce(function (s, p) { return s + p.x }, 0) / recent.length
    var avgY = recent.reduce(function (s, p) { return s + p.y }, 0) / recent.length
    var allClose = recent.every(function (p) {
        return Math.sqrt(Math.pow(p.x - avgX, 2) + Math.pow(p.y - avgY, 2)) < CONFIG.FIXATION_THRESHOLD_PX
    })
    var fixDuration = allClose ? (recent[recent.length - 1].t - recent[0].t) : 0
    var fixationScore = Math.min(fixDuration / CONFIG.FIXATION_STRESS_DURATION_MS, 1.0)

    var velocities = []
    for (var i = 1; i < buffer.length; i++) {
        var dt = buffer[i].t - buffer[i - 1].t
        if (dt <= 0) continue
        var dx = buffer[i].x - buffer[i - 1].x
        var dy = buffer[i].y - buffer[i - 1].y
        velocities.push(Math.sqrt(dx * dx + dy * dy) / dt * 1000)
    }
    var highV = velocities.filter(function (v) { return v > CONFIG.SACCADE_HIGH_VELOCITY }).length
    var saccadeScore = Math.min(highV / Math.max(velocities.length * 0.3, 1), 1.0)

    var win = buffer.slice(-CONFIG.REGRESSION_WINDOW)
    var regressions = 0
    for (var j = 1; j < win.length; j++) {
        if (win[j].x < win[j - 1].x - 20) regressions++
    }
    var regressionScore = Math.min(regressions / (CONFIG.REGRESSION_WINDOW * 0.4), 1.0)

    return {
        fixation: parseFloat(fixationScore.toFixed(3)),
        saccade: parseFloat(saccadeScore.toFixed(3)),
        regression: parseFloat(regressionScore.toFixed(3)),
    }
}

function shouldAllowIntervention(state) {
    var now = Date.now()
    var measurementRatio = typeof state.measurementRatio === 'number' ? state.measurementRatio : getMeasurementRatio()
    var readingScore = typeof state.readingScore === 'number' ? state.readingScore : 0
    var degradation = typeof state.degradationScore === 'number' ? state.degradationScore : 0
    var degraded = !!state.isTrackerDegraded
    var readingOk = state.isReading !== false && readingScore >= CONFIG.INTERVENTION_MIN_READING_SCORE
    var measurementOk = measurementRatio >= CONFIG.INTERVENTION_MIN_MEAS_RATIO
    var degradationOk = !degraded && degradation <= CONFIG.INTERVENTION_MAX_DEGRADATION
    if (degradation > 0.9) degradationSpikeStreak += 1
    else degradationSpikeStreak = 0

    // Enter a short quiet period whenever tracking quality drops.
    if (!measurementOk || !degradationOk) {
        interventionBlockedUntil = now + CONFIG.INTERVENTION_QUIET_MS
    } else if (degradationSpikeStreak >= 2) {
        interventionBlockedUntil = now + CONFIG.INTERVENTION_QUIET_MS * 2
    }
    var blocked = now < interventionBlockedUntil
    latestPrecisionLive.interventionBlocked = blocked
    if (blocked) return false
    return readingOk && measurementOk && degradationOk
}

function applyInterventionStable(tier, state) {
    var allow = shouldAllowIntervention(state)
    var targetTier = allow ? tier : 'CALM'
    var goingDownFromOverload = currentTier === 'OVERLOAD' && targetTier !== 'OVERLOAD'
    var requiredTicks = CONFIG.INTERVENTION_CONFIRM_TICKS
    if (activeFlags && activeFlags.intervention_hysteresis_v2 && goingDownFromOverload) {
        requiredTicks = 3
    }

    if (targetTier === currentTier) {
        interventionCandidateTier = null
        interventionCandidateCount = 0
        return
    }

    if (interventionCandidateTier !== targetTier) {
        interventionCandidateTier = targetTier
        interventionCandidateCount = 1
        return
    }

    interventionCandidateCount += 1
    if (interventionCandidateCount < requiredTicks) return

    interventionCandidateTier = null
    interventionCandidateCount = 0
    if (targetTier !== 'CALM') {
        sessionMetrics.interventionActivations += 1
        var falseTrigger = (state.readingScore < CONFIG.INTERVENTION_MIN_READING_SCORE) || !!state.isTrackerDegraded || latestPrecisionLive.interventionBlocked
        if (falseTrigger) sessionMetrics.interventionFalseTriggers += 1
    }
    applyIntervention(targetTier, allow && state.isReading)
}

// ── Ambient Reading Progress Bar ─────────────────────────────────────────────
// Thin top-of-viewport bar that ratchets forward based on the furthest paragraph
// the reader has reached. Gives short-attention-span readers a visible sense of
// momentum and a reachable endpoint. Works independently of focus mode and
// works without eye tracking (falls back to viewport-center paragraph).
var progressBarActive = false
var progressBarEl = null
var progressBarFillEl = null
var progressBadgeEl = null
var progressLoopTimer = null
var progressFarthestIndex = -1
var progressTotalParagraphs = 0
var progressCachedRootSig = null
var PROGRESS_POLL_MS = 500
var PROGRESS_MIN_PARAGRAPHS = 3
var dyslexiaModeActive = false

// ── Blended readability (stress + disengagement + wheel churn) ───────────────
var readabilityWheelSamples = []
var readabilityWheelBound = false
var readabilityStruggleSmoothed = 0
var readabilityStrugglePrev = 0
var lastReadingFocusEl = null
var readingFocusTimerId = null
var lastReadabilityAnchorTs = 0

function pruneReadabilityWheelSamples(now) {
    var win = CONFIG.READABILITY_WHEEL_WINDOW_MS
    while (readabilityWheelSamples.length && now - readabilityWheelSamples[0].t > win) {
        readabilityWheelSamples.shift()
    }
}

function getWheelChurn01() {
    var now = Date.now()
    pruneReadabilityWheelSamples(now)
    var sum = 0
    for (var i = 0; i < readabilityWheelSamples.length; i++) {
        sum += readabilityWheelSamples[i].dy
    }
    var cap = CONFIG.READABILITY_WHEEL_CAP
    return cap > 0 ? Math.min(1, sum / cap) : 0
}

function onReadabilityWheel(e) {
    if (!isRunning || isCalibrating) return
    var dy = Math.abs(e.deltaY || 0)
    if (dy < 0.5) return
    var now = Date.now()
    pruneReadabilityWheelSamples(now)
    readabilityWheelSamples.push({ t: now, dy: dy })
}

function bindReadabilityWheel() {
    if (readabilityWheelBound) return
    window.addEventListener('wheel', onReadabilityWheel, { passive: true, capture: true })
    readabilityWheelBound = true
}

function unbindReadabilityWheel() {
    if (!readabilityWheelBound) return
    window.removeEventListener('wheel', onReadabilityWheel, { passive: true, capture: true })
    readabilityWheelBound = false
    readabilityWheelSamples = []
}

function computeBlendedReadabilityRaw(stressScore, readingScore, measurementRatio, degradationScore) {
    var disengage = Math.min(1, Math.max(0, 1 - (typeof readingScore === 'number' ? readingScore : 0.5)))
    var stress = Math.min(1, Math.max(0, typeof stressScore === 'number' ? stressScore : 0))
    var scroll01 = getWheelChurn01()
    var raw = CONFIG.READABILITY_W_STRESS * stress +
        CONFIG.READABILITY_W_DISENGAGE * disengage +
        CONFIG.READABILITY_W_SCROLL * scroll01
    raw = Math.min(1, Math.max(0, raw))
    var mr = typeof measurementRatio === 'number' ? measurementRatio : 1
    if (mr < CONFIG.READABILITY_MEAS_GATE) {
        raw *= Math.max(0.25, mr / CONFIG.READABILITY_MEAS_GATE)
    }
    var deg = typeof degradationScore === 'number' ? degradationScore : 0
    if (deg > 0.82) raw *= 0.72
    return raw
}

function pickFocusParagraph() {
    var root = findReadingContent()
    if (!root) return null
    var el = null
    if (smoothedPoint && typeof smoothedPoint.x === 'number') {
        el = DwellGrid.getParagraphAt(smoothedPoint.x, smoothedPoint.y)
        if (el && !root.contains(el)) el = null
    }
    if (!el && LearningState.lastReadElement && root.contains(LearningState.lastReadElement)) {
        el = LearningState.lastReadElement
    }
    if (!el) {
        var mid = window.innerHeight / 2
        var best = null
        var bestD = Infinity
        var ps = root.querySelectorAll('p')
        for (var i = 0; i < ps.length; i++) {
            var p = ps[i]
            var t = (p.innerText || '').trim()
            if (t.length < 15) continue
            var r = p.getBoundingClientRect()
            if (r.bottom < -120 || r.top > window.innerHeight + 120) continue
            var d = Math.abs((r.top + r.bottom) / 2 - mid)
            if (d < bestD) { bestD = d; best = p }
        }
        el = best
    }
    return el
}

function clearReadingFocusPara() {
    if (lastReadingFocusEl) {
        try {
            lastReadingFocusEl.classList.remove('na-readability-focus', 'na-dyslexia-focus')
            lastReadingFocusEl.style.removeProperty('--na-struggle')
        } catch (_e) {}
        lastReadingFocusEl = null
    }
}

function applyReadingFocusStyles(cappedStruggle) {
    injectStyles()
    var root = findReadingContent()
    if (!root) {
        clearReadingFocusPara()
        return
    }
    var para = pickFocusParagraph()
    if (!para) {
        clearReadingFocusPara()
        return
    }
    if (lastReadingFocusEl && lastReadingFocusEl !== para) {
        try {
            lastReadingFocusEl.classList.remove('na-readability-focus', 'na-dyslexia-focus')
            lastReadingFocusEl.style.removeProperty('--na-struggle')
        } catch (_e) {}
        lastReadingFocusEl = null
    }
    lastReadingFocusEl = para
    if (dyslexiaModeActive) {
        para.classList.add('na-dyslexia-focus')
    } else {
        para.classList.remove('na-dyslexia-focus')
    }
    var cap = typeof cappedStruggle === 'number' ? cappedStruggle : 0
    var showReadability = isRunning && !isCalibrating && cap >= 0.02 && textEnlargeEnabled
    if (showReadability) {
        para.classList.add('na-readability-focus')
        para.style.setProperty(
            '--na-struggle',
            Math.min(CONFIG.READABILITY_STRUGGLE_CAP, cap).toFixed(4)
        )
    } else {
        para.classList.remove('na-readability-focus')
        para.style.removeProperty('--na-struggle')
    }
}

function scheduleReadingFocusLoop() {
    if (readingFocusTimerId) return
    if (!dyslexiaModeActive && !isRunning) return
    readingFocusTimerId = setInterval(function () {
        if (!dyslexiaModeActive && !isRunning) {
            clearInterval(readingFocusTimerId)
            readingFocusTimerId = null
            clearReadingFocusPara()
            return
        }
        var cap = (isRunning && !isCalibrating)
            ? Math.min(CONFIG.READABILITY_STRUGGLE_CAP, readabilityStruggleSmoothed)
            : 0
        applyReadingFocusStyles(cap)
    }, 420)
}

function stopReadingFocusLoopIfIdle() {
    if (readingFocusTimerId && !dyslexiaModeActive && !isRunning) {
        clearInterval(readingFocusTimerId)
        readingFocusTimerId = null
        clearReadingFocusPara()
    }
}

function clearReadabilityStruggleDom() {
    clearReadingFocusPara()
    if (readingFocusTimerId) {
        clearInterval(readingFocusTimerId)
        readingFocusTimerId = null
    }
    readabilityStruggleSmoothed = 0
    readabilityStrugglePrev = 0
}

function maybeReadabilityAnchorSpike(prevS, nextS) {
    var now = Date.now()
    if (now - lastReadabilityAnchorTs < CONFIG.READABILITY_ANCHOR_COOLDOWN_MS) return
    if (prevS < CONFIG.READABILITY_ANCHOR_SPIKE_LO && nextS >= CONFIG.READABILITY_ANCHOR_SPIKE_HI) {
        lastReadabilityAnchorTs = now
        applyVisualAnchor()
    }
}

function updateReadabilityBlend(stressScore, readingScore, measurementRatio, degradationScore) {
    if (!isRunning || isCalibrating) return
    injectStyles()
    var raw = computeBlendedReadabilityRaw(stressScore, readingScore, measurementRatio, degradationScore)
    var a = CONFIG.READABILITY_SMOOTH_ALPHA
    readabilityStrugglePrev = readabilityStruggleSmoothed
    readabilityStruggleSmoothed = a * raw + (1 - a) * readabilityStruggleSmoothed
    readabilityStruggleSmoothed = Math.min(1, Math.max(0, readabilityStruggleSmoothed))

    var capped = Math.min(CONFIG.READABILITY_STRUGGLE_CAP, readabilityStruggleSmoothed)
    applyReadingFocusStyles(capped)
    scheduleReadingFocusLoop()

    maybeReadabilityAnchorSpike(readabilityStrugglePrev, readabilityStruggleSmoothed)
}

function progressCollectParagraphs() {
    var root = findReadingContent()
    if (!root) return null
    var all = root.querySelectorAll('p')
    var out = []
    for (var i = 0; i < all.length; i++) {
        var p = all[i]
        var txt = (p.innerText || '').trim()
        if (txt.length < 20) continue
        out.push(p)
    }
    if (out.length < PROGRESS_MIN_PARAGRAPHS) return null
    return out
}

function progressPickCurrentIndex(paragraphs) {
    // Use gaze Y if available, else fall back to viewport center.
    var gazeY = getRecentGazeY(2000)
    if (gazeY == null) gazeY = window.innerHeight / 2

    var bestIdx = -1
    var bestDist = Infinity
    for (var i = 0; i < paragraphs.length; i++) {
        var r = paragraphs[i].getBoundingClientRect()
        if (r.bottom < -200 || r.top > window.innerHeight + 200) continue
        var dist
        if (gazeY >= r.top && gazeY <= r.bottom) dist = 0
        else if (gazeY < r.top) dist = r.top - gazeY
        else dist = gazeY - r.bottom
        if (dist < bestDist) { bestDist = dist; bestIdx = i }
    }
    return bestIdx
}

function progressUpdateUi(currentIdx, total) {
    if (!progressBarFillEl || !progressBadgeEl) return
    var pct = total > 0 ? Math.max(0, Math.min(1, (progressFarthestIndex + 1) / total)) : 0
    progressBarFillEl.style.width = (pct * 100).toFixed(1) + '%'
    var n = Math.max(0, progressFarthestIndex + 1)
    progressBadgeEl.textContent = n + ' / ' + total
}

// Reading position tracker — always runs, regardless of whether the progress
// bar UI is visible. The session summary needs this data even when the bar
// is toggled off.
function progressTick() {
    var paragraphs = progressCollectParagraphs()
    if (!paragraphs) {
        progressLoopTimer = setTimeout(progressTick, PROGRESS_POLL_MS)
        return
    }
    // Reset the ratchet if the article changed (SPA navigation, new article).
    var sig = paragraphs.length + ':' + (paragraphs[0].innerText || '').slice(0, 40)
    if (sig !== progressCachedRootSig) {
        progressCachedRootSig = sig
        progressFarthestIndex = -1
    }
    progressTotalParagraphs = paragraphs.length
    var idx = progressPickCurrentIndex(paragraphs)
    if (idx > progressFarthestIndex) progressFarthestIndex = idx
    if (progressBarActive) progressUpdateUi(idx, paragraphs.length)
    progressLoopTimer = setTimeout(progressTick, PROGRESS_POLL_MS)
}

function startProgressBar() {
    if (progressBarActive) return
    injectStyles()
    progressBarActive = true
    if (!progressBarEl) {
        progressBarEl = document.createElement('div')
        progressBarEl.id = 'na-progress-bar'
        progressBarFillEl = document.createElement('div')
        progressBarFillEl.id = 'na-progress-bar-fill'
        progressBarEl.appendChild(progressBarFillEl)
        ;(document.body || document.documentElement).appendChild(progressBarEl)
    }
    if (!progressBadgeEl) {
        progressBadgeEl = document.createElement('div')
        progressBadgeEl.id = 'na-progress-badge'
        progressBadgeEl.textContent = '0 / 0'
        ;(document.body || document.documentElement).appendChild(progressBadgeEl)
    }
    // Fade in after a tick so the bar animates in rather than flashes.
    setTimeout(function () {
        if (progressBarEl) progressBarEl.classList.add('na-progress-visible')
        if (progressBadgeEl) progressBadgeEl.classList.add('na-progress-visible')
    }, 50)
    console.log('[NeuralAdaptive] Reading Progress UI ON')
}

function stopProgressBar() {
    if (!progressBarActive) return
    progressBarActive = false
    if (progressBarEl) {
        progressBarEl.classList.remove('na-progress-visible')
        var bar = progressBarEl
        setTimeout(function () { if (bar && bar.parentNode) bar.parentNode.removeChild(bar) }, 500)
        progressBarEl = null
        progressBarFillEl = null
    }
    if (progressBadgeEl) {
        progressBadgeEl.classList.remove('na-progress-visible')
        var badge = progressBadgeEl
        setTimeout(function () { if (badge && badge.parentNode) badge.parentNode.removeChild(badge) }, 500)
        progressBadgeEl = null
    }
    // NOTE: we deliberately keep progressFarthestIndex and the tick loop running
    // so the session summary still has "paragraphs read" data even with UI off.
    console.log('[NeuralAdaptive] Reading Progress UI OFF')
}

function setProgressBar(active) {
    if (active) startProgressBar()
    else stopProgressBar()
}

function setDyslexiaMode(active) {
    dyslexiaModeActive = !!active
    injectStyles()
    document.documentElement.classList.remove('na-dyslexia-mode')
    if (document.body) document.body.classList.remove('na-dyslexia-mode')
    if (dyslexiaModeActive) {
        var cap = (isRunning && !isCalibrating)
            ? Math.min(CONFIG.READABILITY_STRUGGLE_CAP, readabilityStruggleSmoothed)
            : 0
        applyReadingFocusStyles(cap)
        scheduleReadingFocusLoop()
    } else {
        stopReadingFocusLoopIfIdle()
        if (!isRunning) clearReadingFocusPara()
        else applyReadingFocusStyles(Math.min(CONFIG.READABILITY_STRUGGLE_CAP, readabilityStruggleSmoothed))
    }
    console.log('[NeuralAdaptive] Dyslexia mode:', dyslexiaModeActive ? 'ON' : 'OFF')
}

var TIER_RANK = { CALM: 0, ELEVATED: 1, OVERLOAD: 2 }
var TIER_NAMES = ['CALM', 'ELEVATED', 'OVERLOAD']
var maxTypographyTier = 'CALM'

// When OFF, the dynamic per-paragraph font-size scaling and the tier-based
// typography ratchets (na-elevated, na-overload) are suppressed. Other
// interventions (dimming, halo, sentence highlight, AI simplify, tooltip,
// dyslexia mode) are unaffected. Defaults to ON for back-compat.
var textEnlargeEnabled = true

function setTextEnlarge(active) {
    textEnlargeEnabled = !!active
    if (!textEnlargeEnabled) {
        // Strip any existing enlargement the user can currently see.
        document.querySelectorAll('.na-elevated, .na-overload').forEach(function (el) {
            el.classList.remove('na-elevated', 'na-overload')
        })
        document.querySelectorAll('.na-readability-focus').forEach(function (el) {
            el.classList.remove('na-readability-focus')
            el.style.removeProperty('--na-struggle')
        })
        maxTypographyTier = 'CALM'
    } else {
        // Re-apply based on current state, so turning it back on is immediate.
        var el = findReadingContent && findReadingContent()
        if (el) {
            if (currentTier === 'ELEVATED') el.classList.add('na-elevated')
            else if (currentTier === 'OVERLOAD') el.classList.add('na-overload')
        }
        if (isRunning) applyReadingFocusStyles(Math.min(CONFIG.READABILITY_STRUGGLE_CAP, readabilityStruggleSmoothed))
    }
    console.log('[NeuralAdaptive] Text enlarge:', textEnlargeEnabled ? 'ON' : 'OFF')
}

// ── Long-dwell auto-summarize ────────────────────────────────────────────────
// If the user's gaze rests on the same paragraph for more than
// AUTO_SUMMARIZE_DWELL_MS without progressing, fire a Gemini summary and show
// the tooltip. Each paragraph can only auto-summarize once per page load.
var AUTO_SUMMARIZE_DWELL_MS = 10000
var autoSummarizeCurrentEl = null
var autoSummarizeStartTs = 0
var autoSummarizeInFlight = false
var autoSummarizedParas = new WeakSet()

function resetAutoSummarizeTracking() {
    autoSummarizeCurrentEl = null
    autoSummarizeStartTs = 0
    autoSummarizeInFlight = false
}

function checkLongDwellAutoSummarize() {
    if (!isRunning || isCalibrating) return
    if (LearningState.isDistracted) { resetAutoSummarizeTracking(); return }

    var el = LearningState.lastReadElement
    if (!el || !el.isConnected) { resetAutoSummarizeTracking(); return }

    // Only paragraphs with enough substance to be worth summarizing.
    var text = (el.innerText || el.textContent || '').trim()
    if (text.length < 120) { resetAutoSummarizeTracking(); return }

    var now = Date.now()
    if (el !== autoSummarizeCurrentEl) {
        autoSummarizeCurrentEl = el
        autoSummarizeStartTs = now
        autoSummarizeInFlight = false
        return
    }
    if (autoSummarizeInFlight) return
    if (autoSummarizedParas.has(el)) return
    if (now - autoSummarizeStartTs < AUTO_SUMMARIZE_DWELL_MS) return

    autoSummarizeInFlight = true
    var snippet = text.slice(0, 800)
    chrome.runtime.sendMessage({
        type: 'SUMMARIZE_PARAGRAPH',
        text: snippet,
    }, function (response) {
        autoSummarizeInFlight = false
        if (chrome.runtime.lastError) {
            console.warn('[NeuralAdaptive] auto-summarize transport failed:', chrome.runtime.lastError.message)
            return
        }
        if (!response || response.error) {
            console.warn('[NeuralAdaptive] auto-summarize failed:', response && response.error)
            return
        }
        if (!response.summary) return
        // If gaze has moved to a different paragraph in the meantime, still
        // show the summary — the dwell earned it.
        autoSummarizedParas.add(el)
        renderTooltip(response.summary)
    })
}

// ── Session aggregation for the Spectrum companion iMessage ──────────────────
// Samples stress score + tier on every STRESS_SCORE dispatch (~600ms). Keeps
// running average, peak tier, time-in-tier durations, a capped timestamped
// score history (for binning into a stress timeline), and tier transitions
// (for the reading-coach agent to reason about rough patches).
var SESSION_HISTORY_CAP = 3000
var sessionAgg = {
    startTs: Date.now(),
    scoreSum: 0,
    scoreCount: 0,
    peakRank: 0,
    tierDurationMs: { CALM: 0, ELEVATED: 0, OVERLOAD: 0 },
    lastTierTs: Date.now(),
    lastTier: 'CALM',
    scoreHistory: [],   // [{ t: ms, score: 0..1, tier: 'CALM'|... }]
    transitions: [],    // [{ atMs, from, to }]
}

function resetSessionAggregation() {
    var now = Date.now()
    sessionAgg = {
        startTs: now,
        scoreSum: 0,
        scoreCount: 0,
        peakRank: 0,
        tierDurationMs: { CALM: 0, ELEVATED: 0, OVERLOAD: 0 },
        lastTierTs: now,
        lastTier: 'CALM',
        scoreHistory: [],
        transitions: [],
    }
}

function recordSessionSample(score, tier) {
    var now = Date.now()
    if (typeof score === 'number' && isFinite(score)) {
        sessionAgg.scoreSum += score
        sessionAgg.scoreCount += 1
        if (sessionAgg.scoreHistory.length < SESSION_HISTORY_CAP) {
            sessionAgg.scoreHistory.push({ t: now, score: score, tier: tier })
        }
    }
    var rank = TIER_RANK[tier] != null ? TIER_RANK[tier] : 0
    if (rank > sessionAgg.peakRank) sessionAgg.peakRank = rank
    var dt = Math.max(0, now - sessionAgg.lastTierTs)
    if (sessionAgg.tierDurationMs[sessionAgg.lastTier] != null) {
        sessionAgg.tierDurationMs[sessionAgg.lastTier] += dt
    }
    if (tier !== sessionAgg.lastTier) {
        sessionAgg.transitions.push({ atMs: now, from: sessionAgg.lastTier, to: tier })
    }
    sessionAgg.lastTierTs = now
    sessionAgg.lastTier = tier
}

// Compress the raw score history into N bins of (startSec, endSec, avgScore,
// dominantTier). The reading-coach agent uses this to locate rough patches
// without having to page through thousands of raw samples.
function buildStressTimeline(history, startTs, endTs, nBins) {
    if (!history || history.length === 0 || endTs <= startTs) return []
    var span = endTs - startTs
    var binMs = span / nBins
    var bins = []
    for (var i = 0; i < nBins; i++) {
        bins.push({ sum: 0, count: 0, tierCounts: { CALM: 0, ELEVATED: 0, OVERLOAD: 0 } })
    }
    for (var j = 0; j < history.length; j++) {
        var s = history[j]
        var idx = Math.min(nBins - 1, Math.max(0, Math.floor((s.t - startTs) / binMs)))
        bins[idx].sum += s.score
        bins[idx].count += 1
        if (bins[idx].tierCounts[s.tier] != null) bins[idx].tierCounts[s.tier] += 1
    }
    var out = []
    for (var k = 0; k < nBins; k++) {
        var b = bins[k]
        var avg = b.count > 0 ? b.sum / b.count : 0
        var tier = 'CALM'
        if (b.tierCounts.OVERLOAD > b.tierCounts.ELEVATED && b.tierCounts.OVERLOAD > b.tierCounts.CALM) tier = 'OVERLOAD'
        else if (b.tierCounts.ELEVATED > b.tierCounts.CALM) tier = 'ELEVATED'
        out.push({
            startSec: Math.round((k * binMs) / 1000),
            endSec: Math.round(((k + 1) * binMs) / 1000),
            avgScore: parseFloat(avg.toFixed(3)),
            samples: b.count,
            tier: tier,
        })
    }
    return out
}

function buildSessionSummary() {
    var now = Date.now()
    // Flush the time spent in the current tier since the last sample.
    var dt = Math.max(0, now - sessionAgg.lastTierTs)
    if (sessionAgg.tierDurationMs[sessionAgg.lastTier] != null) {
        sessionAgg.tierDurationMs[sessionAgg.lastTier] += dt
    }
    sessionAgg.lastTierTs = now

    var totalMs = sessionAgg.tierDurationMs.CALM +
                  sessionAgg.tierDurationMs.ELEVATED +
                  sessionAgg.tierDurationMs.OVERLOAD
    var denom = totalMs > 0 ? totalMs : 1
    var tierBreakdown = {
        calm: 100 * sessionAgg.tierDurationMs.CALM / denom,
        elevated: 100 * sessionAgg.tierDurationMs.ELEVATED / denom,
        overload: 100 * sessionAgg.tierDurationMs.OVERLOAD / denom,
    }

    var peakTier = TIER_NAMES[sessionAgg.peakRank] || 'CALM'
    var averageScore = sessionAgg.scoreCount > 0
        ? sessionAgg.scoreSum / sessionAgg.scoreCount
        : 0

    // Words-read estimate + paragraph samples: the reading-coach agent uses
    // these to reference specific content when writing the debrief.
    var paragraphsRead = Math.max(0, progressFarthestIndex + 1)
    var paragraphsTotal = progressTotalParagraphs || 0
    var wordsRead = 0
    var paragraphSamples = []
    var PARA_TEXT_CAP = 260        // chars per paragraph snippet
    var PARA_SAMPLE_CAP = 30       // max paragraph samples in payload
    var paragraphs = progressCollectParagraphs()
    if (paragraphs) {
        var cap = Math.min(paragraphsRead, paragraphs.length)
        // Evenly sample up to PARA_SAMPLE_CAP across the range the reader covered.
        var stride = cap > PARA_SAMPLE_CAP ? Math.ceil(cap / PARA_SAMPLE_CAP) : 1
        for (var i = 0; i < cap; i++) {
            var full = (paragraphs[i].innerText || '').trim()
            if (!full) continue
            var wc = full.split(/\s+/).length
            wordsRead += wc
            if (i % stride === 0) {
                paragraphSamples.push({
                    index: i,
                    text: full.length > PARA_TEXT_CAP ? full.slice(0, PARA_TEXT_CAP) + '…' : full,
                    wordCount: wc,
                })
            }
        }
    }

    var durationSeconds = Math.round((now - sessionAgg.startTs) / 1000)
    // Pace: wordsRead sums every word in paragraphs touched by progress — that
    // over-counts when scrolling quickly. Cap words to a per-session "budget" at
    // ~typical sustained reading, then flag when we had to clip (finicky/skimming).
    var PACE_REF_WPM = 200
    var PACE_MAX_ABOVE_REF = 50
    var maxPlausibleWpm = PACE_REF_WPM + PACE_MAX_ABOVE_REF
    var naiveWpm = durationSeconds >= 8
        ? Math.round(wordsRead / (durationSeconds / 60))
        : 0
    var wordsBudget = Math.max(
        0,
        Math.floor((durationSeconds / 60) * maxPlausibleWpm)
    )
    var wordsForPace = Math.min(wordsRead, wordsBudget)
    var credibleWpm = durationSeconds >= 8 && wordsBudget > 0
        ? Math.round(wordsForPace / (durationSeconds / 60))
        : 0
    var paceUnreliable = durationSeconds >= 15 &&
        (naiveWpm > maxPlausibleWpm || wordsRead > wordsBudget)
    var readingPace = {
        referenceWpm: PACE_REF_WPM,
        maxPlausibleWpm: maxPlausibleWpm,
        rawWpm: naiveWpm,
        credibleWpm: credibleWpm,
        wordsBudget: wordsBudget,
        wordsCapped: wordsRead > wordsBudget,
        unreliable: paceUnreliable,
        note: paceUnreliable
            ? 'Word count from scrolled paragraphs exceeds what fits typical sustained reading in this time — likely skimming, scrolling, or jumping ahead. Do not praise WPM; use credibleWpm if mentioning pace at all.'
            : '',
    }
    var stressTimeline = buildStressTimeline(sessionAgg.scoreHistory, sessionAgg.startTs, now, 15)
    var tierTransitions = sessionAgg.transitions.map(function (t) {
        return {
            atSec: Math.round((t.atMs - sessionAgg.startTs) / 1000),
            from: t.from,
            to: t.to,
        }
    })

    return {
        sessionType: 'reading',
        durationSeconds: durationSeconds,
        averageScore: parseFloat(averageScore.toFixed(3)),
        peakTier: peakTier,
        tierBreakdown: {
            calm: parseFloat(tierBreakdown.calm.toFixed(1)),
            elevated: parseFloat(tierBreakdown.elevated.toFixed(1)),
            overload: parseFloat(tierBreakdown.overload.toFixed(1)),
        },
        interventionCount: sessionMetrics.interventionActivations || 0,
        paragraphsRead: paragraphsRead,
        paragraphsTotal: paragraphsTotal,
        wordsRead: wordsRead,
        readingPace: readingPace,
        pageTitle: document.title || '',
        // Rich context for the reading-coach agent on the Spectrum server.
        stressTimeline: stressTimeline,
        tierTransitions: tierTransitions,
        paragraphSamples: paragraphSamples,
    }
}

function applyIntervention(tier, isReading) {
    if (tier === currentTier) return
    currentTier = tier
    setOverloadHalo(tier)
    var el = findReadingContent()
    if (!el) return

    // Typography ratchets: once we reach ELEVATED or OVERLOAD, the class stays
    // on the container even when stress drops. Only a manual reset clears it.
    // Gated by the Text Enlarge toggle — when off, these classes never land.
    if (textEnlargeEnabled && TIER_RANK[tier] > TIER_RANK[maxTypographyTier]) {
        maxTypographyTier = tier
        el.classList.remove('na-elevated', 'na-overload')
        if (tier === 'ELEVATED') el.classList.add('na-elevated')
        else if (tier === 'OVERLOAD') el.classList.add('na-overload')
    }

    // Dimming of surrounding paragraphs is transient — only active while the
    // student is in OVERLOAD right now.
    if (tier === 'OVERLOAD') el.classList.add('na-dim-surround')
    else el.classList.remove('na-dim-surround')

    if (tier === 'CALM') {
        removeTooltip()
        clearSentenceHighlight(el)
        return
    }
    if (tier === 'ELEVATED') {
        clearSentenceHighlight(el)
        removeTooltip()
        return
    }
    applySentenceHighlight(el)
    removeTooltip()
    if (isReading !== false) triggerReadingAgent(el)
}

function resetTypography() {
    maxTypographyTier = 'CALM'
    document.querySelectorAll('.na-elevated, .na-overload, .na-dim-surround').forEach(function (el) {
        el.classList.remove('na-elevated', 'na-overload', 'na-dim-surround')
    })
    setOverloadHalo('CALM')
}

function findReadingContent() {
    var selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content', '.mw-parser-output']
    for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i])
        if (el) return el
    }
    var best = null
    var bestScore = 0
    document.querySelectorAll('div, section').forEach(function (el) {
        var ps = el.querySelectorAll('p')
        var children = el.children.length
        if (!children) return
        var s = ps.length / children
        if (ps.length > 3 && s > bestScore) { bestScore = s; best = el }
    })
    return best
}

function applySentenceHighlight(contentEl) {
    var mid = window.innerHeight / 2
    var closestP = null
    var closestDist = Infinity
    contentEl.querySelectorAll('p').forEach(function (p) {
        var r = p.getBoundingClientRect()
        var d = Math.abs((r.top + r.bottom) / 2 - mid)
        if (d < closestDist) { closestDist = d; closestP = p }
    })
    if (!closestP || highlightedSentence === closestP) return
    highlightedSentence = closestP

    var raw = closestP.innerText
    var sentences = raw.match(/[^.!?]+[.!?]+/g) || [raw]
    closestP.innerHTML = sentences.map(function (s, i) {
        return '<span class="na-sentence" data-idx="' + i + '">' + s + '</span>'
    }).join('')

    var spans = closestP.querySelectorAll('.na-sentence')
    spans.forEach(function (s) { s.style.opacity = '0.25' })
    var targetIdx = 0
    if (gazeBuffer.length > 0 && spans.length > 1) {
        var lastGaze = gazeBuffer[gazeBuffer.length - 1]
        var rect = closestP.getBoundingClientRect()
        var rel = (lastGaze.x - rect.left) / rect.width
        targetIdx = Math.max(0, Math.min(Math.floor(rel * spans.length), spans.length - 1))
    }
    if (spans[targetIdx]) spans[targetIdx].style.opacity = '1'
}

function clearSentenceHighlight(contentEl) {
    highlightedSentence = null
    contentEl.querySelectorAll('.na-sentence').forEach(function (s) { s.style.opacity = '' })
}

function triggerGeminiTooltip(contentEl) {
    var mid = window.innerHeight / 2
    var closestP = null
    var closestDist = Infinity
    contentEl.querySelectorAll('p').forEach(function (p) {
        var r = p.getBoundingClientRect()
        var d = Math.abs((r.top + r.bottom) / 2 - mid)
        if (d < closestDist) { closestDist = d; closestP = p }
    })
    if (!closestP || !closestP.innerText.trim()) return

    chrome.runtime.sendMessage({
        type: 'SUMMARIZE_PARAGRAPH',
        text: closestP.innerText.trim().slice(0, 800)
    }, function (response) {
        if (chrome.runtime.lastError) {
            console.warn('[NeuralAdaptive] summarize transport failed:', chrome.runtime.lastError.message)
            return
        }
        if (!response) {
            console.warn('[NeuralAdaptive] summarize returned no response')
            return
        }
        if (response.error) {
            console.warn('[NeuralAdaptive] summarize failed:', response.error)
            return
        }
        if (response.summary) renderTooltip(response.summary)
    })
}

// ── Inline AI simplification (plain LLM call, no tool routing) ───────────────
// On OVERLOAD we pick the paragraph closest to screen center and ask Dedalus
// to rewrite it at a 6th-grade level. One-shot transformation — no agent,
// no tools. Cache keyed by paragraph text so re-triggering is free.

var simplificationCache = new Map()          // originalText → simplifiedText
var simplifiedParagraphs = new Set()         // <p> elements currently transformed
var pendingSimplification = new WeakSet()    // paragraphs with in-flight fetch
var MIN_SIMPLIFY_WORDS = 30
var MAX_SIMPLIFY_CHARS = 1400

// Weighted average of the most recent gaze y positions (viewport space).
// Weights recent samples more heavily so a quick glance doesn't hijack the
// paragraph pick, but recent fixations do.
function getRecentGazeY(windowMs) {
    if (!gazeBuffer.length) return null
    var now = Date.now()
    var cutoff = now - (windowMs || 3000)
    var wSum = 0, ySum = 0
    for (var i = gazeBuffer.length - 1; i >= 0; i--) {
        var s = gazeBuffer[i]
        if (s.t < cutoff) break
        var age = now - s.t
        var w = 1 / (1 + age / 500)   // halves every 500ms
        ySum += s.y * w
        wSum += w
    }
    return wSum > 0 ? ySum / wSum : null
}

// Pick the paragraph the student is actually reading, based on recent gaze
// position rather than screen center.
function pickGazeParagraph(contentEl) {
    var gazeY = getRecentGazeY(3000)
    if (gazeY == null) gazeY = window.innerHeight / 2   // fallback: no gaze yet

    var best = null
    var bestDist = Infinity
    contentEl.querySelectorAll('p').forEach(function (p) {
        if (p.classList.contains('na-simplified')) return
        var txt = (p.innerText || '').trim()
        if (!txt) return
        if (txt.split(/\s+/).length < MIN_SIMPLIFY_WORDS) return
        var r = p.getBoundingClientRect()
        if (r.bottom < 0 || r.top > window.innerHeight) return
        var dist
        if (gazeY >= r.top && gazeY <= r.bottom) dist = 0
        else if (gazeY < r.top) dist = r.top - gazeY
        else dist = gazeY - r.bottom
        if (dist < bestDist) { bestDist = dist; best = p }
    })
    return best
}

function triggerReadingAgent(contentEl) {
    var closestP = pickGazeParagraph(contentEl)
    if (!closestP) return
    if (pendingSimplification.has(closestP)) return

    // Dismiss the OVERLOAD border halo once we're taking action — the AI
    // summary/simplify is the feedback, no need to also pulse the edges.
    setOverloadHalo('CALM')

    var original = closestP.innerText.trim()
    var cacheKey = original.slice(0, MAX_SIMPLIFY_CHARS)

    if (simplificationCache.has(cacheKey)) {
        applySimplificationToParagraph(closestP, simplificationCache.get(cacheKey))
        return
    }

    pendingSimplification.add(closestP)
    closestP.classList.add('na-simplified-pending')

    chrome.runtime.sendMessage({
        type: 'SIMPLIFY_PARAGRAPH',
        text: original.slice(0, MAX_SIMPLIFY_CHARS),
    }, function (response) {
        pendingSimplification.delete(closestP)
        closestP.classList.remove('na-simplified-pending')

        if (chrome.runtime.lastError) {
            console.warn('[NeuralAdaptive] simplify transport failed:', chrome.runtime.lastError.message)
            return
        }
        if (!response) {
            console.warn('[NeuralAdaptive] simplify returned no response')
            return
        }
        if (response.error) {
            console.warn('[NeuralAdaptive] simplify failed:', response.error, {
                preview: original.slice(0, 80),
            })
            return
        }
        if (!response.simplified) {
            console.warn('[NeuralAdaptive] simplify returned empty text')
            return
        }

        simplificationCache.set(cacheKey, response.simplified)
        applySimplificationToParagraph(closestP, response.simplified)
    })
}

function buildCoachBadge(label, reason) {
    var badge = document.createElement('span')
    badge.className = 'na-simplified-badge'
    badge.textContent = label
    if (reason) badge.title = reason
    return badge
}

function buildCoachToggle(p, onClick) {
    var toggle = document.createElement('button')
    toggle.className = 'na-simplified-toggle'
    toggle.type = 'button'
    toggle.textContent = 'Show original'
    toggle.addEventListener('click', function (ev) {
        ev.preventDefault()
        ev.stopPropagation()
        onClick()
    })
    return toggle
}

function applySimplificationToParagraph(p, simplifiedText, reason) {
    if (p.classList.contains('na-simplified')) return
    if (!p.dataset.naOriginalHtml) {
        p.dataset.naOriginalHtml = p.innerHTML
    }
    var clean = String(simplifiedText || '').trim()
    if (!clean) return

    p.innerHTML = ''
    p.appendChild(buildCoachBadge('Simplified for focus', reason))
    p.appendChild(buildCoachToggle(p, function () { restoreParagraph(p) }))
    var body = document.createElement('div')
    body.style.marginTop = '8px'
    body.textContent = clean
    p.appendChild(body)

    p.classList.add('na-simplified')
    p.dataset.naCoachAction = 'simplify'
    simplifiedParagraphs.add(p)
}

function restoreParagraph(p) {
    if (!p.classList.contains('na-simplified')) return
    var orig = p.dataset.naOriginalHtml
    if (typeof orig === 'string') {
        p.innerHTML = orig
        delete p.dataset.naOriginalHtml
    }
    delete p.dataset.naCoachAction
    p.classList.remove('na-simplified')
    simplifiedParagraphs.delete(p)
}

function restoreAllSimplifications(contentEl) {
    var root = contentEl || document
    var nodes = root.querySelectorAll('p.na-simplified')
    nodes.forEach(restoreParagraph)
    simplifiedParagraphs.clear()
}

function renderTooltip(text) {
    removeTooltip()
    tooltipEl = document.createElement('div')
    tooltipEl.id = 'na-tooltip'
    tooltipEl.innerHTML = [
        '<div style="font-size:10px;font-weight:600;letter-spacing:0.1em;opacity:0.4;margin-bottom:8px;">NEURAL ADAPTIVE</div>',
        '<div style="font-size:13px;line-height:1.7;white-space:pre-line;">' + text + '</div>',
        '<button id="na-close" style="position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;font-size:16px;opacity:0.3;color:#fff;line-height:1;">x</button>',
    ].join('')
    Object.assign(tooltipEl.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        width: '280px',
        background: 'rgba(10,10,16,0.94)',
        color: '#e8e8e8',
        padding: '14px 16px',
        borderRadius: '10px',
        zIndex: '2147483646',
        fontFamily: '"Segoe UI", Tahoma, sans-serif',
        border: '0.5px solid rgba(255,255,255,0.1)',
        transition: 'opacity 0.3s ease',
        opacity: '0',
    })
    document.body.appendChild(tooltipEl)
    document.getElementById('na-close').onclick = function () { removeTooltip() }
    requestAnimationFrame(function () { tooltipEl.style.opacity = '1' })
}

function removeTooltip() {
    var el = document.getElementById('na-tooltip')
    if (el) el.remove()
    tooltipEl = null
}

function applyEnabledState(enabled) {
    if (enabled) startNeuralAdaptive()
    else stopNeuralAdaptive()
}

function applyAccuracyMode(mode) {
    if (!ACCURACY_MODE[mode]) mode = 'balanced'
    activeAccuracyMode = mode
    console.log('[NeuralAdaptive] Accuracy mode:', activeAccuracyMode)
}

chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return
    if (changes.enabled) applyEnabledState(!!changes.enabled.newValue)
    if (changes.accuracyMode) applyAccuracyMode(changes.accuracyMode.newValue)
    if (changes.na_flags) activeFlags = mergeFlags(changes.na_flags.newValue)
    if (changes.readingProgress) setProgressBar(!!changes.readingProgress.newValue)
    if (changes.dyslexiaMode) setDyslexiaMode(!!changes.dyslexiaMode.newValue)
    if (changes.textEnlargeEnabled) setTextEnlarge(changes.textEnlargeEnabled.newValue !== false)
})

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return

    if (message.type === 'NA_GET_STATUS') {
        sendResponse({
            running: isRunning,
            booting: isBooting,
            calibrating: isCalibrating,
            mode: activeAccuracyMode,
        })
        return
    }

    if (message.type === 'NA_GET_PRECISION_LIVE') {
        sendResponse({
            measurementRatio: parseFloat((latestPrecisionLive.measurementRatio || 0).toFixed(3)),
            readingScore: parseFloat((latestPrecisionLive.readingScore || 0).toFixed(3)),
            degradationScore: parseFloat((latestPrecisionLive.degradationScore || 0).toFixed(3)),
            snapDistancePx: parseFloat((latestPrecisionLive.snapDistancePx || 0).toFixed(2)),
            interventionBlocked: !!latestPrecisionLive.interventionBlocked,
            readabilityStruggle: parseFloat(
                Math.min(
                    CONFIG.READABILITY_STRUGGLE_CAP,
                    readabilityStruggleSmoothed || 0
                ).toFixed(3)
            ),
            ts: latestPrecisionLive.ts || 0,
        })
        return
    }

    if (message.type === 'NA_GET_SESSION_METRICS') {
        sendResponse(buildSessionMetricsSnapshot())
        return
    }

    if (message.type === 'NA_SET_ENABLED') {
        applyEnabledState(!!message.enabled)
        sendResponse({ ok: true })
        return
    }

    if (message.type === 'NA_SET_READING_PROGRESS') {
        setProgressBar(!!message.readingProgress)
        sendResponse({ ok: true, readingProgress: progressBarActive })
        return
    }

    if (message.type === 'NA_SET_DYSLEXIA_MODE') {
        setDyslexiaMode(!!message.dyslexiaMode)
        sendResponse({ ok: true, dyslexiaMode: dyslexiaModeActive })
        return
    }

    if (message.type === 'NA_SET_TEXT_ENLARGE') {
        setTextEnlarge(message.textEnlargeEnabled !== false)
        sendResponse({ ok: true, textEnlargeEnabled: textEnlargeEnabled })
        return
    }

    if (message.type === 'NA_FINISH_SESSION') {
        var payload = buildSessionSummary()
        // Require at least 15 seconds of session to avoid spamming during dev.
        // The user asked for a 30s threshold; we honour it unless force is set.
        var MIN_DURATION = message.force ? 0 : 15
        if (payload.durationSeconds < MIN_DURATION) {
            sendResponse({
                ok: false,
                error: 'Session too short (< ' + MIN_DURATION + 's). Keep reading.',
                payload: payload,
            })
            return
        }
        chrome.runtime.sendMessage({
            type: 'NA_SEND_SESSION_SUMMARY',
            payload: payload,
        }, function (bgResponse) {
            if (chrome.runtime.lastError) {
                sendResponse({ ok: false, error: chrome.runtime.lastError.message, payload: payload })
                return
            }
            if (bgResponse && bgResponse.ok) {
                resetSessionAggregation()
                sendResponse({ ok: true, payload: payload })
            } else {
                sendResponse({
                    ok: false,
                    error: (bgResponse && bgResponse.error) || 'unknown error',
                    payload: payload,
                })
            }
        })
        return true
    }

    if (message.type === 'NA_RECALIBRATE') {
        ; (async function () {
            if (!isRunning) {
                await startNeuralAdaptive({ forceRecalibrate: true })
            } else {
                await runCalibrationAndValidation(true)
            }
            sendResponse({ ok: true })
        })()
        return true
    }

    if (message.type === 'NA_POSE_CALIBRATE') {
        ; (async function () {
            if (!isRunning) {
                await startNeuralAdaptive()
            }
            isCalibrating = true
            try {
                var poseResult = await runNosePoseCalibrationMode()
                if (!poseResult || !poseResult.ok) {
                    sendResponse({ ok: false, error: poseResult && poseResult.reason ? poseResult.reason : 'pose calibration unavailable' })
                    return
                }
                var poseStats = poseResult && poseResult.stats ? poseResult.stats : null
                var poseLimits = poseResult && poseResult.limits ? poseResult.limits : null
                await new Promise(function (resolve) {
                    chrome.storage.local.set({
                        poseCalibrationVersion: CONFIG.POSE_CALIBRATION_VERSION,
                        poseCalibrationUpdatedAt: Date.now(),
                        poseCalibrationQualityScore: poseStats ? poseStats.qualityScore : null,
                        poseNeutralYaw: poseStats ? poseStats.neutralYaw : null,
                        poseNeutralPitch: poseStats ? poseStats.neutralPitch : null,
                        poseNeutralRoll: poseStats ? poseStats.neutralRoll : null,
                        poseYawLeftMax: poseStats ? poseStats.leftYawMax : null,
                        poseYawRightMax: poseStats ? poseStats.rightYawMax : null,
                        posePitchUpMax: poseStats ? poseStats.upPitchMax : null,
                        posePitchDownMax: poseStats ? poseStats.downPitchMax : null,
                        poseIpdMedian: poseStats ? poseStats.ipdMedian : null,
                        poseYawLimit: poseLimits ? poseLimits.yawLimit : null,
                        posePitchLimit: poseLimits ? poseLimits.pitchLimit : null,
                        poseRollLimit: poseLimits ? poseLimits.rollLimit : null,
                    }, function () {
                        if (chrome.runtime.lastError) {
                            console.warn('[NeuralAdaptive] pose cal save failed:', chrome.runtime.lastError.message)
                        }
                        resolve()
                    })
                })
                sendResponse({ ok: true, poseResult: poseResult })
            } catch (e) {
                sendResponse({ ok: false, error: e && e.message ? e.message : String(e) })
            } finally {
                isCalibrating = false
            }
        })()
        return true
    }
})

// ── Dev shortcuts for demoing AI simplification ──────────────────────────────
//   Ctrl/Cmd + Shift + O  → force OVERLOAD (runs AI simplify on focused paragraph)
//   Ctrl/Cmd + Shift + K  → force CALM    (stops dimming; keeps typography+simplify)
//   Ctrl/Cmd + Shift + R  → reset typography + restore all simplified paragraphs
document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey
    if (!mod || !e.shiftKey) return
    var key = e.key ? e.key.toLowerCase() : ''
    if (key === 'o') {
        e.preventDefault()
        console.log('[NeuralAdaptive] dev shortcut → forcing OVERLOAD')
        currentTier = 'CALM'    // reset so applyIntervention proceeds
        applyIntervention('OVERLOAD', true)
    } else if (key === 'k') {
        e.preventDefault()
        console.log('[NeuralAdaptive] dev shortcut → forcing CALM')
        applyIntervention('CALM', true)
    } else if (key === 'r') {
        e.preventDefault()
        console.log('[NeuralAdaptive] dev shortcut → resetting typography + simplifications')
        var el = findReadingContent()
        if (el) restoreAllSimplifications(el)
        resetTypography()
    } else if (key === 'p') {
        e.preventDefault()
        var nextProg = !progressBarActive
        chrome.storage.local.set({ readingProgress: nextProg }, function () {
            if (chrome.runtime.lastError) { /* swallow */ }
        })
        setProgressBar(nextProg)
    }
})

// ── DOM event bridge from iris-tracker.js (MAIN world) ───────────────────────
document.addEventListener('na-gaze', function (e) {
    onGazeUpdate(e.detail)
})
document.addEventListener('na-tracking-error', function (e) {
    var msg = e.detail && e.detail.error ? e.detail.error : 'unknown error'
    console.error('[NeuralAdaptive] Tracker error:', msg)
    if (/permission|notallowed/i.test(msg)) {
        chrome.storage.local.set({ enabled: false }, function () {
            if (chrome.runtime.lastError) { /* swallow */ }
        })
    }
})

// Start the always-on reading position tracker. It feeds both the progress bar
// (when the UI is on) and the "paragraphs read" metric in the session summary.
if (!progressLoopTimer) progressTick()

chrome.storage.local.get(['enabled', 'accuracyMode', 'na_flags', 'readingProgress', 'dyslexiaMode', 'textEnlargeEnabled'], function (data) {
    if (chrome.runtime.lastError) {
        console.warn('[NeuralAdaptive] storage unavailable in this frame:', chrome.runtime.lastError.message)
        return
    }
    applyAccuracyMode(data && data.accuracyMode ? data.accuracyMode : 'balanced')
    activeFlags = mergeFlags(data && data.na_flags)
    if (data && data.readingProgress) {
        startProgressBar()
    }
    setDyslexiaMode(!!(data && data.dyslexiaMode))
    setTextEnlarge(!data || data.textEnlargeEnabled !== false)
    var enabled = !!(data && data.enabled)
    if (!enabled) {
        console.log('[NeuralAdaptive] Disabled by default. Use popup to enable.')
        return
    }
    startNeuralAdaptive()
})
