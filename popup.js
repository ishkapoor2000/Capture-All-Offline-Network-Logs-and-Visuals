// Popup script for controlling the extension

let currentTabId = null;
let isRecording = false;
let recordingMode = 'video'; // 'logs' or 'video' - Default to 'video' for video + logs feature
let videoRecordingStartTime = null;
let videoDurationInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
	// The version Chrome actually loaded - shows at a glance whether a Reload picked up new code.
	document.getElementById('extVersion').textContent = 'v' + chrome.runtime.getManifest().version;

	if (await applyPendingUpdate()) return;

	// Get current tab
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	currentTabId = tab.id;

	// Check if it's a recordable page
	if (isRestrictedPage(tab.url)) {
		document.getElementById('startBtn').disabled = true;
		document.getElementById('captureBtn').disabled = true;
		showPageInfo('Cannot record on browser internal pages', true);
	} else {
		try {
			const hostname = new URL(tab.url).hostname;
			showPageInfo(`Ready to record ${hostname}`);
		} catch (e) {
			showPageInfo('Ready to record');
		}
	}

	// Set up mode tab listeners
	document.getElementById('logModeTab').addEventListener('click', () => switchMode('logs'));
	document.getElementById('videoModeTab').addEventListener('click', () => switchMode('video'));

	// Set initial mode to video (default)
	switchMode('video');

	// Update initial status
	updateStatus();
	updateStats();

	// Set up button listeners
	document.getElementById('startBtn').addEventListener('click', startRecording);
	document.getElementById('stopBtn').addEventListener('click', stopRecording);
	document.getElementById('captureBtn').addEventListener('click', captureElements);
	document.getElementById('exportBtn').addEventListener('click', exportLogs);
	document.getElementById('clearBtn').addEventListener('click', clearLogs);

	// Refresh status (button states) and stats every 2 seconds while the popup is open, so
	// the UI stays correct even if the recording state changes underneath it.
	setInterval(() => {
		updateStatus();
		updateStats();
	}, 2000);
});

/**
 * Unpacked installs: Chrome reads this popup from disk on every open but keeps running the
 * background it loaded at the last Reload, so after the files change the new popup talks to an
 * old background ("Unknown action"). Reload the extension when the version on disk differs.
 * @returns {Promise<boolean>} true when a reload was started (the popup is about to close)
 */
async function applyPendingUpdate() {
	try {
		const onDisk = await (await fetch(chrome.runtime.getURL('manifest.json'))).json();
		if (onDisk.version === chrome.runtime.getManifest().version) return false;

		const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
		if (status && status.isRecording) {
			// Never interrupt a recording; the update applies on the next open after Stop.
			showNotification(`Update to v${onDisk.version} ready - it applies after you stop`, 'success');
			return false;
		}

		showNotification(`Updating Capture All to v${onDisk.version}...`, 'success');
		setTimeout(() => chrome.runtime.reload(), 600);
		return true;
	} catch (error) {
		return false;
	}
}

function isRestrictedPage(url) {
	return url.startsWith('chrome://') ||
		url.startsWith('chrome-extension://') ||
		url.startsWith('edge://') ||
		url.startsWith('about:') ||
		url.startsWith('view-source:');
}

function switchMode(mode) {
	if (isRecording) {
		showNotification('Stop recording before switching modes', 'error');
		return;
	}

	recordingMode = mode;

	// Update tab styling
	document.querySelectorAll('.mode-tab').forEach(tab => {
		tab.classList.toggle('active', tab.dataset.mode === mode);
		tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
	});

	if (mode === 'logs') {
		document.getElementById('videoInfoCard').style.display = 'none';
		showPageInfo('Records network requests and interactions');
	} else {
		showPageInfo('Records the tab as video, plus requests and interactions');
	}
}

function showPageInfo(message, isError = false) {
	const pageInfo = document.getElementById('pageInfo');
	pageInfo.textContent = message;
	pageInfo.classList.toggle('is-error', isError);
}

async function updateStatus() {
	try {
		const response = await chrome.runtime.sendMessage({ action: 'getStatus' });

		if (chrome.runtime.lastError) {
			console.warn('Could not get status:', chrome.runtime.lastError);
			return;
		}

		if (response) {
			isRecording = response.isRecording;
			const statusDot = document.getElementById('statusDot');
			const statusText = document.getElementById('statusText');
			const startBtn = document.getElementById('startBtn');
			const stopBtn = document.getElementById('stopBtn');

			if (isRecording) {
				statusDot.classList.add('recording');
				statusText.textContent = 'Recording';
				startBtn.disabled = true;
				stopBtn.disabled = false;
			} else {
				statusDot.classList.remove('recording');
				statusText.textContent = 'Ready';
				startBtn.disabled = false;
				stopBtn.disabled = true;
			}
		}
	} catch (error) {
		console.error('Error updating status:', error);
	}
}

async function updateStats() {
	try {
		const response = await chrome.runtime.sendMessage({ action: 'getStatus' });
		if (response && !chrome.runtime.lastError) {
			setCount('networkCount', response.networkLogsCount || 0);
		}
	} catch (error) {
		// Silently fail
	}

	try {
		const result = await chrome.storage.local.get(['interactionLogs', 'elementSnapshots']);
		if (!chrome.runtime.lastError) {
			const interactionLogs = result.interactionLogs || [];
			const elementSnapshots = result.elementSnapshots || [];

			setCount('interactionCount', interactionLogs.length);
			setCount('snapshotCount', elementSnapshots.length);
		}
	} catch (error) {
		// Silently fail
	}
}

