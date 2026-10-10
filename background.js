// Background service worker for network logging, video capture, and debugger attachment
// This file handles:
// - Network request logging via Chrome Debugger API
// - Video recording coordination (uses offscreen document for MediaRecorder)
// - User interaction logging (receives from content script)
// - Export functionality (JSON + HTML timeline with optional video)

// Video storage functions are defined inline in this file (IndexedDB helpers)
// This approach is more reliable than using importScripts() and avoids potential timing issues

let isRecording = false;
let networkLogs = [];
let attachedTabs = new Set();
let debuggerListenerAdded = false;

// Video recording state
// Note: We no longer store videoBlob in memory - it's stored in IndexedDB
let videoStartTime = null;
let currentRecordingTabId = null;
let videoBlob = null; // Kept for backward compatibility, but prefer IndexedDB

// Initialize debugger event listeners
function initializeDebuggerListeners() {
    if (debuggerListenerAdded) return;

    try {
        if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onEvent) {
            chrome.debugger.onEvent.addListener(onDebuggerEvent);
            debuggerListenerAdded = true;
            console.log('Debugger event listener initialized');
        }
    } catch (error) {
        console.error('Failed to initialize debugger listeners:', error);
    }

    try {
        if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
            chrome.debugger.onDetach.addListener((source, reason) => {
                console.log('Debugger detached:', reason);
                if (attachedTabs.has(source.tabId)) {
                    attachedTabs.delete(source.tabId);
                    isRecording = false;
                }
            });
        }
    } catch (error) {
        console.error('Failed to initialize debugger detachment listener:', error);
    }
}

initializeDebuggerListeners();

// ============================================================================
// Persistent recording state (survives MV3 service-worker restarts)
// MV3 service workers are ephemeral: module-level vars like isRecording are lost when the
// worker is torn down mid-recording, which made the popup show "Ready" (Stop disabled) while
// the offscreen document kept recording. We mirror the essential state into chrome.storage
// so the popup and Stop keep working across restarts, and rehydrate the module vars on wake.
// ============================================================================

async function setRecordingState(patch) {
    try {
        const { recordingState } = await chrome.storage.local.get(['recordingState']);
        const next = { ...(recordingState || {}), ...patch };
        await chrome.storage.local.set({ recordingState: next });
    } catch (e) {
        console.warn('[State] Failed to persist recording state:', e);
    }
}

async function clearRecordingState() {
    try {
        await chrome.storage.local.remove(['recordingState']);
    } catch (e) {
        console.warn('[State] Failed to clear recording state:', e);
    }
}

async function restoreRecordingState() {
    try {
        const { recordingState } = await chrome.storage.local.get(['recordingState']);
        if (recordingState && recordingState.isRecording) {
            isRecording = true;
            currentRecordingTabId = recordingState.tabId ?? null;
            videoStartTime = recordingState.startTime ?? null;
            // If the debugger was attached before the restart it stays attached to the tab,
            // so re-track it to keep logging network events and to allow a clean detach.
            if (recordingState.debuggerAttached && recordingState.tabId != null) {
                attachedTabs.add(recordingState.tabId);
            }
            console.log('[State] Restored recording state after SW restart:', recordingState);
        }
    } catch (e) {
        console.warn('[State] Failed to restore recording state:', e);
    }
}

restoreRecordingState();


/**
 * Creates or reuses an offscreen document for video recording
 * Offscreen documents are needed because service workers can't use MediaRecorder directly
 * This function includes retry logic to handle timing issues
 * 
 * @param {string} streamId - The media stream ID from tabCapture API
 * @param {number} tabId - The tab ID being recorded
 * @returns {Promise<void>}
 */
async function createOffscreenDocument(streamId, tabId) {
    try {
        await ensureOffscreenDocument(['USER_MEDIA'], 'Recording screen for session replay');
        const response = await sendToOffscreen({
            type: 'start-recording',
            target: 'offscreen',
            data: { streamId, tabId }
        });
        // The offscreen document reports whether MediaRecorder actually started.
        // A delivered message is not enough - surface a real recording failure.
        if (response && response.success === false) {
            throw new Error(response.error || 'Offscreen document failed to start recording');
        }
        console.log('[Video] Recording message sent successfully to offscreen document');
    } catch (error) {
        console.error('[Video] Error creating/communicating with offscreen document:', error);
        throw error;
    }
}

/**
 * Creates the offscreen document if none exists (only one may exist at a time) and waits
 * for offscreen.js to load.
 * @param {string[]} reasons - chrome.offscreen reasons used when creating it
 * @param {string} justification
 */
async function ensureOffscreenDocument(reasons, justification) {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts.length > 0) {
        console.log('[Offscreen] Offscreen document already exists, reusing it');
        return;
    }
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons, justification });
    console.log('[Offscreen] Offscreen document created, waiting for it to be ready...');
    await new Promise(resolve => setTimeout(resolve, 1000));
}

/**
 * Sends a message to the offscreen document, retrying while it is still loading
 * ("Receiving end does not exist").
 */
async function sendToOffscreen(message, maxRetries = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await chrome.runtime.sendMessage(message);
        } catch (error) {
            lastError = error;
            console.warn(`[Offscreen] ${message.type} send failed (attempt ${attempt}):`, error.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            }
        }
    }
    throw new Error(`Failed to communicate with offscreen document after ${maxRetries} attempts: ${lastError?.message}`);
}

/**
 * Downloads an export zip through a blob: URL created in the offscreen document, which builds
 * the zip from the files listed in an IndexedDB record (service workers can't create blob URLs).
 * The URL is revoked (and the document closed, unless recording) once the download ends.
 * @param {{exportId: string}} payload - id of the IndexedDB record listing the zip's files
 * @param {string} filename
 */
async function downloadViaOffscreen(payload, filename) {
    await ensureOffscreenDocument(['BLOBS'], 'Creating export files for download');
    const response = await sendToOffscreen({ type: 'make-download-url', target: 'offscreen', data: payload });
    if (!response || !response.success) {
        throw new Error(response?.error || 'Offscreen document failed to create download URL');
    }
    const url = response.url;
    let downloadId;
    try {
        downloadId = await chrome.downloads.download({ url, filename, saveAs: true });
    } catch (error) {
        await chrome.runtime.sendMessage({ type: 'revoke-url', target: 'offscreen', data: { url } }).catch(() => {});
        throw error;
    }
    pendingDownloads.set(downloadId, url);
    return downloadId;
}

// shortcut: pending downloads live in memory; if the SW restarts mid-download the offscreen
// document stays open until the next recording start closes it, which is harmless.
const pendingDownloads = new Map();

chrome.downloads.onChanged.addListener(async (delta) => {
    const url = pendingDownloads.get(delta.id);
    const state = delta.state?.current;
    if (!url || (state !== 'complete' && state !== 'interrupted')) return;
    pendingDownloads.delete(delta.id);
    try {
        await chrome.runtime.sendMessage({ type: 'revoke-url', target: 'offscreen', data: { url } });
        const { recordingState } = await chrome.storage.local.get(['recordingState']);
        if (pendingDownloads.size === 0 && !(recordingState && recordingState.isRecording)) {
            await closeExistingOffscreenDocument();
        }
    } catch (e) {
        console.warn('[Export] Download cleanup failed:', e);
    }
});

/**
 * Closes any existing offscreen document, releasing a tab-capture stream it may still hold.
 * Safe to call when none exists. Used both to recover orphaned state before a new recording
 * and to tear down the recorder after one.
 * @returns {Promise<boolean>} true if a document was found and closed
 */
async function closeExistingOffscreenDocument() {
    try {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });
        if (contexts.length > 0) {
            await chrome.offscreen.closeDocument();
            console.log('[Video] Closed offscreen document (released any active stream)');
            // Give the stream a moment to fully release before a new capture is requested.
            await new Promise(resolve => setTimeout(resolve, 300));
            return true;
        }
        return false;
    } catch (e) {
        console.warn('[Video] Error closing offscreen document:', e);
        return false;
    }
}

/**
 * Starts video capture for a given tab
 * This function:
 * 1. Validates the tab can be recorded (http/https only)
 * 2. Gets a media stream ID from Chrome's tabCapture API
 * 3. Creates/reuses an offscreen document to handle MediaRecorder
 * 4. Sends the stream ID to offscreen document to start recording
 * 
 * @param {number} tabId - The tab ID to record
 * @returns {Promise<{success: boolean, streamId?: string, error?: string}>}
 */
