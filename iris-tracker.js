// iris-tracker.js - NeuralAdaptive v3.2.0
// Runs in MAIN world, emits per-frame gaze + head quality metadata via CustomEvent('na-gaze').
//
// Changes from v3.1:
//   - Features are head-pose invariant: iris offset normalized by eye-socket width,
//     computed per-eye, plus yaw / pitch / ipdRatio as auxiliary regression features.
//   - 8-D feature vector with bias; ridge regression replaces the 6-param affine.
//   - Kalman filters reset on face-lost, with a cooldown that suppresses emission
//     for the first few frames after re-acquisition (prevents "look-away" wobble).
//   - Camera bumped to 640x480 for ~4x sub-pixel iris precision.

;(function () {
    if (window.__naIrisTrackerActive) return
    window.__naIrisTrackerActive = true

    // Landmark indices (FaceMesh refineLandmarks: true)
    var LEFT_IRIS  = [468, 469, 470, 471, 472]
    var RIGHT_IRIS = [473, 474, 475, 476, 477]
    var LEFT_OUTER  = 33     // lateral canthus, left iris group
    var LEFT_INNER  = 133    // medial canthus, left iris group
    var RIGHT_OUTER = 263    // lateral canthus, right iris group
    var RIGHT_INNER = 362    // medial canthus, right iris group
    var NOSE_BRIDGE = 168

    // Feature layout: [1 (bias), leftOffX, leftOffY, rightOffX, rightOffY, yawN, pitchN, ipdN]
    var FEATURE_DIM = 8
    var RIDGE_LAMBDA = 0.01
    var REACQ_COOLDOWN_FRAMES = 5

    // Element + camera plumbing
    var videoEl = document.createElement('video')
    videoEl.autoplay = true
    videoEl.playsInline = true
    videoEl.muted = true
    videoEl.width = 640
    videoEl.height = 480
    videoEl.style.cssText = 'position:fixed;opacity:0;pointer-events:none;z-index:-1;width:1px;height:1px'
    document.body.appendChild(videoEl)

    // State
    var running = false
    var faceMesh = null
    var model = null                    // { wx: [FEATURE_DIM], wy: [FEATURE_DIM] }
    var calPoints = []                  // { feat: [FEATURE_DIM], sx, sy }
    var ipdBaseline = null
    var lastKnownScreen = { x: 0, y: 0 }
    var lastFeature = null
    var lastMeta = null

    // Per-dim Kalman state (applied to each feature independently)
    var kal = new Array(FEATURE_DIM)
    for (var i = 0; i < FEATURE_DIM; i++) {
        // iris offsets want tighter smoothing (q small, r big); head pose features
        // are already slow, so they can use higher process noise.
        var isBias = i === 0
        var isIris = i >= 1 && i <= 4
        kal[i] = {
            x: 0,
            p: 1,
            q: isIris ? 0.006 : 0.03,
            r: isIris ? 0.40 : 0.08,
            initialized: isBias,
        }
        if (isBias) kal[i].x = 1
    }
    var faceLostCooldown = 0
    var hadFaceLastFrame = false

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(v, hi))
    }

    function kalUpdate(k, z) {
        if (!k.initialized) {
            k.x = z
            k.p = 1
            k.initialized = true
            return k.x
        }
        k.p += k.q
        var g = k.p / (k.p + k.r)
        k.x += g * (z - k.x)
        k.p *= (1 - g)
        return k.x
    }

    function resetKalman() {
        for (var i = 0; i < FEATURE_DIM; i++) {
            if (i === 0) continue    // bias is constant 1
            kal[i].initialized = false
            kal[i].x = 0
            kal[i].p = 1
        }
    }

    // ── Feature extraction ────────────────────────────────────────────────────

    function irisCenter(lm, idx) {
        var sx = 0, sy = 0
        for (var i = 0; i < idx.length; i++) {
            sx += lm[idx[i]].x
            sy += lm[idx[i]].y
        }
        return { x: sx / idx.length, y: sy / idx.length }
    }

    // Normalized iris offset = iris center projected into eye-corner frame.
    // x axis points along eye (outer → inner); y axis is perpendicular.
    // Both axes scaled by eye width so the result is invariant to head
    // translation and camera distance.
    function normalizedEyeOffset(lm, irisIdx, outerIdx, innerIdx) {
        var iris = irisCenter(lm, irisIdx)
        var outer = lm[outerIdx]
        var inner = lm[innerIdx]
        var midX = (outer.x + inner.x) * 0.5
        var midY = (outer.y + inner.y) * 0.5
        var dx = inner.x - outer.x
        var dy = inner.y - outer.y
        var w = Math.sqrt(dx * dx + dy * dy)
        if (w < 1e-5) return { x: 0, y: 0 }
        // Build local basis: ex = along eye, ey perpendicular (rotated +90°)
        var exX = dx / w,  exY = dy / w
        var eyX = -exY,    eyY = exX
        var ox = iris.x - midX
        var oy = iris.y - midY
        return {
            x: (ox * exX + oy * exY) / w,
            y: (ox * eyX + oy * eyY) / w,
        }
    }

    function computeHeadMeta(lm) {
        var le = lm[LEFT_OUTER]
        var re = lm[RIGHT_OUTER]
        var nose = lm[NOSE_BRIDGE]
        var midX = (le.x + re.x) / 2
        var midY = (le.y + re.y) / 2
        var eyeDx = re.x - le.x
        var eyeDy = re.y - le.y
        var eyeDist = Math.sqrt(eyeDx * eyeDx + eyeDy * eyeDy)
        eyeDist = Math.max(eyeDist, 0.0001)

        if (!ipdBaseline) ipdBaseline = eyeDist
        ipdBaseline = ipdBaseline * 0.98 + eyeDist * 0.02
        var ipdRatio = eyeDist / Math.max(ipdBaseline, 0.0001)

        var yaw   = Math.atan2(nose.x - midX, eyeDist * 0.5) * 57.2958
        var pitch = Math.atan2(nose.y - midY, eyeDist * 0.5) * 57.2958
        var roll  = Math.atan2(eyeDy,  Math.max(eyeDx, 0.0001)) * 57.2958

        var yawN   = clamp(Math.abs(yaw) / 35, 0, 1.5)
        var pitchN = clamp(Math.abs(pitch) / 25, 0, 1.5)
        var rollN  = clamp(Math.abs(roll) / 20, 0, 1.5)
        var ipdN   = clamp(Math.abs(ipdRatio - 1) / 0.15, 0, 1.5)
        var degradationScore = clamp(
            yawN * 0.35 + pitchN * 0.3 + rollN * 0.2 + ipdN * 0.15, 0, 1
        )

        return {
            yaw: yaw,
            pitch: pitch,
            roll: roll,
            ipdRatio: ipdRatio,
            degradationScore: degradationScore,
            isTrackerDegraded: degradationScore > 0.75,
        }
    }

    function computeFeature(lm, meta) {
        var left  = normalizedEyeOffset(lm, LEFT_IRIS,  LEFT_OUTER,  LEFT_INNER)
        var right = normalizedEyeOffset(lm, RIGHT_IRIS, RIGHT_OUTER, RIGHT_INNER)
        return [
            1,
            left.x,
            left.y,
            right.x,
            right.y,
            meta.yaw   / 30,     // ~[-1, 1]
            meta.pitch / 30,
            meta.ipdRatio - 1,   // ~[-0.2, 0.2]
        ]
    }

    // ── Ridge regression ──────────────────────────────────────────────────────
    //
    // Fits wx, wy in R^FEATURE_DIM minimizing
    //   sum_i (wx . feat_i - sx_i)^2  +  λ ||wx||^2
    // by solving (X^T X + λI) w = X^T y for each axis.

    function fitRidge(pts) {
        var n = pts.length
        var D = FEATURE_DIM
        if (n < D) return null

        var XtX = new Array(D * D)
        for (var i = 0; i < D * D; i++) XtX[i] = 0
        var Xtx = new Array(D), Xty = new Array(D)
        for (var i = 0; i < D; i++) { Xtx[i] = 0; Xty[i] = 0 }

        for (var k = 0; k < n; k++) {
            var f = pts[k].feat
            var sx = pts[k].sx
            var sy = pts[k].sy
            for (var a = 0; a < D; a++) {
                Xtx[a] += f[a] * sx
                Xty[a] += f[a] * sy
                for (var b = 0; b < D; b++) {
                    XtX[a * D + b] += f[a] * f[b]
                }
            }
        }
        // Add ridge. Don't penalize the bias column (index 0) — standard practice.
        for (var i = 1; i < D; i++) XtX[i * D + i] += RIDGE_LAMBDA * n

        var wx = solveLinear(XtX.slice(), Xtx.slice(), D)
        var wy = solveLinear(XtX.slice(), Xty.slice(), D)
        if (!wx || !wy) return null
        return { wx: wx, wy: wy }
    }

    // Gauss elimination with partial pivoting. A is row-major D×D, b is D,
    // modifies A and b in place and returns the solution.
    function solveLinear(A, b, D) {
        for (var col = 0; col < D; col++) {
            var pivotRow = col
            var pivotAbs = Math.abs(A[col * D + col])
            for (var row = col + 1; row < D; row++) {
                var v = Math.abs(A[row * D + col])
                if (v > pivotAbs) { pivotAbs = v; pivotRow = row }
            }
            if (pivotAbs < 1e-12) return null
            if (pivotRow !== col) {
                for (var j = 0; j < D; j++) {
                    var tmp = A[col * D + j]
                    A[col * D + j] = A[pivotRow * D + j]
                    A[pivotRow * D + j] = tmp
                }
                var tb = b[col]; b[col] = b[pivotRow]; b[pivotRow] = tb
            }
            var pivot = A[col * D + col]
            for (var row = col + 1; row < D; row++) {
                var factor = A[row * D + col] / pivot
                if (factor === 0) continue
                for (var j = col; j < D; j++) {
                    A[row * D + j] -= factor * A[col * D + j]
                }
                b[row] -= factor * b[col]
            }
        }
        var x = new Array(D)
        for (var row = D - 1; row >= 0; row--) {
            var s = b[row]
            for (var j = row + 1; j < D; j++) s -= A[row * D + j] * x[j]
            x[row] = s / A[row * D + row]
        }
        return x
    }

    function predictGaze(m, feat) {
        var x = 0, y = 0
        for (var i = 0; i < FEATURE_DIM; i++) {
            x += m.wx[i] * feat[i]
            y += m.wy[i] * feat[i]
        }
        return { x: x, y: y }
    }

    // ── Frame pipeline ────────────────────────────────────────────────────────

    function emitGaze(detail) {
        document.dispatchEvent(new CustomEvent('na-gaze', { detail: detail }))
    }

    function emitNoMeasurement(meta) {
        emitGaze({
            hasMeasurement: false,
            x: lastKnownScreen.x,
            y: lastKnownScreen.y,
            yaw: meta ? meta.yaw : 0,
            pitch: meta ? meta.pitch : 0,
            roll: meta ? meta.roll : 0,
            ipdRatio: meta ? meta.ipdRatio : 1,
            degradationScore: 1,
            isTrackerDegraded: true,
            ts: Date.now(),
        })
    }

    function onResults(results) {
        if (!running) return
        if (!results || !results.multiFaceLandmarks || !results.multiFaceLandmarks[0]) {
            if (hadFaceLastFrame) {
                resetKalman()
                faceLostCooldown = REACQ_COOLDOWN_FRAMES
            }
            hadFaceLastFrame = false
            emitNoMeasurement(null)
            return
        }

        var lm = results.multiFaceLandmarks[0]
        if (!lm || lm.length < 478) {
            if (hadFaceLastFrame) {
                resetKalman()
                faceLostCooldown = REACQ_COOLDOWN_FRAMES
            }
            hadFaceLastFrame = false
            emitNoMeasurement(null)
            return
        }

        hadFaceLastFrame = true

        var meta = computeHeadMeta(lm)
        var raw  = computeFeature(lm, meta)
        var smoothed = new Array(FEATURE_DIM)
        for (var i = 0; i < FEATURE_DIM; i++) {
            smoothed[i] = kalUpdate(kal[i], raw[i])
        }
        lastFeature = smoothed
        lastMeta = meta

        if (faceLostCooldown > 0) {
            faceLostCooldown--
            emitNoMeasurement(meta)
            return
        }

        if (!model) {
            emitGaze({
                hasMeasurement: false,
                x: lastKnownScreen.x,
                y: lastKnownScreen.y,
                yaw: meta.yaw,
                pitch: meta.pitch,
                roll: meta.roll,
                ipdRatio: meta.ipdRatio,
                degradationScore: meta.degradationScore,
                isTrackerDegraded: true,
                ts: Date.now(),
            })
            return
        }

        var sw = screen.width || window.innerWidth || 1920
        var sh = screen.height || window.innerHeight || 1080
        var sc = predictGaze(model, smoothed)
        var x = Math.round(clamp(sc.x, 0, sw))
        var y = Math.round(clamp(sc.y, 0, sh))
        lastKnownScreen.x = x
        lastKnownScreen.y = y

        emitGaze({
            hasMeasurement: true,
            x: x,
            y: y,
            yaw: meta.yaw,
            pitch: meta.pitch,
            roll: meta.roll,
            ipdRatio: meta.ipdRatio,
            degradationScore: meta.degradationScore,
            isTrackerDegraded: meta.isTrackerDegraded,
            ts: Date.now(),
        })
    }

    function frameLoop() {
        if (!running) return
        faceMesh.send({ image: videoEl }).catch(function () {
            emitNoMeasurement(null)
        }).finally(function () {
            requestAnimationFrame(frameLoop)
        })
    }

    async function start() {
        var baseUrl = window.__naFaceMeshBase
        if (!baseUrl) throw new Error('__naFaceMeshBase not set')

        faceMesh = new FaceMesh({
            locateFile: function (f) {
                return baseUrl + f
            },
        })
        faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5,
        })
        faceMesh.onResults(onResults)

        var stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width:  { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 30 },
                facingMode: 'user',
            },
        })
        videoEl.srcObject = stream
        await new Promise(function (resolve) {
            videoEl.onloadedmetadata = resolve
        })
        await videoEl.play()
        running = true
        frameLoop()
    }

    function stop() {
        running = false
        if (videoEl.srcObject) {
            videoEl.srcObject.getTracks().forEach(function (t) { t.stop() })
            videoEl.srcObject = null
        }
        videoEl.remove()
        window.__naIrisTrackerActive = false
    }

    // ── Calibration bridge ────────────────────────────────────────────────────

    document.addEventListener('na-cal-point', function (e) {
        if (!lastFeature) return
        var d = e.detail || {}
        calPoints.push({
            feat: lastFeature.slice(),
            sx: d.screenX,
            sy: d.screenY,
        })
    })

    document.addEventListener('na-cal-complete', function () {
        var fit = fitRidge(calPoints)
        if (fit) {
            model = fit
            document.dispatchEvent(new CustomEvent('na-cal-ready'))
        } else {
            document.dispatchEvent(new CustomEvent('na-cal-error', {
                detail: {
                    reason: 'Ridge fit failed — need at least ' + FEATURE_DIM +
                            ' samples with spread across screen and head pose.',
                },
            }))
        }
    })

    document.addEventListener('na-cal-reset', function () {
        calPoints = []
        model = null
    })

    document.addEventListener('na-stop-tracking', function () {
        stop()
    })

    start().catch(function (err) {
        document.dispatchEvent(new CustomEvent('na-tracking-error', {
            detail: { error: err && err.message ? err.message : String(err) },
        }))
    })
})()
