// content.js — NeuralAdaptive v2.3.0
// Stability layer: GazeSmoother + DwellGrid + Princeton calibration wizard.

console.log('[NeuralAdaptive v2.3.0] content.js loaded')

var CONFIG = {
    SEND_INTERVAL_MS:              1000,
    FIXATION_THRESHOLD_PX:         60,
    FIXATION_STRESS_DURATION_MS:   1500,
    SACCADE_HIGH_VELOCITY:         500,
    SAMPLE_BUFFER_SIZE:            90,
    REGRESSION_WINDOW:             20,
    CALIBRATION_VERSION:           'princeton_v1',
    CALIBRATION_CLICKS_PER_POINT:  5,
    VALIDATION_THRESHOLD_PX:       160,
    MAX_FORCED_RECALIBRATION_ATTEMPTS: 1,
    GAZE_SMOOTHING_FACTOR:         0.15,   // low-pass α — lower = smoother/slower
    DWELL_THRESHOLD_MS:            1500,   // ms in same grid sector to fire dwell event
    GRID_COLS:                     3,
    GRID_ROWS:                     4,
}

var ACCURACY_MODE = {
    balanced: {
        alpha:                0.15,   // overridden by GazeSmoother; kept for legacy paths
        outlierThresholdPx:   220,
        validationThresholdPx: 160,
    },
    precision: {
        alpha:                0.10,
        outlierThresholdPx:   160,
        validationThresholdPx: 100,
    },
}

// 5-point Princeton calibration wizard (TL → TR → Center → BL → BR)
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
var smoothedPoint = null       // legacy alias — kept so existing call-sites compile
var calibrationPromise = null
var webgazerInitialized = false

// ─── GazeSmoother ─────────────────────────────────────────────────────────────
// Single-pole IIR low-pass filter.  α = 0.15 means each new frame contributes
// 15% and the history 85%, yielding ~6-frame smoothing at 30 fps.
var GazeSmoother = {
    x:      null,
    y:      null,

    /** Feed raw WebGazer coordinates; returns smoothed {x, y}. */
    update: function (rawX, rawY) {
        if (this.x === null) {
            this.x = rawX
            this.y = rawY
            return { x: rawX, y: rawY }
        }
        var a = CONFIG.GAZE_SMOOTHING_FACTOR
        this.x = this.x * (1 - a) + rawX * a
        this.y = this.y * (1 - a) + rawY * a
        return { x: this.x, y: this.y }
    },

    reset: function () { this.x = null; this.y = null }
}

// ─── GazeCursor ───────────────────────────────────────────────────────────────
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

// ─── DwellGrid ────────────────────────────────────────────────────────────────
// Divides the viewport into GRID_COLS × GRID_ROWS sectors.
// Fires onDwell(sectorId, x, y) only when the smoothed gaze stays inside the
// same sector for DWELL_THRESHOLD_MS — eliminating spurious fixation signals.
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
            // Left the previous sector — cancel any pending dwell
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
     * Maps (x, y) → integer sector ID  0 … (COLS × ROWS − 1),
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

function injectStyles() {
    if (document.getElementById('na-styles')) return
    var style = document.createElement('style')
    style.id = 'na-styles'
    style.textContent = [
        // Gaze cursor — Princeton orange ring, centre-anchored
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
    ].join('\n')
    document.head.appendChild(style)
}

function ensureWebGazerLoaded() {
    return new Promise(function (resolve, reject) {
        if (window.webgazer && typeof window.webgazer.begin === 'function') {
            resolve()
            return
        }

        // Ask background to inject webgazer.js via chrome.scripting (isolated world,
        // so chrome.runtime.getURL is available for local model loading).
        chrome.runtime.sendMessage({ type: 'INJECT_WEBGAZER' }, function (response) {
            if (chrome.runtime.lastError) {
                reject(new Error('webgazer inject error: ' + chrome.runtime.lastError.message))
                return
            }
            if (!response || !response.ok) {
                reject(new Error('webgazer inject failed: ' + (response && response.error || 'unknown')))
                return
            }
            // chrome.scripting.executeScript resolves only after the script finishes,
            // so window.webgazer should be set immediately. Poll briefly as safety net.
            var attempts = 0
            var timer = setInterval(function () {
                attempts++
                if (window.webgazer && typeof window.webgazer.begin === 'function') {
                    clearInterval(timer)
                    resolve()
                } else if (attempts >= 30) {
                    clearInterval(timer)
                    reject(new Error('webgazer.js did not initialize after injection'))
                }
            }, 100)
        })
    })
}