async function startVideoCapture(tabId) {
    try {
        console.log('[Video] Starting video capture for tab:', tabId);

        // Always clear orphaned recorder state before starting - this is what lets a fresh
        // Start recover on its own after a crash or a service-worker restart. An offscreen
        // document left over from a previous attempt keeps holding the tab-capture stream,
        // which makes getMediaStreamId fail with "Cannot capture a tab with an active stream".
        // Closing it releases the stream so we don't need the user to reload the tab.
        // Module state (isRecording etc.) is lost on SW restart, so we can't rely on it here.
        await closeExistingOffscreenDocument();
        // If a recording is still tracked as in progress, also detach the network debugger.
        if (currentRecordingTabId === tabId || isRecording) {
            console.log('[Video] Existing recording detected, stopping it first...');
            try {
                // Stop network recording first
                if (attachedTabs.has(tabId)) {
                    await stopRecording(tabId);
                }
                // Stop video capture
                await stopVideoCapture(tabId);
                // Wait longer for cleanup to complete (streams need time to release)
                await new Promise(resolve => setTimeout(resolve, 1500));
            } catch (cleanupError) {
                console.warn('[Video] Error during cleanup:', cleanupError);
                // Wait a bit anyway before continuing
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        currentRecordingTabId = tabId;

        // Validate tab exists and is recordable
        const tab = await chrome.tabs.get(tabId);
        const tabUrl = tab?.url || '';
        console.log('[Video] Target tab URL:', tabUrl);
        
        // Only allow http/https pages for security reasons
        // Chrome extensions can't record chrome://, chrome-extension://, etc.
        const allowedSchemes = ['http:', 'https:'];
        const urlScheme = (() => { 
            try { 
                return new URL(tabUrl).protocol; 
            } catch { 
                return ''; 
            } 
        })();
        
        if (!allowedSchemes.includes(urlScheme)) {
            const errorMsg = `Video recording not supported for ${urlScheme} URLs. Only http/https pages can be recorded.`;
            console.error('[Video]', errorMsg);
            throw new Error(errorMsg);
        }

        // Request media stream ID from Chrome's tabCapture API
        // This gives us access to capture the tab's visual content
        console.log('[Video] Requesting media stream ID from tabCapture API...');
        
        let streamId;
        let retryCount = 0;
        const maxRetries = 2;
        
        while (retryCount <= maxRetries) {
            try {
                streamId = await chrome.tabCapture.getMediaStreamId({
                    targetTabId: tabId
                });
                break; // Success, exit loop
            } catch (streamError) {
                // Handle "Cannot capture a tab with an active stream" error
                if (streamError.message && streamError.message.includes('active stream')) {
                    retryCount++;
                    if (retryCount > maxRetries) {
                        throw new Error('Tab has an active stream. Please refresh the page and try again.');
                    }
                    
                    console.warn(`[Video] Tab has active stream, attempting cleanup (attempt ${retryCount}/${maxRetries})...`);
                    // Try to stop any existing recording
                    try {
                        // Stop video capture
                        await stopVideoCapture(tabId);
                        // Stop network recording if active
                        if (attachedTabs.has(tabId)) {
                            await stopRecording(tabId);
                        }
                        // Wait longer for streams to fully release
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } catch (cleanupError) {
                        console.warn('[Video] Error during stream cleanup:', cleanupError);
                    }
                    // Will retry in next iteration
                } else {
                    // Other error, throw immediately
                    throw streamError;
                }
            }
        }

        if (!streamId) {
            const errorMsg = 'Failed to get media stream ID. Make sure the tab is active and recordable.';
            console.error('[Video]', errorMsg);
            throw new Error(errorMsg);
        }
        
        console.log('[Video] Got stream ID:', streamId);

        // Create or reuse offscreen document for MediaRecorder
        // Service workers can't use MediaRecorder, so we need an offscreen document
        console.log('[Video] Setting up offscreen document for recording...');
        await createOffscreenDocument(streamId, tabId);

        // Mark t=0 now: createOffscreenDocument only resolves once the offscreen document has
        // confirmed MediaRecorder actually started, so this closely matches the first frame
        // and keeps the exported timeline aligned with the footage.
        videoStartTime = Date.now();

        // Store recording metadata in chrome.storage (not the video itself)
        // videoRecordingStartTime is a durable copy that survives stopVideoCapture so the
        // exporter can anchor the timeline to when the video actually began (video t=0),
        // rather than to the first captured event.
        await chrome.storage.local.set({
            videoStreamId: streamId,
            videoStartTime: videoStartTime,
            videoRecordingStartTime: videoStartTime,
            isVideoRecording: true
        });

        // Persist unified recording state so the popup shows "recording" and Stop stays
        // enabled across service-worker restarts.
        await setRecordingState({ isRecording: true, mode: 'video', tabId: tabId, startTime: videoStartTime });

        console.log('[Video] Video capture started successfully!');
        return { success: true, streamId: streamId };
    } catch (error) {
        console.error('[Video] Error starting video capture:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Stops video capture and processes the recorded video
 * This function:
 * 1. Sends stop signal to offscreen document
 * 2. Waits for video processing to complete
 * 3. Uses the offscreen document's report of whether the video reached IndexedDB
 * 4. Cleans up resources and closes offscreen document
 * 
 * @param {number} tabId - The tab ID that was being recorded
 * @returns {Promise<void>}
 */
async function stopVideoCapture(tabId) {
    try {
        console.log('[Video] Stopping video capture for tab:', tabId);

        // Only talk to the offscreen recorder when one is actually present. stopVideoCapture
        // is also called as pre-cleanup before a fresh recording, where there is nothing to stop.
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT']
        });

        // The offscreen document stops MediaRecorder, writes the blob to IndexedDB and only
        // then responds, reporting whether the video was stored.
        let stored = false;
        if (existingContexts.length > 0) {
            try {
                const stopResponse = await chrome.runtime.sendMessage({
                    type: 'stop-recording',
                    target: 'offscreen'
                });
                console.log('[Video] Stop message sent to offscreen document, response:', stopResponse);
                stored = !!(stopResponse && stopResponse.stored);
            } catch (error) {
                console.warn('[Video] Could not send stop message to offscreen:', error);
                // Continue anyway - offscreen might have already stopped
            }
        }

        // Note: Video blob is stored in IndexedDB by the offscreen document and
        // fetched during export. videoRecordingStartTime is intentionally kept so the
        // exporter can anchor the timeline; it is overwritten on the next recording.

        // Clean up recording metadata from chrome.storage
        await chrome.storage.local.remove([
            'videoStreamId',
            'videoStartTime',
            'isVideoRecording'
        ]);
        // In video mode the debugger is stopped separately by stopRecording; clear the
        // unified state here too so a stopped video recording never looks "still running".
        await clearRecordingState();
        console.log('[Video] Recording metadata cleaned up');

        // Close offscreen document to free resources
        try {
            if (existingContexts.length > 0) {
                await chrome.offscreen.closeDocument();
                console.log('[Video] Offscreen document closed successfully');
            } else {
                console.log('[Video] No offscreen document to close');
            }
        } catch (e) {
            console.warn('[Video] Error closing offscreen document:', e);
        }

        currentRecordingTabId = null;
        videoStartTime = null;

        console.log('[Video] Video capture stopped successfully');
        return { stored };
    } catch (error) {
        console.error('[Video] Error stopping video capture:', error);
        // Don't throw - try to clean up anyway
        try {
            await chrome.offscreen.closeDocument();
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

/**
 * Runs the whole start sequence (video → network debugger → interaction recorder) in the
 * service worker. It used to run in the popup, whose script stops the moment the popup
 * closes - clicking back onto the page right after Start left only the video running.
 * @param {number} tabId
 * @param {'video'|'logs'} mode
 * @returns {Promise<{success: boolean, interactions: boolean}>}
 */
async function startSession(tabId, mode) {
    const { recordingState } = await chrome.storage.local.get(['recordingState']);
    if (recordingState && recordingState.isRecording) {
        console.log('[Session] Existing recording detected, stopping it first...');
        await stopSession(tabId);
    }

    if (mode === 'video') {
        const video = await startVideoCapture(tabId);
        if (!video.success) throw new Error(video.error || 'Failed to start video recording');
    }

    try {
        await startRecording(tabId);
    } catch (error) {
        if (mode === 'video') await stopVideoCapture(tabId);
        throw error;
    }
    await setRecordingState({ mode });

    let interactions = false;
    if (await ensureContentScript(tabId)) {
        try {
            await chrome.tabs.sendMessage(tabId, { action: 'startInteractionRecording' });
            interactions = true;
        } catch (error) {
            // Network (and video) keep recording without interactions.
            console.warn('[Session] Could not start interaction recording:', error.message);
        }
    }
    return { success: true, interactions };
}

/**
 * Stops whatever startSession started. Mode and tab come from the persisted recording state,
 * so a popup reopened on another tab (or after a service-worker restart) stops the right one.
 * @param {number} fallbackTabId - used only when no recording state is persisted
 * @returns {Promise<{success: boolean, mode: string, stored: boolean|null}>}
 */
async function stopSession(fallbackTabId) {
    const { recordingState } = await chrome.storage.local.get(['recordingState']);
    const tabId = recordingState?.tabId ?? fallbackTabId;
    const mode = recordingState?.mode === 'logs' ? 'logs' : 'video';

    let stored = null;
    if (mode === 'video') {
        const result = await stopVideoCapture(tabId);
        stored = !!(result && result.stored);
    }
    await stopRecording(tabId);
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'stopInteractionRecording' });
    } catch (error) {
        // Expected when the tab was closed or is on a page without the content script.
    }
    return { success: true, mode, stored };
}

// content.js lives only as long as the page: after a full page load of the recorded tab, add it
// again. Its init() asks getStatus and resumes recording interactions by itself.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    const { recordingState } = await chrome.storage.local.get(['recordingState']);
    if (recordingState && recordingState.isRecording && recordingState.tabId === tabId) {
        await ensureContentScript(tabId);
    }
});

/**
 * Injects content.js unless it already answers a ping.
 * @returns {Promise<boolean>} whether the content script is available
 */
async function ensureContentScript(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        if (response && response.pong) return true;
    } catch (error) {
        // Not injected yet.
    }
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        await new Promise(resolve => setTimeout(resolve, 300));
        return true;
    } catch (error) {
        console.error('Failed to inject content script:', error);
        return false;
    }
}

// ============================================================================
// IndexedDB Helper Functions for Video Storage
// These functions handle large video files that exceed chrome.storage limits
// ============================================================================

const VIDEO_DB_NAME = 'CaptureAllVideoDB';
const VIDEO_DB_VERSION = 1;
const VIDEO_STORE_NAME = 'videos';

/**
 * Opens the IndexedDB database for video storage
 * Creates the database and object store if they don't exist
 * @returns {Promise<IDBDatabase>} The opened database instance
 */
async function openVideoDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(VIDEO_DB_NAME, VIDEO_DB_VERSION);

        request.onerror = () => {
            console.error('[VideoStorage] Failed to open IndexedDB:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            console.log('[VideoStorage] IndexedDB opened successfully');
            resolve(request.result);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // Create object store if it doesn't exist
            if (!db.objectStoreNames.contains(VIDEO_STORE_NAME)) {
                const objectStore = db.createObjectStore(VIDEO_STORE_NAME, { keyPath: 'id', autoIncrement: true });
                console.log('[VideoStorage] Created object store:', VIDEO_STORE_NAME);
            }
        };
    });
}

/**
 * Retrieves a video blob from IndexedDB
 * @param {string} videoId - The video identifier (default: 'current-video')
 * @returns {Promise<Blob|null>} The video blob or null if not found
 */
async function getVideoBlob(videoId = 'current-video') {
    try {
        console.log('[VideoStorage] Retrieving video blob, ID:', videoId);
        
        const db = await openVideoDatabase();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([VIDEO_STORE_NAME], 'readonly');
            const store = transaction.objectStore(VIDEO_STORE_NAME);
            const request = store.get(videoId);
            
            request.onsuccess = () => {
                const result = request.result;
                if (result && result.blob) {
                    console.log('[VideoStorage] Video retrieved successfully, size:', result.blob.size, 'bytes');
                    resolve(result.blob);
                } else {
                    console.warn('[VideoStorage] Video not found for ID:', videoId);
                    resolve(null);
                }
            };
            
            request.onerror = () => {
                console.error('[VideoStorage] Failed to retrieve video:', request.error);
                reject(request.error);
            };
        });
    } catch (error) {
        console.error('[VideoStorage] Error retrieving video:', error);
        return null;
    }
}

/**
 * Deletes a video from IndexedDB
 * Useful for cleanup after export
 * @param {string} videoId - The video identifier (default: 'current-video')
 * @returns {Promise<void>}
 */
