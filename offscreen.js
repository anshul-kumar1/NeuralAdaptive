var state = {
  cameraRunning: false,
  baseline: null,
  noseYBuffer: [],
  bufferMax: 180,
  lastSendTime: 0,
  sendIntervalMs: 2000,
};

var landmarks = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
};

var video = document.getElementById("webcam-feed");
var debug = document.getElementById("debug-status");

function log(message) {
  console.log("[offscreen] " + message);
  if (debug) {
    debug.textContent = "[NeuralAdaptive] " + message;
  }
}

log("Script loaded, signaling OFFSCREEN_READY");
chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(function (error) {
  log("OFFSCREEN_READY failed: " + error.message);
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === "START_CAMERA") {
    log("START_CAMERA received");
    initCamera()
      .then(function () {
        sendResponse({ ok: true });
      })
      .catch(function (error) {
        log("Camera init failed: " + error.message);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "SET_BASELINE") {
    state.baseline = null;
    state.noseYBuffer = [];
    log("Baseline reset");
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function initCamera() {
  if (state.cameraRunning) {
    log("Camera already running");
    return;
  }

  var stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
  } catch (error) {
    throw new Error("getUserMedia failed: " + error.name + " " + error.message);
  }

  video.srcObject = stream;
  await video.play();
  initMediaPipe();
}

function initMediaPipe() {
  if (typeof Pose === "undefined") {
    log("Pose is undefined. Verify lib/pose.js exists.");
    return;
  }

  if (typeof Camera === "undefined") {
    log("Camera is undefined. Verify lib/camera_utils.js exists.");
    return;
  }

  var pose = new Pose({
    locateFile: function (file) {
      return chrome.runtime.getURL("lib/" + file);
    },
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  pose.onResults(onPoseResults);

  var camera = new Camera(video, {
    onFrame: async function () {
      await pose.send({ image: video });
    },
    width: 640,
    height: 480,
  });

  camera.start();
  state.cameraRunning = true;
  log("MediaPipe pose pipeline started");
}

function onPoseResults(results) {
  if (!results.poseLandmarks) {
    return;
  }

  var lm = results.poseLandmarks;
  var nose = lm[landmarks.NOSE];
  var leftShoulder = lm[landmarks.LEFT_SHOULDER];
  var rightShoulder = lm[landmarks.RIGHT_SHOULDER];

  if (
    nose.visibility < 0.5 ||
    leftShoulder.visibility < 0.5 ||
    rightShoulder.visibility < 0.5
  ) {
    return;
  }

  if (!state.baseline) {
    state.baseline = {
      noseY: nose.y,
      shoulderWidth: Math.abs(rightShoulder.x - leftShoulder.x),
    };
    log(
      "Baseline set noseY=" +
        nose.y.toFixed(3) +
        " shoulderWidth=" +
        state.baseline.shoulderWidth.toFixed(3)
    );
    return;
  }

  var slumpDelta = nose.y - state.baseline.noseY;
  var slumpScore = Math.min(Math.max(slumpDelta / 0.15, 0), 1);

  var currentShoulderWidth = Math.abs(rightShoulder.x - leftShoulder.x);
  var widthRatio = currentShoulderWidth / state.baseline.shoulderWidth;
  var leanScore = Math.min(Math.max(widthRatio - 1, 0) / 0.25, 1);

  state.noseYBuffer.push(nose.y);
  if (state.noseYBuffer.length > state.bufferMax) {
    state.noseYBuffer.shift();
  }

  var fixationScore = 0;
  if (state.noseYBuffer.length >= 10) {
    var mean =
      state.noseYBuffer.reduce(function (sum, y) {
        return sum + y;
      }, 0) / state.noseYBuffer.length;
    var variance =
      state.noseYBuffer.reduce(function (sum, y) {
        return sum + Math.pow(y - mean, 2);
      }, 0) / state.noseYBuffer.length;
    fixationScore = Math.min(Math.max(1 - variance / 0.0005, 0), 1);
  }

  var stressScore = Math.min(slumpScore * 0.4 + leanScore * 0.4 + fixationScore * 0.2, 1);

  var now = Date.now();
  if (now - state.lastSendTime < state.sendIntervalMs) {
    return;
  }
  state.lastSendTime = now;

  var signals = {
    slump: parseFloat(slumpScore.toFixed(3)),
    leanIn: parseFloat(leanScore.toFixed(3)),
    fixation: parseFloat(fixationScore.toFixed(3)),
  };

  chrome.runtime
    .sendMessage({
      type: "STRESS_SCORE",
      score: parseFloat(stressScore.toFixed(3)),
      signals: signals,
    })
    .catch(function (error) {
      console.warn("[offscreen] sendMessage failed: " + error.message);
    });
}
