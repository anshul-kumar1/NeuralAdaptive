// content.js
// Now does THREE jobs:
//   1. Load WebGazer and start eye tracking
//   2. Compute stress signals from gaze data
//   3. Apply DOM interventions based on stress tier

console.log('[NeuralAdaptive v2.0.13] content.js loaded')

// ── Config ─────────────────────────────────────────────────────────────────────

var CONFIG = {
    SEND_INTERVAL_MS: 2000,
    FIXATION_THRESHOLD_PX: 60,
    FIXATION_STRESS_DURATION_MS: 3000,
    SACCADE_HIGH_VELOCITY: 800,
    SAMPLE_BUFFER_SIZE: 90,
    REGRESSION_WINDOW: 20,
}

// ── State ──────────────────────────────────────────────────────────────────────

var gazeBuffer = []
var lastSendTime = 0
var currentTier = 'CALM'
var tooltipEl = null
var highlightedSentence = null
var interventionActive = false

// ── Step 1: Initialize WebGazer ───────────────────────────────────────────────
// webgazer.js is loaded first via manifest content_scripts.

async function initWebGazer() {
    if (!window.webgazer || typeof window.webgazer.setGazeListener !== 'function') {
        console.error('[NeuralAdaptive] webgazer is unavailable; verify webgazer.js loads before content.js')
        return
    }

    // Use local bundle settings only; avoid stale persisted calibration across major bundle changes.
    window.webgazer.saveDataAcrossSessions(false)
    try {
        await window.webgazer.clearData()
        console.log('[NeuralAdaptive] Cleared persisted WebGazer data')
    } catch (clearErr) {
        console.warn('[NeuralAdaptive] Failed to clear persisted data:', clearErr && clearErr.message ? clearErr.message : clearErr)
    }

    window.webgazer
        .setGazeListener(onGaze)
        .setRegression('ridge')

    // Show the webcam dot overlay so users can see tracking is live.
    // For the demo this is intentional — it's part of the UX story.
    window.webgazer.showVideoPreview(true)
    window.webgazer.showPredictionPoints(true)

    var permissionState = await getCameraPermissionState()
    console.log('[NeuralAdaptive] Camera permission state before begin():', permissionState)
    if (permissionState === 'denied') {
        console.error('[NeuralAdaptive] Camera permission is denied. Allow camera in site settings, then reload the page.')
        return
    }

    try {
        await window.webgazer.begin()
        console.log('[NeuralAdaptive] WebGazer running')
    } catch (err) {
        var msg = err && err.message ? err.message : String(err)
        var classification = classifyWebGazerError(err)
        permissionState = await getCameraPermissionState()

        console.error('[NeuralAdaptive] WebGazer begin() failed: ' + msg)
        console.error('[NeuralAdaptive] Failure class:', classification)
        console.error('[NeuralAdaptive] Camera permission state at failure:', permissionState)
        console.error('[NeuralAdaptive] Active FaceMesh path at failure:', window.webgazer.params.faceMeshSolutionPath || '(unset)')

        if (classification === 'camera_permission') {
            console.error('[NeuralAdaptive] Camera access was dismissed/blocked. Click the camera icon in the address bar and allow access, then reload.')
        } else if (classification === 'facemesh_asset') {
            console.error('[NeuralAdaptive] Face tracking asset fetch failed. Check Network tab for blocked model/asset requests.')
        } else {
            console.error('[NeuralAdaptive] Unknown begin() failure. Inspect Network + Permissions + Service Worker console.')
        }
    }
}

function classifyWebGazerError(err) {
    var name = err && err.name ? String(err.name).toLowerCase() : ''
    var message = err && err.message ? String(err.message).toLowerCase() : String(err || '').toLowerCase()

    if (
        name.indexOf('notallowed') !== -1 ||
        message.indexOf('permission dismissed') !== -1 ||
        message.indexOf('permission denied') !== -1 ||
        message.indexOf('notallowederror') !== -1
    ) {
        return 'camera_permission'
    }

    if (
        message.indexOf('packed_assets') !== -1 ||
        message.indexOf('face_mesh_solution') !== -1 ||
        message.indexOf('networkerror') !== -1 ||
        message.indexOf('404') !== -1
    ) {
        return 'facemesh_asset'
    }

    if (message.indexOf('no stream') !== -1) {
        return 'camera_stream'
    }

    return 'unknown'
}

async function getCameraPermissionState() {
    try {
        if (!navigator.permissions || !navigator.permissions.query) return 'unknown'
        var status = await navigator.permissions.query({ name: 'camera' })
        return status && status.state ? status.state : 'unknown'
    } catch (e) {
        return 'unknown'
    }
}

// ── Step 2: Gaze listener — called every ~16ms by WebGazer ───────────────────

