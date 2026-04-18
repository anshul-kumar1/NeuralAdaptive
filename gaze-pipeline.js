/**
 * gaze-pipeline.js â€” NeuralAdaptive Stability Layer v1.0
 *
 * Pipeline order (per frame):
 *   WebGazer raw (x,y) | null
 *       â†’ [D] KalmanGaze          â€” predictive smoothing, blink recovery
 *       â†’ [A] GazeSnap            â€” DOM magnetism, element binding
 *       â†’ [B] ReadingPattern      â€” confidence gate, prevents false triggers
 *       â†’ [C] SilentRecal         â€” passive drift correction via user clicks
 *       â†’ GazePipeline.emit()     â€” delivers final state to the application
 */

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FEATURE D â€” Kalman Gaze Smoother
// 2-state (position + velocity) scalar Kalman filter, run independently per
// axis.  Handles missing frames (blinks, pupil-loss) via predict-only mode.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * KalmanAxis  â€” 1-D position+velocity filter.
 *
 * State vector:   [pos, vel]
 * Transition:     F = [[1, dt], [0, 1]]
 * Observation:    H = [1, 0]
 * Process noise:  Q = q * [[dtÂ³/3, dtÂ²/2], [dtÂ²/2, dt]]
 * Meas noise:     R = r  (scalar)
 *
 * Tuning guide:
 *   processNoise HIGH  â†’ trusts measurements more, faster response to saccades
 *   processNoise LOW   â†’ trusts model more, smoother fixations
 *   measurementNoise HIGH â†’ more smoothing / more lag
 *   measurementNoise LOW  â†’ less smoothing / noisier output
 */
function KalmanAxis(opts) {
    opts = opts || {}
    this.q  = opts.processNoise     !== undefined ? opts.processNoise     : 8.0
    this.r  = opts.measurementNoise !== undefined ? opts.measurementNoise : 40.0
    // State
    this.pos = 0
    this.vel = 0
    // Error covariance  P = [[pp, pv], [vp, vv]]
    this.pp = 1000; this.pv = 0
    this.vp = 0;    this.vv = 100
    this.lastT = null
}

KalmanAxis.prototype.predict = function (nowMs) {
    var dt = (this.lastT !== null) ? (nowMs - this.lastT) / 1000 : 0.033
    this.lastT = nowMs
    // Clamp dt to [1 ms, 200 ms] â€” guards against tab backgrounding
    dt = Math.max(0.001, Math.min(dt, 0.2))

    // State propagation:  x = F * x
    this.pos += this.vel * dt

    // Covariance propagation:  P = F*P*F' + Q
    var pp = this.pp + dt * (this.pv + this.vp) + dt * dt * this.vv + this.q * dt * dt * dt / 3
    var pv = this.pv + dt * this.vv              + this.q * dt * dt / 2
    var vp = this.vp + dt * this.vv              + this.q * dt * dt / 2
    var vv = this.vv                             + this.q * dt
    this.pp = pp; this.pv = pv; this.vp = vp; this.vv = vv
}

KalmanAxis.prototype.update = function (measurement) {
    // Innovation covariance  S = H*P*H' + R  â†’  S = P[0][0] + R
    var S  = this.pp + this.r
    if (S === 0) return
    // Kalman gain  K = P*H'/S  â†’  K = [pp, vp] / S
    var kp = this.pp / S
    var kv = this.vp / S
    // State update
    var innov = measurement - this.pos
    this.pos += kp * innov
    this.vel += kv * innov
    // Covariance update  P = (I - K*H)*P  (Joseph form for numerical stability)
    var pp = (1 - kp) * this.pp
    var pv = (1 - kp) * this.pv
    var vp = this.vp - kv * this.pp
    var vv = this.vv - kv * this.pv
    this.pp = pp; this.pv = pv; this.vp = vp; this.vv = vv
}