async function deleteVideoBlob(videoId = 'current-video') {
    try {
        console.log('[VideoStorage] Deleting video blob, ID:', videoId);
        
        const db = await openVideoDatabase();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([VIDEO_STORE_NAME], 'readwrite');
            const store = transaction.objectStore(VIDEO_STORE_NAME);
            const request = store.delete(videoId);
            
            request.onsuccess = () => {
                console.log('[VideoStorage] Video deleted successfully');
                resolve();
            };
            
            request.onerror = () => {
                console.error('[VideoStorage] Failed to delete video:', request.error);
                reject(request.error);
            };
        });
    } catch (error) {
        console.error('[VideoStorage] Error deleting video:', error);
        throw error;
    }
}

/**
 * Runs one request against the shared object store (same pattern as offscreen.js).
 */
async function videoStoreRequest(mode, op) {
    const db = await openVideoDatabase();
    return new Promise((resolve, reject) => {
        const request = op(db.transaction([VIDEO_STORE_NAME], mode).objectStore(VIDEO_STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ============================================================================
// Network log persistence
// networkLogs is mirrored into IndexedDB: Chrome stops an idle service worker ~30s after its
// last event, which used to empty the export when it ran a while after Stop.
// ============================================================================

const NETWORK_LOGS_ID = 'network-logs';
let saveNetworkLogsTimer = null;

// shortcut: rewrites the whole array on every save; move to one record per request if sessions reach 100MB+.
async function saveNetworkLogs() {
    clearTimeout(saveNetworkLogsTimer);
    saveNetworkLogsTimer = null;
    try {
        await videoStoreRequest('readwrite', store => store.put({ id: NETWORK_LOGS_ID, logs: networkLogs }));
    } catch (e) {
        console.warn('[NetworkLogs] Failed to persist network logs:', e);
    }
}

function scheduleSaveNetworkLogs() {
    if (!saveNetworkLogsTimer) saveNetworkLogsTimer = setTimeout(saveNetworkLogs, 1000);
}

// Restores logs saved by a previous worker instance; events that arrived meanwhile are kept after them.
const networkLogsReady = (async () => {
    try {
        const record = await videoStoreRequest('readonly', store => store.get(NETWORK_LOGS_ID));
        if (record && Array.isArray(record.logs)) networkLogs = record.logs.concat(networkLogs);
    } catch (e) {
        console.warn('[NetworkLogs] Failed to restore network logs:', e);
    }
})();

// ============================================================================
// Keepalive Handler - Pings from the offscreen recorder
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Keepalive ping from the offscreen recorder. Simply receiving it resets the service
    // worker's idle timer; acknowledge and stop so it isn't treated as an unknown action.
    if (message.type === 'keepalive' && message.target === 'background') {
        sendResponse({ alive: true });
        return true;
    }

});

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Type-based messages (keepalive, start/stop-recording, download URLs) are handled by
    // other listeners; ignore them here so they don't fall through to "Unknown action".
    if (!message || !message.action) return;

    console.log('Background received message:', message);

    switch (message.action) {
        case 'startSession':
            startSession(message.tabId, message.mode)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'stopSession':
            stopSession(message.tabId)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'ensureContentScript':
            ensureContentScript(message.tabId)
                .then(ok => sendResponse({ success: ok }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'getStatus':
            // Read the persisted flag so status is correct even after a SW restart (when the
            // in-memory isRecording would be false while a recording is still running).
            (async () => {
                try {
                    await networkLogsReady;
                    const { recordingState } = await chrome.storage.local.get(['recordingState']);
                    const active = !!(recordingState && recordingState.isRecording) || isRecording;
                    sendResponse({
                        isRecording: active,
                        mode: recordingState ? recordingState.mode : null,
                        networkLogsCount: networkLogs.length
                    });
                } catch (e) {
                    sendResponse({ isRecording: isRecording, networkLogsCount: networkLogs.length });
                }
            })();
            return true;

        case 'exportLogs':
            exportAllLogs(message.tabId, message.mode || 'logs')
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'clearLogs':
            clearAllLogs();
            sendResponse({ success: true });
            break;

        case 'logInteraction':
            (async () => {
                try {
                    const result = await chrome.storage.local.get(['interactionLogs']);
                    const logs = result.interactionLogs || [];
                    logs.push({
                        ...message.data,
                        timestamp: Date.now()
                    });
                    await chrome.storage.local.set({ interactionLogs: logs });
                    sendResponse({ success: true });
                } catch (error) {
                    console.error('Error storing interaction:', error);
                    sendResponse({ success: false, error: error.message });
                }
            })();
            return true;

        default:
            console.warn('Unknown message action:', message.action);
            sendResponse({ success: false, error: 'Unknown action' });
    }
});

async function startRecording(tabId) {
    try {
        console.log('Starting recording for tab:', tabId);

        try {
            await chrome.debugger.attach({ tabId: tabId }, "1.3");
        } catch (attachError) {
            // A stranded attachment from a previous crash / failed stop leaves the tab
            // "being debugged" and makes every subsequent attach throw "Another debugger is
            // already attached", which bricks Start for both Logs and Video modes until the
            // extension is reloaded. Detach the orphan and retry once so it self-heals.
            const msg = (attachError && attachError.message || '').toLowerCase();
            if (msg.includes('already attached') || msg.includes('another debugger')) {
                console.warn('Debugger already attached to tab, detaching orphan and retrying...');
                try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) { /* orphan may not be ours */ }
                attachedTabs.delete(tabId);
                await new Promise(resolve => setTimeout(resolve, 300));
                await chrome.debugger.attach({ tabId: tabId }, "1.3");
            } else {
                throw attachError;
            }
        }
        console.log('Debugger attached to tab:', tabId);

        await chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable");
        await chrome.debugger.sendCommand({ tabId: tabId }, "Runtime.enable");

        // Let a pending restore finish first so it can't re-add the previous session's logs.
        await networkLogsReady;
        attachedTabs.add(tabId);
        isRecording = true;
        networkLogs = [];
        await saveNetworkLogs();

        // Persist so status/stop survive a service-worker restart. Merges with any state
        // already set by startVideoCapture (which records mode/startTime for video mode).
        await setRecordingState({ isRecording: true, tabId: tabId, debuggerAttached: true });

        console.log('Recording started successfully for tab:', tabId);
    } catch (error) {
        console.error('Error starting recording:', error);
        // Never leave a half-attached debugger behind - it would block the next Start.
        try { await chrome.debugger.detach({ tabId: tabId }); } catch (e) { /* ignore */ }
        attachedTabs.delete(tabId);
        isRecording = false;
        throw error;
    }
}

function onDebuggerEvent(source, method, params) {
    if (!attachedTabs.has(source.tabId)) return;

    switch (method) {
        case 'Network.requestWillBeSent':
            handleNetworkRequest(params, source.tabId);
            break;
        case 'Network.responseReceived':
            handleNetworkResponse(params, source.tabId);
            break;
        case 'Network.loadingFinished':
            handleNetworkLoadingFinished(params, source.tabId);
            break;
        case 'Network.loadingFailed':
            handleNetworkLoadingFailed(params, source.tabId);
            break;
    }
    scheduleSaveNetworkLogs();
}

function handleNetworkRequest(params, tabId) {
    const logEntry = {
        type: 'request',
        timestamp: Date.now(),
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        headers: params.request.headers,
        postData: params.request.postData,
        tabId: tabId
    };

    networkLogs.push(logEntry);
    console.log('Network request logged:', logEntry.url);
}

async function handleNetworkResponse(params, tabId) {
    const requestIndex = networkLogs.findIndex(log =>
        log.requestId === params.requestId && log.type === 'request'
    );

    if (requestIndex !== -1) {
        networkLogs[requestIndex].response = {
            status: params.response.status,
            statusText: params.response.statusText,
            headers: params.response.headers,
            mimeType: params.response.mimeType,
            timestamp: Date.now()
        };

        // Get response body for JSON/text responses
        if (params.response.mimeType &&
            (params.response.mimeType.includes('json') ||
                params.response.mimeType.includes('javascript') ||
                params.response.mimeType.includes('text') ||
                params.response.mimeType.includes('xml'))) {

            try {
                const responseBody = await chrome.debugger.sendCommand(
                    { tabId: tabId },
                    "Network.getResponseBody",
                    { requestId: params.requestId }
                );

                if (responseBody && responseBody.body) {
                    let bodyContent = responseBody.body;

                    // Decode if base64
                    if (responseBody.base64Encoded) {
                        try {
                            bodyContent = atob(responseBody.body);
                        } catch (e) {
                            console.warn('Could not decode base64 response');
                        }
                    }

                    // Try to parse JSON for better display
                    if (params.response.mimeType.includes('json')) {
                        try {
                            bodyContent = JSON.parse(bodyContent);
                        } catch (e) {
                            // Keep as string if not valid JSON
                        }
                    }

                    networkLogs[requestIndex].response.body = bodyContent;
                    networkLogs[requestIndex].response.bodySize = responseBody.body.length;
                    scheduleSaveNetworkLogs();
                }
            } catch (error) {
                console.warn('Could not get response body for:', networkLogs[requestIndex].url, error.message);
            }
        }

        console.log('Network response logged:', params.response.status, networkLogs[requestIndex].url);
    }
}

function handleNetworkLoadingFinished(params, tabId) {
    const requestIndex = networkLogs.findIndex(log =>
        log.requestId === params.requestId && log.type === 'request'
    );

    if (requestIndex !== -1) {
        networkLogs[requestIndex].loadingFinished = {
            timestamp: Date.now(),
            encodedDataLength: params.encodedDataLength
        };
        console.log('Network loading finished:', networkLogs[requestIndex].url);
    }
}

function handleNetworkLoadingFailed(params, tabId) {
    const requestIndex = networkLogs.findIndex(log =>
        log.requestId === params.requestId && log.type === 'request'
    );

    if (requestIndex !== -1) {
        networkLogs[requestIndex].loadingFailed = {
            timestamp: Date.now(),
            errorText: params.errorText,
            canceled: params.canceled
        };
        console.log('Network loading failed:', networkLogs[requestIndex].url, params.errorText);
    }
}

async function stopRecording(tabId) {
    try {
        console.log('Stopping recording for tab:', tabId);

        // Best-effort detach even if attachedTabs was lost to a SW restart, so the "being
        // debugged" banner is always cleared and the next Start isn't blocked.
        try {
            await chrome.debugger.detach({ tabId: tabId });
            console.log('Debugger detached from tab:', tabId);
        } catch (e) {
            // Not attached (or attached by something else) - nothing to detach.
        }
        attachedTabs.delete(tabId);

        isRecording = false;
        await clearRecordingState();
        await saveNetworkLogs();
        console.log('Recording stopped successfully for tab:', tabId);
    } catch (error) {
        console.warn('Error stopping recording:', error);
        attachedTabs.delete(tabId);
        isRecording = false;
        await clearRecordingState();
    }
}

/**
 * Exports all captured data as one zip: capture_all_<timestamp>/timeline.html, logs.json and,
 * in video mode, video.webm. The zip is assembled in the offscreen document (service workers
 * can't create blob URLs); the JSON and HTML reach it through IndexedDB instead of messaging,
 * which caps out at 64MB, and the video never leaves IndexedDB until it's zipped.
 *
 * @param {number} tabId - The tab ID
 * @param {string} mode - Export mode: 'logs' or 'video'
 * @returns {Promise<void>}
 */
async function exportAllLogs(tabId, mode) {
    try {
        console.log('[Export] Starting export, mode:', mode);
        await networkLogsReady;

        // Get interaction logs and element snapshots from chrome.storage
        const result = await chrome.storage.local.get(['interactionLogs', 'elementSnapshots', 'videoRecordingStartTime']);
        const interactionLogs = result.interactionLogs || [];
        const elementSnapshots = result.elementSnapshots || [];
        // When video began (video t=0). Used to align the timeline with the video player.
        const videoStartTime = result.videoRecordingStartTime || null;

        const timestamp = Date.now();
        const folder = `capture_all_${timestamp}`;
        const videoFileName = 'video.webm';

        let videoBlob = null;
        if (mode === 'video') {
            videoBlob = await getVideoBlob('current-video');
            if (!(videoBlob instanceof Blob) || videoBlob.size === 0) {
                console.warn('[Export] No video found in IndexedDB - video recording may have failed or was not started');
                videoBlob = null;
            } else if (videoBlob.size > 500 * 1024 * 1024) {
                console.warn('[Export] Video is very large:', videoBlob.size, 'bytes. Export may take time.');
            }
        }

        // Prepare export data structure
        const exportData = {
            exportDate: new Date().toISOString(),
            extensionVersion: chrome.runtime.getManifest().version,
            tabId: tabId,
            mode: mode,
            videoStartTime: videoStartTime,
            networkLogs: networkLogs,
            interactionLogs: interactionLogs,
            elementSnapshots: elementSnapshots,
            videoData: videoBlob ? {
                hasVideo: true,
                videoFileName: videoFileName,
                videoSize: videoBlob.size
            } : { hasVideo: false },
            summary: {
                totalNetworkRequests: networkLogs.length,
                totalInteractions: interactionLogs.length,
                totalElementSnapshots: elementSnapshots.length
            }
        };

        const htmlContent = mode === 'video'
            ? generateVideoTimelineHTML(exportData, videoBlob, videoFileName)
            : generateImprovedTimelineHTML(exportData);

        const files = [
            { name: `${folder}/timeline.html`, blob: new Blob([htmlContent], { type: 'text/html' }) },
            { name: `${folder}/logs.json`, blob: new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }) }
        ];
        if (videoBlob) files.push({ name: `${folder}/${videoFileName}`, videoId: 'current-video' });

        await videoStoreRequest('readwrite', store => store.put({ id: 'pending-export', files }));
        await downloadViaOffscreen({ exportId: 'pending-export' }, `${folder}.zip`);
        console.log('[Export] Zip export started:', `${folder}.zip`);
    } catch (error) {
        console.error('[Export] Error exporting logs:', error);
        throw error;
    }
}

