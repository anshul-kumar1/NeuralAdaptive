//DOM manipulation on each page
// content.js — Phase 1 placeholder
// This script is injected into every page by the manifest content_scripts config.
// Phase 2 will add the DOM manipulation and intervention logic here.
//
// For now, just confirm it's loading and listening.

console.log('[NeuralAdaptive] content.js loaded on:', window.location.href)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'INTERVENTION') {
        console.log(
            `[NeuralAdaptive] Intervention received — tier: ${message.tier}, score: ${message.score.toFixed(2)}`,
            message.signals
        )
        sendResponse({ ok: true })
    }
})