KalmanAxis.prototype.reset = function () {
    this.pp = 1000; this.pv = 0; this.vp = 0; this.vv = 100
    this.lastT = null
    this.pos = 0; this.vel = 0
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

var KalmanGaze = {
    _x: null,
    _y: null,

    /**
     * Tuning presets.
     * 'responsive' â€” prioritises tracking saccades accurately.
     * 'stable'     â€” prioritises smooth fixations, more lag on fast moves.
     */
    PRESETS: {
        responsive: { processNoise: 15, measurementNoise: 25 },
        stable:     { processNoise: 4,  measurementNoise: 60 },
        balanced:   { processNoise: 8,  measurementNoise: 40 },
    },

    init: function (preset) {
        var opts = this.PRESETS[preset] || this.PRESETS.balanced
        this._x = new KalmanAxis(opts)
        this._y = new KalmanAxis(opts)
    },

    /**
     * process(rawX, rawY)
     * Pass null for both when WebGazer returns null (blink / tracking loss).
     * The filter predicts forward using the last known velocity instead of
     * returning zeros â€” the cursor drifts gracefully rather than jumping.
     *
     * @returns {{ x, y, vx, vy }}
     */
    process: function (rawX, rawY) {
        if (!this._x) this.init()
        var now = Date.now()
        this._x.predict(now)
        this._y.predict(now)
        if (rawX !== null && rawY !== null) {
            this._x.update(rawX)
            this._y.update(rawY)
        }
        // On null frame, covariance grows (filter becomes less confident),
        // which is the correct Bayesian behaviour.
        return { x: this._x.pos, y: this._y.pos, vx: this._x.vel, vy: this._y.vel }
    },

    reset: function () {
        if (this._x) this._x.reset()
        if (this._y) this._y.reset()
    }
}


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FEATURE A â€” Gaze Snap (DOM Magnetism)
// Snaps the smoothed gaze to the nearest text element when the gaze falls
// in gutters or margins.  Eliminates jittery false-negatives at line edges.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

var GazeSnap = (function () {

    // â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var MAGNETIC_RADIUS = 80       // px â€” snapping distance around elements
    var SNAP_SELECTORS  = 'p, li, h1, h2, h3, h4, blockquote, td, th, [role="text"]'
    var CACHE_TTL_MS    = 400      // re-query DOM at most every 400 ms
    var MAX_ELEMENTS    = 120      // cap to avoid O(n) on huge pages

    // â”€â”€ Internal state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var cachedEntries  = []
    var lastCacheTime  = 0

    // â”€â”€ Geometry helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /**
     * Shortest distance from point (px, py) to an axis-aligned bounding box.
     * Returns 0 if the point is inside the box.
     *
     *   dx = max(left - px, 0, px - right)   (0 if inside horizontally)
     *   dy = max(top  - py, 0, py - bottom)  (0 if inside vertically)
     *   distance = âˆš(dxÂ² + dyÂ²)
     */
    function distToRect(px, py, r) {
        var dx = Math.max(r.left - px, 0, px - r.right)
        var dy = Math.max(r.top  - py, 0, py - r.bottom)
        return Math.sqrt(dx * dx + dy * dy)
    }

    /**
     * Nearest point ON (or inside) the rectangle â€” used to compute the
     * snapped coordinate when the gaze is within magnetic radius but outside.
     *
     *   cx = clamp(px, left, right)
     *   cy = clamp(py, top, bottom)
     */
    function clampToRect(px, py, r) {
        return {
            x: Math.max(r.left, Math.min(px, r.right)),
            y: Math.max(r.top,  Math.min(py, r.bottom))
        }
    }

    // â”€â”€ DOM rect cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function refreshCache() {
        var now = Date.now()
        if (now - lastCacheTime < CACHE_TTL_MS) return
        lastCacheTime = now
        cachedEntries = []
        var els = document.querySelectorAll(SNAP_SELECTORS)
        for (var i = 0; i < els.length && cachedEntries.length < MAX_ELEMENTS; i++) {
            var el = els[i]
            var r  = el.getBoundingClientRect()
            if (r.width < 20 || r.height < 4)   continue  // degenerate element
            if (r.bottom < -50 || r.top > window.innerHeight + 50) continue  // offscreen
            cachedEntries.push({ el: el, r: r })
        }
    }

    // â”€â”€ Public â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    return {
        magneticRadius: MAGNETIC_RADIUS,

        /**
         * snap(gx, gy) â†’ { x, y, element, snapped, dist }
         *
         * snapped = false â†’ gaze was already inside an element  (no override)
         * snapped = true  â†’ gaze was in the margin; coordinates overridden
         * element = null  â†’ too far from any snappable element
         */
        snap: function (gx, gy) {
            refreshCache()

            var bestDist  = Infinity
            var bestEntry = null

            for (var i = 0; i < cachedEntries.length; i++) {
                var entry = cachedEntries[i]
                var dist  = distToRect(gx, gy, entry.r)
                if (dist < bestDist) {
                    bestDist  = dist
                    bestEntry = entry
                }
            }

            if (!bestEntry) {
                return { x: gx, y: gy, element: null, snapped: false, dist: Infinity }
            }

            // Point is inside the bounding box
            if (bestDist === 0) {
                return { x: gx, y: gy, element: bestEntry.el, snapped: false, dist: 0 }
            }

            // In magnetic zone â†’ snap coordinates onto the element's edge
            if (bestDist <= this.magneticRadius) {
                var c = clampToRect(gx, gy, bestEntry.r)
                return { x: c.x, y: c.y, element: bestEntry.el, snapped: true, dist: bestDist }
            }

            // Outside magnetic zone â€” return raw, no element binding
            return { x: gx, y: gy, element: null, snapped: false, dist: bestDist }
        },

        /** Call after scroll events to force a DOM re-query on the next frame. */
        invalidateCache: function () { lastCacheTime = 0 }
    }
}())


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FEATURE B â€” Reading Pattern Recognition
// Analyses a rolling window of gaze points and emits a 0â€“1 confidence score.
// Interventions are gated behind a threshold to prevent false triggers from
// static staring, zoning-out, or accidental fixations.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