function generateImprovedTimelineHTML(data) {
    // Process all events
    const allEvents = [];

    // Add network events
    if (data.networkLogs) {
        data.networkLogs.forEach(log => {
            allEvents.push({
                type: 'network',
                timestamp: log.timestamp,
                data: log
            });
        });
    }

    // Add interaction events
    if (data.interactionLogs) {
        data.interactionLogs.forEach(log => {
            allEvents.push({
                type: 'interaction',
                timestamp: log.timestamp,
                data: log
            });
        });
    }

    // Add snapshot events
    if (data.elementSnapshots) {
        data.elementSnapshots.forEach(snapshot => {
            allEvents.push({
                type: 'snapshot',
                timestamp: snapshot.timestamp,
                data: snapshot
            });
        });
    }

    // Sort by timestamp
    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    const startTime = allEvents.length > 0 ? allEvents[0].timestamp : Date.now();
    const endTime = allEvents.length > 0 ? allEvents[allEvents.length - 1].timestamp : Date.now();
    const duration = endTime - startTime;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Capture All Timeline - ${new Date(data.exportDate).toLocaleString()}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f5f7fa;
            color: #1a202c;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }

        .header h1 {
            font-size: 2rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }

        .header p {
            opacity: 0.9;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }

        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .summary-card {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            text-align: center;
        }

        .summary-card h3 {
            font-size: 2rem;
            color: #667eea;
            margin-bottom: 0.5rem;
        }

        .summary-card p {
            color: #718096;
            font-size: 0.875rem;
        }

        .timeline-section {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            margin-bottom: 2rem;
        }

        .timeline-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            flex-wrap: wrap;
            gap: 1rem;
        }

        .timeline-title {
            font-size: 1.5rem;
            font-weight: 600;
        }

        .playback-controls {
            display: flex;
            gap: 0.5rem;
            align-items: center;
        }

        .playback-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.875rem;
            font-weight: 500;
            transition: all 0.2s;
        }

        .playback-btn:hover {
            background: #5568d3;
            transform: translateY(-1px);
        }

        .playback-btn:disabled {
            background: #cbd5e0;
            cursor: not-allowed;
            transform: none;
        }

        .speed-selector {
            padding: 0.5rem;
            border: 1px solid #e2e8f0;
            border-radius: 6px;
            font-size: 0.875rem;
        }

        .playback-info {
            background: #edf2f7;
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            text-align: center;
        }

        .current-time {
            font-size: 1.5rem;
            font-weight: 600;
            color: #667eea;
        }

        .current-event-card {
            background: linear-gradient(135deg, #fef5e7 0%, #fdebd0 100%);
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            border-left: 4px solid #f59e0b;
            display: none;
        }

        .current-event-card.active {
            display: block;
        }

        .current-event-card h4 {
            color: #92400e;
            margin-bottom: 0.5rem;
            font-size: 0.875rem;
            font-weight: 600;
        }

        .current-event-card .event-summary {
            color: #78350f;
            font-size: 0.875rem;
        }

        .timeline-wrapper {
            overflow-x: auto;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            background: #f7fafc;
            max-height: 600px;
            overflow-y: auto;
        }

        .timeline {
            min-width: 1200px;
            position: relative;
        }

        .cursor-track {
            position: sticky;
            top: 0;
            height: 40px;
            background: linear-gradient(90deg, #edf2f7 0%, #e2e8f0 100%);
            border-bottom: 2px solid #cbd5e0;
            display: flex;
            align-items: center;
            padding: 0 1rem;
            z-index: 10;
        }

        .track-label {
            width: 150px;
            font-weight: 600;
            font-size: 0.875rem;
            color: #4a5568;
            flex-shrink: 0;
        }

        .track-content {
            flex: 1;
            position: relative;
            height: 100%;
        }

        .cursor-marker {
            position: absolute;
            width: 3px;
            height: 100%;
            background: #ef4444;
            box-shadow: 0 0 10px rgba(239, 68, 68, 0.5);
            z-index: 20;
            transition: left 0.1s linear;
        }

        .cursor-marker::before {
            content: '';
            position: absolute;
            top: -6px;
            left: -4px;
            width: 11px;
            height: 11px;
            background: #ef4444;
            border-radius: 50%;
            border: 2px solid white;
            box-shadow: 0 2px 8px rgba(239, 68, 68, 0.6);
        }

        .timeline-track {
            display: flex;
            align-items: center;
            min-height: 60px;
            padding: 0.5rem 1rem;
            border-bottom: 1px solid #e2e8f0;
        }

        .event-pill {
            position: absolute;
            height: 28px;
            background: #667eea;
            color: white;
            border-radius: 14px;
            padding: 0 12px;
            display: flex;
            align-items: center;
            font-size: 0.75rem;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 180px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }

        .event-pill:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.15);
            z-index: 5;
            max-width: none;
        }

        .event-pill.network {
            background: linear-gradient(135deg, #10b981, #059669);
        }

        .event-pill.interaction {
            background: linear-gradient(135deg, #3b82f6, #2563eb);
        }

        .event-pill.snapshot {
            background: linear-gradient(135deg, #f59e0b, #d97706);
        }

        .details-panel {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            margin-top: 2rem;
            display: none;
        }

        .details-panel.active {
            display: block;
        }

        .details-panel h3 {
            font-size: 1.25rem;
            font-weight: 600;
            margin-bottom: 1.5rem;
            color: #1a202c;
        }

        .details-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
        }

        .detail-section {
            background: #f7fafc;
            padding: 1.5rem;
            border-radius: 8px;
            border: 1px solid #e2e8f0;
        }

        .detail-section h4 {
            font-size: 1rem;
            font-weight: 600;
            color: #667eea;
            margin-bottom: 1rem;
        }

        .detail-item {
            margin-bottom: 0.75rem;
        }

        .detail-label {
            font-size: 0.75rem;
            font-weight: 600;
            color: #718096;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 0.25rem;
        }

        .detail-value {
            font-size: 0.875rem;
            color: #2d3748;
            word-break: break-word;
        }

        .detail-value pre {
            background: #edf2f7;
            padding: 0.75rem;
            border-radius: 4px;
            font-size: 0.75rem;
            overflow-x: auto;
            max-height: 300px;
            overflow-y: auto;
        }

        .status-badge {
            display: inline-block;
            padding: 0.25rem 0.75rem;
            border-radius: 12px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .status-success {
            background: #d1fae5;
            color: #065f46;
        }

        .status-error {
            background: #fee2e2;
            color: #991b1b;
        }

        .response-body {
            max-height: 400px;
            overflow-y: auto;
        }

        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }

            .timeline-wrapper {
                max-height: 400px;
            }

            .details-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Capture All Timeline</h1>
        <p>Session recorded on ${new Date(data.exportDate).toLocaleString()}</p>
    </div>

    <div class="container">
        <div class="summary-grid">
            <div class="summary-card">
                <h3>${data.summary.totalNetworkRequests}</h3>
                <p>Network Requests</p>
            </div>
            <div class="summary-card">
                <h3>${data.summary.totalInteractions}</h3>
                <p>User Interactions</p>
            </div>
            <div class="summary-card">
                <h3>${data.summary.totalElementSnapshots}</h3>
                <p>Element Snapshots</p>
            </div>
            <div class="summary-card">
                <h3>${formatDuration(duration)}</h3>
                <p>Session Duration</p>
            </div>
        </div>

        <div class="timeline-section">
            <div class="timeline-header">
                <h2 class="timeline-title">Interactive Timeline</h2>
                <div class="playback-controls">
                    <select class="speed-selector" id="speedSelector">
                        <option value="0.5">0.5x</option>
                        <option value="1" selected>1x</option>
                        <option value="2">2x</option>
                        <option value="5">5x</option>
                        <option value="10">10x</option>
                    </select>
                    <button class="playback-btn" id="playBtn">▶ Play</button>
                    <button class="playback-btn" id="pauseBtn" disabled>⏸ Pause</button>
                    <button class="playback-btn" id="resetBtn">🔄 Reset</button>
                </div>
            </div>

            <div class="playback-info">
                <div class="current-time" id="currentTime">00:00.000</div>
                <div style="font-size: 0.875rem; color: #718096; margin-top: 0.25rem;">
                    Total: ${formatDuration(duration)}
                </div>
            </div>

            <div class="current-event-card" id="currentEventCard">
                <h4>Current Event</h4>
                <div class="event-summary" id="currentEventSummary"></div>
            </div>

            <div class="timeline-wrapper">
                <div class="timeline">
                    <div class="cursor-track">
                        <div class="track-label">Playback</div>
                        <div class="track-content">
                            <div class="cursor-marker" id="cursorMarker" style="left: 0%"></div>
                        </div>
                    </div>
                    ${generateTimelineTracks(data, startTime, endTime)}
                </div>
            </div>
        </div>

        <div class="details-panel" id="detailsPanel">
            <!-- Event details will be populated here -->
        </div>
    </div>

    <script>
        const captureData = ${JSON.stringify(data, null, 2).replace(/</g, '\\u003c')};
        let allEvents = [];
        let isPlaying = false;
        let currentTime = 0;
        let playbackSpeed = 1;
        let animationFrame = null;
        let lastFrameTime = null;
        let startTime = 0;
        let endTime = 0;
        let duration = 0;
        let currentEventIndex = -1;

        function init() {
            processEvents();
            setupEventListeners();
        }

        function processEvents() {
            allEvents = [];
            
            if (captureData.networkLogs) {
                captureData.networkLogs.forEach(log => {
                    allEvents.push({
                        type: 'network',
                        timestamp: log.timestamp,
                        data: log
                    });
                });
            }
            
            if (captureData.interactionLogs) {
                captureData.interactionLogs.forEach(log => {
                    allEvents.push({
                        type: 'interaction',
                        timestamp: log.timestamp,
                        data: log
                    });
                });
            }
            
            if (captureData.elementSnapshots) {
                captureData.elementSnapshots.forEach(snapshot => {
                    allEvents.push({
                        type: 'snapshot',
                        timestamp: snapshot.timestamp,
                        data: snapshot
                    });
                });
            }
            
            allEvents.sort((a, b) => a.timestamp - b.timestamp);
            
            if (allEvents.length > 0) {
                startTime = allEvents[0].timestamp;
                endTime = allEvents[allEvents.length - 1].timestamp;
                duration = endTime - startTime;
            }
        }

        function setupEventListeners() {
            document.getElementById('playBtn').addEventListener('click', startPlayback);
            document.getElementById('pauseBtn').addEventListener('click', pausePlayback);
            document.getElementById('resetBtn').addEventListener('click', resetPlayback);
            document.getElementById('speedSelector').addEventListener('change', (e) => {
                playbackSpeed = parseFloat(e.target.value);
            });

            // Add click handlers to all event pills
            document.querySelectorAll('.event-pill').forEach((pill, index) => {
                pill.addEventListener('click', () => {
                    const eventIndex = parseInt(pill.dataset.index);
                    if (eventIndex >= 0 && eventIndex < allEvents.length) {  // Add bounds check
                        showEventDetails(allEvents[eventIndex]);
                    }
                });
            });
        }

        function startPlayback() {
            if (isPlaying) return;
            isPlaying = true;
            document.getElementById('playBtn').disabled = true;
            document.getElementById('pauseBtn').disabled = false;
            lastFrameTime = performance.now();
            animate();
        }

        function pausePlayback() {
            isPlaying = false;
            document.getElementById('playBtn').disabled = false;
            document.getElementById('pauseBtn').disabled = true;
            if (animationFrame) {
                cancelAnimationFrame(animationFrame);
            }
        }

        function resetPlayback() {
            pausePlayback();
            currentTime = 0;
            currentEventIndex = -1;
            updateCursor();
            updateCurrentTime();
            document.getElementById('currentEventCard').classList.remove('active');
        }

        function animate() {
            if (!isPlaying) return;

            const now = performance.now();
            const deltaTime = now - lastFrameTime;
            lastFrameTime = now;

            currentTime += deltaTime * playbackSpeed;

            if (currentTime >= duration) {
                currentTime = duration;
                pausePlayback();
            }

            updateCursor();
            updateCurrentTime();
            updateCurrentEvent();

            animationFrame = requestAnimationFrame(animate);
        }

        function updateCursor() {
            const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
            document.getElementById('cursorMarker').style.left = progress + '%';
        }

        function updateCurrentTime() {
            const milliseconds = Math.floor(currentTime);
            const seconds = Math.floor(milliseconds / 1000);
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            const remainingMillis = milliseconds % 1000;
            
            document.getElementById('currentTime').textContent = 
                \`\${minutes.toString().padStart(2, '0')}:\${remainingSeconds.toString().padStart(2, '0')}.\${remainingMillis.toString().padStart(3, '0')}\`;
        }

        function updateCurrentEvent() {
            const currentTimestamp = startTime + currentTime;
            
            // Find the current event
            let newEventIndex = -1;
            for (let i = 0; i < allEvents.length; i++) {
                if (allEvents[i].timestamp <= currentTimestamp) {
                    newEventIndex = i;
                } else {
                    break;
                }
            }

            if (newEventIndex !== currentEventIndex && newEventIndex >= 0) {
                currentEventIndex = newEventIndex;
                const event = allEvents[currentEventIndex];
                showCurrentEvent(event);
            }
        }

        function showCurrentEvent(event) {
            const card = document.getElementById('currentEventCard');
            const summary = document.getElementById('currentEventSummary');
            
            card.classList.add('active');
            
            let summaryText = '';
            const relativeTime = event.timestamp - startTime;
            const timeStr = formatTimestamp(relativeTime);
            
            if (event.type === 'network') {
                const method = event.data.method || 'GET';
                const url = truncateUrl(event.data.url);
                const status = event.data.response ? event.data.response.status : 'pending';
                summaryText = \`<strong>Network:</strong> \${method} \${url} - Status: \${status} <span style="opacity:0.7">(\${timeStr})</span>\`;
            } else if (event.type === 'interaction') {
                const interactionType = event.data.type || 'unknown';
                let details = '';
                if (event.data.coordinates) {
                    details = \` at (\${event.data.coordinates.clientX}, \${event.data.coordinates.clientY})\`;
                } else if (event.data.scrollPosition) {
                    details = \` to (\${event.data.scrollPosition.x}, \${event.data.scrollPosition.y})\`;
                }
                summaryText = \`<strong>Interaction:</strong> \${interactionType}\${details} <span style="opacity:0.7">(\${timeStr})</span>\`;
            } else if (event.type === 'snapshot') {
                const elementCount = event.data.elements ? event.data.elements.length : 0;
                summaryText = \`<strong>Snapshot:</strong> \${elementCount} elements captured <span style="opacity:0.7">(\${timeStr})</span>\`;
            }
            
            summary.innerHTML = summaryText;
        }

        function showEventDetails(event) {
            const panel = document.getElementById('detailsPanel');
            panel.classList.add('active');
            
            let detailsHTML = '<h3>Event Details</h3><div class="details-grid">';
            
            // Common details
            detailsHTML += '<div class="detail-section">';
            detailsHTML += '<h4>Event Information</h4>';
            detailsHTML += \`<div class="detail-item"><div class="detail-label">Type</div><div class="detail-value">\${event.type}</div></div>\`;
            detailsHTML += \`<div class="detail-item"><div class="detail-label">Timestamp</div><div class="detail-value">\${new Date(event.timestamp).toLocaleString()}</div></div>\`;
            detailsHTML += \`<div class="detail-item"><div class="detail-label">Relative Time</div><div class="detail-value">\${formatTimestamp(event.timestamp - startTime)}</div></div>\`;
            detailsHTML += '</div>';
            
            if (event.type === 'network') {
                detailsHTML += generateNetworkDetails(event.data);
            } else if (event.type === 'interaction') {
                detailsHTML += generateInteractionDetails(event.data);
            } else if (event.type === 'snapshot') {
                detailsHTML += generateSnapshotDetails(event.data);
            }
            
            detailsHTML += '</div>';
            panel.innerHTML = detailsHTML;
            
            panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        function generateNetworkDetails(data) {
            let html = '<div class="detail-section">';
            html += '<h4>Request Details</h4>';
            html += \`<div class="detail-item"><div class="detail-label">URL</div><div class="detail-value">\${data.url}</div></div>\`;
            html += \`<div class="detail-item"><div class="detail-label">Method</div><div class="detail-value">\${data.method}</div></div>\`;
            
            if (data.headers) {
                html += \`<div class="detail-item"><div class="detail-label">Request Headers</div><div class="detail-value"><pre>\${JSON.stringify(data.headers, null, 2)}</pre></div></div>\`;
            }
            
            if (data.postData) {
                html += \`<div class="detail-item"><div class="detail-label">Request Body</div><div class="detail-value"><pre>\${data.postData}</pre></div></div>\`;
            }
            html += '</div>';
            
            if (data.response) {
                html += '<div class="detail-section">';
                html += '<h4>Response Details</h4>';
                
                const statusClass = data.response.status >= 200 && data.response.status < 300 ? 'status-success' : 'status-error';
                html += \`<div class="detail-item"><div class="detail-label">Status</div><div class="detail-value"><span class="status-badge \${statusClass}">\${data.response.status} \${data.response.statusText}</span></div></div>\`;
                
                if (data.response.headers) {
                    html += \`<div class="detail-item"><div class="detail-label">Response Headers</div><div class="detail-value"><pre>\${JSON.stringify(data.response.headers, null, 2)}</pre></div></div>\`;
                }
                
                if (data.response.body) {
                    let bodyDisplay = data.response.body;
                    if (typeof bodyDisplay === 'object') {
                        bodyDisplay = JSON.stringify(bodyDisplay, null, 2);
                    }
                    html += \`<div class="detail-item"><div class="detail-label">Response Body</div><div class="detail-value response-body"><pre>\${bodyDisplay}</pre></div></div>\`;
                }
                
                if (data.loadingFinished) {
                    html += \`<div class="detail-item"><div class="detail-label">Data Size</div><div class="detail-value">\${formatBytes(data.loadingFinished.encodedDataLength)}</div></div>\`;
                }
                
                html += '</div>';
            }
            
            if (data.loadingFailed) {
                html += '<div class="detail-section">';
                html += '<h4>Error Details</h4>';
                html += \`<div class="detail-item"><div class="detail-label">Error</div><div class="detail-value"><span class="status-badge status-error">\${data.loadingFailed.errorText}</span></div></div>\`;
                html += '</div>';
            }
            
            return html;
        }

        function generateInteractionDetails(data) {
            let html = '<div class="detail-section">';
            html += '<h4>Interaction Details</h4>';
            html += \`<div class="detail-item"><div class="detail-label">Type</div><div class="detail-value">\${data.type}</div></div>\`;
            
            // Handle coordinates object
            if (data.coordinates && data.coordinates.clientX !== undefined) {
                html += \`<div class="detail-item"><div class="detail-label">Client Coordinates</div><div class="detail-value">(\${data.coordinates.clientX}, \${data.coordinates.clientY})</div></div>\`;
            }
            
            if (data.coordinates && data.coordinates.pageX !== undefined) {
                html += \`<div class="detail-item"><div class="detail-label">Page Coordinates</div><div class="detail-value">(\${data.coordinates.pageX}, \${data.coordinates.pageY})</div></div>\`;
            }
            
            // Handle scrollPosition object
            if (data.scrollPosition) {
                html += \`<div class="detail-item"><div class="detail-label">Scroll Position</div><div class="detail-value">(\${data.scrollPosition.x}, \${data.scrollPosition.y})</div></div>\`;
            }
            
            if (data.element) {
                html += \`<div class="detail-item"><div class="detail-label">Element</div><div class="detail-value"><pre>\${JSON.stringify(data.element, null, 2)}</pre></div></div>\`;
            }
            
            html += '</div>';
            return html;
        }

        function generateSnapshotDetails(data) {
            let html = '<div class="detail-section">';
            html += '<h4>Snapshot Details</h4>';
            html += \`<div class="detail-item"><div class="detail-label">URL</div><div class="detail-value">\${data.url}</div></div>\`;
            html += \`<div class="detail-item"><div class="detail-label">Element Count</div><div class="detail-value">\${data.elements.length}</div></div>\`;
            
            if (data.viewport) {
                html += \`<div class="detail-item"><div class="detail-label">Viewport</div><div class="detail-value">\${data.viewport.width}x\${data.viewport.height}</div></div>\`;
            }
            
            if (data.elements && data.elements.length > 0) {
                html += '<div class="detail-item"><div class="detail-label">Elements</div><div class="detail-value"><pre>';
                data.elements.slice(0, 20).forEach((el, i) => {
                    html += \`\${i + 1}. \${el.tagName}\${el.id ? ' #' + el.id : ''}\${el.className ? ' .' + el.className : ''}\\n\`;
                });
                if (data.elements.length > 20) {
                    html += \`... and \${data.elements.length - 20} more\\n\`;
                }
                html += '</pre></div></div>';
            }
            
            html += '</div>';
            return html;
        }

        function formatTimestamp(ms) {
            const seconds = Math.floor(ms / 1000);
            const minutes = Math.floor(seconds / 60);
            const hours = Math.floor(minutes / 60);
            
            if (hours > 0) {
                return \`\${hours}h \${minutes % 60}m \${seconds % 60}s\`;
            } else if (minutes > 0) {
                return \`\${minutes}m \${seconds % 60}s\`;
            } else {
                return \`\${seconds}s\`;
            }
        }

        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
        }

        function truncateUrl(url) {
            try {
                const urlObj = new URL(url);
                const path = urlObj.pathname + urlObj.search;
                return path.length > 50 ? path.substring(0, 50) + '...' : path;
            } catch {
                return url.length > 50 ? url.substring(0, 50) + '...' : url;
            }
        }

        init();
    </script>
</body>
</html>`;

    function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        }
        return `${seconds}s`;
    }

    function generateTimelineTracks(data, startTime, endTime) {
        const duration = endTime - startTime;
        let html = '';

        // Network track with vertical list
        if (data.networkLogs && data.networkLogs.length > 0) {
            html += '<div class="timeline-track" style="min-height: auto; flex-direction: column; align-items: stretch;">';
            html += '<div class="track-label" style="padding: 0.5rem 1rem; position: sticky; top: 0; background: #f7fafc; z-index: 5; border-bottom: 1px solid #e2e8f0;">Network Requests</div>';
            html += '<div style="display: flex; flex-direction: column;">';
            data.networkLogs.forEach((log, index) => {
                const method = log.method || 'GET';
                const url = log.url.split('?')[0].split('/').pop() || 'API';
                const status = log.response ? log.response.status : '...';
                const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(2);
                html += `<div class="event-pill network" data-type="network" data-index="${index}" style="position: relative; left: 0; margin: 0.25rem 1rem; max-width: none; border-radius: 6px; justify-content: space-between;">
                    <span>${method} ${url}</span>
                    <span style="opacity: 0.8; font-size: 0.7rem;">${status} • ${relativeTime}s</span>
                </div>`;
            });
            html += '</div></div>';
        }

        // Interactions track with vertical list
        if (data.interactionLogs && data.interactionLogs.length > 0) {
            html += '<div class="timeline-track" style="min-height: auto; flex-direction: column; align-items: stretch;">';
            html += '<div class="track-label" style="padding: 0.5rem 1rem; position: sticky; top: 0; background: #f7fafc; z-index: 5; border-bottom: 1px solid #e2e8f0;">User Interactions</div>';
            html += '<div style="display: flex; flex-direction: column;">';
            data.interactionLogs.forEach((log, index) => {
                const globalIndex = data.networkLogs ? data.networkLogs.length + index : index;
                const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(2);
                html += `<div class="event-pill interaction" data-type="interaction" data-index="${globalIndex}" style="position: relative; left: 0; margin: 0.25rem 1rem; max-width: none; border-radius: 6px; justify-content: space-between;">
                    <span>${log.type}</span>
                    <span style="opacity: 0.8; font-size: 0.7rem;">${relativeTime}s</span>
                </div>`;
            });
            html += '</div></div>';
        }

        // Snapshots track with vertical list
        if (data.elementSnapshots && data.elementSnapshots.length > 0) {
            html += '<div class="timeline-track" style="min-height: auto; flex-direction: column; align-items: stretch;">';
            html += '<div class="track-label" style="padding: 0.5rem 1rem; position: sticky; top: 0; background: #f7fafc; z-index: 5; border-bottom: 1px solid #e2e8f0;">Element Snapshots</div>';
            html += '<div style="display: flex; flex-direction: column;">';
            data.elementSnapshots.forEach((snapshot, index) => {
                const globalIndex = (data.networkLogs?.length || 0) + (data.interactionLogs?.length || 0) + index;
                const relativeTime = ((snapshot.timestamp - startTime) / 1000).toFixed(2);
                html += `<div class="event-pill snapshot" data-type="snapshot" data-index="${globalIndex}" style="position: relative; left: 0; margin: 0.25rem 1rem; max-width: none; border-radius: 6px; justify-content: space-between;">
                    <span>Snapshot (${snapshot.elements.length})</span>
                    <span style="opacity: 0.8; font-size: 0.7rem;">${relativeTime}s</span>
                </div>`;
            });
            html += '</div></div>';
        }

        return html;
    }
}