async function getCurrentPredictionSafe() {
    try {
        if (!window.webgazer || typeof window.webgazer.getCurrentPrediction !== 'function') return null
        return await window.webgazer.getCurrentPrediction()
    } catch (e) {
        return null
    }
}

async function collectCalibrationSample(targetX, targetY, pointState) {
    var mode = getModeConfig()
    var prediction = await getCurrentPredictionSafe()

    if (prediction && pointState.accepted >= 1) {
        var dx = prediction.x - targetX
        var dy = prediction.y - targetY
        var error = Math.sqrt(dx * dx + dy * dy)
        if (error > mode.outlierThresholdPx) {
            return { accepted: false, reason: 'outlier', errorPx: Math.round(error) }
        }
    }

    // Add multiple click-type samples to stabilize regression fit.
    window.webgazer.recordScreenPosition(targetX, targetY, 'click')
    window.webgazer.recordScreenPosition(targetX, targetY, 'click')
    pointState.accepted += 1
    return { accepted: true, reason: 'ok' }
}

// ─── Princeton Calibration Wizard ─────────────────────────────────────────────
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

    // ── Header bar ──────────────────────────────────────────────────────────
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

    // ── Progress pip row ─────────────────────────────────────────────────────
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

    // ── Center instructional card ────────────────────────────────────────────
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

    // ── Status bar ───────────────────────────────────────────────────────────
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
    status.textContent = 'Preparing…'
    overlay.appendChild(status)

    document.body.appendChild(overlay)
    return { overlay: overlay, status: status, pips: pips, stepEl: header.querySelector('#na-cal-step') }
}

/**
 * Run the full 5-point Princeton calibration wizard.
 * Returns a validation result object { medianPx, meanPx, samples }.
 */
async function runPrincetonCalibration() {
    var ui = createPrincetonOverlay()

    for (var i = 0; i < CAL_POINTS_5.length; i++) {
        var pt      = CAL_POINTS_5[i]
        var vp      = toViewportPoint(pt)
        var clicks  = CONFIG.CALIBRATION_CLICKS_PER_POINT
        var accepted = 0

        // Update header step counter
        if (ui.stepEl) ui.stepEl.textContent = 'Point ' + (i + 1) + ' of ' + CAL_POINTS_5.length

        // Mark current pip orange
        ui.pips.forEach(function (p, idx) {
            if (idx < i)      { p.style.background = '#3fb950'; p.style.borderColor = '#3fb950' }
            else if (idx === i){ p.style.background = '#E77500'; p.style.borderColor = '#E77500' }
            else              { p.style.background = '#333';    p.style.borderColor = '#555'    }
        })

        ui.status.textContent = pt.label + ' — click the dot ' + clicks + ' times while staring at it'

        // Place the dot
        var dot = document.createElement('button')
        dot.type = 'button'
        dot.className = 'na-cal-dot'
        dot.textContent = String(clicks)
        dot.style.left = pt.x + '%'
        dot.style.top  = pt.y + '%'
        ui.overlay.appendChild(dot)

        await new Promise(function (resolvePt) {
            dot.addEventListener('click', async function onClick() {
                var mode     = getModeConfig()
                var pred     = accepted >= 1 ? await getCurrentPredictionSafe() : null

                // Outlier guard: skip if prediction is way off (only after first click)
                if (pred) {
                    var ex = pred.x - vp.x, ey = pred.y - vp.y
                    if (Math.sqrt(ex * ex + ey * ey) > mode.outlierThresholdPx) {
                        ui.status.textContent = 'Outlier detected — keep your gaze on the dot and try again'
                        dot.style.background = '#f85149'
                        setTimeout(function () { dot.style.background = '#E77500' }, 400)
                        return
                    }
                }

                // Feed two samples per click for regression stability
                window.webgazer.recordScreenPosition(vp.x, vp.y, 'click')
                window.webgazer.recordScreenPosition(vp.x, vp.y, 'click')
                accepted++

                var remaining = clicks - accepted
                dot.textContent = remaining > 0 ? String(remaining) : '✓'
                ui.status.textContent = pt.label + ' — ' + accepted + ' / ' + clicks + ' clicks'

                if (accepted >= clicks) {
                    dot.classList.add('na-cal-dot--done')
                    dot.removeEventListener('click', onClick)
                    await new Promise(function (r) { setTimeout(r, 250) })
                    dot.remove()
                    resolvePt()
                }
            })
        })
    }

    // All pips green — done, go straight to tracking
    ui.pips.forEach(function (p) { p.style.background = '#3fb950'; p.style.borderColor = '#3fb950' })
    if (ui.stepEl) ui.stepEl.textContent = 'Complete'
    ui.status.textContent = '✅ All done! Starting tracking…'
    await new Promise(function (r) { setTimeout(r, 600) })
    removeCalibrationOverlay()
}