function onGaze(data, elapsedTime) {
    if (!data) return

    var point = { x: data.x, y: data.y, t: Date.now() }
    gazeBuffer.push(point)
    if (gazeBuffer.length > CONFIG.SAMPLE_BUFFER_SIZE) gazeBuffer.shift()

    var now = Date.now()
    if (now - lastSendTime < CONFIG.SEND_INTERVAL_MS) return
    lastSendTime = now

    if (gazeBuffer.length < 10) return

    var signals = computeSignals(gazeBuffer)
    var stressScore = (signals.fixation * 0.45) + (signals.saccade * 0.35) + (signals.regression * 0.20)
    stressScore = Math.min(Math.max(stressScore, 0), 1.0)
    stressScore = parseFloat(stressScore.toFixed(3))

    var tier = stressScore < 0.3 ? 'CALM' : stressScore < 0.6 ? 'ELEVATED' : 'OVERLOAD'

    console.log('[NeuralAdaptive] Score: ' + stressScore + ' | tier: ' + tier + ' | fix:' + signals.fixation + ' sacc:' + signals.saccade + ' reg:' + signals.regression)

    // Tell background.js to persist to storage (for sidepanel)
    chrome.runtime.sendMessage({
        type: 'STRESS_SCORE',
        score: stressScore,
        signals: signals
    }).catch(function () { })

    applyIntervention(tier, stressScore)
}

// ── Step 3: Compute three gaze signals ───────────────────────────────────────

function computeSignals(buffer) {

    // Signal 1: Fixation Duration
    // How long has the gaze been stuck in roughly the same spot?
    var recent = buffer.slice(-30)
    var avgX = recent.reduce(function (s, p) { return s + p.x }, 0) / recent.length
    var avgY = recent.reduce(function (s, p) { return s + p.y }, 0) / recent.length
    var allClose = recent.every(function (p) {
        return Math.sqrt(Math.pow(p.x - avgX, 2) + Math.pow(p.y - avgY, 2)) < CONFIG.FIXATION_THRESHOLD_PX
    })
    var fixationDuration = allClose ? (recent[recent.length - 1].t - recent[0].t) : 0
    var fixationScore = Math.min(fixationDuration / CONFIG.FIXATION_STRESS_DURATION_MS, 1.0)

    // Signal 2: Saccade Velocity
    // Are the eyes jumping around erratically? High velocity = losing the line.
    var velocities = []
    for (var i = 1; i < buffer.length; i++) {
        var dt = buffer[i].t - buffer[i - 1].t
        if (dt <= 0) continue
        var dx = buffer[i].x - buffer[i - 1].x
        var dy = buffer[i].y - buffer[i - 1].y
        var dist = Math.sqrt(dx * dx + dy * dy)
        velocities.push(dist / dt * 1000)
    }
    var highVelocityCount = velocities.filter(function (v) { return v > CONFIG.SACCADE_HIGH_VELOCITY }).length
    var saccadeScore = Math.min(highVelocityCount / (velocities.length * 0.3), 1.0)

    // Signal 3: Regression Rate
    // Is the gaze moving backward (right to left) through the text?
    // Regressions = re-reading because comprehension failed.
    var window = buffer.slice(-CONFIG.REGRESSION_WINDOW)
    var regressions = 0
    for (var j = 1; j < window.length; j++) {
        if (window[j].x < window[j - 1].x - 20) regressions++
    }
    var regressionScore = Math.min(regressions / (CONFIG.REGRESSION_WINDOW * 0.4), 1.0)

    return {
        fixation: parseFloat(fixationScore.toFixed(3)),
        saccade: parseFloat(saccadeScore.toFixed(3)),
        regression: parseFloat(regressionScore.toFixed(3))
    }
}

// ── Step 4: DOM Interventions ─────────────────────────────────────────────────

function applyIntervention(tier, score) {
    if (tier === currentTier) return
    currentTier = tier

    var contentEl = findReadingContent()
    if (!contentEl) return

    // Remove all previous tier classes
    contentEl.classList.remove('na-calm', 'na-elevated', 'na-overload')

    if (tier === 'CALM') {
        removeTooltip()
        clearSentenceHighlight(contentEl)
        return
    }

    if (tier === 'ELEVATED') {
        contentEl.classList.add('na-elevated')
        clearSentenceHighlight(contentEl)
        removeTooltip()
        return
    }

    if (tier === 'OVERLOAD') {
        contentEl.classList.add('na-overload')
        applySentenceHighlight(contentEl)
        triggerGeminiTooltip(contentEl)
    }
}

// ── Find the main reading surface ─────────────────────────────────────────────

function findReadingContent() {
    var selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-body', '.entry-content']
    for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i])
        if (el) return el
    }
    // Fallback: find element with highest <p> density
    var candidates = document.querySelectorAll('div, section')
    var best = null
    var bestScore = 0
    candidates.forEach(function (el) {
        var ps = el.querySelectorAll('p')
        var children = el.children.length
        if (children === 0) return
        var score = ps.length / children
        if (ps.length > 3 && score > bestScore) {
            bestScore = score
            best = el
        }
    })
    return best
}

