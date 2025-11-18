// Popup script for controlling the extension

let currentTabId = null;
let isRecording = false;
let recordingMode = 'video'; // 'logs' or 'video' - Default to 'video' for video + logs feature
let videoRecordingStartTime = null;
let videoDurationInterval = null;

document.addEventListener('DOMContentLoaded', async () => {
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
			showPageInfo(`Ready to record: ${hostname}`);
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

	// Update stats every 2 seconds while popup is open
	setInterval(updateStats, 2000);
});

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
		tab.classList.remove('active');
	});

	if (mode === 'logs') {
		document.getElementById('logModeTab').classList.add('active');
		document.getElementById('videoInfoCard').style.display = 'none';
		showPageInfo('Logs mode: Network + Interactions recording');
	} else {
		document.getElementById('videoModeTab').classList.add('active');
		showPageInfo('Video mode: Screen recording + Network + Interactions');
	}
}

function showPageInfo(message, isError = false) {
	const pageInfo = document.getElementById('pageInfo');
	pageInfo.textContent = message;
	pageInfo.style.color = isError ? '#ef4444' : 'inherit';
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
			document.getElementById('networkCount').textContent = response.networkLogsCount || 0;
		}
	} catch (error) {
		// Silently fail
	}

	try {
		const result = await chrome.storage.local.get(['interactionLogs', 'elementSnapshots']);
		if (!chrome.runtime.lastError) {
			const interactionLogs = result.interactionLogs || [];
			const elementSnapshots = result.elementSnapshots || [];

			document.getElementById('interactionCount').textContent = interactionLogs.length;
			document.getElementById('snapshotCount').textContent = elementSnapshots.length;
		}
	} catch (error) {
		// Silently fail
	}
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

// Check if content script is injected
async function isContentScriptInjected(tabId) {
	try {
		const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
		return response && response.pong === true;
	} catch (error) {
		return false;
	}
}

// Inject content script programmatically
async function injectContentScript(tabId) {
	try {
		const injected = await isContentScriptInjected(tabId);
		if (injected) {
			console.log('Content script already injected');
			return true;
		}

		await chrome.scripting.executeScript({
			target: { tabId: tabId },
			files: ['content.js']
		});

		console.log('Content script injected successfully');
		await new Promise(resolve => setTimeout(resolve, 300));
		return true;
	} catch (error) {
		console.error('Failed to inject content script:', error);
		return false;
	}
}

async function startRecording() {
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		currentTabId = tab.id;

		if (isRestrictedPage(tab.url)) {
			showNotification('Cannot record on browser internal pages', 'error');
			return;
		}

		// Start based on mode
		if (recordingMode === 'video') {
			await startVideoRecording();
		} else {
			await startLogsRecording();
		}

		updateStatus();
	} catch (error) {
		console.error('Failed to start recording:', error);
		showNotification('Failed to start: ' + error.message, 'error');
	}
}

async function startLogsRecording() {
	// Start network recording
	const response = await chrome.runtime.sendMessage({
		action: 'startRecording',
		tabId: currentTabId
	});

	if (!response || !response.success) {
		throw new Error(response?.error || 'Failed to start network recording');
	}

	// Inject and start interaction recording
	const injected = await injectContentScript(currentTabId);

	if (injected) {
		try {
			await chrome.tabs.sendMessage(currentTabId, {
				action: 'startInteractionRecording'
			});
			showNotification('Recording started (network + interactions)', 'success');
		} catch (error) {
			console.warn('Could not start interaction recording:', error.message);
			showNotification('Recording started (network only)', 'success');
		}
	} else {
		showNotification('Recording started (network only)', 'success');
	}
}