var ReadingPattern = (function () {

    // â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var WINDOW_SIZE         = 32     // number of frames to analyse
    var MIN_RIGHTWARD_VX    = 60     // px/s â€” smallest saccade counted as reading progression
    var RETURN_SWEEP_VX     = -350   // px/s â€” faster-than-this leftward = return sweep
    var LINE_ADV_MIN_PX     = 8      // minimum Y-advance to count as line change
    var LINE_ADV_MAX_PX     = 80     // maximum Y-advance (too large = not a line)
    var ZONEOUT_DISP_PX     = 30     // total X displacement in window below this = staring
    var SCORE_ALPHA         = 0.25   // IIR smoothing on the raw score

    // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var history      = []   // [{x, y, t, vx, vy}]
    var smoothScore  = 0

    function push(x, y, t) {
        if (history.length > 0) {
            var prev = history[history.length - 1]
            var dt = (t - prev.t) / 1000
            if (dt < 0.001) return  // duplicate timestamp
            history.push({ x: x, y: y, t: t, vx: (x - prev.x) / dt, vy: (y - prev.y) / dt })
        } else {
            history.push({ x: x, y: y, t: t, vx: 0, vy: 0 })
        }
        if (history.length > WINDOW_SIZE) history.shift()
    }

    function rawScore() {
        var n = history.length
        if (n < 8) return 0

        // â”€â”€ Component 1: Horizontal progression ratio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Counts steps where gaze moves rightward fast enough to be a reading
        // saccade, but not so fast as to be a return sweep.
        var progressCount = 0
        var totalValid    = 0
        for (var i = 1; i < n; i++) {
            var h = history[i]
            var absVx = Math.abs(h.vx)
            if (absVx > 1200) continue  // skip extreme noise spikes
            totalValid++
            if (h.vx >= MIN_RIGHTWARD_VX) progressCount++
        }
        var progressRatio = totalValid > 0 ? progressCount / totalValid : 0

        // â”€â”€ Component 2: Return sweep + line advance pattern â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // A real reading sweep is: fast-left vx < RETURN_SWEEP_VX, then a
        // small downward Y step (line advance) shortly after.
        var sweepCount = 0
        for (var j = 1; j < n - 1; j++) {
            if (history[j].vx < RETURN_SWEEP_VX) {
                var dy = history[j + 1].y - history[j].y
                if (dy >= LINE_ADV_MIN_PX && dy <= LINE_ADV_MAX_PX) sweepCount++
            }
        }
        var sweepScore = Math.min(sweepCount / 1.5, 1.0)  // 1.5 sweeps â†’ 1.0

        // â”€â”€ Component 3: Penalise static staring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // If total X displacement across the window is tiny, the user is not
        // reading â€” they're zoning out.
        var xFirst = history[0].x
        var xLast  = history[n - 1].x
        var totalXDisp = xLast - xFirst
        var notStaring = totalXDisp > ZONEOUT_DISP_PX ? 1.0
                       : Math.max(0, totalXDisp / ZONEOUT_DISP_PX)

        // â”€â”€ Component 4: Y-axis stability â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // During reading the Y position should be relatively stable between
        // return sweeps.  High Y variance = scrolling/looking around.
        var ys   = history.map(function (h) { return h.y })
        var mY   = ys.reduce(function (a, b) { return a + b }, 0) / ys.length
        var varY = ys.reduce(function (a, b) { return a + Math.pow(b - mY, 2) }, 0) / ys.length
        var yStability = Math.max(0, 1 - Math.sqrt(varY) / 100)

        // â”€â”€ Composite (weights tuned to favour genuine reading patterns) â”€â”€
        return (progressRatio * 0.40) +
               (sweepScore    * 0.25) +
               (notStaring    * 0.20) +
               (yStability    * 0.15)
    }

    // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    return {
        /** 0.0â€“1.0 threshold above which we declare "actively reading". */
        READING_THRESHOLD: 0.42,

        /**
         * update(x, y) â€” call once per filtered gaze frame.
         * Returns the current IIR-smoothed reading confidence (0â€“1).
         */
        update: function (x, y) {
            push(x, y, Date.now())
            var raw  = rawScore()
            smoothScore = smoothScore * (1 - SCORE_ALPHA) + raw * SCORE_ALPHA
            return parseFloat(Math.min(Math.max(smoothScore, 0), 1).toFixed(3))
        },

        getScore:  function () { return parseFloat(smoothScore.toFixed(3)) },
        isReading: function () { return smoothScore >= this.READING_THRESHOLD },
        reset:     function () { history = []; smoothScore = 0 }
    }
}())


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FEATURE C â€” Silent Recalibration
// Intercepts user mouse interactions to passively feed high-certainty ground-
// truth points into WebGazer's regression model, correcting drift silently.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