// ── Sentence Highlighter ──────────────────────────────────────────────────────

function applySentenceHighlight(contentEl) {
    var paragraphs = contentEl.querySelectorAll('p')
    var viewportMid = window.innerHeight / 2

    // Find paragraph closest to vertical center of viewport
    var closestP = null
    var closestDist = Infinity
    paragraphs.forEach(function (p) {
        var rect = p.getBoundingClientRect()
        var dist = Math.abs((rect.top + rect.bottom) / 2 - viewportMid)
        if (dist < closestDist) {
            closestDist = dist
            closestP = p
        }
    })

    if (!closestP) return
    if (highlightedSentence === closestP) return
    highlightedSentence = closestP

    // Split into sentences and wrap each in a span
    var raw = closestP.innerText
    var sentences = raw.match(/[^.!?]+[.!?]+/g) || [raw]
    var html = sentences.map(function (s, idx) {
        return '<span class="na-sentence" data-idx="' + idx + '">' + s + '</span>'
    }).join('')
    closestP.innerHTML = html

    // Dim all sentences, highlight the first one (estimated current position)
    var spans = closestP.querySelectorAll('.na-sentence')
    spans.forEach(function (span) { span.style.opacity = '0.25' })
    if (spans[0]) spans[0].style.opacity = '1'

    // Use gaze X position to estimate which sentence the user is on
    if (gazeBuffer.length > 0) {
        var lastGaze = gazeBuffer[gazeBuffer.length - 1]
        var pRect = closestP.getBoundingClientRect()
        var relativeX = (lastGaze.x - pRect.left) / pRect.width
        var estimatedIdx = Math.floor(relativeX * sentences.length)
        estimatedIdx = Math.max(0, Math.min(estimatedIdx, spans.length - 1))
        spans.forEach(function (span) { span.style.opacity = '0.25' })
        if (spans[estimatedIdx]) spans[estimatedIdx].style.opacity = '1'
    }
}

function clearSentenceHighlight(contentEl) {
    highlightedSentence = null
    var spans = contentEl.querySelectorAll('.na-sentence')
    spans.forEach(function (span) { span.style.opacity = '' })
}

// ── Gemini Tooltip ────────────────────────────────────────────────────────────

function triggerGeminiTooltip(contentEl) {
    var paragraphs = contentEl.querySelectorAll('p')
    var viewportMid = window.innerHeight / 2
    var closestP = null
    var closestDist = Infinity
    paragraphs.forEach(function (p) {
        var rect = p.getBoundingClientRect()
        var dist = Math.abs((rect.top + rect.bottom) / 2 - viewportMid)
        if (dist < closestDist) { closestDist = dist; closestP = p }
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
    tooltipEl.innerHTML =
        '<div style="font-size:11px;font-weight:600;letter-spacing:0.08em;opacity:0.5;margin-bottom:6px;">NEURAL ADAPTIVE</div>' +
        '<div style="font-size:13px;line-height:1.7;white-space:pre-line;">' + text + '</div>' +
        '<button onclick="document.getElementById(\'na-tooltip\').remove()" style="position:absolute;top:8px;right:10px;background:none;border:none;cursor:pointer;font-size:14px;opacity:0.4;">x</button>'

    Object.assign(tooltipEl.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        width: '280px',
        background: 'rgba(15,15,20,0.92)',
        color: '#e8e8e8',
        padding: '14px 16px',
        borderRadius: '10px',
        zIndex: '2147483647',
        fontFamily: 'system-ui, sans-serif',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(12px)',
        border: '0.5px solid rgba(255,255,255,0.12)',
        transition: 'opacity 0.3s ease',
        opacity: '0'
    })

    document.body.appendChild(tooltipEl)
    requestAnimationFrame(function () { tooltipEl.style.opacity = '1' })
}

function removeTooltip() {
    var existing = document.getElementById('na-tooltip')
    if (existing) existing.remove()
    tooltipEl = null
}

// ── Inject CSS for typography tiers ──────────────────────────────────────────

function injectStyles() {
    if (document.getElementById('na-styles')) return
    var style = document.createElement('style')
    style.id = 'na-styles'
    style.textContent = [
        '.na-elevated p { line-height: 1.9 !important; letter-spacing: 0.04em !important; transition: all 0.6s ease !important; }',
        '.na-overload p { line-height: 2.1 !important; letter-spacing: 0.12em !important; max-width: 66ch !important; transition: all 0.6s ease !important; }',
        '.na-sentence { transition: opacity 0.4s ease; }',
    ].join('\n')
    document.head.appendChild(style)
}

// ── Boot ───────────────────────────────────────────────────────────────────────

injectStyles()
initWebGazer()
