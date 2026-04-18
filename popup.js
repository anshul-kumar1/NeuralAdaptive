var toggleBtn = document.getElementById('toggleBtn')
var progressBarBtn = document.getElementById('progressBarBtn')
var statusText = document.getElementById('statusText')
var recalibrateBtn = document.getElementById('recalibrateBtn')
var poseCalibrateBtn = document.getElementById('poseCalibrateBtn')
var modeSelect = document.getElementById('modeSelect')
var calibrationText = document.getElementById('calibrationText')
var poseCalibrationText = document.getElementById('poseCalibrationText')
var liveStale = document.getElementById('liveStale')
var mMeasurement = document.getElementById('mMeasurement')
var mReading = document.getElementById('mReading')
var mDegradation = document.getElementById('mDegradation')
var mSnap = document.getElementById('mSnap')
var mBlocked = document.getElementById('mBlocked')
var sJitter = document.getElementById('sJitter')
var sLineErr = document.getElementById('sLineErr')
var sFalse = document.getElementById('sFalse')
var livePollTimer = null

function renderEnabled(enabled) {
    toggleBtn.textContent = enabled ? 'Turn OFF' : 'Turn ON'
    toggleBtn.classList.toggle('enabled', enabled)
    toggleBtn.classList.toggle('disabled', !enabled)
    toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false')
    statusText.textContent = enabled ? 'Tracking is enabled for loaded pages.' : 'Tracking is disabled.'
    recalibrateBtn.disabled = !enabled
    poseCalibrateBtn.disabled = !enabled
}

function renderProgressBar(active) {
    progressBarBtn.textContent = active ? 'Reading Progress: ON' : 'Reading Progress: OFF'
    progressBarBtn.classList.toggle('enabled', active)
    progressBarBtn.setAttribute('aria-pressed', active ? 'true' : 'false')
}

function renderCalibration(data) {
    if (!data || typeof data.calibrationMedianErrorPx !== 'number') {
        calibrationText.textContent = 'Calibration: not completed yet'
        return
    }
    calibrationText.textContent = 'Calibration median error: ' + data.calibrationMedianErrorPx + 'px'
}

function renderPoseCalibration(data) {
    if (!data || typeof data.poseCalibrationQualityScore !== 'number') {
        poseCalibrationText.textContent = 'Pose calibration: not completed yet'
        return
    }
    var quality = Math.round(data.poseCalibrationQualityScore)
    poseCalibrationText.textContent = 'Pose calibration quality: ' + quality + '%'
}

function queryActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs || !tabs.length) {
            callback(null)
            return
        }
        callback(tabs[0])
    })
}

function isInjectableTab(tab) {
    if (!tab || !tab.url) return false
    return /^https?:\/\//i.test(tab.url)
}

function sendToActiveTab(message, callback) {
    queryActiveTab(function (tab) {
        if (!tab || !tab.id) {
            callback(false, 'No active tab')
            return
        }
        if (!isInjectableTab(tab)) {
            callback(false, 'Unsupported page. Open a normal http(s) webpage.')
            return
        }
        chrome.tabs.sendMessage(tab.id, message, function (response) {
            if (chrome.runtime.lastError) {
                callback(false, chrome.runtime.lastError.message || 'No receiver')
                return
            }
            callback(true, response)
        })
    })
}

function setMetricColor(el, mode) {
    el.classList.remove('good', 'warn', 'bad')
    if (mode) el.classList.add(mode)
}

function renderLiveMetrics(data) {
    if (!data) return
    var now = Date.now()
    var stale = !data.ts || now - data.ts > 2000
    liveStale.textContent = stale ? 'Live: stale' : 'Live: active'
    setMetricColor(liveStale, stale ? 'warn' : 'good')

    mMeasurement.textContent = typeof data.measurementRatio === 'number' ? data.measurementRatio.toFixed(3) : '--'
    mReading.textContent = typeof data.readingScore === 'number' ? data.readingScore.toFixed(3) : '--'
    mDegradation.textContent = typeof data.degradationScore === 'number' ? data.degradationScore.toFixed(3) : '--'
    mSnap.textContent = typeof data.snapDistancePx === 'number' ? data.snapDistancePx.toFixed(1) : '--'
    mBlocked.textContent = data.interventionBlocked ? 'true' : 'false'

    setMetricColor(mMeasurement, data.measurementRatio >= 0.85 ? 'good' : (data.measurementRatio >= 0.7 ? 'warn' : 'bad'))
    setMetricColor(mReading, data.readingScore >= 0.55 ? 'good' : (data.readingScore >= 0.42 ? 'warn' : 'bad'))
    setMetricColor(mDegradation, data.degradationScore <= 0.5 ? 'good' : (data.degradationScore <= 0.8 ? 'warn' : 'bad'))
    setMetricColor(mSnap, data.snapDistancePx <= 20 ? 'good' : (data.snapDistancePx <= 42 ? 'warn' : 'bad'))
    setMetricColor(mBlocked, data.interventionBlocked ? 'warn' : 'good')
}

