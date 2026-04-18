// background.js - NeuralAdaptive v3.0.0
console.log('[NeuralAdaptive v3.0.0] background service worker loaded')

chrome.runtime.onInstalled.addListener(function () {
    chrome.storage.local.get(['enabled', 'accuracyMode', 'na_flags'], function (data) {
        var patch = {}
        var isDev = !chrome.runtime.getManifest().update_url
        if (typeof data.enabled === 'undefined') patch.enabled = false
        if (typeof data.accuracyMode === 'undefined') patch.accuracyMode = 'balanced'
        if (!data.na_flags || typeof data.na_flags !== 'object') {
            patch.na_flags = {
                adaptive_kalman_v1: isDev,
                intervention_hysteresis_v2: isDev,
                calibration_quality_gates_v1: false,
                line_aware_snap_v1: false,
                drift_map_v1: false,
                residual_fusion_v1: false
            }
        }
        if (Object.keys(patch).length > 0) chrome.storage.local.set(patch)
    })
})

// ── Script injection helpers ──────────────────────────────────────────────────
async function injectTracker(tabId) {
    var baseUrl = chrome.runtime.getURL('mediapipe/face_mesh/')

    // 1. Set base URL in MAIN world before face_mesh.js loads
    await chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: 'MAIN',
        func: function (url) { window.__naFaceMeshBase = url },
        args: [baseUrl]
    })

    // 2. Inject FaceMesh library into MAIN world
    await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['mediapipe/face_mesh/face_mesh.js'],
        world: 'MAIN'
    })

    // 3. Inject iris tracker into MAIN world (reads __naFaceMeshBase, uses page camera)
    await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['iris-tracker.js'],
        world: 'MAIN'
    })
}

async function stopTracker(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: function () {
                document.dispatchEvent(new CustomEvent('na-stop-tracking'))
            }
        })
    } catch (e) { /* tab may have navigated away */ }
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.type) return false

    if (message.type === 'START_TRACKING') {
        var tabId = sender && sender.tab ? sender.tab.id : null
        if (!tabId) { sendResponse({ ok: false, error: 'no tab' }); return false }
        injectTracker(tabId).then(function () {
            sendResponse({ ok: true })
        }).catch(function (err) {
            console.error('[NeuralAdaptive] inject failed:', err)
            sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
        })
        return true
    }

    if (message.type === 'STOP_TRACKING') {
        var tabId = sender && sender.tab ? sender.tab.id : null
        if (tabId) stopTracker(tabId)
        sendResponse({ ok: true })
        return false
    }

    if (message.type === 'STRESS_SCORE') {
        var score = message.score
        var tier = score < 0.3 ? 'CALM' : score < 0.6 ? 'ELEVATED' : 'OVERLOAD'
        chrome.storage.local.set({
            currentScore: score,
            currentTier: tier,
            signals: message.signals,
            lastUpdated: Date.now()
        })
        sendResponse({ ok: true })
        return false
    }

    if (message.type === 'SUMMARIZE_PARAGRAPH') {
        callGemini(message.text).then(function (summary) {
            sendResponse({ summary: summary })
        }).catch(function (err) {
            sendResponse({ summary: null, error: err.message })
        })
        return true
    }

    if (message.type === 'BREADCRUMB_SUMMARY') {
        var prompt = 'The student is returning to this text after being distracted. ' +
            'Summarize the key takeaway of the last 300 words in exactly 12 words, ' +
            'starting with "You were just exploring..."\n\n' + message.text
        callGemini(prompt).then(function (summary) {
            sendResponse({ summary: summary })
        }).catch(function (err) {
            sendResponse({ summary: null, error: err.message })
        })
        return true
    }

    return false
})

var GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE'
var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + GEMINI_API_KEY

async function callGemini(text) {
    var prompt = 'Summarize this paragraph into exactly 3 bullet points, each under 12 words. Return ONLY the bullets, no preamble.\n\n' + text
    var res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 150 }
        })
    })
    if (!res.ok) throw new Error('Gemini ' + res.status)
    var data = await res.json()
    return data.candidates[0].content.parts[0].text
}
