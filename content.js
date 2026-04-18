console.log("[NeuralAdaptive] content.js loaded on: " + window.location.href);

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === "INTERVENTION") {
    console.log(
      "[NeuralAdaptive] Intervention received. tier=" +
        message.tier +
        " score=" +
        Number(message.score || 0).toFixed(2)
    );
    console.log("[NeuralAdaptive] Signals:", message.signals);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
