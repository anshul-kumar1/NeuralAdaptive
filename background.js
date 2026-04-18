//service worker, message router
// background.js — Service Worker
// Responsibilities:
//   1. Create (and recreate) the offscreen document that runs MediaPipe
//   2. Route stress score messages from offscreen → content.js in the active tab
//   3. Call Gemini API when content.js requests a paragraph summary
//
// IMPORTANT: Service workers sleep after ~30s of inactivity.
// Variables reset on every wake. Use chrome.storage for anything that must persist.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html')

// ─── Offscreen Document Management ────────────────────────────────────────────

async function ensureOffscreenDocument() {
    // Chrome only allows ONE offscreen document at a time.
    // Always check before creating — calling create() twice throws an error.
    const existing = await chrome.offscreen.hasDocument()
    if (existing) return

    await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        // DISPLAY_MEDIA or USER_MEDIA reason is required to justify webcam access.
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'Camera feed required for MediaPipe Pose landmark detection'
    })

    console.log('[background] Offscreen document created')
}

// ─── Extension Startup ────────────────────────────────────────────────────────

// Fires when Chrome first installs or re-enables the extension.
chrome.runtime.onInstalled.addListener(async () => {
    console.log('[background] NeuralAdaptive installed')
    await ensureOffscreenDocument()
    // Tell the offscreen doc to boot the camera.
    // Small delay because the document needs a moment to initialize its listeners.
    setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'START_CAMERA' }).catch(() => {
            // Ignore — offscreen doc may not be ready yet on very first install
        })
    }, 500)
})

// Fires when the browser starts (extension was already installed).
chrome.runtime.onStartup.addListener(async () => {
    console.log('[background] Browser started, booting NeuralAdaptive')
    await ensureOffscreenDocument()
    setTimeout(() => {
        chrome.runtime.sendMessage({ type: 'START_CAMERA' }).catch(() => { })
    }, 500)
})

// ─── Message Router ───────────────────────────────────────────────────────────
//
// All inter-component communication flows through here.
// Think of background.js as the switchboard — it never acts on its own,
// it just routes messages between offscreen.js and content.js.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ── From offscreen.js: new stress score computed ──
    if (message.type === 'STRESS_SCORE') {
        handleStressScore(message)
        sendResponse({ ok: true })
        return false // synchronous response, don't keep channel open
    }

    // ── From content.js: summarize this paragraph via Gemini ──
    if (message.type === 'SUMMARIZE_PARAGRAPH') {
        // Must return true to keep the message channel open for async response
        callGemini(message.text).then(summary => {
            sendResponse({ summary })
        }).catch(err => {
            console.error('[background] Gemini error:', err)
            sendResponse({ summary: null, error: err.message })
        })
        return true // keep channel open for async sendResponse
    }

    // ── From sidepanel.html: user clicked Calibrate ──
    if (message.type === 'SET_BASELINE') {
        chrome.runtime.sendMessage({ type: 'SET_BASELINE' }).catch(() => { })
        sendResponse({ ok: true })
        return false
    }

    // ── From sidepanel.html: toggle interventions on/off ──
    if (message.type === 'TOGGLE_ACTIVE') {
        chrome.storage.local.set({ interventionsActive: message.active })
        sendResponse({ ok: true })
        return false
    }
})

// ─── Stress Score Handler ─────────────────────────────────────────────────────

// Throttle tracker — we only forward a message to content.js every 2 seconds
// even though offscreen.js sends scores more frequently during development.
let lastForwardTime = 0

async function handleStressScore(message) {
    const { score, signals } = message
    const now = Date.now()

    // Determine intervention tier
    const tier = score < 0.3 ? 'CALM' : score < 0.6 ? 'ELEVATED' : 'OVERLOAD'

    // Persist current state so sidepanel.html can read it at any time
    await chrome.storage.local.set({
        currentScore: score,
        currentTier: tier,
        signals: signals,
        lastUpdated: now
    })

    // Throttle forwarding to content.js — no need to hammer the DOM
    if (now - lastForwardTime < 2000) return
    lastForwardTime = now

    // Get the active tab and forward the intervention instruction
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!activeTab?.id) return

    // Don't inject into chrome:// or extension pages — content.js won't be there
    if (!activeTab.url?.startsWith('http')) return

    chrome.tabs.sendMessage(activeTab.id, {
        type: 'INTERVENTION',
        tier,
        score,
        signals
    }).catch(() => {
        // Tab may not have content.js yet (e.g. brand new tab still loading)
        // This is expected and safe to ignore
    })
}

// ─── Gemini API ───────────────────────────────────────────────────────────────
//
// API key lives HERE and ONLY here.
// content.js sends the paragraph text, we make the fetch, we send back the bullets.
// Never expose this key in content.js — it would be visible in Chrome DevTools.

const GEMINI_API_KEY = 'YOUR_GEMINI_API_KEY_HERE' // ← replace before demo
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`

async function callGemini(paragraphText) {
    const prompt = `You are a reading assistant helping a student with ADHD or dyslexia.
Summarize the following paragraph into exactly 3 short bullet points.
Each bullet must be under 12 words. Use plain, simple language.
Return ONLY the 3 bullets, nothing else. No preamble. No labels.

Paragraph:
"${paragraphText}"`

    const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 150 }
        })
    })

    if (!response.ok) {
        throw new Error(`Gemini API returned ${response.status}`)
    }

    const data = await response.json()
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Could not summarize.'
}
