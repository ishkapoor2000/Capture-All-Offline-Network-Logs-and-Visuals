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

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    <meta name="color-scheme" content="light dark">
    <title>Capture All timeline · ${new Date(data.exportDate).toLocaleString()}</title>
    <style>
        :root {
            --bg: #f7f7f8;
            --panel: #ffffff;
            --panel-2: #f2f2f4;
            --line: #e4e4e7;
            --line-2: #d4d4d8;
            --text: #18181b;
            --text-2: #52525b;
            --text-3: #6b6b74;
            --accent: #ce2c31;
            --accent-soft: rgba(206, 44, 49, 0.09);
            --ok: #18794e;
            --ok-soft: rgba(24, 121, 78, 0.1);
            --info: #0d74ce;
            --info-soft: rgba(13, 116, 206, 0.09);
            --warn: #a35200;
            --warn-soft: rgba(241, 161, 13, 0.14);
            --shadow: 0 1px 2px rgba(24, 24, 27, 0.05), 0 12px 32px -16px rgba(24, 24, 27, 0.16);
            --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
            --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --bg: #0c0c0e;
                --panel: #141417;
                --panel-2: #1b1b1f;
                --line: #25252a;
                --line-2: #34343b;
                --text: #ececef;
                --text-2: #b0b0b9;
                --text-3: #8a8a94;
                --accent: #ff6369;
                --accent-soft: rgba(229, 72, 77, 0.14);
                --ok: #3dd68c;
                --ok-soft: rgba(61, 214, 140, 0.12);
                --info: #70b8ff;
                --info-soft: rgba(112, 184, 255, 0.12);
                --warn: #f1a10d;
                --warn-soft: rgba(241, 161, 13, 0.12);
                --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 32px -16px rgba(0, 0, 0, 0.7);
            }
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            -webkit-font-smoothing: antialiased;
        }

        button, select {
            font: inherit;
            color: inherit;
        }

        :focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
        }

        .header {
            border-bottom: 1px solid var(--line);
            background: var(--panel);
        }

        .header-inner {
            display: flex;
            align-items: center;
            gap: 12px;
            max-width: 1280px;
            margin: 0 auto;
            padding: 16px 24px;
        }

        .mark {
            flex: none;
            width: 30px;
            height: 30px;
            border-radius: 9px;
            background: var(--text);
            display: grid;
            place-items: center;
        }

        .mark span {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 0 3px var(--text);
        }

        .header h1 {
            font-size: 16px;
            font-weight: 650;
            letter-spacing: -0.01em;
            line-height: 1.25;
        }

        .header p {
            font-size: 12.5px;
            color: var(--text-3);
        }

        .version {
            margin-left: auto;
            padding: 3px 8px;
            border: 1px solid var(--line);
            border-radius: 6px;
            font-family: var(--mono);
            font-size: 11px;
            color: var(--text-3);
        }

        .container {
            max-width: 1280px;
            margin: 0 auto;
            padding: 24px;
        }

        .container > * {
            animation: rise 0.4s var(--ease) both;
        }

        .container > :nth-child(2) { animation-delay: 60ms; }
        .container > :nth-child(3) { animation-delay: 120ms; }

        @keyframes rise {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: none; }
        }

        .summary-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            border: 1px solid var(--line);
            border-radius: 14px;
            background: var(--panel);
            overflow: hidden;
            margin-bottom: 20px;
        }

        .summary-card {
            padding: 16px 20px;
        }

        .summary-card + .summary-card {
            border-left: 1px solid var(--line);
        }

        .summary-card h3 {
            font-size: 26px;
            font-weight: 600;
            letter-spacing: -0.02em;
            font-variant-numeric: tabular-nums;
            line-height: 1.2;
        }

        .summary-card p {
            font-size: 12.5px;
            color: var(--text-3);
        }

        .timeline-section {
            border: 1px solid var(--line);
            border-radius: 14px;
            background: var(--panel);
            box-shadow: var(--shadow);
            padding: 20px;
        }

        .timeline-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 16px;
        }

        .timeline-title {
            font-size: 15px;
            font-weight: 650;
            letter-spacing: -0.01em;
        }

        .playback-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .playback-btn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            padding: 0 12px;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--panel);
            font-size: 13px;
            font-weight: 550;
            cursor: pointer;
            transition: background 0.15s var(--ease), border-color 0.15s var(--ease), transform 0.12s var(--ease);
        }

        .playback-btn svg {
            width: 14px;
            height: 14px;
        }

        .playback-btn:hover:not(:disabled) {
            background: var(--panel-2);
            border-color: var(--line-2);
        }

        .playback-btn:active:not(:disabled) {
            transform: scale(0.97);
        }

        .playback-btn.primary {
            border-color: transparent;
            background: var(--text);
            color: var(--panel);
        }

        .playback-btn.primary:hover:not(:disabled) {
            background: var(--text);
            opacity: 0.88;
        }

        .playback-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .speed-selector {
            height: 32px;
            padding: 0 8px;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--panel);
            font-size: 13px;
            cursor: pointer;
        }

        .playback-info {
            display: flex;
            align-items: baseline;
            gap: 10px;
            margin-bottom: 12px;
        }

        .current-time {
            font-family: var(--mono);
            font-size: 22px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            letter-spacing: -0.02em;
        }

        .total-time {
            font-size: 13px;
            color: var(--text-3);
        }

        .current-event-card {
            display: none;
            margin-bottom: 14px;
            padding: 10px 14px;
            border-radius: 10px;
            background: var(--accent-soft);
            box-shadow: inset 2px 0 0 var(--accent);
        }

        .current-event-card.active {
            display: block;
            animation: rise 0.25s var(--ease) both;
        }

        .current-event-card h4 {
            font-size: 11.5px;
            font-weight: 600;
            color: var(--accent);
            margin-bottom: 2px;
        }

        .current-event-card .event-summary {
            font-size: 13px;
            overflow-wrap: anywhere;
        }

        .event-time {
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 12px;
        }

        .timeline-wrapper {
            border: 1px solid var(--line);
            border-radius: 10px;
            max-height: 600px;
            overflow: auto;
            overscroll-behavior: contain;
        }

        .timeline {
            position: relative;
        }

        .cursor-track {
            position: sticky;
            top: 0;
            z-index: 10;
            display: flex;
            align-items: center;
            height: 40px;
            padding: 0 16px;
            border-bottom: 1px solid var(--line);
            background: var(--panel);
        }

        .track-label {
            width: 150px;
            flex-shrink: 0;
            font-size: 12px;
            font-weight: 600;
            color: var(--text-2);
        }

        .track-content {
            flex: 1;
            position: relative;
            height: 100%;
        }

        .track-content::before {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            top: 50%;
            height: 4px;
            margin-top: -2px;
            border-radius: 2px;
            background: var(--panel-2);
        }

        .cursor-marker {
            position: absolute;
            top: 50%;
            width: 12px;
            height: 12px;
            margin: -6px 0 0 -6px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 0 4px var(--accent-soft);
            transition: left 0.1s linear;
        }

        .timeline-track {
            display: flex;
            flex-direction: column;
            border-bottom: 1px solid var(--line);
        }

        .timeline-track:last-child {
            border-bottom: none;
        }

        .timeline-track .track-label {
            position: sticky;
            top: 40px;
            z-index: 5;
            width: auto;
            padding: 8px 16px;
            border-bottom: 1px solid var(--line);
            background: var(--panel-2);
        }

        .track-list {
            display: flex;
            flex-direction: column;
            padding: 4px;
        }

        .event-pill {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            min-height: 34px;
            padding: 6px 12px;
            border: none;
            border-radius: 7px;
            background: transparent;
            text-align: left;
            font-size: 13px;
            cursor: pointer;
            transition: background 0.15s var(--ease);
        }

        .event-pill:hover {
            background: var(--panel-2);
        }

        .event-pill.selected {
            background: var(--accent-soft);
            box-shadow: inset 2px 0 0 var(--accent);
        }

        .pill-main {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }

        .pill-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .pill-meta {
            flex: none;
            font-family: var(--mono);
            font-size: 11.5px;
            color: var(--text-3);
            font-variant-numeric: tabular-nums;
        }

        .tag {
            flex: none;
            padding: 1px 6px;
            border-radius: 5px;
            font-family: var(--mono);
            font-size: 10.5px;
            font-weight: 600;
            background: var(--panel-2);
            color: var(--text-2);
        }

        .tag.network { background: var(--ok-soft); color: var(--ok); }
        .tag.interaction { background: var(--info-soft); color: var(--info); }
        .tag.snapshot { background: var(--warn-soft); color: var(--warn); }

        .details-panel {
            display: none;
            margin-top: 20px;
            padding: 24px;
            border: 1px solid var(--line);
            border-radius: 14px;
            background: var(--panel);
            box-shadow: var(--shadow);
        }

        .details-panel.active {
            display: block;
            animation: rise 0.3s var(--ease) both;
        }

        .details-panel h3 {
            font-size: 15px;
            font-weight: 650;
            margin-bottom: 16px;
        }

        .details-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 16px;
        }

        .detail-section {
            min-width: 0;
            padding: 16px;
            border: 1px solid var(--line);
            border-radius: 10px;
            background: var(--bg);
        }

        .detail-section h4 {
            font-size: 12px;
            font-weight: 600;
            color: var(--text-3);
            margin-bottom: 10px;
        }

        .detail-item + .detail-item {
            margin-top: 10px;
        }

        .detail-label {
            font-size: 11.5px;
            color: var(--text-3);
            margin-bottom: 2px;
        }

        .detail-value {
            font-size: 13px;
            overflow-wrap: anywhere;
        }

        .detail-value pre {
            max-height: 320px;
            overflow: auto;
            padding: 10px 12px;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--panel);
            font-family: var(--mono);
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .status-badge {
            display: inline-block;
            padding: 1px 8px;
            border-radius: 6px;
            font-family: var(--mono);
            font-size: 12px;
            font-weight: 600;
        }

        .status-success { background: var(--ok-soft); color: var(--ok); }
        .status-error { background: var(--accent-soft); color: var(--accent); }

        @media (max-width: 720px) {
            .summary-grid { grid-template-columns: repeat(2, 1fr); }
            .summary-card:nth-child(3) { border-left: none; }
            .summary-card:nth-child(n + 3) { border-top: 1px solid var(--line); }
            .container { padding: 16px; }
            .track-label { width: 90px; }
        }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }
    </style>