// ─── Legacy overlay helpers (used by stop / cleanup) ─────────────────────────

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

        ui.status.textContent = 'Point ' + (i + 1) + ' / ' + points.length + ' — accepted 0 / ' + clicksPerPoint

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
                        ui.status.textContent = 'Point ' + (i + 1) + ' / ' + points.length + ' — accepted ' + pointState.accepted + ' / ' + clicksPerPoint
                    }, 500)
                    return
                }

                var left = clicksPerPoint - pointState.accepted
                dot.textContent = left > 0 ? String(left) : '✓'
                ui.status.textContent = 'Point ' + (i + 1) + ' / ' + points.length + ' — accepted ' + pointState.accepted + ' / ' + clicksPerPoint
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
        await clearWebGazerData()
        await runPrincetonCalibration()

        // Await the storage write so shouldForceCalibration never races against it
        await new Promise(function (resolve) {
            chrome.storage.local.set({
                calibrationVersion:  CONFIG.CALIBRATION_VERSION,
                calibrationUpdatedAt: Date.now(),
            }, resolve)
        })

        console.log('[NeuralAdaptive] Calibration saved — version', CONFIG.CALIBRATION_VERSION)
        isCalibrating = false
    })()

    try {
        await calibrationPromise
    } finally {
        calibrationPromise = null
        isCalibrating = false
    }
}

async function shouldForceCalibration(forceRequested) {
    if (forceRequested) return true
    return await new Promise(function (resolve) {
        chrome.storage.local.get(['calibrationVersion'], function (data) {
            // Only re-calibrate when the calibration schema version changes,
            // not when accuracy is below threshold — prevents re-entry loops.
            var hasVersion = data && data.calibrationVersion === CONFIG.CALIBRATION_VERSION
            resolve(!hasVersion)
        })
    })
}

async function preflightCameraAccess() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API unavailable')
    }
    var stream = await navigator.mediaDevices.getUserMedia({ video: true })
    if (stream && stream.getTracks) {
        stream.getTracks().forEach(function (track) {
            try { track.stop() } catch (e) { }
        })
    }
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
        injectStyles()
        GazeSmoother.reset()
        DwellGrid.reset()
        GazeCursor.create()

        if (webgazerInitialized && window.webgazer) {
            // Already initialized — resume and re-wire listener; skip model reload
            window.webgazer
                .setGazeListener(onGaze)
                .showPredictionPoints(false)   // cursor replaces the default dot
            try { window.webgazer.resume() } catch (e) { }
            smoothedPoint = null

            var needCal = await shouldForceCalibration(!!options.forceRecalibrate)
            if (needCal) await runCalibrationAndValidation(!!options.forceRecalibrate)
        } else {
            await ensureWebGazerLoaded()
            if (!window.webgazer || typeof window.webgazer.setGazeListener !== 'function') {
                throw new Error('webgazer global unavailable after load')
            }

            window.webgazer
                .saveDataAcrossSessions(true)
                .setGazeListener(onGaze)
                .setTracker('TFFacemesh')
                .setRegression('ridge')
                .showVideoPreview(false)
                .showPredictionPoints(false)   // cursor replaces the default dot

            try {
                if (navigator.permissions && navigator.permissions.query) {
                    var camPerm = await navigator.permissions.query({ name: 'camera' })
                    if (camPerm && camPerm.state === 'denied') {
                        throw new Error('Camera permission denied')
                    }
                }
            } catch (permErr) {
                // If permissions API is unavailable, continue and let begin() decide.
            }

            await preflightCameraAccess()
            await window.webgazer.begin()
            webgazerInitialized = true
            smoothedPoint = null

            var needCal = await shouldForceCalibration(!!options.forceRecalibrate)
            if (needCal) await runCalibrationAndValidation(!!options.forceRecalibrate)
        }

        isRunning = true
        console.log('[NeuralAdaptive] Tracking enabled')
    } catch (err) {
        var msg = err && err.message ? err.message : String(err)
        console.error('[NeuralAdaptive] Failed to start tracking:', msg)
        if (/permission dismissed|notallowed|camera permission denied/i.test(msg)) {
            console.error('[NeuralAdaptive] Camera permission is blocked/dismissed. Allow camera and try again.')
            chrome.storage.local.set({ enabled: false }, function () { })
        }
        isRunning = false
    } finally {
        isBooting = false
    }
}