var SilentRecal = (function () {

    // â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var RATE_LIMIT_MS        = 3500  // minimum gap between recal points
    var OUTLIER_THRESHOLD_PX = 190   // max gazeâ†”cursor distance to accept
    var MAX_PER_MINUTE       = 12    // prevents model overfitting on dense clicks
    var FEED_DUPLICATES      = 2     // feed each accepted point N times (regression weight)

    // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    var active            = false
    var lastFeedMs        = 0
    var samplesThisMinute = 0
    var minuteStart       = 0
    var getLatestGaze     = null    // injected: () => {x, y} | null
    var feedCount         = 0      // lifetime accepted samples (for telemetry)

    function tryFeed(cursorX, cursorY) {
        if (!active || !getLatestGaze || !window.webgazer) return

        var now = Date.now()

        // â”€â”€ Rate gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (now - lastFeedMs < RATE_LIMIT_MS) return

        // â”€â”€ Per-minute cap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (now - minuteStart > 60000) { minuteStart = now; samplesThisMinute = 0 }
        if (samplesThisMinute >= MAX_PER_MINUTE) return

        // â”€â”€ Outlier rejection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Only feed when gaze is already close to cursor â€” meaning the model is
        // roughly correct and this click will reinforce rather than corrupt it.
        var gaze = getLatestGaze()
        if (!gaze) return
        var dx   = gaze.x - cursorX
        var dy   = gaze.y - cursorY
        if (Math.sqrt(dx * dx + dy * dy) > OUTLIER_THRESHOLD_PX) return

        // â”€â”€ Feed into regression model â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        try {
            for (var k = 0; k < FEED_DUPLICATES; k++) {
                window.webgazer.recordScreenPosition(cursorX, cursorY, 'click')
            }
            lastFeedMs = now
            samplesThisMinute++
            feedCount++
        } catch (e) { /* webgazer not ready */ }
    }

    function onMousedown(e) { tryFeed(e.clientX, e.clientY) }

    // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    return {
        outlierThreshold: OUTLIER_THRESHOLD_PX,
        rateLimit:        RATE_LIMIT_MS,

        /**
         * start(gazeProvider)
         * gazeProvider â€” zero-arg function that returns the current smoothed
         * gaze point {x, y}, or null if unavailable.
         */
        start: function (gazeProvider) {
            if (active) return
            getLatestGaze = gazeProvider
            minuteStart   = Date.now()
            active        = true
            document.addEventListener('mousedown', onMousedown, { passive: true })
        },

        stop: function () {
            if (!active) return
            active = false
            document.removeEventListener('mousedown', onMousedown)
            getLatestGaze = null
        },

        /** Manual feed for programmatic interactions (e.g. keyboard shortcuts). */
        feedPoint: function (x, y) { tryFeed(x, y) },

        getFeedCount: function () { return feedCount },
        reset:        function () { feedCount = 0; lastFeedMs = 0; samplesThisMinute = 0 }
    }
}())


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// INTEGRATION â€” GazePipeline
// Wires all four modules together and exposes a single API surface to the
// application.  Replace direct webgazer.setGazeListener() calls with
// GazePipeline.start() / GazePipeline.stop().
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

