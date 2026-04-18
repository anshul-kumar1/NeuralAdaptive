// background.js
// Much simpler now. No offscreen document needed.
// WebGazer runs inside content.js on the reading page.
// This file just routes summarization requests to Gemini.
console.log('[NeuralAdaptive v2.0.13] background service worker loaded')

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {

    if (message.type === 'SUMMARIZE_PARAGRAPH') {
        callGemini(message.text).then(function (summary) {
            sendResponse({ summary: summary })
        }).catch(function (err) {
            sendResponse({ summary: null, error: err.message })
        })
        return true
    }

    if (message.type === 'STRESS_SCORE') {
        var score = message.score
        var signals = message.signals
        var tier = score < 0.3 ? 'CALM' : score < 0.6 ? 'ELEVATED' : 'OVERLOAD'
        chrome.storage.local.set({
            currentScore: score,
            currentTier: tier,
            signals: signals,
            lastUpdated: Date.now()
        })
        sendResponse({ ok: true })
        return false
    }

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