/**
 * Generates HTML timeline with embedded video player
 * This creates a split-view interface:
 * - Left side: Video player with controls
 * - Right side: Synchronized logs (Network/Interactions/Snapshots)
 * 
 * The video is referenced either as:
 * - A data URL (if small enough and provided as blob)
 * - A relative file path (if exported separately)
 * 
 * @param {Object} data - Export data with logs and metadata
 * @param {Blob|null} videoBlob - The video blob (optional, for data URL embedding)
 * @param {string|null} videoFileName - The video filename (for relative path reference)
 * @returns {Promise<string>} HTML content as string
 */
function generateVideoTimelineHTML(data, videoBlob = null, videoFileName = null) {
    console.log('[VideoHTML] Generating video timeline HTML...');

    // The export zip always ships the video next to this HTML, so reference it by filename.
    const videoSrc = videoBlob ? (videoFileName || 'video.webm') : null;
    if (!videoSrc) console.warn('[VideoHTML] No video blob provided');

    // Process events
    const allEvents = [];

    if (data.networkLogs) {
        data.networkLogs.forEach(log => {
            allEvents.push({ type: 'network', timestamp: log.timestamp, data: log });
        });
    }

    if (data.interactionLogs) {
        data.interactionLogs.forEach(log => {
            allEvents.push({ type: 'interaction', timestamp: log.timestamp, data: log });
        });
    }

    if (data.elementSnapshots) {
        data.elementSnapshots.forEach(snapshot => {
            allEvents.push({ type: 'snapshot', timestamp: snapshot.timestamp, data: snapshot });
        });
    }

    allEvents.sort((a, b) => a.timestamp - b.timestamp);

    const firstEventTime = allEvents.length > 0 ? allEvents[0].timestamp : Date.now();
    const lastEventTime = allEvents.length > 0 ? allEvents[allEvents.length - 1].timestamp : Date.now();
    // Anchor the timeline to when the video actually started (video t=0) so highlighted
    // events line up with the footage. Fall back to the first captured event for older
    // exports or when the video start time is unavailable.
    const startTime = data.videoStartTime || firstEventTime;
    const endTime = lastEventTime;
    const duration = Math.max(0, endTime - startTime);

    // Only what the player needs to draw clicks on the video (t = ms since video t=0).
    const clicks = (data.interactionLogs || [])
        .filter(log => log.type === 'click' && log.coordinates && log.viewport)
        .map(log => ({
            t: log.timestamp - startTime,
            x: log.coordinates.clientX,
            y: log.coordinates.clientY,
            vw: log.viewport.width,
            vh: log.viewport.height
        }));

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video Timeline - ${new Date(data.exportDate).toLocaleString()}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            overflow: hidden;
        }

        .video-layout {
            display: flex;
            height: 100vh;
        }

        .video-section {
            flex: 0 0 60%;
            background: #000;
            display: flex;
            flex-direction: column;
            border-right: 2px solid #1e293b;
        }

        .video-header {
            padding: 1rem;
            background: #1e293b;
            border-bottom: 1px solid #334155;
        }

        .video-header h1 {
            font-size: 1.25rem;
            font-weight: 600;
            color: #f1f5f9;
        }

        .video-container {
            flex: 1;
            min-height: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #000;
            position: relative;
            overflow: hidden;
        }

        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            cursor: pointer;
        }

        .click-layer {
            position: absolute;
            inset: 0;
            pointer-events: none;
        }

        .click-marker {
            position: absolute;
            display: none;
            width: 44px;
            height: 44px;
            margin: -22px 0 0 -22px;
            border-radius: 50%;
            border: 3px solid #f43f5e;
            background: rgba(244, 63, 94, 0.25);
            box-shadow: 0 0 12px rgba(244, 63, 94, 0.6);
        }

        .click-marker::after {
            content: '';
            position: absolute;
            left: 50%;
            top: 50%;
            width: 10px;
            height: 10px;
            margin: -5px 0 0 -5px;
            border-radius: 50%;
            background: #f43f5e;
        }

        .click-tick {
            position: absolute;
            top: -3px;
            width: 2px;
            height: 12px;
            margin-left: -1px;
            background: #f43f5e;
            border-radius: 1px;
            pointer-events: none;
        }

        .video-placeholder {
            text-align: center;
            color: #64748b;
            padding: 2rem;
        }

        .video-placeholder svg {
            width: 80px;
            height: 80px;
            margin-bottom: 1rem;
            opacity: 0.5;
        }

        .video-controls {
            padding: 1rem;
            background: #1e293b;
            border-top: 1px solid #334155;
        }

        .controls-row {
            display: flex;
            align-items: center;
            gap: 1rem;
            margin-bottom: 0.75rem;
        }

        .play-btn {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: #3b82f6;
            border: none;
            color: white;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.2s;
        }

        .play-btn:hover {
            background: #2563eb;
            transform: scale(1.05);
        }

        .time-display {
            font-size: 0.875rem;
            font-variant-numeric: tabular-nums;
            color: #94a3b8;
            min-width: 120px;
        }

        .timeline-slider {
            flex: 1;
            height: 6px;
            background: #334155;
            border-radius: 3px;
            position: relative;
            cursor: pointer;
            touch-action: none;
        }

        .timeline-progress {
            height: 100%;
            background: #3b82f6;
            border-radius: 3px;
            position: relative;
        }

        .timeline-handle {
            position: absolute;
            right: -6px;
            top: 50%;
            transform: translateY(-50%);
            width: 12px;
            height: 12px;
            background: white;
            border-radius: 50%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        }

        .speed-control {
            padding: 0.5rem 0.75rem;
            background: #334155;
            border: 1px solid #475569;
            border-radius: 6px;
            color: #e2e8f0;
            font-size: 0.875rem;
            cursor: pointer;
        }

        .data-section {
            flex: 0 0 40%;
            background: #1e293b;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .data-header {
            padding: 1rem;
            background: #334155;
            border-bottom: 1px solid #475569;
        }

        .data-tabs {
            display: flex;
            gap: 0.5rem;
        }

        .data-tab {
            padding: 0.5rem 1rem;
            background: transparent;
            border: none;
            color: #94a3b8;
            font-size: 0.875rem;
            font-weight: 500;
            cursor: pointer;
            border-radius: 6px;
            transition: all 0.2s;
        }

        .data-tab.active {
            background: #1e293b;
            color: #3b82f6;
        }

        .data-tab:hover {
            color: #e2e8f0;
        }

        .data-content {
            flex: 1;
            overflow-y: auto;
            padding: 0;
        }

        .log-list {
            list-style: none;
        }

        .log-item {
            padding: 0.75rem 1rem;
            border-bottom: 1px solid #334155;
            cursor: pointer;
            transition: background 0.2s;
            display: flex;
            align-items: flex-start;
            gap: 0.75rem;
        }

        .log-item:hover {
            background: #334155;
        }

        .log-item.active {
            background: #1e40af;
            border-left: 3px solid #3b82f6;
        }

        .log-item.selected {
            background: #1e3a8a;
            box-shadow: inset 3px 0 0 #f43f5e;
        }

        .log-time {
            font-size: 0.75rem;
            color: #64748b;
            font-variant-numeric: tabular-nums;
            min-width: 48px;
            flex-shrink: 0;
            padding-top: 0.125rem;
        }

        .log-content {
            flex: 1;
            min-width: 0;
        }

        .log-method {
            display: inline-block;
            padding: 0.125rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            margin-right: 0.5rem;
        }

        .method-GET { background: #065f46; color: #d1fae5; }
        .method-POST { background: #1e40af; color: #dbeafe; }
        .method-PUT { background: #c2410c; color: #fed7aa; }
        .method-DELETE { background: #991b1b; color: #fecaca; }
        .method-PATCH { background: #7e22ce; color: #f3e8ff; }

        .log-url {
            font-size: 0.8125rem;
            line-height: 1.4;
            color: #cbd5e1;
            overflow-wrap: anywhere;
            margin-top: 0.375rem;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .log-item.selected .log-url {
            display: block;
            -webkit-line-clamp: unset;
        }

        .log-status {
            display: inline-block;
            font-size: 0.75rem;
            margin-top: 0.25rem;
            padding: 0.125rem 0.5rem;
            border-radius: 4px;
            font-weight: 500;
        }

        .status-success { background: #064e3b; color: #a7f3d0; }
        .status-error { background: #7f1d1d; color: #fca5a5; }
        .status-pending { background: #713f12; color: #fde68a; }

        .interaction-icon {
            width: 32px;
            height: 32px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.875rem;
            flex-shrink: 0;
        }

        .icon-click { background: #1e40af; }
        .icon-scroll { background: #0891b2; }
        .icon-drag { background: #c026d3; }
        .icon-input { background: #ea580c; }

        .interaction-details {
            flex: 1;
            min-width: 0;
        }

        .interaction-type {
            font-size: 0.875rem;
            font-weight: 600;
            color: #f1f5f9;
            text-transform: capitalize;
        }

        .interaction-info {
            font-size: 0.75rem;
            color: #94a3b8;
            margin-top: 0.25rem;
            overflow-wrap: anywhere;
        }

        .summary-section {
            padding: 1rem;
            background: #334155;
            border-bottom: 1px solid #475569;
        }

        .summary-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 0.75rem;
        }

        .summary-item {
            text-align: center;
        }

        .summary-value {
            font-size: 1.5rem;
            font-weight: 700;
            color: #3b82f6;
        }

        .summary-label {
            font-size: 0.75rem;
            color: #94a3b8;
            margin-top: 0.25rem;
        }

        ::-webkit-scrollbar {
            width: 8px;
        }

        ::-webkit-scrollbar-track {
            background: #1e293b;
        }

        ::-webkit-scrollbar-thumb {
            background: #475569;
            border-radius: 4px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #64748b;
        }

        .no-video {
            color: #64748b;
            font-size: 0.875rem;
        }
    </style>
</head>
<body>
    <div class="video-layout">
        <!-- Video Section (60%) -->
        <div class="video-section">
            <div class="video-header">
                <h1>Session Replay - ${new Date(data.exportDate).toLocaleString()}</h1>
            </div>
            
            <div class="video-container" id="videoContainer">
                ${videoSrc ? `<video id="videoPlayer" src="${videoSrc}" playsinline></video><div class="click-layer" id="clickLayer"></div>` : `
                <div class="video-placeholder">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <circle cx="12" cy="12" r="10"/>
                        <polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/>
                    </svg>
                    <p class="no-video">Video recording not available</p>
                    <p style="font-size: 0.75rem; margin-top: 0.5rem;">${videoFileName ? 'Video file: ' + videoFileName + ' (place in same directory as this HTML file)' : 'Enable video mode to capture screen recording'}</p>
                </div>
                `}
            </div>
            
            ${videoSrc ? `
            <div class="video-controls">
                <div class="controls-row">
                    <button class="play-btn" id="playBtn">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                    </button>
                    <div class="time-display" id="timeDisplay">00:00 / 00:00</div>
                    <div class="timeline-slider" id="timelineSlider">
                        <div class="timeline-progress" id="timelineProgress" style="width: 0%">
                            <div class="timeline-handle"></div>
                        </div>
                    </div>
                    <select class="speed-control" id="speedControl">
                        <option value="0.5">0.5x</option>
                        <option value="1" selected>1x</option>
                        <option value="1.5">1.5x</option>
                        <option value="2">2x</option>
                    </select>
                </div>
            </div>
            ` : ''}
        </div>

        <!-- Data Section (40%) -->
        <div class="data-section">
            <div class="summary-section">
                <div class="summary-grid">
                    <div class="summary-item">
                        <div class="summary-value">${data.summary.totalNetworkRequests}</div>
                        <div class="summary-label">Network</div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-value">${data.summary.totalInteractions}</div>
                        <div class="summary-label">Interactions</div>
                    </div>
                    <div class="summary-item">
                        <div class="summary-value">${formatDuration(duration)}</div>
                        <div class="summary-label">Duration</div>
                    </div>
                </div>
            </div>

            <div class="data-header">
                <div class="data-tabs">
                    <button class="data-tab active" data-tab="network">Network</button>
                    <button class="data-tab" data-tab="interactions">Interactions</button>
                    <button class="data-tab" data-tab="snapshots">Snapshots</button>
                </div>
            </div>
            
            <div class="data-content">
                <ul class="log-list" id="networkList">
                    ${generateNetworkList(data.networkLogs, startTime)}
                </ul>
                <ul class="log-list" id="interactionsList" style="display: none;">
                    ${generateInteractionsList(data.interactionLogs, startTime)}
                </ul>
                <ul class="log-list" id="snapshotsList" style="display: none;">
                    ${generateSnapshotsList(data.elementSnapshots, startTime)}
                </ul>
            </div>
        </div>
    </div>

    <script>
        const startTime = ${startTime};
        const hasVideo = ${!!videoSrc};
        const fallbackDuration = ${duration / 1000};
        const clicks = ${JSON.stringify(clicks).replace(/</g, '\\u003c')};
        let seekVideo = null;

        // Tab switching
        document.querySelectorAll('.data-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                document.querySelectorAll('.data-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                document.getElementById('networkList').style.display = 'none';
                document.getElementById('interactionsList').style.display = 'none';
                document.getElementById('snapshotsList').style.display = 'none';
                
                document.getElementById(tabName + 'List').style.display = 'block';
            });
        });

        // Clicking a row selects it (expanding its full text) and jumps the video to that moment.
        document.querySelectorAll('.log-item[data-timestamp]').forEach(item => {
            item.addEventListener('click', () => {
                document.querySelectorAll('.log-item.selected').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                if (seekVideo) seekVideo((Number(item.dataset.timestamp) - startTime) / 1000);
            });
        });

        if (hasVideo) {
            const video = document.getElementById('videoPlayer');
            const playBtn = document.getElementById('playBtn');
            const timeDisplay = document.getElementById('timeDisplay');
            const timelineSlider = document.getElementById('timelineSlider');
            const timelineProgress = document.getElementById('timelineProgress');
            const speedControl = document.getElementById('speedControl');
            const clickLayer = document.getElementById('clickLayer');
            const PLAY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
            const PAUSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
            const CLICK_SHOW_SECONDS = 1.2;
            const logItems = Array.from(document.querySelectorAll('.log-item[data-timestamp]'))
                .map(el => ({ el, timestamp: Number(el.dataset.timestamp) }));
            const markers = clicks.map(() => {
                const marker = document.createElement('div');
                marker.className = 'click-marker';
                clickLayer.appendChild(marker);
                return marker;
            });
            let durationPending = false;
            let pendingSeek = null;
            let lastHighlightBucket = -1;

            function getDuration() {
                return isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackDuration;
            }

            function currentPosition() {
                return durationPending ? (pendingSeek || 0) : video.currentTime;
            }

            // MediaRecorder WebM files carry no duration; seeking past the end makes the browser work it out.
            function onMetadata() {
                if (isFinite(video.duration)) {
                    renderTicks();
                    render();
                    return;
                }
                durationPending = true;
                video.addEventListener('durationchange', function resolved() {
                    if (!isFinite(video.duration)) return;
                    video.removeEventListener('durationchange', resolved);
                    // Let the seek to the end finish first; overlapping seeks can leave the player off 0.
                    const finish = () => {
                        durationPending = false;
                        video.currentTime = pendingSeek || 0;
                        pendingSeek = null;
                        renderTicks();
                        render();
                    };
                    if (video.seeking) video.addEventListener('seeked', finish, { once: true });
                    else finish();
                });
                video.currentTime = 1e101;
            }
            if (video.readyState >= 1) onMetadata();
            else video.addEventListener('loadedmetadata', onMetadata, { once: true });

            function seekTo(seconds) {
                const target = Math.max(0, Math.min(seconds, getDuration()));
                if (durationPending) pendingSeek = target;
                else video.currentTime = target;
                render();
            }
            seekVideo = seekTo;

            function togglePlay() {
                if (video.paused || video.ended) video.play();
                else video.pause();
            }

            playBtn.addEventListener('click', togglePlay);
            video.addEventListener('click', togglePlay);
            document.addEventListener('keydown', (e) => {
                if (e.code !== 'Space' || e.target.closest('button, select, input')) return;
                e.preventDefault();
                togglePlay();
            });

            video.addEventListener('play', () => {
                playBtn.innerHTML = PAUSE_ICON;
                requestAnimationFrame(loop);
            });
            video.addEventListener('pause', () => {
                playBtn.innerHTML = PLAY_ICON;
                render();
            });
            video.addEventListener('seeked', render);
            window.addEventListener('resize', render);

            // Redraw every frame while playing; timeupdate only fires ~4 times a second.
            function loop() {
                render();
                if (!video.paused && !video.ended) requestAnimationFrame(loop);
            }

            // Scrubber: click or drag.
            function seekFromPointer(e) {
                const rect = timelineSlider.getBoundingClientRect();
                seekTo(((e.clientX - rect.left) / rect.width) * getDuration());
            }
            timelineSlider.addEventListener('pointerdown', (e) => {
                timelineSlider.setPointerCapture(e.pointerId);
                seekFromPointer(e);
            });
            timelineSlider.addEventListener('pointermove', (e) => {
                if (timelineSlider.hasPointerCapture(e.pointerId)) seekFromPointer(e);
            });

            // Speed control
            speedControl.addEventListener('change', (e) => {
                video.playbackRate = parseFloat(e.target.value);
            });

            function render() {
                const current = currentPosition();
                const total = getDuration();
                timelineProgress.style.width = (total ? Math.min(100, (current / total) * 100) : 0) + '%';
                timeDisplay.textContent = formatTime(current) + ' / ' + formatTime(total);
                renderClicks(current);
                const bucket = Math.floor(current * 4);
                if (bucket !== lastHighlightBucket) {
                    lastHighlightBucket = bucket;
                    highlightCurrentEvents(current * 1000);
                }
            }

            function renderTicks() {
                const total = getDuration();
                if (!total) return;
                timelineSlider.querySelectorAll('.click-tick').forEach(tick => tick.remove());
                clicks.forEach(click => {
                    const tick = document.createElement('div');
                    tick.className = 'click-tick';
                    tick.style.left = Math.max(0, Math.min(100, (click.t / 1000 / total) * 100)) + '%';
                    timelineSlider.appendChild(tick);
                });
            }

            // Where the frame is drawn inside the video element (object-fit: contain).
            function frameBox() {
                const vW = video.videoWidth;
                const vH = video.videoHeight;
                const scale = Math.min(video.clientWidth / vW, video.clientHeight / vH);
                return { vW, vH, scale, left: (video.clientWidth - vW * scale) / 2, top: (video.clientHeight - vH * scale) / 2 };
            }

            // Tab capture letterboxes the tab's viewport into the frame, centered and aspect-preserved.
            function clickPoint(click, box) {
                const s = Math.min(box.vW / click.vw, box.vH / click.vh);
                const fx = (box.vW - click.vw * s) / 2 + click.x * s;
                const fy = (box.vH - click.vh * s) / 2 + click.y * s;
                return { x: box.left + fx * box.scale, y: box.top + fy * box.scale };
            }

            function renderClicks(current) {
                if (!video.videoWidth) return;
                const box = frameBox();
                clicks.forEach((click, i) => {
                    const marker = markers[i];
                    const age = current - click.t / 1000;
                    // Small negative slack so seeking exactly onto a click still shows it.
                    if (age < -0.15 || age > CLICK_SHOW_SECONDS) {
                        marker.style.display = 'none';
                        return;
                    }
                    const point = clickPoint(click, box);
                    const progress = Math.max(0, age) / CLICK_SHOW_SECONDS;
                    marker.style.display = 'block';
                    marker.style.left = point.x + 'px';
                    marker.style.top = point.y + 'px';
                    marker.style.opacity = String(1 - progress * 0.85);
                    marker.style.transform = 'scale(' + (0.7 + progress * 0.6) + ')';
                });
            }

            function formatTime(seconds) {
                if (!isFinite(seconds)) seconds = 0;
                const mins = Math.floor(seconds / 60);
                const secs = Math.floor(seconds % 60);
                return mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
            }

            function highlightCurrentEvents(currentTimeMs) {
                const currentTimestamp = startTime + currentTimeMs;
                logItems.forEach(({ el, timestamp }) => {
                    el.classList.toggle('active', Math.abs(timestamp - currentTimestamp) < 1000);
                });
            }

            render();
        }
    </script>
</body>
</html>`;

    function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function generateNetworkList(logs, startTime) {
        if (!logs || logs.length === 0) return '<li class="log-item"><div class="log-content">No network requests recorded</div></li>';

        return logs.map(log => {
            const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(1);
            const method = escapeHtml(log.method || 'GET');
            const url = escapeHtml(log.url || '');
            const status = log.response ? log.response.status : 'pending';
            const statusClass = status >= 200 && status < 300 ? 'status-success' : (status === 'pending' ? 'status-pending' : 'status-error');

            return `
                <li class="log-item" data-timestamp="${log.timestamp}">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="log-content">
                        <div>
                            <span class="log-method method-${method}">${method}</span>
                            <span class="log-status ${statusClass}">${escapeHtml(status)}</span>
                        </div>
                        <div class="log-url" title="${url}">${url}</div>
                    </div>
                </li>
            `;
        }).join('');
    }

    function generateInteractionsList(logs, startTime) {
        if (!logs || logs.length === 0) return '<li class="log-item"><div class="log-content">No interactions recorded</div></li>';

        return logs.map(log => {
            const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(1);
            const type = log.type || 'unknown';
            const iconClass = `icon-${type}`;
            const icon = type === 'click' ? '🖱️' : type === 'scroll' ? '📜' : type === 'drag' ? '✋' : '⌨️';

            let details = '';
            if (log.coordinates) {
                details = `at (${log.coordinates.clientX}, ${log.coordinates.clientY})`;
            } else if (log.scrollPosition) {
                details = `to (${log.scrollPosition.x}, ${log.scrollPosition.y})`;
            }

            return `
                <li class="log-item" data-timestamp="${log.timestamp}">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="interaction-icon ${iconClass}">${icon}</div>
                    <div class="interaction-details">
                        <div class="interaction-type">${type}</div>
                        ${details ? `<div class="interaction-info">${details}</div>` : ''}
                    </div>
                </li>
            `;
        }).join('');
    }

    function generateSnapshotsList(snapshots, startTime) {
        if (!snapshots || snapshots.length === 0) return '<li class="log-item"><div class="log-content">No snapshots recorded</div></li>';

        return snapshots.map(snapshot => {
            const relativeTime = ((snapshot.timestamp - startTime) / 1000).toFixed(1);
            const elementCount = snapshot.elements ? snapshot.elements.length : 0;

            return `
                <li class="log-item" data-timestamp="${snapshot.timestamp}">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="log-content">
                        <div class="interaction-type">Element Snapshot</div>
                        <div class="interaction-info">${elementCount} elements captured</div>
                    </div>
                </li>
            `;
        }).join('');
    }
}

function clearAllLogs() {
    networkLogs = [];
    videoBlob = null;
    chrome.storage.local.remove(['interactionLogs', 'elementSnapshots', 'recordedVideoBlob']);
    videoStoreRequest('readwrite', store => store.delete(NETWORK_LOGS_ID))
        .catch(e => console.warn('[NetworkLogs] Failed to clear saved network logs:', e));
    console.log('All logs cleared');
}

chrome.tabs.onRemoved.addListener((tabId) => {
    if (attachedTabs.has(tabId)) {
        stopRecording(tabId).catch(err => console.error('Error cleaning up tab:', err));
    }
});

self.addEventListener('install', (event) => {
    console.log('Service worker installed');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service worker activated');
    event.waitUntil(clients.claim());
});

console.log('Background service worker loaded');