</head>
<body>
    <header class="header">
        <div class="header-inner">
            <span class="mark" aria-hidden="true"><span></span></span>
            <div>
                <h1>Capture All timeline</h1>
                <p>Session recorded ${new Date(data.exportDate).toLocaleString()}</p>
            </div>
            ${data.extensionVersion ? `<span class="version">v${escapeHtml(data.extensionVersion)}</span>` : ''}
        </div>
    </header>

    <main class="container">
        <section class="summary-grid" aria-label="Summary">
            <div class="summary-card">
                <h3>${data.summary.totalNetworkRequests}</h3>
                <p>Network requests</p>
            </div>
            <div class="summary-card">
                <h3>${data.summary.totalInteractions}</h3>
                <p>Interactions</p>
            </div>
            <div class="summary-card">
                <h3>${data.summary.totalElementSnapshots}</h3>
                <p>Element snapshots</p>
            </div>
            <div class="summary-card">
                <h3>${formatDuration(duration)}</h3>
                <p>Duration</p>
            </div>
        </section>

        <section class="timeline-section" aria-labelledby="timelineTitle">
            <div class="timeline-header">
                <h2 class="timeline-title" id="timelineTitle">Timeline</h2>
                <div class="playback-controls">
                    <select class="speed-selector" id="speedSelector" aria-label="Playback speed">
                        <option value="0.5">0.5×</option>
                        <option value="1" selected>1×</option>
                        <option value="2">2×</option>
                        <option value="5">5×</option>
                        <option value="10">10×</option>
                    </select>
                    <button class="playback-btn primary" id="playBtn">
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12.5-7.5a1 1 0 000-1.72L8.5 3.64A1 1 0 007 4.5z"/></svg>
                        Play
                    </button>
                    <button class="playback-btn" id="pauseBtn" disabled>
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>
                        Pause
                    </button>
                    <button class="playback-btn" id="resetBtn">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 103-6.7L3 8M3 3v5h5"/></svg>
                        Reset
                    </button>
                </div>
            </div>

            <div class="playback-info">
                <div class="current-time" id="currentTime" aria-live="off">00:00.000</div>
                <div class="total-time">of ${formatDuration(duration)}</div>
            </div>

            <div class="current-event-card" id="currentEventCard" aria-live="polite">
                <h4>Now</h4>
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
        </section>

        <section class="details-panel" id="detailsPanel" aria-live="polite">
        </section>
    </main>

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
                captureData.networkLogs.forEach((log, sourceIndex) => {
                    allEvents.push({
                        type: 'network',
                        sourceIndex,
                        timestamp: log.timestamp,
                        data: log
                    });
                });
            }
            
            if (captureData.interactionLogs) {
                captureData.interactionLogs.forEach((log, sourceIndex) => {
                    allEvents.push({
                        type: 'interaction',
                        sourceIndex,
                        timestamp: log.timestamp,
                        data: log
                    });
                });
            }
            
            if (captureData.elementSnapshots) {
                captureData.elementSnapshots.forEach((snapshot, sourceIndex) => {
                    allEvents.push({
                        type: 'snapshot',
                        sourceIndex,
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

            // Pills carry their index within their own type's list; allEvents is sorted by time.
            document.querySelectorAll('.event-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    const sourceIndex = parseInt(pill.dataset.index);
                    const event = allEvents.find(e => e.type === pill.dataset.type && e.sourceIndex === sourceIndex);
                    if (!event) return;
                    document.querySelectorAll('.event-pill.selected').forEach(el => el.classList.remove('selected'));
                    pill.classList.add('selected');
                    showEventDetails(event);
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
                summaryText = \`<strong>\${esc(method)}</strong> \${esc(url)} · \${esc(status)} <span class="event-time">\${timeStr}</span>\`;
            } else if (event.type === 'interaction') {
                const interactionType = event.data.type || 'unknown';
                let details = '';
                if (event.data.coordinates) {
                    details = \` at (\${event.data.coordinates.clientX}, \${event.data.coordinates.clientY})\`;
                } else if (event.data.scrollPosition) {
                    details = \` to (\${event.data.scrollPosition.x}, \${event.data.scrollPosition.y})\`;
                }
                summaryText = \`<strong>\${esc(interactionType)}</strong>\${esc(details)} <span class="event-time">\${timeStr}</span>\`;
            } else if (event.type === 'snapshot') {
                const elementCount = event.data.elements ? event.data.elements.length : 0;
                summaryText = \`<strong>Snapshot</strong> \${elementCount} elements captured <span class="event-time">\${timeStr}</span>\`;
            }
            
            summary.innerHTML = summaryText;
        }

        function showEventDetails(event) {
            const panel = document.getElementById('detailsPanel');
            panel.classList.add('active');
            
            let detailsHTML = '<h3>Event details</h3><div class="details-grid">';
            
            // Common details
            detailsHTML += '<div class="detail-section">';
            detailsHTML += '<h4>Event</h4>';
            detailsHTML += \`<div class="detail-item"><div class="detail-label">Type</div><div class="detail-value">\${esc(event.type)}</div></div>\`;
            detailsHTML += \`<div class="detail-item"><div class="detail-label">Timestamp</div><div class="detail-value">\${new Date(event.timestamp).toLocaleString()}</div></div>\`;
            detailsHTML += \`<div class="detail-item"><div class="detail-label">Relative time</div><div class="detail-value">\${formatTimestamp(event.timestamp - startTime)}</div></div>\`;
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
            html += '<h4>Request</h4>';
            html += \`<div class="detail-item"><div class="detail-label">URL</div><div class="detail-value">\${esc(data.url)}</div></div>\`;
            html += \`<div class="detail-item"><div class="detail-label">Method</div><div class="detail-value">\${esc(data.method)}</div></div>\`;
            
            if (data.headers) {
                html += \`<div class="detail-item"><div class="detail-label">Request headers</div><div class="detail-value"><pre>\${esc(JSON.stringify(data.headers, null, 2))}</pre></div></div>\`;
            }
            
            if (data.postData) {
                html += \`<div class="detail-item"><div class="detail-label">Request body</div><div class="detail-value"><pre>\${esc(data.postData)}</pre></div></div>\`;
            }
            html += '</div>';
            
            if (data.response) {
                html += '<div class="detail-section">';
                html += '<h4>Response</h4>';
                
                const statusClass = data.response.status >= 200 && data.response.status < 300 ? 'status-success' : 'status-error';
                html += \`<div class="detail-item"><div class="detail-label">Status</div><div class="detail-value"><span class="status-badge \${statusClass}">\${esc(data.response.status)} \${esc(data.response.statusText || '')}</span></div></div>\`;
                
                if (data.response.headers) {
                    html += \`<div class="detail-item"><div class="detail-label">Response headers</div><div class="detail-value"><pre>\${esc(JSON.stringify(data.response.headers, null, 2))}</pre></div></div>\`;
                }
                
                if (data.response.body) {
                    let bodyDisplay = data.response.body;
                    if (typeof bodyDisplay === 'object') {
                        bodyDisplay = JSON.stringify(bodyDisplay, null, 2);
                    }
                    html += \`<div class="detail-item"><div class="detail-label">Response body</div><div class="detail-value response-body"><pre>\${esc(bodyDisplay)}</pre></div></div>\`;
                }
                
                if (data.loadingFinished) {
                    html += \`<div class="detail-item"><div class="detail-label">Size</div><div class="detail-value">\${formatBytes(data.loadingFinished.encodedDataLength)}</div></div>\`;
                }
                
                html += '</div>';
            }
            
            if (data.loadingFailed) {
                html += '<div class="detail-section">';
                html += '<h4>Error</h4>';
                html += \`<div class="detail-item"><div class="detail-label">Error</div><div class="detail-value"><span class="status-badge status-error">\${esc(data.loadingFailed.errorText)}</span></div></div>\`;
                html += '</div>';
            }
            
            return html;
        }

        function generateInteractionDetails(data) {
            let html = '<div class="detail-section">';
            html += '<h4>Interaction</h4>';
            html += \`<div class="detail-item"><div class="detail-label">Type</div><div class="detail-value">\${esc(data.type)}</div></div>\`;
            
            // Handle coordinates object
            if (data.coordinates && data.coordinates.clientX !== undefined) {
                html += \`<div class="detail-item"><div class="detail-label">Client coordinates</div><div class="detail-value">(\${data.coordinates.clientX}, \${data.coordinates.clientY})</div></div>\`;
            }
            
            if (data.coordinates && data.coordinates.pageX !== undefined) {
                html += \`<div class="detail-item"><div class="detail-label">Page coordinates</div><div class="detail-value">(\${data.coordinates.pageX}, \${data.coordinates.pageY})</div></div>\`;
            }
            
            // Handle scrollPosition object
            if (data.scrollPosition) {
                html += \`<div class="detail-item"><div class="detail-label">Scroll position</div><div class="detail-value">(\${data.scrollPosition.x}, \${data.scrollPosition.y})</div></div>\`;
            }
            
            if (data.element) {
                html += \`<div class="detail-item"><div class="detail-label">Element</div><div class="detail-value"><pre>\${esc(JSON.stringify(data.element, null, 2))}</pre></div></div>\`;
            }
            
            html += '</div>';
            return html;
        }

        function generateSnapshotDetails(data) {
            let html = '<div class="detail-section">';
            html += '<h4>Snapshot</h4>';
            html += \`<div class="detail-item"><div class="detail-label">URL</div><div class="detail-value">\${esc(data.url)}</div></div>\`;
            html += \`<div class="detail-item"><div class="detail-label">Element count</div><div class="detail-value">\${data.elements.length}</div></div>\`;
            
            if (data.viewport) {
                html += \`<div class="detail-item"><div class="detail-label">Viewport</div><div class="detail-value">\${data.viewport.width}x\${data.viewport.height}</div></div>\`;
            }
            
            if (data.elements && data.elements.length > 0) {
                html += '<div class="detail-item"><div class="detail-label">Elements</div><div class="detail-value"><pre>';
                data.elements.slice(0, 20).forEach((el, i) => {
                    html += esc(\`\${i + 1}. \${el.tagName}\${el.id ? ' #' + el.id : ''}\${el.className ? ' .' + el.className : ''}\`) + '\\n';
                });
                if (data.elements.length > 20) {
                    html += \`... and \${data.elements.length - 20} more\\n\`;
                }
                html += '</pre></div></div>';
            }
            
            html += '</div>';
            return html;
        }

        function esc(value) {
            return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
        // data-index is the position in that type's own list; the page script maps it back to the event.
        const track = (label, items) => `<div class="timeline-track"><div class="track-label">${label}</div><div class="track-list">${items}</div></div>`;
        const pill = (type, index, tag, name, meta) => `<button class="event-pill ${type}" data-type="${type}" data-index="${index}">
                    <span class="pill-main"><span class="tag ${type}">${tag}</span><span class="pill-name">${name}</span></span>
                    <span class="pill-meta">${meta}</span>
                </button>`;
        const at = timestamp => ((timestamp - startTime) / 1000).toFixed(2) + 's';
        let html = '';

        if (data.networkLogs && data.networkLogs.length > 0) {
            html += track('Network requests', data.networkLogs.map((log, index) => {
                const url = String(log.url || '').split('?')[0].split('/').pop() || 'API';
                const status = log.response ? log.response.status : '...';
                return pill('network', index, escapeHtml(log.method || 'GET'), escapeHtml(url), `${escapeHtml(status)} · ${at(log.timestamp)}`);
            }).join(''));
        }

        if (data.interactionLogs && data.interactionLogs.length > 0) {
            html += track('User interactions', data.interactionLogs.map((log, index) =>
                pill('interaction', index, escapeHtml(log.type || 'event'), escapeHtml(log.element && log.element.text ? log.element.text.replace(/\s+/g, ' ').trim().slice(0, 80) : (log.element ? String(log.element.tagName || '').toLowerCase() : '')), at(log.timestamp))
            ).join(''));
        }

        if (data.elementSnapshots && data.elementSnapshots.length > 0) {
            html += track('Element snapshots', data.elementSnapshots.map((snapshot, index) =>
                pill('snapshot', index, 'snapshot', `${(snapshot.elements || []).length} elements`, at(snapshot.timestamp))
            ).join(''));
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

    const recordedAt = new Date(data.exportDate).toLocaleString();
    const pageUrl = ((data.interactionLogs || []).find(log => log.url) || (data.networkLogs || [])[0] || {}).url;
    const host = hostOf(pageUrl);
    const snapshotCount = (data.elementSnapshots || []).length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <title>Session replay${host ? ' · ' + escapeHtml(host) : ''} · ${escapeHtml(recordedAt)}</title>
    <style>
        :root {
            --bg: #0c0c0e;
            --panel: #141417;
            --panel-2: #1b1b1f;
            --line: #25252a;
            --line-2: #34343b;
            --text: #ececef;
            --text-2: #b0b0b9;
            --text-3: #8a8a94;
            --accent: #e5484d;
            --accent-soft: rgba(229, 72, 77, 0.14);
            --ok: #3dd68c;
            --warn: #f1a10d;
            --info: #70b8ff;
            --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
            --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            overflow: hidden;
            -webkit-font-smoothing: antialiased;
        }

        button, select {
            font: inherit;
            color: inherit;
        }

        :focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
        }

        .app {
            display: flex;
            flex-direction: column;
            height: 100vh;
            height: 100dvh;
        }

        /* Top bar */
        .topbar {
            display: flex;
            align-items: center;
            gap: 14px;
            padding: 12px 20px;
            border-bottom: 1px solid var(--line);
            background: var(--panel);
            animation: fade 0.4s var(--ease) both;
        }

        .mark {
            flex: none;
            width: 28px;
            height: 28px;
            border-radius: 8px;
            background: var(--text);
            display: grid;
            place-items: center;
        }

        .mark span {
            width: 11px;
            height: 11px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 0 3px var(--text);
        }

        .title {
            min-width: 0;
        }

        .title h1 {
            font-size: 14px;
            font-weight: 650;
            letter-spacing: -0.01em;
        }

        .title p {
            font-size: 12px;
            color: var(--text-3);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .chips {
            display: flex;
            gap: 6px;
            margin-left: auto;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .chip {
            display: inline-flex;
            align-items: baseline;
            gap: 5px;
            padding: 4px 9px;
            border: 1px solid var(--line-2);
            border-radius: 7px;
            font-size: 12px;
            color: var(--text-3);
            white-space: nowrap;
        }

        .chip b {
            color: var(--text);
            font-weight: 600;
            font-variant-numeric: tabular-nums;
        }

        .chip.version {
            font-family: var(--mono);
            font-size: 11px;
        }

        /* Two-pane layout */
        .video-layout {
            flex: 1;
            min-height: 0;
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(340px, 38%);
        }

        .video-section {
            display: flex;
            flex-direction: column;
            min-width: 0;
            padding: 16px;
            gap: 12px;
            animation: fade 0.45s var(--ease) 60ms both;
        }

        .video-container {
            flex: 1;
            min-height: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
            border-radius: 12px;
            background: #000;
            box-shadow: 0 0 0 1px var(--line), 0 24px 48px -24px rgba(0, 0, 0, 0.8);
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
            width: 40px;
            height: 40px;
            margin: -20px 0 0 -20px;
            border-radius: 50%;
            border: 2px solid var(--accent);
            background: rgba(229, 72, 77, 0.22);
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 0 18px rgba(229, 72, 77, 0.55);
        }

        .click-marker::after {
            content: '';
            position: absolute;
            left: 50%;
            top: 50%;
            width: 8px;
            height: 8px;
            margin: -4px 0 0 -4px;
            border-radius: 50%;
            background: var(--accent);
        }

        /* Ripple replays each time a marker appears (display none -> block restarts it). */
        .click-marker::before {
            content: '';
            position: absolute;
            inset: -2px;
            border-radius: 50%;
            border: 2px solid var(--accent);
            animation: ripple 0.7s var(--ease) both;
        }

        @keyframes ripple {
            from { transform: scale(0.6); opacity: 0.9; }
            to { transform: scale(2.2); opacity: 0; }
        }

        .video-placeholder {
            display: grid;
            justify-items: center;
            gap: 8px;
            padding: 32px;
            text-align: center;
            color: var(--text-3);
            max-width: 340px;
        }

        .video-placeholder svg {
            width: 40px;
            height: 40px;
            color: var(--text-3);
            margin-bottom: 4px;
        }

        .no-video {
            color: var(--text);
            font-weight: 600;
        }

        /* Transport */
        .video-controls {
            padding: 10px 12px;
            border: 1px solid var(--line);
            border-radius: 12px;
            background: var(--panel);
        }

        .controls-row {
            display: flex;
            align-items: center;
            gap: 14px;
        }

        .play-btn {
            flex: none;
            width: 36px;
            height: 36px;
            border-radius: 50%;
            border: none;
            background: var(--text);
            color: var(--bg);
            display: grid;
            place-items: center;
            cursor: pointer;
            transition: transform 0.15s var(--ease), background 0.15s var(--ease);
        }

        .play-btn:hover {
            background: #fff;
        }

        .play-btn:active {
            transform: scale(0.94);
        }

        .play-btn svg {
            width: 16px;
            height: 16px;
        }

        .time-display {
            flex: none;
            min-width: 96px;
            font-family: var(--mono);
            font-size: 12px;
            color: var(--text-2);
            font-variant-numeric: tabular-nums;
        }

        .timeline-slider {
            flex: 1;
            height: 22px;
            position: relative;
            cursor: pointer;
            touch-action: none;
            border-radius: 4px;
        }

        .timeline-slider::before {
            content: '';
            position: absolute;
            left: 0;
            right: 0;
            top: 50%;
            height: 4px;
            margin-top: -2px;
            border-radius: 2px;
            background: var(--line-2);
            transition: transform 0.15s var(--ease);
        }

        .timeline-progress {
            position: absolute;
            left: 0;
            top: 50%;
            height: 4px;
            margin-top: -2px;
            border-radius: 2px;
            background: var(--accent);
            transition: transform 0.15s var(--ease);
        }

        .timeline-slider:hover::before,
        .timeline-slider:hover .timeline-progress,
        .timeline-slider:focus-visible::before,
        .timeline-slider:focus-visible .timeline-progress {
            transform: scaleY(1.5);
        }

        .timeline-handle {
            position: absolute;
            right: -7px;
            top: 50%;
            width: 14px;
            height: 14px;
            margin-top: -7px;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 0 0 4px rgba(229, 72, 77, 0.35), 0 2px 6px rgba(0, 0, 0, 0.5);
            transform: scale(0.6);
            transition: transform 0.15s var(--ease);
        }

        .timeline-slider:hover .timeline-handle,
        .timeline-slider:focus-visible .timeline-handle,
        .timeline-slider:active .timeline-handle {
            transform: scale(1);
        }

        .click-tick {
            position: absolute;
            top: 50%;
            width: 2px;
            height: 10px;
            margin: -5px 0 0 -1px;
            border-radius: 1px;
            background: #fff;
            opacity: 0.55;
            pointer-events: none;
        }

        .speed-control {
            flex: none;
            height: 30px;
            padding: 0 8px;
            border: 1px solid var(--line-2);
            border-radius: 8px;
            background: var(--panel-2);
            font-size: 12px;
            font-variant-numeric: tabular-nums;
            cursor: pointer;
        }

        .shortcuts {
            margin-top: 8px;
            font-size: 11.5px;
            color: var(--text-3);
        }

        kbd {
            font-family: var(--mono);
            font-size: 10.5px;
            padding: 1px 5px;
            border: 1px solid var(--line-2);
            border-bottom-width: 2px;
            border-radius: 4px;
            color: var(--text-2);
        }

        /* Side panel */
        .data-section {
            display: flex;
            flex-direction: column;
            min-height: 0;
            border-left: 1px solid var(--line);
            background: var(--panel);
            animation: fade 0.45s var(--ease) 120ms both;
        }

        .data-header {
            padding: 12px 12px 0;
            border-bottom: 1px solid var(--line);
        }

        .data-tabs {
            display: flex;
            gap: 4px;
        }

        .data-tab {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 10px 11px;
            border: none;
            background: transparent;
            color: var(--text-3);
            font-size: 12.5px;
            font-weight: 550;
            cursor: pointer;
            transition: color 0.15s var(--ease);
        }

        .data-tab::after {
            content: '';
            position: absolute;
            left: 10px;
            right: 10px;
            bottom: -1px;
            height: 2px;
            border-radius: 2px;
            background: var(--accent);
            transform: scaleX(0);
            transition: transform 0.2s var(--ease);
        }

        .data-tab:hover {
            color: var(--text);
        }

        .data-tab.active {
            color: var(--text);
        }

        .data-tab.active::after {
            transform: scaleX(1);
        }

        .tab-count {
            padding: 0 6px;
            border-radius: 5px;
            background: var(--panel-2);
            color: var(--text-3);
            font-size: 11px;
            font-variant-numeric: tabular-nums;
        }

        .data-content {
            flex: 1;
            overflow-y: auto;
            overscroll-behavior: contain;
        }

        .log-list {
            list-style: none;
            padding: 6px;
        }

        .log-item {
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 9px 10px;
            border-radius: 8px;
            cursor: pointer;
            transition: background 0.16s var(--ease), box-shadow 0.16s var(--ease);
        }

        .log-item + .log-item {
            margin-top: 1px;
        }

        .log-item:hover {
            background: var(--panel-2);
        }

        .log-item.active {
            background: rgba(255, 255, 255, 0.045);
            box-shadow: inset 2px 0 0 var(--text-3);
        }

        .log-item.selected {
            background: var(--accent-soft);
            box-shadow: inset 2px 0 0 var(--accent);
        }

        .log-item.empty {
            justify-content: center;
            padding: 40px 16px;
            color: var(--text-3);
            cursor: default;
        }

        .log-item.empty:hover {
            background: transparent;
        }

        .log-time {
            flex: none;
            min-width: 44px;
            padding-top: 1px;
            font-family: var(--mono);
            font-size: 11.5px;
            color: var(--text-3);
            font-variant-numeric: tabular-nums;
        }

        .log-content {
            flex: 1;
            min-width: 0;
        }

        .log-meta {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .log-method,
        .log-status {
            display: inline-block;
            padding: 1px 6px;
            border-radius: 5px;
            font-family: var(--mono);
            font-size: 10.5px;
            font-weight: 600;
            letter-spacing: 0.02em;
        }

        .log-method { background: var(--panel-2); color: var(--text-2); }
        .method-POST { background: rgba(112, 184, 255, 0.12); color: var(--info); }
        .method-PUT, .method-PATCH { background: rgba(241, 161, 13, 0.12); color: var(--warn); }
        .method-DELETE { background: var(--accent-soft); color: var(--accent); }

        .status-success { background: rgba(61, 214, 140, 0.12); color: var(--ok); }
        .status-error { background: var(--accent-soft); color: #ff8589; }
        .status-pending { background: rgba(241, 161, 13, 0.12); color: var(--warn); }

        .log-url {
            margin-top: 5px;
            font-family: var(--mono);
            font-size: 12px;
            line-height: 1.45;
            color: var(--text);
            overflow-wrap: anywhere;
            display: -webkit-box;
            -webkit-line-clamp: 3;
            -webkit-box-orient: vertical;
            overflow: hidden;
        }

        .url-host {
            color: var(--text-3);
        }

        .log-item.selected .log-url {
            display: block;
            -webkit-line-clamp: unset;
        }

        .interaction-icon {
            flex: none;
            width: 26px;
            height: 26px;
            border-radius: 7px;
            display: grid;
            place-items: center;
            background: var(--panel-2);
            color: var(--text-2);
        }

        .interaction-icon svg {
            width: 14px;
            height: 14px;
        }

        .icon-click {
            background: var(--accent-soft);
            color: var(--accent);
        }

        .interaction-details {
            flex: 1;
            min-width: 0;
        }

        .interaction-type {
            font-size: 12.5px;
            font-weight: 600;
            color: var(--text);
        }

        .interaction-info {
            margin-top: 2px;
            font-size: 12px;
            color: var(--text-2);
            overflow-wrap: anywhere;
        }

        .interaction-info code {
            font-family: var(--mono);
            font-size: 11.5px;
            color: var(--text-3);
        }

        ::-webkit-scrollbar {
            width: 10px;
        }

        ::-webkit-scrollbar-thumb {
            border: 3px solid var(--panel);
            border-radius: 6px;
            background: var(--line-2);
        }

        ::-webkit-scrollbar-thumb:hover {
            background: #4a4a52;
        }

        @keyframes fade {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: none; }
        }

        @media (max-width: 900px) {
            body { overflow: auto; }
            .app { height: auto; }
            .video-layout { grid-template-columns: minmax(0, 1fr); }
            .data-section { min-width: 0; }
            .data-tabs { overflow-x: auto; }
            .data-tab { padding-left: 8px; padding-right: 8px; }
            .video-container { aspect-ratio: 16 / 10; flex: none; }
            .data-section { border-left: none; border-top: 1px solid var(--line); height: 70vh; }
            .chips { display: none; }
        }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                animation-iteration-count: 1 !important;
                transition-duration: 0.01ms !important;
            }
        }
    </style>
</head>
<body>
    <div class="app">
        <header class="topbar">
            <span class="mark" aria-hidden="true"><span></span></span>
            <div class="title">
                <h1>Session replay</h1>
                <p>${host ? escapeHtml(host) + ' · ' : ''}Recorded ${escapeHtml(recordedAt)}</p>
            </div>
            <div class="chips">
                <span class="chip"><b>${formatDuration(duration)}</b> duration</span>
                <span class="chip"><b>${data.summary.totalNetworkRequests}</b> requests</span>
                <span class="chip"><b>${data.summary.totalInteractions}</b> interactions</span>
                ${data.extensionVersion ? `<span class="chip version">v${escapeHtml(data.extensionVersion)}</span>` : ''}
            </div>
        </header>

        <main class="video-layout">
            <section class="video-section" aria-label="Recording">
                <div class="video-container" id="videoContainer">
                    ${videoSrc ? `<video id="videoPlayer" src="${videoSrc}" playsinline aria-label="Screen recording of the session"></video><div class="click-layer" id="clickLayer"></div>` : `
                    <div class="video-placeholder">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <rect x="2.5" y="5.5" width="13" height="13" rx="2.5"/>
                            <path d="M15.5 10l6-3.5v11l-6-3.5M3 3l18 18"/>
                        </svg>
                        <p class="no-video">No video in this export</p>
                        <p>${videoFileName ? 'Keep ' + escapeHtml(videoFileName) + ' in the same folder as this file.' : 'Record in Video + logs mode to include the screen recording.'}</p>
                    </div>
                    `}
                </div>

                ${videoSrc ? `
                <div class="video-controls">
                    <div class="controls-row">
                        <button class="play-btn" id="playBtn" aria-label="Play">
                            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12.5-7.5a1 1 0 000-1.72L8.5 3.64A1 1 0 007 4.5z"/></svg>
                        </button>
                        <div class="time-display" id="timeDisplay" aria-hidden="true">00:00 / 00:00</div>
                        <div class="timeline-slider" id="timelineSlider" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
                            <div class="timeline-progress" id="timelineProgress" style="width: 0%">
                                <div class="timeline-handle"></div>
                            </div>
                        </div>
                        <select class="speed-control" id="speedControl" aria-label="Playback speed">
                            <option value="0.5">0.5×</option>
                            <option value="1" selected>1×</option>
                            <option value="1.5">1.5×</option>
                            <option value="2">2×</option>
                        </select>
                    </div>
                    <p class="shortcuts"><kbd>Space</kbd> play / pause · <kbd>←</kbd> <kbd>→</kbd> 5 s on the timeline · click a row to jump to it</p>
                </div>
                ` : ''}
            </section>

            <aside class="data-section" aria-label="Captured events">
                <div class="data-header">
                    <div class="data-tabs" role="tablist" aria-label="Event type">
                        <button class="data-tab active" data-tab="network" role="tab" id="tab-network" aria-controls="networkList" aria-selected="true">Network <span class="tab-count">${(data.networkLogs || []).length}</span></button>
                        <button class="data-tab" data-tab="interactions" role="tab" id="tab-interactions" aria-controls="interactionsList" aria-selected="false" tabindex="-1">Interactions <span class="tab-count">${(data.interactionLogs || []).length}</span></button>
                        <button class="data-tab" data-tab="snapshots" role="tab" id="tab-snapshots" aria-controls="snapshotsList" aria-selected="false" tabindex="-1">Snapshots <span class="tab-count">${snapshotCount}</span></button>
                    </div>
                </div>

                <div class="data-content">
                    <ul class="log-list" id="networkList" role="tabpanel" aria-labelledby="tab-network">
                        ${generateNetworkList(data.networkLogs, startTime)}
                    </ul>
                    <ul class="log-list" id="interactionsList" role="tabpanel" aria-labelledby="tab-interactions" style="display: none;">
                        ${generateInteractionsList(data.interactionLogs, startTime)}
                    </ul>
                    <ul class="log-list" id="snapshotsList" role="tabpanel" aria-labelledby="tab-snapshots" style="display: none;">
                        ${generateSnapshotsList(data.elementSnapshots, startTime)}
                    </ul>
                </div>
            </aside>
        </main>
    </div>

    <script>
        const startTime = ${startTime};
        const hasVideo = ${!!videoSrc};
        const fallbackDuration = ${duration / 1000};
        const clicks = ${JSON.stringify(clicks).replace(/</g, '\\u003c')};
        let seekVideo = null;

        // Tab switching (click, Space/Enter, or arrow keys inside the tab list).
        const tabs = Array.from(document.querySelectorAll('.data-tab'));
        function selectTab(tab) {
            tabs.forEach(t => {
                const on = t === tab;
                t.classList.toggle('active', on);
                t.setAttribute('aria-selected', String(on));
                t.tabIndex = on ? 0 : -1;
                document.getElementById(t.dataset.tab + 'List').style.display = on ? 'block' : 'none';
            });
        }
        tabs.forEach((tab, i) => {
            tab.addEventListener('click', () => selectTab(tab));
            tab.addEventListener('keydown', (e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                selectTab(next);
                next.focus();
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
            const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12.5-7.5a1 1 0 000-1.72L8.5 3.64A1 1 0 007 4.5z"/></svg>';
            const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>';
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
                playBtn.setAttribute('aria-label', 'Pause');
                requestAnimationFrame(loop);
            });
            video.addEventListener('pause', () => {
                playBtn.innerHTML = PLAY_ICON;
                playBtn.setAttribute('aria-label', 'Play');
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
            timelineSlider.addEventListener('keydown', (e) => {
                const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
                if (step) seekTo(currentPosition() + step);
                else if (e.key === 'Home') seekTo(0);
                else if (e.key === 'End') seekTo(getDuration());
                else return;
                e.preventDefault();
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
                timelineSlider.setAttribute('aria-valuemax', String(Math.round(total)));
                timelineSlider.setAttribute('aria-valuenow', String(Math.round(current)));
                timelineSlider.setAttribute('aria-valuetext', formatTime(current) + ' of ' + formatTime(total));
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

    function hostOf(url) {
        try {
            return new URL(url).host;
        } catch (e) {
            return '';
        }
    }

    function emptyRow(text) {
        return `<li class="log-item empty">${text}</li>`;
    }

    function generateNetworkList(logs, startTime) {
        if (!logs || logs.length === 0) return emptyRow('No network requests recorded');

        return logs.map(log => {
            const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(1);
            const method = escapeHtml(log.method || 'GET');
            const rawUrl = log.url || '';
            const host = hostOf(rawUrl);
            const hostEnd = host ? rawUrl.indexOf(host) + host.length : 0;
            const status = log.response ? log.response.status : 'pending';
            const statusClass = status >= 200 && status < 300 ? 'status-success' : (status === 'pending' ? 'status-pending' : 'status-error');

            return `
                <li class="log-item" data-timestamp="${log.timestamp}">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="log-content">
                        <div class="log-meta">
                            <span class="log-method method-${method}">${method}</span>
                            <span class="log-status ${statusClass}">${escapeHtml(status)}</span>
                        </div>
                        <div class="log-url" title="${escapeHtml(rawUrl)}"><span class="url-host">${escapeHtml(rawUrl.slice(0, hostEnd))}</span>${escapeHtml(rawUrl.slice(hostEnd))}</div>
                    </div>
                </li>
            `;
        }).join('');
    }

    function generateInteractionsList(logs, startTime) {
        if (!logs || logs.length === 0) return emptyRow('No interactions recorded');

        const ICONS = {
            click: '<path d="M4 3l6.5 16 2.3-6.7L19.5 10 4 3z"/>',
            scroll: '<path d="M12 3v18M7.5 7.5L12 3l4.5 4.5M7.5 16.5L12 21l4.5-4.5"/>',
            drag: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
            input: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
            change: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>'
        };

        return logs.map(log => {
            const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(1);
            const type = log.type || 'unknown';
            const label = type.charAt(0).toUpperCase() + type.slice(1);
            const icon = ICONS[type] || ICONS.input;

            let position = '';
            if (log.coordinates) {
                position = `(${log.coordinates.clientX}, ${log.coordinates.clientY})`;
            } else if (log.scrollPosition) {
                position = `to (${log.scrollPosition.x}, ${log.scrollPosition.y})`;
            }
            const element = log.element || null;
            const text = element && element.text ? element.text.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
            const tag = element && element.tagName ? `<code>${escapeHtml(String(element.tagName).toLowerCase())}</code>` : '';
            const target = [tag, text && escapeHtml(`“${text}”`)].filter(Boolean).join(' ');
            const details = [target, position && `<code>${escapeHtml(position)}</code>`].filter(Boolean).join(' · ');

            return `
                <li class="log-item" data-timestamp="${log.timestamp}">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="interaction-icon icon-${escapeHtml(type)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></div>
                    <div class="interaction-details">
                        <div class="interaction-type">${escapeHtml(label)}</div>
                        ${details ? `<div class="interaction-info">${details}</div>` : ''}
                    </div>
                </li>
            `;
        }).join('');
    }

    function generateSnapshotsList(snapshots, startTime) {
        if (!snapshots || snapshots.length === 0) return emptyRow('No snapshots captured. Use Capture in the popup to add one');

        return snapshots.map(snapshot => {
            const relativeTime = ((snapshot.timestamp - startTime) / 1000).toFixed(1);
            const elementCount = snapshot.elements ? snapshot.elements.length : 0;

            return `
                <li class="log-item" data-timestamp="${snapshot.timestamp}">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="log-content">
                        <div class="interaction-type">Element snapshot</div>
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