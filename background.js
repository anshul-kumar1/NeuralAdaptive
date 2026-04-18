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
            var msg = err && err.message ? err.message : String(err)
            console.error('[NeuralAdaptive] SUMMARIZE_PARAGRAPH failed:', msg, {
                textPreview: (message.text || '').slice(0, 80),
                error: err,
            })
            sendResponse({ summary: null, error: msg })
        })
        return true
    }

    if (message.type === 'SIMPLIFY_PARAGRAPH') {
        simplifyViaGemini(message.text).then(function (simplified) {
            sendResponse({ simplified: simplified })
        }).catch(function (err) {
            var msg = err && err.message ? err.message : String(err)
            console.error('[NeuralAdaptive] SIMPLIFY_PARAGRAPH failed:', msg, {
                textPreview: (message.text || '').slice(0, 80),
                error: err,
            })
            sendResponse({ simplified: null, error: msg })
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

// ── Dedalus (Claude) routing ──────────────────────────────────────────────────
// Dedalus exposes an OpenAI-compatible chat completions endpoint. The API key
// can live in code for development; for production set it via
//   chrome.storage.local.set({ dedalusApiKey: '...' })
// and it will override the constant below.

var DEDALUS_API_KEY = 'dsk-test-94af530a2791-b3bc6d4ca5fdcc568dce33e70df376a2'
var DEDALUS_API_URL = 'https://api.dedaluslabs.ai/v1/chat/completions'
var CLAUDE_MODEL    = 'anthropic/claude-haiku-4-5-20251001'

var SUMMARIZE_SYSTEM_PROMPT =
    'You are a reading assistant for a student with dyslexia or ADHD. ' +
    'Given a paragraph, return exactly three bullet points capturing its ' +
    'key ideas. Each bullet must be under 12 words. Return ONLY the bullets ' +
    'as lines starting with a dash. No preamble, no closing remarks.'

var SIMPLIFY_SYSTEM_PROMPT =
    'You are a reading assistant for a student with dyslexia or ADHD who is ' +
    'losing focus. Rewrite the passage at roughly a 6th-grade reading level. ' +
    'Keep every key fact and the original point of view. Use short sentences ' +
    '(max 15 words) and plain everyday words. Aim for about 60-70% of the ' +
    'original length. Return ONLY the rewritten passage as plain prose — no ' +
    'preamble, no bullets, no markdown, no quotation marks.'

async function getDedalusKey() {
    try {
        var stored = await chrome.storage.local.get(['dedalusApiKey'])
        if (stored && typeof stored.dedalusApiKey === 'string' && stored.dedalusApiKey.length > 0) {
            return stored.dedalusApiKey
        }
    } catch (err) {
        console.warn('[NeuralAdaptive] Could not read dedalusApiKey from storage:', err && err.message)
    }
    return DEDALUS_API_KEY
}

async function callGemini(text) {
    return callDedalus(SUMMARIZE_SYSTEM_PROMPT, 'Paragraph:\n"' + text + '"', 300, 0.3)
}

async function simplifyViaGemini(text) {
    return callDedalus(SIMPLIFY_SYSTEM_PROMPT, 'Passage:\n' + text, 600, 0.4)
}

async function callDedalus(systemPrompt, userPrompt, maxTokens, temperature) {
    var apiKey = await getDedalusKey()
    if (!apiKey) throw new Error('Dedalus API key not configured')

    var res = await fetch(DEDALUS_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
            model: CLAUDE_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userPrompt   },
            ],
            max_tokens: maxTokens,
            temperature: temperature,
        }),
    })

    if (!res.ok) {
        var errText = ''
        try { errText = await res.text() } catch (_) {}
        console.error('[NeuralAdaptive] Dedalus HTTP error', {
            status: res.status,
            statusText: res.statusText,
            model: CLAUDE_MODEL,
            bodyPreview: errText.slice(0, 300),
        })
        throw new Error('Dedalus ' + res.status + (errText ? ': ' + errText.slice(0, 200) : ''))
    }

    var data
    try {
        data = await res.json()
    } catch (err) {
        console.error('[NeuralAdaptive] Dedalus JSON parse failed:', err)
        throw new Error('Dedalus invalid JSON response')
    }

    var content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : null
    if (!content) {
        console.error('[NeuralAdaptive] Dedalus empty response body:', data)
        throw new Error('Dedalus empty response')
    }
    return String(content).trim()
}
