// iris-tracker.js - NeuralAdaptive v3.1.0
// Runs in MAIN world, emits per-frame gaze + head quality metadata via CustomEvent('na-gaze').

;(function () {
    if (window.__naIrisTrackerActive) return
    window.__naIrisTrackerActive = true

    var LEFT_IRIS = [468, 469, 470, 471, 472]
    var RIGHT_IRIS = [473, 474, 475, 476, 477]
    var LEFT_EYE_OUTER = 33
    var RIGHT_EYE_OUTER = 263
    var NOSE_BRIDGE = 168

    var EYE_WEIGHT = 0.8
    var HEAD_WEIGHT = 0.2

    var videoEl = document.createElement('video')
    videoEl.autoplay = true
    videoEl.playsInline = true
    videoEl.muted = true
    videoEl.width = 320
    videoEl.height = 240
    videoEl.style.cssText = 'position:fixed;opacity:0;pointer-events:none;z-index:-1;width:1px;height:1px'
    document.body.appendChild(videoEl)

    var kalX = { x: 0.5, p: 1, q: 0.008, r: 0.4 }
    var kalY = { x: 0.5, p: 1, q: 0.008, r: 0.4 }
    var running = false
    var faceMesh = null
    var transform = null
    var calPoints = []
    var ipdBaseline = null
    var lastKnownScreen = { x: 0, y: 0 }

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(v, hi))
    }

    function kalUpdate(k, z) {
        k.p += k.q
        var g = k.p / (k.p + k.r)
        k.x += g * (z - k.x)
        k.p *= (1 - g)
        return k.x
    }

    function inv3x3(m) {
        var det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
        if (Math.abs(det) < 1e-12) return null
        var d = 1 / det
        return [
            (m[4] * m[8] - m[5] * m[7]) * d, (m[2] * m[7] - m[1] * m[8]) * d, (m[1] * m[5] - m[2] * m[4]) * d,
            (m[5] * m[6] - m[3] * m[8]) * d, (m[0] * m[8] - m[2] * m[6]) * d, (m[2] * m[3] - m[0] * m[5]) * d,
            (m[3] * m[7] - m[4] * m[6]) * d, (m[1] * m[6] - m[0] * m[7]) * d, (m[0] * m[4] - m[1] * m[3]) * d,
        ]
    }

    function mulMat3Vec(m, v) {
        return [
            m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
            m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
        ]
    }

    function computeAffine(pts) {
        var n = pts.length
        if (n < 4) return null
        var s_rx2 = 0, s_rxry = 0, s_rx = 0, s_ry2 = 0, s_ry = 0
        var s_rxsx = 0, s_rysx = 0, s_sx = 0, s_rxsy = 0, s_rysy = 0, s_sy = 0
        for (var i = 0; i < n; i++) {
            var rx = pts[i].rx
            var ry = pts[i].ry
            var sx = pts[i].sx
            var sy = pts[i].sy
            s_rx2 += rx * rx
            s_rxry += rx * ry
            s_rx += rx
            s_ry2 += ry * ry
            s_ry += ry
            s_rxsx += rx * sx
            s_rysx += ry * sx
            s_sx += sx
            s_rxsy += rx * sy
            s_rysy += ry * sy
            s_sy += sy
        }
        var ata = [s_rx2, s_rxry, s_rx, s_rxry, s_ry2, s_ry, s_rx, s_ry, n]
        var inv = inv3x3(ata)
        if (!inv) return null
        var cx = mulMat3Vec(inv, [s_rxsx, s_rysx, s_sx])
        var cy = mulMat3Vec(inv, [s_rxsy, s_rysy, s_sy])
        return { a: cx[0], b: cx[1], c: cx[2], d: cy[0], e: cy[1], f: cy[2] }
    }

    function applyTf(tf, rx, ry) {
        return { x: tf.a * rx + tf.b * ry + tf.c, y: tf.d * rx + tf.e * ry + tf.f }
    }

    function irisCenter(lm, idx) {
        var sx = 0
        var sy = 0
        for (var i = 0; i < idx.length; i++) {
            sx += lm[idx[i]].x
            sy += lm[idx[i]].y
        }
        return { x: sx / idx.length, y: sy / idx.length }
    }

    function computeRawGaze(lm) {
        var l = irisCenter(lm, LEFT_IRIS)
        var r = irisCenter(lm, RIGHT_IRIS)
        var irisX = (l.x + r.x) / 2
        var irisY = (l.y + r.y) / 2
        var anchor = lm[NOSE_BRIDGE]
        var relX = irisX - anchor.x
        var relY = irisY - anchor.y
        return {
            x: EYE_WEIGHT * relX + HEAD_WEIGHT * anchor.x,
            y: EYE_WEIGHT * relY + HEAD_WEIGHT * anchor.y,
        }
    }

    function computeHeadMeta(lm) {
        var le = lm[LEFT_EYE_OUTER]
        var re = lm[RIGHT_EYE_OUTER]
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

        var yaw = Math.atan2(nose.x - midX, eyeDist * 0.5) * 57.2958
        var pitch = Math.atan2(nose.y - midY, eyeDist * 0.5) * 57.2958
        var roll = Math.atan2(eyeDy, Math.max(eyeDx, 0.0001)) * 57.2958

        var yawN = clamp(Math.abs(yaw) / 35, 0, 1.5)
        var pitchN = clamp(Math.abs(pitch) / 25, 0, 1.5)
        var rollN = clamp(Math.abs(roll) / 20, 0, 1.5)
        var ipdN = clamp(Math.abs(ipdRatio - 1) / 0.15, 0, 1.5)
        var degradationScore = clamp(yawN * 0.35 + pitchN * 0.3 + rollN * 0.2 + ipdN * 0.15, 0, 1)

        return {
            yaw: yaw,
            pitch: pitch,
            roll: roll,
            ipdRatio: ipdRatio,
            degradationScore: degradationScore,
            isTrackerDegraded: degradationScore > 0.75,
        }
    }

    function emitGaze(detail) {
        document.dispatchEvent(new CustomEvent('na-gaze', { detail: detail }))
    }

    function emitNoMeasurement() {
        emitGaze({
            hasMeasurement: false,
            x: lastKnownScreen.x,
            y: lastKnownScreen.y,
            yaw: 0,
            pitch: 0,
            roll: 0,
            ipdRatio: 1,
            degradationScore: 1,
            isTrackerDegraded: true,
            ts: Date.now(),
        })
    }

    function onResults(results) {
        if (!running) return
        if (!results || !results.multiFaceLandmarks || !results.multiFaceLandmarks[0]) {
            emitNoMeasurement()
            return
        }

        var lm = results.multiFaceLandmarks[0]
        if (!lm || lm.length < 478) {
            emitNoMeasurement()
            return
        }

        var raw = computeRawGaze(lm)
        var smX = kalUpdate(kalX, raw.x)
        var smY = kalUpdate(kalY, raw.y)
        var meta = computeHeadMeta(lm)
        var sw = screen.width || window.innerWidth || 1920
        var sh = screen.height || window.innerHeight || 1080

        if (!transform) {
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

        var sc = applyTf(transform, smX, smY)
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
            emitNoMeasurement()
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
            video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
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
            videoEl.srcObject.getTracks().forEach(function (t) {
                t.stop()
            })
            videoEl.srcObject = null
        }
        videoEl.remove()
        window.__naIrisTrackerActive = false
    }

    document.addEventListener('na-cal-point', function (e) {
        var d = e.detail || {}
        calPoints.push({ rx: kalX.x, ry: kalY.x, sx: d.screenX, sy: d.screenY })
    })

    document.addEventListener('na-cal-complete', function () {
        var tf = computeAffine(calPoints)
        if (tf) {
            transform = tf
            document.dispatchEvent(new CustomEvent('na-cal-ready'))
        } else {
            document.dispatchEvent(new CustomEvent('na-cal-error', {
                detail: { reason: 'Affine calibration degenerate. Retry with wider spread samples.' },
            }))
        }
    })

    document.addEventListener('na-cal-reset', function () {
        calPoints = []
        transform = null
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