function renderSessionMetrics(data) {
    if (!data) return
    sJitter.textContent = typeof data.medianJitterPx === 'number' ? data.medianJitterPx.toFixed(2) : '--'
    sLineErr.textContent = typeof data.lineSwitchErrorRate === 'number' ? (data.lineSwitchErrorRate * 100).toFixed(1) + '%' : '--'
    sFalse.textContent = typeof data.interventionFalseTriggerRate === 'number' ? (data.interventionFalseTriggerRate * 100).toFixed(1) + '%' : '--'

    setMetricColor(sJitter, data.medianJitterPx <= 22 ? 'good' : (data.medianJitterPx <= 35 ? 'warn' : 'bad'))
    setMetricColor(sLineErr, data.lineSwitchErrorRate <= 0.18 ? 'good' : (data.lineSwitchErrorRate <= 0.32 ? 'warn' : 'bad'))
    setMetricColor(sFalse, data.interventionFalseTriggerRate <= 0.2 ? 'good' : (data.interventionFalseTriggerRate <= 0.35 ? 'warn' : 'bad'))
}

function pollMetrics() {
    sendToActiveTab({ type: 'NA_GET_PRECISION_LIVE' }, function (ok, response) {
        if (!ok) return
        renderLiveMetrics(response)
    })
    sendToActiveTab({ type: 'NA_GET_SESSION_METRICS' }, function (ok, response) {
        if (!ok) return
        renderSessionMetrics(response)
    })
}

function readState() {
    chrome.storage.local.get(['enabled', 'accuracyMode', 'calibrationMedianErrorPx', 'poseCalibrationQualityScore', 'readingProgress'], function (data) {
        var enabled = !!(data && data.enabled)
        var mode = data && data.accuracyMode ? data.accuracyMode : 'balanced'
        renderEnabled(enabled)
        renderProgressBar(!!(data && data.readingProgress))
        modeSelect.value = mode
        renderCalibration(data)
        renderPoseCalibration(data)
        if (livePollTimer) clearInterval(livePollTimer)
        livePollTimer = setInterval(pollMetrics, 500)
        pollMetrics()
    })
}

toggleBtn.addEventListener('click', function () {
    chrome.storage.local.get(['enabled'], function (data) {
        var nextEnabled = !(data && data.enabled)
        chrome.storage.local.set({ enabled: nextEnabled }, function () {
            renderEnabled(nextEnabled)
            sendToActiveTab({ type: 'NA_SET_ENABLED', enabled: nextEnabled }, function (ok) {
                if (!ok && nextEnabled) {
                    statusText.textContent = 'Enabled globally. Open a normal website to start.'
                }
            })
        })
    })
})

progressBarBtn.addEventListener('click', function () {
    chrome.storage.local.get(['readingProgress'], function (data) {
        var next = !(data && data.readingProgress)
        chrome.storage.local.set({ readingProgress: next }, function () {
            renderProgressBar(next)
            sendToActiveTab({ type: 'NA_SET_READING_PROGRESS', readingProgress: next }, function (ok) {
                if (!ok) {
                    statusText.textContent = next
                        ? 'Reading Progress set. Open a normal webpage to see it.'
                        : 'Reading Progress off.'
                } else {
                    statusText.textContent = next
                        ? 'Reading Progress on — bar visible at top of page.'
                        : 'Reading Progress off.'
                }
            })
        })
    })
})

modeSelect.addEventListener('change', function () {
    var mode = modeSelect.value
    chrome.storage.local.set({ accuracyMode: mode }, function () {
        statusText.textContent = 'Accuracy mode set to ' + (mode === 'precision' ? 'Precision' : 'Balanced') + '.'
    })
})

recalibrateBtn.addEventListener('click', function () {
    recalibrateBtn.disabled = true
    statusText.textContent = 'Starting recalibration on active tab...'
    sendToActiveTab({ type: 'NA_RECALIBRATE' }, function (ok, response) {
        recalibrateBtn.disabled = false
        if (!ok) {
            statusText.textContent = 'Recalibration requires an http(s) page with tracking enabled.'
            return
        }
        statusText.textContent = 'Recalibration completed.'
        chrome.storage.local.get(['calibrationMedianErrorPx', 'poseCalibrationQualityScore'], function (data) {
            renderCalibration(data)
            renderPoseCalibration(data)
        })
    })
})

poseCalibrateBtn.addEventListener('click', function () {
    poseCalibrateBtn.disabled = true
    statusText.textContent = 'Starting nose + pose calibration...'
    sendToActiveTab({ type: 'NA_POSE_CALIBRATE' }, function (ok, response) {
        poseCalibrateBtn.disabled = false
        if (!ok || !response || !response.ok) {
            var reason = response && response.error ? response.error : null
            statusText.textContent = reason ? ('Pose calibration failed: ' + reason) : 'Pose calibration requires an http(s) page with tracking enabled.'
            return
        }
        statusText.textContent = 'Nose + pose calibration completed.'
        chrome.storage.local.get(['poseCalibrationQualityScore'], function (data) {
            renderPoseCalibration(data)
        })
    })
})

readState()

window.addEventListener('unload', function () {
    if (livePollTimer) clearInterval(livePollTimer)
})
