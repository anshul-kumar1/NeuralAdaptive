// offscreen.js - NeuralAdaptive v3.0.0
// MediaPipe FaceMesh iris tracking in offscreen document.
// Receives CAL_POINT messages, computes affine transform, sends GAZE_FRAME.

;(function () {
    'use strict'

    // Iris landmark indices (FaceMesh refineLandmarks: true, 478 total)
    // 468-472 = left iris boundary, 473-477 = right iris boundary
    var LEFT_IRIS  = [468, 469, 470, 471, 472]
    var RIGHT_IRIS = [473, 474, 475, 476, 477]

    var videoEl   = document.getElementById('na-video')
    var canvasEl  = document.getElementById('na-canvas')

    var faceMesh  = null
    var running   = false
    var calPoints = []          // [{rawX, rawY, screenX, screenY}]
    var transform = null        // {a,b,c,d,e,f} affine coeffs (or null)
    var kalX      = { x: 0.5, p: 1, q: 0.008, r: 0.4 }
    var kalY      = { x: 0.5, p: 1, q: 0.008, r: 0.4 }

    // ── Kalman filter (1-D) ───────────────────────────────────────────────────
    function kalUpdate(k, z) {
        k.p += k.q
        var gain = k.p / (k.p + k.r)
        k.x = k.x + gain * (z - k.x)
        k.p = (1 - gain) * k.p
        return k.x
    }

    // ── Iris geometry ─────────────────────────────────────────────────────────
    function irisCenter(lm, indices) {
        var sx = 0, sy = 0
        for (var i = 0; i < indices.length; i++) {
            sx += lm[indices[i]].x
            sy += lm[indices[i]].y
        }
        return { x: sx / indices.length, y: sy / indices.length }
    }

    function getGazeRaw(lm) {
        var L = irisCenter(lm, LEFT_IRIS)
        var R = irisCenter(lm, RIGHT_IRIS)
        return { x: (L.x + R.x) / 2, y: (L.y + R.y) / 2 }
    }

    // ── Affine transform math ─────────────────────────────────────────────────
    // Solve [a,b,c] and [d,e,f] from least-squares on calPoints.
    // screen_x = a*rx + b*ry + c
    // screen_y = d*rx + e*ry + f

    function computeAffineTransform(pts) {
        var n = pts.length
        if (n < 3) return null

        // AtA = A^T * A  (3x3, stored row-major as flat 9-element array)
        var s_rx2 = 0, s_rxry = 0, s_rx = 0
        var s_ry2 = 0, s_ry  = 0
        var s_rxsx = 0, s_rysx = 0, s_sx = 0
        var s_rxsy = 0, s_rysy = 0, s_sy = 0

        for (var i = 0; i < n; i++) {
            var rx = pts[i].rawX, ry = pts[i].rawY
            var sx = pts[i].screenX, sy = pts[i].screenY
            s_rx2  += rx * rx
            s_rxry += rx * ry
            s_rx   += rx
            s_ry2  += ry * ry
            s_ry   += ry
            s_rxsx += rx * sx
            s_rysx += ry * sx
            s_sx   += sx
            s_rxsy += rx * sy
            s_rysy += ry * sy
            s_sy   += sy
        }

        var AtA = [s_rx2, s_rxry, s_rx,
                   s_rxry, s_ry2, s_ry,
                   s_rx,   s_ry,  n]

        var inv = inv3x3(AtA)
        if (!inv) return null

        var Atbx = [s_rxsx, s_rysx, s_sx]
        var Atby = [s_rxsy, s_rysy, s_sy]

        var cx = mat3Vec(inv, Atbx)
        var cy = mat3Vec(inv, Atby)

        return { a: cx[0], b: cx[1], c: cx[2],
                 d: cy[0], e: cy[1], f: cy[2] }
    }

    function inv3x3(m) {
        var det = m[0] * (m[4]*m[8] - m[5]*m[7])
                - m[1] * (m[3]*m[8] - m[5]*m[6])
                + m[2] * (m[3]*m[7] - m[4]*m[6])
        if (Math.abs(det) < 1e-12) return null
        var id = 1 / det
        return [
            (m[4]*m[8] - m[5]*m[7]) * id,
            (m[2]*m[7] - m[1]*m[8]) * id,
            (m[1]*m[5] - m[2]*m[4]) * id,
            (m[5]*m[6] - m[3]*m[8]) * id,
            (m[0]*m[8] - m[2]*m[6]) * id,
            (m[2]*m[3] - m[0]*m[5]) * id,
            (m[3]*m[7] - m[4]*m[6]) * id,
            (m[1]*m[6] - m[0]*m[7]) * id,
            (m[0]*m[4] - m[1]*m[3]) * id
        ]
    }

    function mat3Vec(m, v) {
        return [
            m[0]*v[0] + m[1]*v[1] + m[2]*v[2],
            m[3]*v[0] + m[4]*v[1] + m[5]*v[2],
            m[6]*v[0] + m[7]*v[1] + m[8]*v[2]
        ]
    }

    function applyTransform(tf, rx, ry) {
        return {
            x: tf.a * rx + tf.b * ry + tf.c,
            y: tf.d * rx + tf.e * ry + tf.f
        }
    }

    // ── FaceMesh results handler ───────────────────────────────────────────────
    function onResults(results) {
        if (!running) return
        if (!results.multiFaceLandmarks || !results.multiFaceLandmarks[0]) return

        var lm = results.multiFaceLandmarks[0]
        if (lm.length < 478) return  // refineLandmarks not active yet

        var raw = getGazeRaw(lm)
        var smX = kalUpdate(kalX, raw.x)
        var smY = kalUpdate(kalY, raw.y)

        if (!transform) return

        var screen = applyTransform(transform, smX, smY)
        screen.x = Math.max(0, Math.min(window.screen.width  || 1920, screen.x))
        screen.y = Math.max(0, Math.min(window.screen.height || 1080, screen.y))

        chrome.runtime.sendMessage({
            type: 'GAZE_FRAME',
            x: Math.round(screen.x),
            y: Math.round(screen.y)
        }).catch(function () {})
    }

    // ── Camera + FaceMesh lifecycle ───────────────────────────────────────────
    async function initFaceMesh() {
        faceMesh = new FaceMesh({
            locateFile: function (file) {
                return chrome.runtime.getURL('mediapipe/face_mesh/' + file)
            }
        })
        faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        })
        faceMesh.onResults(onResults)
    }

    async function startCamera() {
        var stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }
        })
        videoEl.srcObject = stream
        await new Promise(function (resolve) {
            videoEl.onloadedmetadata = resolve
        })
        await videoEl.play()
    }

    function frameLoop() {
        if (!running) return
        faceMesh.send({ image: videoEl }).catch(function () {}).finally(function () {
            requestAnimationFrame(frameLoop)
        })
    }

    async function startTracking() {
        if (running) return
        await initFaceMesh()
        await startCamera()
        running = true
        frameLoop()
    }

    function stopTracking() {
        running = false
        if (videoEl.srcObject) {
            videoEl.srcObject.getTracks().forEach(function (t) { t.stop() })
            videoEl.srcObject = null
        }
        faceMesh = null
    }

    // ── Calibration helpers ───────────────────────────────────────────────────
    function sampleCurrentIris() {
        // Caller holds the latest smoothed Kalman state
        return { x: kalX.x, y: kalY.x }  // kalX.x = latest estimate
    }

    // ── Message handling ──────────────────────────────────────────────────────
    chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || !msg.type) return

        if (msg.type === 'START_FACEMESH') {
            startTracking().catch(function (err) {
                chrome.runtime.sendMessage({
                    type: 'TRACKING_ERROR',
                    error: err && err.message ? err.message : String(err)
                }).catch(function () {})
            })
            return
        }

        if (msg.type === 'STOP_FACEMESH') {
            stopTracking()
            return
        }

        if (msg.type === 'CAL_POINT') {
            // Sample the current smoothed iris position and pair with screen coords
            var iris = { x: kalX.x, y: kalY.x }
            calPoints.push({
                rawX:    iris.x,
                rawY:    iris.y,
                screenX: msg.screenX,
                screenY: msg.screenY
            })
            return
        }

        if (msg.type === 'CAL_COMPLETE') {
            var tf = computeAffineTransform(calPoints)
            if (tf) {
                transform = tf
                chrome.runtime.sendMessage({ type: 'CAL_READY' }).catch(function () {})
            } else {
                chrome.runtime.sendMessage({
                    type: 'TRACKING_ERROR',
                    error: 'Affine transform degenerate — not enough calibration spread'
                }).catch(function () {})
            }
            return
        }

        if (msg.type === 'CAL_RESET') {
            calPoints = []
            transform = null
            return
        }
    })

})()
