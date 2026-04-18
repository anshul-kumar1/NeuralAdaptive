var toggleBtn = document.getElementById('toggleBtn')
var statusText = document.getElementById('statusText')
var recalibrateBtn = document.getElementById('recalibrateBtn')
var modeSelect = document.getElementById('modeSelect')
var calibrationText = document.getElementById('calibrationText')

function renderEnabled(enabled) {
    toggleBtn.textContent = enabled ? 'Turn OFF' : 'Turn ON'
    toggleBtn.classList.toggle('enabled', enabled)
    toggleBtn.classList.toggle('disabled', !enabled)
    toggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false')
    statusText.textContent = enabled ? 'Tracking is enabled for loaded pages.' : 'Tracking is disabled.'
    recalibrateBtn.disabled = !enabled
}

function renderCalibration(data) {
    if (!data || typeof data.calibrationMedianErrorPx !== 'number') {
        calibrationText.textContent = 'Calibration: not completed yet'
        return
    }
    calibrationText.textContent = 'Calibration median error: ' + data.calibrationMedianErrorPx + 'px'
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

function sendToActiveTab(message, callback) {
    queryActiveTab(function (tab) {
        if (!tab || !tab.id) {
            callback(false, 'No active tab')
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

function readState() {
    chrome.storage.local.get(['enabled', 'accuracyMode', 'calibrationMedianErrorPx'], function (data) {
        var enabled = !!(data && data.enabled)
        var mode = data && data.accuracyMode ? data.accuracyMode : 'balanced'
        renderEnabled(enabled)
        modeSelect.value = mode
        renderCalibration(data)
    })
}

toggleBtn.addEventListener('click', function () {
    chrome.storage.local.get(['enabled'], function (data) {
        var nextEnabled = !(data && data.enabled)
        chrome.storage.local.set({ enabled: nextEnabled }, function () {
            renderEnabled(nextEnabled)
            if (nextEnabled) {
                sendToActiveTab({ type: 'NA_SET_ENABLED', enabled: true }, function () { })
            } else {
                sendToActiveTab({ type: 'NA_SET_ENABLED', enabled: false }, function () { })
            }
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
            statusText.textContent = 'Recalibration failed: open a normal webpage and try again.'
            return
        }
        statusText.textContent = 'Recalibration completed.'
        chrome.storage.local.get(['calibrationMedianErrorPx'], function (data) {
            renderCalibration(data)
        })
    })
})

readState()
