var OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
var lastForwardTime = 0;

async function ensureOffscreenDocument() {
  var exists = await chrome.offscreen.hasDocument();
  if (exists) {
    console.log("[background] Offscreen document already exists");
    return;
  }

  console.log("[background] Creating offscreen document");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Camera feed for MediaPipe Pose",
  });
  console.log("[background] Offscreen document created");
}

chrome.runtime.onInstalled.addListener(async function () {
  console.log("[background] onInstalled");
  await ensureOffscreenDocument();
});

chrome.runtime.onStartup.addListener(async function () {
  console.log("[background] onStartup");
  await ensureOffscreenDocument();
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === "OFFSCREEN_READY") {
    console.log("[background] OFFSCREEN_READY received; sending START_CAMERA");
    chrome.runtime.sendMessage({ type: "START_CAMERA" }).catch(function (error) {
      console.error("[background] START_CAMERA failed: " + error.message);
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "STRESS_SCORE") {
    handleStressScore(message)
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (error) {
        console.error("[background] handleStressScore failed: " + error.message);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "SUMMARIZE_PARAGRAPH") {
    callGemini(message.text)
      .then(function (summary) {
        sendResponse({ summary: summary });
      })
      .catch(function (error) {
        sendResponse({ summary: null, error: error.message });
      });
    return true;
  }

  if (message.type === "SET_BASELINE") {
    chrome.runtime.sendMessage({ type: "SET_BASELINE" }).catch(function () {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function handleStressScore(message) {
  var score = message.score;
  var signals = message.signals;
  var now = Date.now();
  var tier = score < 0.3 ? "CALM" : score < 0.6 ? "ELEVATED" : "OVERLOAD";

  await chrome.storage.local.set({
    currentScore: score,
    currentTier: tier,
    signals: signals,
    lastUpdated: now,
  });

  if (now - lastForwardTime < 2000) {
    return;
  }
  lastForwardTime = now;

  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var activeTab = tabs[0];
  if (!activeTab || !activeTab.id) {
    return;
  }
  if (!activeTab.url || activeTab.url.indexOf("http") !== 0) {
    return;
  }

  console.log(
    "[background] Forwarding intervention to tab " + activeTab.id +
      " tier=" + tier + " score=" + score
  );

  chrome.tabs
    .sendMessage(activeTab.id, {
      type: "INTERVENTION",
      tier: tier,
      score: score,
      signals: signals,
    })
    .catch(function (error) {
      console.warn("[background] Tab message failed: " + error.message);
    });
}

var GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";
var GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
  GEMINI_API_KEY;

async function callGemini(paragraphText) {
  var prompt =
    "Summarize this paragraph into exactly 3 bullet points, each under 12 words. Return ONLY the bullets.\n\n" +
    paragraphText;

  var response = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 150 },
    }),
  });

  if (!response.ok) {
    throw new Error("Gemini status " + response.status);
  }

  var data = await response.json();
  return data.candidates[0].content.parts[0].text;
}