function stopNeuralAdaptive() {
    if (window.webgazer) {
        try { window.webgazer.clearGazeListener() } catch (e) { }
        try { window.webgazer.showPredictionPoints(false) } catch (e) { }
        try { window.webgazer.pause() } catch (e) { }
    }

    GazeSmoother.reset()
    DwellGrid.reset()
    GazeCursor.hide()

    isRunning = false
    isBooting = false
    isCalibrating = false
    gazeBuffer = []
    lastSendTime = 0
    lastDwellBoost = 0
    currentTier = 'CALM'
    smoothedPoint = null
    clearAllInterventions()
    removeCalibrationOverlay()
    console.log('[NeuralAdaptive] Tracking disabled')
}

function clearAllInterventions() {
    removeTooltip()
    highlightedSentence = null
    document.querySelectorAll('.na-elevated, .na-overload').forEach(function (el) {
        el.classList.remove('na-elevated')
        el.classList.remove('na-overload')
    })
    document.querySelectorAll('.na-sentence').forEach(function (span) {
        span.style.opacity = ''
    })
}

// Dwell callback — fires when gaze stays in one grid sector for DWELL_THRESHOLD_MS
DwellGrid.onDwellCb = function (sector, x, y) {
    if (!isRunning || isCalibrating) return
    var para = DwellGrid.getParagraphAt(x, y)
    console.log('[NeuralAdaptive] Dwell sector', sector, para ? 'on <' + para.tagName + '>' : '(no para)')
    // Dwell on a paragraph counts as a heavy fixation signal — boost the next score flush
    if (para) lastDwellBoost = Date.now()
}

var lastDwellBoost = 0   // timestamp of most recent dwell event

function onGaze(data) {
    if (!data || !isRunning || isCalibrating) return

    // ── 1. Smooth raw coordinates (α = 0.15 low-pass filter) ──────────────
    var smooth = GazeSmoother.update(data.x, data.y)
    smoothedPoint = smooth                  // keep legacy alias in sync

    // ── 2. Move the Princeton-orange cursor ring ───────────────────────────
    GazeCursor.move(smooth.x, smooth.y)

    // ── 3. Spatial binning — sector dwell detection ────────────────────────
    DwellGrid.update(smooth.x, smooth.y)

    // ── 4. Push to signal buffer ───────────────────────────────────────────
    var point = { x: smooth.x, y: smooth.y, t: Date.now() }
    gazeBuffer.push(point)
    if (gazeBuffer.length > CONFIG.SAMPLE_BUFFER_SIZE) gazeBuffer.shift()

    // ── 5. Throttled stress scoring ────────────────────────────────────────
    var now = Date.now()
    if (now - lastSendTime < CONFIG.SEND_INTERVAL_MS) return
    lastSendTime = now
    if (gazeBuffer.length < 10) return

    var signals = computeSignals(gazeBuffer)

    // Dwell boost: if a sector dwell fired recently, inflate fixation signal
    if (now - lastDwellBoost < CONFIG.SEND_INTERVAL_MS * 1.5) {
        signals.fixation = Math.min(signals.fixation + 0.25, 1.0)
    }

    var score = (signals.fixation * 0.45) + (signals.saccade * 0.35) + (signals.regression * 0.20)
    score = parseFloat(Math.min(Math.max(score, 0), 1.0).toFixed(3))
    var tier = score < 0.3 ? 'CALM' : score < 0.6 ? 'ELEVATED' : 'OVERLOAD'

    chrome.runtime.sendMessage({
        type: 'STRESS_SCORE',
        score: score,
        signals: signals
    }).catch(function () { })

    applyIntervention(tier)
}

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

function applyIntervention(tier) {
    if (tier === currentTier) return
    currentTier = tier
    var el = findReadingContent()
    if (!el) return

    el.classList.remove('na-calm', 'na-elevated', 'na-overload')
    if (tier === 'CALM') {
        removeTooltip()
        clearSentenceHighlight(el)
        return
    }
    if (tier === 'ELEVATED') {
        el.classList.add('na-elevated')
        clearSentenceHighlight(el)
        removeTooltip()
        return
    }
    el.classList.add('na-overload')
    applySentenceHighlight(el)
    triggerGeminiTooltip(el)
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
        if (response && response.summary) renderTooltip(response.summary)
    })
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

    if (message.type === 'NA_SET_ENABLED') {
        applyEnabledState(!!message.enabled)
        sendResponse({ ok: true })
        return
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
})

chrome.storage.local.get(['enabled', 'accuracyMode'], function (data) {
    applyAccuracyMode(data && data.accuracyMode ? data.accuracyMode : 'balanced')
    var enabled = !!(data && data.enabled)
    if (!enabled) {
        console.log('[NeuralAdaptive] Disabled by default. Use popup to enable.')
        return
    }
    startNeuralAdaptive()
})