var GazePipeline = (function () {

    var _listeners   = []
    var _lastSmooth  = null    // latest Kalman output (for SilentRecal)
    var _bound       = false

    function gazeProvider() { return _lastSmooth }

    function onRawGaze(data) {
        // â”€â”€ Stage 0: null-guard (blink / tracking loss) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        var rawX = data ? data.x : null
        var rawY = data ? data.y : null
        var poseMeta = {
            headWeight: 0,
            isTrackerDegraded: false,
            degradationScore: 0
        }

        // â”€â”€ Stage 0b: Head pose compensation (depth + yaw/pitch/roll + fusion)
        // HeadPoseLayer is a side-channel module loaded by head-pose-layer.js.
        // It is a no-op pass-through when not ready (no baseline yet) or absent.
        if (rawX !== null && rawY !== null &&
            typeof HeadPoseLayer !== 'undefined' && HeadPoseLayer.isReady()) {
            var compensated = HeadPoseLayer.compensate(rawX, rawY)
            rawX = compensated.x
            rawY = compensated.y
            poseMeta.headWeight = compensated.headWeight || 0
            poseMeta.isTrackerDegraded = !!compensated.isTrackerDegraded
            poseMeta.degradationScore = compensated.degradationScore || 0
        }

        // â”€â”€ Stage 1 [D]: Kalman filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        var filtered = KalmanGaze.process(rawX, rawY)
        _lastSmooth  = filtered

        // â”€â”€ Stage 2 [A]: Gaze snap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        var snapped = GazeSnap.snap(filtered.x, filtered.y)

        // â”€â”€ Stage 3 [B]: Reading pattern score â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        var score    = ReadingPattern.update(snapped.x, snapped.y)
        var reading  = ReadingPattern.isReading()

        // â”€â”€ Emit to application â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        var state = {
            // Filtered, cursor-friendly coordinates (always valid â€” never null)
            x: filtered.x,
            y: filtered.y,
            // Velocity estimates (useful for saccade detection in app layer)
            vx: filtered.vx,
            vy: filtered.vy,
            // DOM-magnetised coordinates + element reference
            snappedX:   snapped.x,
            snappedY:   snapped.y,
            element:    snapped.element,
            wasSnapped: snapped.snapped,
            // Reading intelligence
            readingScore:   score,
            isReading:      reading,
            // Whether this frame had a real WebGazer measurement or was predicted
            hasMeasurement: rawX !== null,
            headWeight: poseMeta.headWeight,
            isTrackerDegraded: poseMeta.isTrackerDegraded,
            degradationScore: poseMeta.degradationScore
        }

        for (var i = 0; i < _listeners.length; i++) {
            try { _listeners[i](state) } catch (e) {}
        }
    }

    return {
        /**
         * start()
         * Call after webgazer.begin() resolves.
         * Replaces whatever gaze listener is currently registered.
         */
        start: function () {
            if (_bound) return
            KalmanGaze.init('balanced')
            ReadingPattern.reset()
            GazeSnap.invalidateCache()
            SilentRecal.start(gazeProvider)
            window.webgazer.setGazeListener(onRawGaze)
            _bound = true

            // Invalidate DOM cache on scroll (element positions change)
            window.addEventListener('scroll', GazeSnap.invalidateCache.bind(GazeSnap), { passive: true })
        },

        stop: function () {
            if (!_bound) return
            _bound = false
            try { window.webgazer.clearGazeListener() } catch (e) {}
            SilentRecal.stop()
            KalmanGaze.reset()
            ReadingPattern.reset()
            GazeSnap.invalidateCache()
            _listeners = []
            window.removeEventListener('scroll', GazeSnap.invalidateCache.bind(GazeSnap))
        },

        /**
         * addListener(fn)
         * fn receives a GazeState object every frame.
         * Multiple listeners can be registered independently.
         */
        addListener: function (fn) {
            if (typeof fn === 'function' && _listeners.indexOf(fn) === -1) {
                _listeners.push(fn)
            }
        },

        removeListener: function (fn) {
            var i = _listeners.indexOf(fn)
            if (i !== -1) _listeners.splice(i, 1)
        },

        /** Runtime tuning â€” takes effect on the next frame. */
        setKalmanPreset: function (preset) {
            KalmanGaze.init(preset)
        },

        setMagneticRadius: function (px) {
            GazeSnap.magneticRadius = px
        },

        setReadingThreshold: function (t) {
            ReadingPattern.READING_THRESHOLD = t
        },

        /** Expose sub-modules for direct access when needed. */
        kalman:         KalmanGaze,
        snap:           GazeSnap,
        readingPattern: ReadingPattern,
        silentRecal:    SilentRecal,
    }
}())