function setCount(id, value) {
	const el = document.getElementById(id);
	if (el.textContent === String(value)) return;
	el.textContent = value;
	el.classList.remove('bump');
	void el.offsetWidth; // restart the animation
	el.classList.add('bump');
}

function updateVideoDuration() {
	if (!videoRecordingStartTime) return;

	const elapsed = Date.now() - videoRecordingStartTime;
	const minutes = Math.floor(elapsed / 60000);
	const seconds = Math.floor((elapsed % 60000) / 1000);

	document.getElementById('videoDuration').textContent =
		`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

	// Update size estimate (rough estimate: 1MB per 10 seconds)
	const estimatedSizeMB = Math.round((elapsed / 10000) * 10) / 10;
	document.getElementById('videoSize').textContent = `~${estimatedSizeMB} MB`;
}

async function startRecording() {
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		currentTabId = tab.id;

		if (isRestrictedPage(tab.url)) {
			showNotification('Cannot record on browser internal pages', 'error');
			return;
		}

		// The background runs the whole sequence, so closing the popup right away is safe.
		const response = await chrome.runtime.sendMessage({
			action: 'startSession',
			tabId: currentTabId,
			mode: recordingMode
		});

		if (!response || !response.success) {
			throw new Error(response?.error || 'Failed to start recording');
		}

		isRecording = true;
		if (recordingMode === 'video') {
			document.getElementById('videoInfoCard').style.display = 'flex';
			videoRecordingStartTime = Date.now();
			videoDurationInterval = setInterval(updateVideoDuration, 1000);
		}
		updateStatus();

		const parts = recordingMode === 'video' ? ['video', 'network'] : ['network'];
		if (response.interactions) parts.push('interactions');
		showNotification(`Recording started (${parts.join(' + ')})`, 'success');
	} catch (error) {
		console.error('Failed to start recording:', error);
		showNotification('Failed to start: ' + error.message, 'error');
		isRecording = false;
		updateStatus();
	}
}

async function stopRecording() {
	try {
		if (recordingMode === 'video') {
			showNotification('Processing video... Please wait', 'success');
		}

		const result = await chrome.runtime.sendMessage({
			action: 'stopSession',
			tabId: currentTabId
		});

		if (!result || !result.success) {
			throw new Error(result?.error || 'Failed to stop recording');
		}

		if (videoDurationInterval) {
			clearInterval(videoDurationInterval);
			videoDurationInterval = null;
		}
		videoRecordingStartTime = null;
		document.getElementById('videoInfoCard').style.display = 'none';

		updateStatus();

		if (result.mode === 'video' && !result.stored) {
			showNotification('Recording stopped, but video may not have saved. Check and try again.', 'error');
		} else if (result.mode === 'video') {
			showNotification('Recording stopped. Video saved', 'success');
		} else {
			showNotification('Recording stopped', 'success');
		}
	} catch (error) {
		console.error('Failed to stop recording:', error);
		showNotification('Failed to stop: ' + error.message, 'error');
	}
}

async function captureElements() {
	try {
		const response = await chrome.runtime.sendMessage({
			action: 'ensureContentScript',
			tabId: currentTabId
		});
		const injected = response && response.success;

		if (!injected) {
			showNotification('Failed to inject content script', 'error');
			return;
		}

		await chrome.tabs.sendMessage(currentTabId, {
			action: 'captureElements'
		});
		showNotification('Elements captured', 'success');
		setTimeout(updateStats, 500);
	} catch (error) {
		console.warn('Could not capture elements:', error);
		showNotification('Failed to capture elements', 'error');
	}
}

async function exportLogs() {
	try {
		showNotification('Preparing .zip export...', 'success');
		const response = await chrome.runtime.sendMessage({
			action: 'exportLogs',
			tabId: currentTabId,
			mode: recordingMode
		});

		if (!response || !response.success) {
			throw new Error(response?.error || 'Export failed');
		}
		showNotification('Export ready - choose where to save the .zip', 'success');
	} catch (error) {
		console.error('Export failed:', error);
		showNotification('Export failed: ' + error.message, 'error');
	}
}

async function clearLogs() {
	if (isRecording) {
		showNotification('Stop recording before clearing logs', 'error');
		return;
	}

	// Two-step confirm inline instead of a blocking confirm() dialog.
	const clearBtn = document.getElementById('clearBtn');
	const label = clearBtn.querySelector('span');
	if (!clearArmedTimer) {
		clearBtn.classList.add('armed');
		label.textContent = 'Click to confirm';
		clearArmedTimer = setTimeout(disarmClear, 3000);
		return;
	}
	disarmClear();

	try {
		await chrome.runtime.sendMessage({ action: 'clearLogs' });
		showNotification('All logs cleared', 'success');
		setTimeout(updateStats, 300);
	} catch (error) {
		showNotification('Failed to clear logs', 'error');
	}
}

let clearArmedTimer = null;

function disarmClear() {
	clearTimeout(clearArmedTimer);
	clearArmedTimer = null;
	const clearBtn = document.getElementById('clearBtn');
	clearBtn.classList.remove('armed');
	clearBtn.querySelector('span').textContent = 'Clear';
}

function showNotification(message, type = 'success') {
	// Remove existing notifications
	const existing = document.querySelectorAll('.notification');
	existing.forEach(n => n.remove());

	const notification = document.createElement('div');
	notification.className = `notification ${type}`;
	notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
	notification.textContent = message;
	document.body.appendChild(notification);

	setTimeout(() => {
		notification.style.opacity = '0';
		setTimeout(() => notification.remove(), 300);
	}, 3000);
}