async function startVideoRecording() {
	try {
		console.log('[Popup] Starting video recording for tab:', currentTabId);
		
		// Check if there's an existing stream and clean it up first
		// This prevents "Cannot capture a tab with an active stream" error
		try {
			const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
			if (status && status.isRecording) {
				console.log('[Popup] Existing recording detected, stopping it first...');
				await chrome.runtime.sendMessage({
					action: 'stopRecording',
					tabId: currentTabId
				});
				await chrome.runtime.sendMessage({
					action: 'stopVideoCapture',
					tabId: currentTabId
				});
				// Wait a bit for cleanup
				await new Promise(resolve => setTimeout(resolve, 500));
			}
		} catch (cleanupError) {
			console.warn('[Popup] Error during cleanup:', cleanupError);
			// Continue anyway
		}
		
		// Start video capture first
		console.log('[Popup] Starting video capture...');
		const videoResponse = await chrome.runtime.sendMessage({
			action: 'startVideoCapture',
			tabId: currentTabId
		});

		console.log('[Popup] Video capture response:', videoResponse);

		if (!videoResponse || !videoResponse.success) {
			throw new Error(videoResponse?.error || 'Failed to start video recording');
		}

		// Start network recording
		console.log('[Popup] Starting network recording...');
		const networkResponse = await chrome.runtime.sendMessage({
			action: 'startRecording',
			tabId: currentTabId
		});

		if (!networkResponse || !networkResponse.success) {
			// Stop video if network recording fails
			console.error('[Popup] Network recording failed, stopping video...');
			await chrome.runtime.sendMessage({
				action: 'stopVideoCapture',
				tabId: currentTabId
			});
			throw new Error(networkResponse?.error || 'Failed to start network recording');
		}

		// Inject and start interaction recording
		console.log('[Popup] Starting interaction recording...');
		const injected = await injectContentScript(currentTabId);

		if (injected) {
			try {
				await chrome.tabs.sendMessage(currentTabId, {
					action: 'startInteractionRecording'
				});
				console.log('[Popup] Interaction recording started');
			} catch (error) {
				console.warn('[Popup] Could not start interaction recording:', error.message);
				// Continue - network recording is more important
			}
		} else {
			console.warn('[Popup] Could not inject content script');
		}

		// Update UI state - wait a bit for background state to update
		isRecording = true;
		
		// Show video info card and start duration timer
		document.getElementById('videoInfoCard').style.display = 'flex';
		videoRecordingStartTime = Date.now();
		videoDurationInterval = setInterval(updateVideoDuration, 1000);

		// Wait a moment for background state to update, then update button states
		await new Promise(resolve => setTimeout(resolve, 200));
		updateStatus();
		
		showNotification('Video recording started (video + network + interactions)', 'success');
		console.log('[Popup] Video recording started successfully');
	} catch (error) {
		console.error('[Popup] Error starting video recording:', error);
		showNotification('Failed to start video recording: ' + error.message, 'error');
		
		// Reset UI state on error
		isRecording = false;
		updateStatus();
		
		// Don't throw error to prevent popup from closing
		return;
	}
}

async function stopRecording() {
	try {
		if (recordingMode === 'video') {
			showNotification('Processing video... Please wait', 'success');

			// Stop video capture
			await chrome.runtime.sendMessage({
				action: 'stopVideoCapture',
				tabId: currentTabId
			});

			// Stop duration timer
			if (videoDurationInterval) {
				clearInterval(videoDurationInterval);
				videoDurationInterval = null;
			}
			videoRecordingStartTime = null;
			document.getElementById('videoInfoCard').style.display = 'none';
		}

		// Stop network recording
		await chrome.runtime.sendMessage({
			action: 'stopRecording',
			tabId: currentTabId
		});

		// Stop interaction recording
		try {
			await chrome.tabs.sendMessage(currentTabId, {
				action: 'stopInteractionRecording'
			});
		} catch (error) {
			console.warn('Could not stop interaction recording:', error.message);
		}

		updateStatus();
		showNotification('Recording stopped - Video processed successfully!', 'success');
	} catch (error) {
		console.error('Failed to stop recording:', error);
		showNotification('Failed to stop: ' + error.message, 'error');
	}
}

async function captureElements() {
	try {
		const injected = await injectContentScript(currentTabId);

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
		await chrome.runtime.sendMessage({
			action: 'exportLogs',
			tabId: currentTabId,
			mode: recordingMode
		});

		if (recordingMode === 'video') {
			showNotification('Exporting video + timeline HTML...', 'success');
		} else {
			showNotification('JSON and timeline HTML exported!', 'success');
		}
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

	if (confirm('Are you sure you want to clear all logs? This cannot be undone.')) {
		try {
			await chrome.runtime.sendMessage({ action: 'clearLogs' });
			showNotification('All logs cleared', 'success');
			setTimeout(updateStats, 300);
		} catch (error) {
			showNotification('Failed to clear logs', 'error');
		}
	}
}

function showNotification(message, type = 'success') {
	// Remove existing notifications
	const existing = document.querySelectorAll('.notification');
	existing.forEach(n => n.remove());

	const notification = document.createElement('div');
	notification.className = `notification ${type}`;
	notification.textContent = message;
	document.body.appendChild(notification);

	setTimeout(() => {
		notification.style.opacity = '0';
		setTimeout(() => notification.remove(), 300);
	}, 3000);
}