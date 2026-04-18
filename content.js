// content.js — NeuralAdaptive v2.2.0
// On-demand eye tracking with two-stage calibration + validation gate.

console.log('[NeuralAdaptive v2.2.0] content.js loaded')

var CONFIG = {
    SEND_INTERVAL_MS: 2000,
    FIXATION_THRESHOLD_PX: 60,
    FIXATION_STRESS_DURATION_MS: 3000,
    SACCADE_HIGH_VELOCITY: 800,
    SAMPLE_BUFFER_SIZE: 90,
    REGRESSION_WINDOW: 20,
    CALIBRATION_VERSION: 'two_stage_v1',
    CALIBRATION_CLICKS_PER_POINT: 3,
    VALIDATION_THRESHOLD_PX: 110,
    MAX_FORCED_RECALIBRATION_ATTEMPTS: 2,
}

var ACCURACY_MODE = {
    balanced: {
        alpha: 0.45,
        outlierThresholdPx: 180,
        validationThresholdPx: 110,
    },
    precision: {
        alpha: 0.25,
        outlierThresholdPx: 130,
        validationThresholdPx: 85,
    },
}

var CAL_STAGE_1 = [
    { x: 5, y: 5 }, { x: 50, y: 5 }, { x: 95, y: 5 },
    { x: 5, y: 50 }, { x: 50, y: 50 }, { x: 95, y: 50 },
    { x: 5, y: 95 }, { x: 50, y: 95 }, { x: 95, y: 95 },
]

var CAL_STAGE_2 = [
    { x: 50, y: 50 },
    { x: 35, y: 50 },
    { x: 65, y: 50 },
    { x: 50, y: 35 },
    { x: 50, y: 65 },
]

var VALIDATION_POINTS = [
    { x: 20, y: 20 },
    { x: 80, y: 20 },
    { x: 50, y: 50 },
    { x: 20, y: 80 },
    { x: 80, y: 80 },
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
var smoothedPoint = null
var calibrationPromise = null
var webgazerInitialized = false

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

function createCalibrationOverlay(title, subtitle) {
    var overlay = document.createElement('div')
    overlay.id = 'na-cal-overlay'
    Object.assign(overlay.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '100vw',
        height: '100vh',
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
        position: 'fixed',
        left: '50%',
        top: '18px',
        transform: 'translateX(-50%)',
        textAlign: 'center',
        pointerEvents: 'none',
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

async function runCalibrationAndValidation(force) {
    if (calibrationPromise) return calibrationPromise

    calibrationPromise = (async function () {
        isCalibrating = true

        var attempt = 0
        while (attempt <= CONFIG.MAX_FORCED_RECALIBRATION_ATTEMPTS) {
            attempt += 1
            await clearWebGazerData()
            await runCalibrationStage('Stage 1 (Coarse)', CAL_STAGE_1, CONFIG.CALIBRATION_CLICKS_PER_POINT)
            await runCalibrationStage('Stage 2 (Fine)', CAL_STAGE_2, CONFIG.CALIBRATION_CLICKS_PER_POINT + 1)

            var validation = await runValidationStage(VALIDATION_POINTS)
            var threshold = getModeConfig().validationThresholdPx || CONFIG.VALIDATION_THRESHOLD_PX
            console.log('[NeuralAdaptive] Validation result:', validation, 'threshold:', threshold, 'attempt:', attempt)

            chrome.storage.local.set({
                calibrationVersion: CONFIG.CALIBRATION_VERSION,
                calibrationMedianErrorPx: Math.round(validation.medianPx),
                calibrationMeanErrorPx: Math.round(validation.meanPx),
                calibrationUpdatedAt: Date.now(),
            })

            if (validation.medianPx <= threshold) {
                isCalibrating = false
                return validation
            }

            if (attempt > CONFIG.MAX_FORCED_RECALIBRATION_ATTEMPTS) {
                throw new Error('Calibration quality too low after retries (median ' + Math.round(validation.medianPx) + 'px)')
            }

            // Forced recalibration
            await new Promise(function (r) { setTimeout(r, 300) })
        }
    })()

    try {
        return await calibrationPromise
    } finally {
        calibrationPromise = null
        isCalibrating = false
    }
}

async function shouldForceCalibration(forceRequested) {
    if (forceRequested) return true
    return await new Promise(function (resolve) {
        chrome.storage.local.get(['calibrationVersion', 'calibrationMedianErrorPx'], function (data) {
            var hasVersion = data && data.calibrationVersion === CONFIG.CALIBRATION_VERSION
            var error = data && typeof data.calibrationMedianErrorPx === 'number' ? data.calibrationMedianErrorPx : 999
            var threshold = getModeConfig().validationThresholdPx || CONFIG.VALIDATION_THRESHOLD_PX
            resolve(!hasVersion || error > threshold)
        })
    })
}

async function startNeuralAdaptive(options) {
    options = options || {}
    if (isBooting || isRunning) {
        if (options.forceRecalibrate && isRunning) {
            await runCalibrationAndValidation(true)
        }
        return
    }

    isBooting = true
    try {
        injectStyles()

        if (webgazerInitialized && window.webgazer) {
            // Already initialized — just resume and re-register listener
            window.webgazer.setGazeListener(onGaze).showPredictionPoints(true)
            try { window.webgazer.resume() } catch (e) { }
            smoothedPoint = null

            var needCal = await shouldForceCalibration(!!options.forceRecalibrate)
            if (needCal) {
                await runCalibrationAndValidation(!!options.forceRecalibrate)
            }
        } else {
            await ensureWebGazerLoaded()
            if (!window.webgazer || typeof window.webgazer.setGazeListener !== 'function') {
                throw new Error('webgazer global unavailable after load')
            }

            window.webgazer
                .saveDataAcrossSessions(false)
                .setGazeListener(onGaze)
                .setTracker('TFFacemesh')
                .setRegression('ridge')
                .showVideoPreview(false)
                .showPredictionPoints(true)

            await window.webgazer.begin()
            webgazerInitialized = true
            smoothedPoint = null

            var needCal = await shouldForceCalibration(!!options.forceRecalibrate)
            if (needCal) {
                await runCalibrationAndValidation(!!options.forceRecalibrate)
            }
        }

        isRunning = true
        console.log('[NeuralAdaptive] Tracking enabled')
    } catch (err) {
        console.error('[NeuralAdaptive] Failed to start tracking:', err && err.message ? err.message : err)
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
    isRunning = false
    isBooting = false
    isCalibrating = false
    gazeBuffer = []
    lastSendTime = 0
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

function onGaze(data) {
    if (!data || !isRunning || isCalibrating) return

    var mode = getModeConfig()
    var alpha = mode.alpha
    if (!smoothedPoint) {
        smoothedPoint = { x: data.x, y: data.y }
    } else {
        smoothedPoint.x = smoothedPoint.x + alpha * (data.x - smoothedPoint.x)
        smoothedPoint.y = smoothedPoint.y + alpha * (data.y - smoothedPoint.y)
    }

    var point = { x: smoothedPoint.x, y: smoothedPoint.y, t: Date.now() }
    gazeBuffer.push(point)
    if (gazeBuffer.length > CONFIG.SAMPLE_BUFFER_SIZE) gazeBuffer.shift()

    var now = Date.now()
    if (now - lastSendTime < CONFIG.SEND_INTERVAL_MS) return
    lastSendTime = now
    if (gazeBuffer.length < 10) return

    var signals = computeSignals(gazeBuffer)
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
