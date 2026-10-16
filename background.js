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
let consoleErrors = [];
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
    const tab = await chrome.tabs.get(tabId);
    if (await pageAccess(tab.url || tab.pendingUrl) === 'policy') throw new Error(POLICY_BLOCKED);
    await clearArm();
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

// IT can limit recording to some sites with the allowedHosts policy (managed_schema.json). null: no limit.
// shortcut: until the policy has loaded after a worker restart, events pass unchecked; Chrome keeps the worker
// alive while the debugger is attached, so that only matters if it restarts mid-recording anyway.
let allowedHosts = null;
const blockedRequests = new Set();
async function loadPolicy() {
    try {
        const { allowedHosts: hosts } = await chrome.storage.managed.get('allowedHosts');
        allowedHosts = Array.isArray(hosts) && hosts.length ? hosts.map(h => String(h).trim().toLowerCase()).filter(Boolean) : null;
    } catch (e) {
        allowedHosts = null; // No managed storage outside Chrome policy (e.g. some Chromium builds).
    }
}
const policyReady = loadPolicy();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'managed') loadPolicy(); });

// "staging.example.com" matches that host; "*.example.com" matches example.com and every subdomain.
function urlAllowed(url) {
    if (!allowedHosts) return true;
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch (e) {
        return false;
    }
    return allowedHosts.some(rule => rule.startsWith('*.')
        ? host === rule.slice(2) || host.endsWith(rule.slice(1))
        : host === rule);
}

const POLICY_BLOCKED = 'Your organization does not allow recording on this site';

/**
 * Chrome keeps every extension off its own pages (New Tab, Settings, the Web Store...).
 * @returns {Promise<'ok'|'chrome'|'file-off'|'policy'>} 'file-off': a local file while "Allow access to file URLs"
 *   is off; 'policy': outside the allowedHosts an administrator set
 */
async function pageAccess(url) {
    const access = await chromeAccess(url);
    if (access !== 'ok') return access;
    await policyReady;
    return urlAllowed(url) ? 'ok' : 'policy';
}

async function chromeAccess(url) {
    let page;
    try {
        page = new URL(url || '');
    } catch (e) {
        return 'chrome';
    }
    const store = page.hostname === 'chromewebstore.google.com' ||
        (page.hostname === 'chrome.google.com' && page.pathname.startsWith('/webstore')) ||
        (page.hostname === 'microsoftedge.microsoft.com' && page.pathname.startsWith('/addons'));
    if (store) return 'chrome';
    if (page.protocol === 'http:' || page.protocol === 'https:') return 'ok';
    if (page.protocol === 'file:') return (await chrome.extension.isAllowedFileSchemeAccess()) ? 'ok' : 'file-off';
    return 'chrome';
}

// "Start on next website": a tab on a Chrome page waits for a website. Kept in storage because the
// service worker can stop while the user types the address.
async function armSession(tabId, mode) {
    await chrome.storage.local.set({ armedSession: { tabId, mode, ready: false } });
    await setTabBadge(tabId, 'WAIT', 'Capture All: waiting for a website in this tab');
}

async function clearArm() {
    const { armedSession } = await chrome.storage.local.get(['armedSession']);
    if (!armedSession) return;
    await chrome.storage.local.remove('armedSession');
    await setTabBadge(armedSession.tabId, '', 'Capture All');
}

async function setTabBadge(tabId, text, title) {
    try {
        await chrome.action.setBadgeText({ tabId, text });
        if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ce2c31' });
        await chrome.action.setTitle({ tabId, title });
    } catch (error) {
        // The tab is gone.
    }
}

// Chrome clears a tab's badge on every page load, so it is set again once the load completes.
async function handleArmedTab(tabId, status, url) {
    const { armedSession } = await chrome.storage.local.get(['armedSession']);
    if (!armedSession || armedSession.tabId !== tabId) return;
    const ok = await pageAccess(url) === 'ok';
    if (ok && armedSession.mode === 'logs') {
        try {
            await startSession(tabId, 'logs');
        } catch (error) {
            console.error('[Arm] Could not start recording:', error);
            await setTabBadge(tabId, 'ERR', 'Capture All could not start recording: ' + error.message);
        }
        return;
    }
    if (status !== 'complete') return;
    // Video needs a click on the extension on the page itself: Chrome grants tab capture only then.
    await chrome.storage.local.set({ armedSession: { ...armedSession, ready: ok } });
    await setTabBadge(tabId, ok ? '▶' : 'WAIT', ok
        ? 'Capture All: click to start recording'
        : 'Capture All: waiting for a website in this tab');
}

// One at a time, so two quick updates of the armed tab can't start two sessions.
let armQueue = Promise.resolve();
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo.status) return;
    armQueue = armQueue
        .then(() => handleArmedTab(tabId, changeInfo.status, tab.url))
        .catch(error => console.warn('[Arm]', error));
});

// content.js lives only as long as the page: after a full page load of the recorded tab, add it
// again. Its init() asks getStatus and resumes recording interactions by itself.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    const { recordingState } = await chrome.storage.local.get(['recordingState']);
    if (recordingState && recordingState.isRecording && recordingState.tabId === tabId) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && await pageAccess(tab.url) === 'ok') await ensureContentScript(tabId);
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
        await videoStoreRequest('readwrite', store => store.put({ id: NETWORK_LOGS_ID, logs: networkLogs, console: consoleErrors }));
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
        if (record && Array.isArray(record.console)) consoleErrors = record.console.concat(consoleErrors);
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

        case 'armSession':
            armSession(message.tabId, message.mode)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'cancelArm':
            clearArm()
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'getStatus':
            // Read the persisted flag so status is correct even after a SW restart (when the
            // in-memory isRecording would be false while a recording is still running).
            (async () => {
                try {
                    await networkLogsReady;
                    const { recordingState, armedSession } = await chrome.storage.local.get(['recordingState', 'armedSession']);
                    const active = !!(recordingState && recordingState.isRecording) || isRecording;
                    // The popup passes its tab: whether Chrome lets us record it, and whether it is armed.
                    let access = null;
                    if (message.tabId != null) {
                        const tab = await chrome.tabs.get(message.tabId).catch(() => null);
                        access = tab ? await pageAccess(tab.url || tab.pendingUrl) : null;
                    }
                    sendResponse({
                        isRecording: active,
                        mode: recordingState ? recordingState.mode : null,
                        networkLogsCount: networkLogs.length,
                        access,
                        armed: armedSession && armedSession.tabId === message.tabId ? armedSession : null
                    });
                } catch (e) {
                    sendResponse({ isRecording: isRecording, networkLogsCount: networkLogs.length });
                }
            })();
            return true;

        case 'exportLogs':
            exportAllLogs(message.tabId, message.mode || 'logs')
                .then(redacted => sendResponse({ success: true, redacted }))
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
        consoleErrors = [];
        blockedRequests.clear();
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
    // A redirect keeps its request ID, so once a request reaches a site outside allowedHosts, none of its
    // later events (response, body) may land on the earlier, allowed entry.
    if (params && blockedRequests.has(params.requestId)) return;

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
        case 'Runtime.consoleAPICalled':
            if (params.type === 'error' || params.type === 'assert') {
                handleConsoleError(params.timestamp, params.args.map(remoteText).join(' '), params.stackTrace, null, source.tabId);
            }
            break;
        case 'Runtime.exceptionThrown': {
            const details = params.exceptionDetails || {};
            const message = details.exception ? remoteText(details.exception) : details.text;
            handleConsoleError(params.timestamp, message, details.stackTrace, details, source.tabId);
            break;
        }
    }
    scheduleSaveNetworkLogs();
}

function handleNetworkRequest(params, tabId) {
    // Judged by the page that made the request, so a blocked site's own requests and its page load stay out.
    if (!urlAllowed(params.documentURL || params.request.url)) {
        blockedRequests.add(params.requestId);
        return;
    }
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

function handleNetworkResponse(params, tabId) {
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
        console.log('Network response logged:', params.response.status, networkLogs[requestIndex].url);
    }
}

// Fetched at loadingFinished: at responseReceived only the headers are in, and Chrome
// rejects getResponseBody for any response still streaming.
async function fetchResponseBody(log, requestId, tabId) {
    const mimeType = log.response && log.response.mimeType;
    if (!mimeType || !['json', 'javascript', 'text', 'xml'].some(kind => mimeType.includes(kind))) return;
    try {
        const responseBody = await chrome.debugger.sendCommand(
            { tabId: tabId },
            "Network.getResponseBody",
            { requestId: requestId }
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
            if (mimeType.includes('json')) {
                try {
                    bodyContent = JSON.parse(bodyContent);
                } catch (e) {
                    // Keep as string if not valid JSON
                }
            }

            log.response.body = bodyContent;
            log.response.bodySize = responseBody.body.length;
            scheduleSaveNetworkLogs();
        }
    } catch (error) {
        console.warn('Could not get response body for:', log.url, error.message);
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
        fetchResponseBody(networkLogs[requestIndex], params.requestId, tabId);
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

// Objects show only as their type ("Object", "Array(3)"): their contents are page data.
function remoteText(arg) {
    if (arg.type === 'string') return arg.value;
    return String(arg.unserializableValue ?? arg.description ?? arg.value ?? arg.type);
}

// shortcut: keeps the first 1000 errors of a session, so a page failing in a loop can't fill storage.
const MAX_CONSOLE_ERRORS = 1000;

// The page's own time, not when the event reached the extension.
async function handleConsoleError(timestamp, message, stackTrace, fallback, tabId) {
    if (consoleErrors.length >= MAX_CONSOLE_ERRORS) return;
    if (allowedHosts) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || !urlAllowed(tab.url)) return;
    }
    const where = (stackTrace && stackTrace.callFrames && stackTrace.callFrames[0]) || fallback || {};
    consoleErrors.push({
        type: 'console',
        timestamp: Number.isFinite(timestamp) ? Math.round(timestamp) : Date.now(),
        message: String(message || 'Error').slice(0, 2000),
        url: where.url || '',
        line: Number.isFinite(where.lineNumber) ? where.lineNumber + 1 : null,
        tabId: tabId
    });
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

// "Skip in export" switches in the popup; true leaves that kind of data out of the export.
const EXPORT_SKIP_DEFAULTS = { typedText: true, privateAreas: true, credentials: true, bodies: true };
// Inputs of these types hold a fixed value (a button label, a checkbox's form value). Any other input's
// value is what the user typed, and React mirrors it into the value attribute, passwords included.
const FIXED_VALUE_TYPES = ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'];
// Header, URL-parameter and JSON-key names that usually carry a login or a key. Errs towards removing too much.
const SECRET_NAME = /auth|token|secret|session|passw|pwd|api[-_]?key|csrf|xsrf|cookie|signature|jwt|^key$|^sig$|^otp$/i;
const REDACTED = 'REDACTED';

// Works on absolute and relative URLs, and on URLs inside text (console messages), leaving the rest byte for byte.
// The fragment counts too: OAuth puts tokens after '#', and window.location.href keeps it.
function redactUrl(url, redacted) {
    if (typeof url !== 'string') return url;
    return url
        .replace(/^([a-z][\w+.-]*:\/\/)[^/?#@]*@/i, (m, scheme) => { redacted.secrets++; return scheme; })
        .replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/g, (m, sep, name) => {
            if (!SECRET_NAME.test(name)) return m;
            redacted.secrets++;
            return `${sep}${name}=${REDACTED}`;
        });
}

function redactHeaders(headers, redacted) {
    if (!headers || typeof headers !== 'object') return headers;
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (SECRET_NAME.test(name)) {
            out[name] = REDACTED;
            redacted.secrets++;
        } else {
            out[name] = /^(referer|location)$/i.test(name) ? redactUrl(String(value), redacted) : value;
        }
    }
    return out;
}

function redactKeys(value, redacted) {
    if (Array.isArray(value)) return value.map(v => redactKeys(v, redacted));
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, v] of Object.entries(value)) {
        if (SECRET_NAME.test(key)) {
            out[key] = REDACTED;
            redacted.secrets++;
        } else {
            out[key] = redactKeys(v, redacted);
        }
    }
    return out;
}

// A body is a parsed JSON value, a JSON string, a form-encoded string, or other text left as it is.
function redactBody(body, redacted) {
    if (typeof body !== 'string') return redactKeys(body, redacted);
    const before = redacted.secrets;
    try {
        const out = redactKeys(JSON.parse(body), redacted);
        return redacted.secrets > before ? JSON.stringify(out) : body;
    } catch (e) {
        // Not JSON.
    }
    return /^[^\s=&]+=\S*$/.test(body) ? redactUrl('?' + body, redacted).slice(1) : body;
}

function scrubNetwork(logs, skip, redacted) {
    return logs.map(log => {
        const out = { ...log };
        const res = log.response ? { ...log.response } : null;
        if (skip.bodies) {
            if (out.postData != null) { delete out.postData; redacted.bodies++; }
            if (res && res.body != null) { delete res.body; redacted.bodies++; }
        }
        if (skip.credentials) {
            out.url = redactUrl(out.url, redacted);
            out.headers = redactHeaders(out.headers, redacted);
            if (out.postData != null) out.postData = redactBody(out.postData, redacted);
            if (res) {
                res.headers = redactHeaders(res.headers, redacted);
                if (res.body != null) res.body = redactBody(res.body, redacted);
            }
        }
        if (res) out.response = res;
        return out;
    });
}

function scrubElement(el, skip, redacted) {
    if (!el || typeof el !== 'object' || !el.tagName) return el;
    const tag = String(el.tagName).toUpperCase();
    const type = String((el.attributes && el.attributes.type) || 'text').toLowerCase();
    const typedField = tag === 'TEXTAREA' || (tag === 'INPUT' && !FIXED_VALUE_TYPES.includes(type));
    const out = { ...el, attributes: { ...(el.attributes || {}) } };
    if ((skip.typedText && typedField) || (skip.privateAreas && el.private)) {
        delete out.attributes.value;
    }
    if ((skip.typedText && (tag === 'TEXTAREA' || el.editable)) || (skip.privateAreas && el.private)) {
        out.text = null;
    }
    if (skip.credentials) {
        if (out.attributes.href) out.attributes.href = redactUrl(out.attributes.href, redacted);
        if (out.attributes.src) out.attributes.src = redactUrl(out.attributes.src, redacted);
    }
    return out;
}

function scrubCapture(interactionLogs, elementSnapshots, skip, redacted) {
    const pageUrl = url => skip.credentials ? redactUrl(url, redacted) : url;
    return {
        interactionLogs: interactionLogs.map(log => ({
            ...log,
            url: pageUrl(log.url),
            element: scrubElement(log.element, skip, redacted),
            scrollTarget: scrubElement(log.scrollTarget, skip, redacted)
        })),
        elementSnapshots: elementSnapshots.map(snap => ({
            ...snap,
            url: pageUrl(snap.url),
            elements: (snap.elements || []).map(el => scrubElement(el, skip, redacted))
        }))
    };
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
        const result = await chrome.storage.local.get(['interactionLogs', 'elementSnapshots', 'videoRecordingStartTime', 'exportSkip']);
        const exportSkip = { ...EXPORT_SKIP_DEFAULTS, ...(result.exportSkip || {}) };
        // How many values each switch left out: logs.json records it and the popup shows it.
        const redacted = { secrets: 0, bodies: 0 };
        const exportedNetworkLogs = scrubNetwork(networkLogs, exportSkip, redacted);
        const exportedConsoleErrors = exportSkip.credentials
            ? consoleErrors.map(e => ({ ...e, message: redactUrl(e.message, redacted), url: redactUrl(e.url, redacted) }))
            : consoleErrors;
        const { interactionLogs, elementSnapshots } = scrubCapture(result.interactionLogs || [], result.elementSnapshots || [], exportSkip, redacted);
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
            exportSkip: exportSkip,
            redacted: redacted,
            videoStartTime: videoStartTime,
            networkLogs: exportedNetworkLogs,
            consoleErrors: exportedConsoleErrors,
            interactionLogs: interactionLogs,
            elementSnapshots: elementSnapshots,
            videoData: videoBlob ? {
                hasVideo: true,
                videoFileName: videoFileName,
                videoSize: videoBlob.size
            } : { hasVideo: false },
            summary: {
                totalNetworkRequests: exportedNetworkLogs.length,
                totalConsoleErrors: exportedConsoleErrors.length,
                totalInteractions: interactionLogs.length,
                totalElementSnapshots: elementSnapshots.length
            }
        };

        const htmlContent = mode === 'video'
            ? generateVideoTimelineHTML(exportData, videoBlob, videoFileName)
            : generateImprovedTimelineHTML(exportData);

        const files = [
            { name: `${folder}/timeline.html`, blob: new Blob([htmlContent], { type: 'text/html' }) },
            { name: `${folder}/logs.json`, blob: new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' }) },
            { name: `${folder}/repro.md`, blob: new Blob([reproSteps(exportData)], { type: 'text/markdown' }) }
        ];
        if (videoBlob) files.push({ name: `${folder}/${videoFileName}`, videoId: 'current-video' });

        await videoStoreRequest('readwrite', store => store.put({ id: 'pending-export', files }));
        await downloadViaOffscreen({ exportId: 'pending-export' }, `${folder}.zip`);
        console.log('[Export] Zip export started:', `${folder}.zip`);
        return redacted;
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
    ${TIMELINE_CSP}
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
            --panel-3: #e9e9ec;
            --line-3: #a1a1aa;
            --dots: rgba(24, 24, 27, 0.07);
            --sunken: rgba(24, 24, 27, 0.025);
            --hover: rgba(24, 24, 27, 0.03);
            --bad: #ce2c31;
            --ok: #18794e;
            --k-link: #0d74ce;
            --k-button: #ce2c31;
            --k-field: #18794e;
            --k-select: #c27c00;
            --k-toggle: #0b8a83;
            --k-other: #71717a;
            --j-key: #0d74ce;
            --j-str: #18794e;
            --j-num: #a35200;
            --j-lit: #ce2c31;
            --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
            --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
            --spring: linear(0, 0.0198 1%, 0.0793 2.1%, 0.3115 5.2%, 0.5823 9.3%, 0.7792 13.5%, 0.8979 17.6%, 0.9618 21.8%, 0.9937 26.4%, 1.0082 31.7%, 1.0118 37.9%, 1.0068 50%, 0.9999 75%, 1);
            --bounce: linear(0, 0.0236 1.1%, 0.0951 2.3%, 0.3793 5.8%, 0.6843 10.2%, 0.9021 14.6%, 1.0236 19.3%, 1.0783 23.6%, 1.0915 27.5%, 1.0804 31.9%, 1.0265 41.5%, 0.9978 51.6%, 0.9933 62%, 1.0004 85%, 1);
            interpolate-size: allow-keywords;
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
                --panel-3: #222227;
                --line-3: #4a4a52;
                --dots: rgba(255, 255, 255, 0.05);
                --sunken: rgba(0, 0, 0, 0.16);
                --hover: rgba(255, 255, 255, 0.025);
                --bad: #ff8589;
                --k-link: #70b8ff;
                --k-button: #ff8589;
                --k-field: #3dd68c;
                --k-select: #f1a10d;
                --k-toggle: #4cc9c0;
                --k-other: #a1a1aa;
                --j-key: #9cc9ff;
                --j-str: #8fe3b6;
                --j-num: #ffc86b;
                --j-lit: #ff9da0;
            }
        }

        ${EXPORT_DETAILS_CSS}

        .details-panel .row-details {
            opacity: 1;
        }

        .detail-main h4 {
            margin-bottom: 8px;
        }

        .detail-url {
            display: flex;
            gap: 8px;
            align-items: baseline;
            font-family: var(--mono);
            font-size: 12px;
            overflow-wrap: anywhere;
        }

        .detail-url span:last-child {
            min-width: 0;
        }

        .swap {
            animation: swap 0.4s var(--ease-out);
        }

        @keyframes swap {
            from { opacity: 0; transform: translateY(4px); filter: blur(4px); }
        }

        .enter {
            animation: rise 0.5s var(--ease-out) both;
            animation-delay: calc(var(--i, 0) * 22ms);
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

        .header-inner > .copy-btn {
            flex: none;
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
            from { opacity: 0; transform: translateY(6px); filter: blur(4px); }
            to { opacity: 1; transform: none; filter: none; }
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
            position: relative;
            padding: 16px 20px;
        }

        .summary-card,
        .event-pill {
            isolation: isolate;
        }

        .summary-card::before,
        .event-pill::before {
            content: '';
            position: absolute;
            inset: 0;
            z-index: -1;
            border-radius: inherit;
            background: radial-gradient(220px circle at var(--mx, -300px) var(--my, -300px), var(--accent-soft), transparent 70%);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s var(--ease);
        }

        .summary-card:hover::before,
        .event-pill:hover::before {
            opacity: 1;
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
            transition: background 0.15s var(--ease), border-color 0.15s var(--ease), transform 0.25s var(--bounce);
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
            transform: scale(0.95);
        }

        .playback-btn svg {
            transition: transform 0.45s var(--bounce);
        }

        .playback-btn:hover:not(:disabled) svg {
            transform: scale(1.15);
        }

        #resetBtn:hover svg {
            transform: rotate(-200deg);
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

        body.playing .cursor-marker::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 50%;
            background: var(--accent);
            animation: ping 1.4s var(--ease-out) infinite;
        }

        @keyframes ping {
            from { transform: scale(1); opacity: 0.6; }
            to { transform: scale(2.8); opacity: 0; }
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
            transition: background 0.15s var(--ease), box-shadow 0.3s var(--spring);
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
            grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
            gap: 16px;
            align-items: start;
        }

        .details-grid > * {
            animation: rise 0.45s var(--ease-out) both;
        }

        .details-grid > :nth-child(2) {
            animation-delay: 70ms;
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
            .details-grid { grid-template-columns: minmax(0, 1fr); }
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
                <h3 data-tick>${data.summary.totalNetworkRequests}</h3>
                <p>Network requests</p>
            </div>
            <div class="summary-card">
                <h3 data-tick>${data.summary.totalInteractions}</h3>
                <p>Interactions</p>
            </div>
            <div class="summary-card">
                <h3 data-tick>${data.summary.totalElementSnapshots}</h3>
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
                    <button class="playback-btn primary" id="playBtn" data-ripple>
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12.5-7.5a1 1 0 000-1.72L8.5 3.64A1 1 0 007 4.5z"/></svg>
                        Play
                    </button>
                    <button class="playback-btn" id="pauseBtn" data-ripple disabled>
                        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>
                        Pause
                    </button>
                    <button class="playback-btn" id="resetBtn" data-ripple>
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
            document.body.classList.add('playing');
            document.getElementById('playBtn').disabled = true;
            document.getElementById('pauseBtn').disabled = false;
            lastFrameTime = performance.now();
            animate();
        }

        function pausePlayback() {
            isPlaying = false;
            document.body.classList.remove('playing');
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
            summary.classList.remove('swap');
            void summary.offsetWidth;
            summary.classList.add('swap');
        }

        function showEventDetails(event) {
            const panel = document.getElementById('detailsPanel');
            panel.classList.remove('active');
            void panel.offsetWidth;
            panel.classList.add('active');

            let detailsHTML = '<h3>Event details</h3><div class="details-grid">';
            detailsHTML += '<div class="detail-section">';
            detailsHTML += '<h4>Event</h4>';
            detailsHTML += '<div class="detail-item"><div class="detail-label">Type</div><div class="detail-value">' + esc(event.type) + '</div></div>';
            detailsHTML += '<div class="detail-item"><div class="detail-label">Timestamp</div><div class="detail-value">' + new Date(event.timestamp).toLocaleString() + '</div></div>';
            detailsHTML += '<div class="detail-item"><div class="detail-label">Relative time</div><div class="detail-value">' + formatTimestamp(event.timestamp - startTime) + '</div></div>';
            detailsHTML += '</div></div>';
            panel.innerHTML = detailsHTML;

            // The same structured views as the session replay: params, headers, bodies, selectors, element maps.
            const main = kit.h('div', { class: 'detail-section detail-main' });
            const log = event.data;
            if (event.type === 'network') {
                main.append(
                    kit.h('h4', { text: 'Request' }),
                    kit.h('div', { class: 'detail-url' }, [kit.h('span', { class: 'tag network', text: String(log.method || 'GET') }), kit.h('span', { text: String(log.url || '') })]),
                    kit.networkDetails(models.requestModel(log)));
            } else if (event.type === 'interaction') {
                main.append(
                    kit.h('h4', { text: 'Interaction: ' + String(log.type || 'unknown') }),
                    kit.interactionDetails(models.interactionModel({ type: String(log.type || 'unknown'), count: 1, url: String(log.url || ''), start: log.timestamp, end: log.timestamp, from: log.scrollPosition || null, to: log.scrollPosition || null, log: log, last: log })));
            } else if (event.type === 'snapshot') {
                main.append(kit.h('h4', { text: 'Snapshot' }), kit.snapshotDetails(models.snapshotModel(log)).node);
            }
            panel.querySelector('.details-grid').append(main);
            panel.scrollIntoView({ behavior: kit.reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
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

        function truncateUrl(url) {
            try {
                const urlObj = new URL(url);
                const path = urlObj.pathname + urlObj.search;
                return path.length > 50 ? path.substring(0, 50) + '...' : path;
            } catch {
                return url.length > 50 ? url.substring(0, 50) + '...' : url;
            }
        }

        const kit = (${exportKit})();
        const models = (function () {
            const BODY_PREVIEW_CHARS = ${BODY_PREVIEW_CHARS};
            const POST_DATA_CHARS = ${POST_DATA_CHARS};
            const ROLE_KINDS = ${JSON.stringify(ROLE_KINDS)};
            ${[requestKind, clip, formatMs, formatBytes, requestModel, isFormControl, controlLabel, elementKind, elementLabel, snapshotModel, interactionModel].join('\n')}
            return { requestModel, snapshotModel, interactionModel };
        })();

        init();
        const reproText = ${embedJson(reproSteps(data))};
        document.querySelector('.header-inner').append(kit.copyButton('Copy repro steps', () => reproText));
        document.querySelectorAll('[data-tick]').forEach((el, i) => kit.ticker(el, 200 + i * 90));
        kit.stagger(Array.from(document.querySelectorAll('.event-pill')), 18);
        kit.spotlight(document.querySelector('.timeline-wrapper'), '.event-pill');
        kit.spotlight(document.querySelector('.summary-grid'), '.summary-card');
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
        const pill = (type, index, tag, name, meta) => `<button class="event-pill ${type}" data-type="${type}" data-index="${index}" data-ripple>
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
                pill('interaction', index, escapeHtml(log.type || 'event'), escapeHtml(elementLabel(log.element) || (log.element ? String(log.element.tagName || '').toLowerCase() : '')), at(log.timestamp))
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

// ---- Export models: shrink captured logs into what the exported pages draw. ----

const KIND_LABELS = { link: 'Links', button: 'Buttons', field: 'Fields', select: 'Selects', toggle: 'Toggles', other: 'Clickable' };
const BODY_PREVIEW_CHARS = 12000;
const POST_DATA_CHARS = 64000;

const ROLE_KINDS = { button: 'button', link: 'link', checkbox: 'toggle', radio: 'toggle', switch: 'toggle', combobox: 'select', listbox: 'select', textbox: 'field', searchbox: 'field' };

function elementKind(el) {
    const tag = String((el && el.tagName) || '').toLowerCase();
    const attrs = (el && el.attributes) || {};
    const type = String(attrs.type || '').toLowerCase();
    const role = String(attrs.role || '').toLowerCase();
    if (ROLE_KINDS[role]) return ROLE_KINDS[role];
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'field';
    if (tag === 'input') {
        if (type === 'checkbox' || type === 'radio') return 'toggle';
        return ['submit', 'button', 'reset', 'image'].includes(type) ? 'button' : 'field';
    }
    return tag === 'button' ? 'button' : 'other';
}

function elementLabel(el) {
    if (!el) return '';
    const attrs = el.attributes || {};
    if (isFormControl(el) && controlLabel(el)) return controlLabel(el);
    const text = String(el.text || '').replace(/\s+/g, ' ').trim();
    const label = text || attrs['aria-label'] || attrs.placeholder || attrs.title || attrs.alt || attrs.name || (el.id ? '#' + el.id : '');
    return String(label).slice(0, 80);
}

// "button “Edit booking”", used on click markers and the scrubber tooltip.
function targetLabel(el) {
    if (!el) return '';
    const tag = String(el.tagName || '').toLowerCase();
    const label = elementLabel(el).slice(0, 40);
    return [tag, label && `“${label}”`].filter(Boolean).join(' ');
}

function pageKey(url) {
    return String(url || '').split('#')[0];
}

function pathOf(url) {
    try {
        const u = new URL(url);
        return u.host + (u.pathname === '/' ? '' : u.pathname);
    } catch (e) {
        return String(url || '');
    }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatMs(ms) {
    if (!Number.isFinite(ms)) return '';
    return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + ' s';
}

function requestKind(log) {
    const mime = String((log.response && log.response.mimeType) || '').toLowerCase();
    if (mime.includes('html')) return 'doc';
    if (/javascript|css|font|wasm/.test(mime)) return 'code';
    if (/^(image|video|audio)\//.test(mime)) return 'media';
    return 'api';
}

function clip(value, max) {
    if (value == null) return { text: '', cut: false };
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
}

function requestModel(log) {
    const res = log.response || null;
    const failed = log.loadingFailed || null;
    const end = (log.loadingFinished || failed || res || {}).timestamp;
    const ms = Number.isFinite(end) ? Math.max(0, end - log.timestamp) : null;
    const size = log.loadingFinished && Number.isFinite(log.loadingFinished.encodedDataLength)
        ? log.loadingFinished.encodedDataLength
        : (res && Number.isFinite(res.bodySize) ? res.bodySize : null);
    const status = res ? res.status : (failed ? (failed.canceled ? 'canceled' : 'failed') : 'pending');
    const kind = requestKind(log);
    // Script and style bodies are rarely what someone debugging a session wants; logs.json keeps them.
    const body = res && res.body != null && kind !== 'code' ? clip(res.body, BODY_PREVIEW_CHARS) : { text: '', cut: false };
    const post = clip(log.postData, POST_DATA_CHARS);
    return {
        method: String(log.method || 'GET'),
        url: String(log.url || ''),
        status,
        statusText: res ? String(res.statusText || '') : '',
        mime: res ? String(res.mimeType || '') : '',
        kind,
        // Requests the browser canceled after a 2xx (navigation, pings) are not failures.
        err: !!((res && res.status >= 400) || (failed && (!res || !failed.canceled))),
        ms,
        msText: formatMs(ms),
        sizeText: formatBytes(size),
        error: failed ? String(failed.errorText || (failed.canceled ? 'Canceled' : 'Failed')) : '',
        reqHeaders: log.headers || null,
        resHeaders: res ? res.headers || null : null,
        post: post.text,
        postCut: post.cut,
        body: body.text,
        bodyCut: body.cut,
        bodyOmitted: !!(res && res.body != null && kind === 'code'),
    };
}

// Consecutive scroll events in one direction (throttled to ~10/s while capturing) read as one "Scrolled" row.
function interactionRows(logs) {
    const rows = [];
    (logs || []).forEach((log, index) => {
        const prev = rows[rows.length - 1];
        const step = prev && prev.to && log.scrollPosition ? Math.sign(log.scrollPosition.y - prev.to.y) : 0;
        const turned = step !== 0 && prev.dir !== 0 && step !== prev.dir;
        if (log.type === 'scroll' && prev && prev.type === 'scroll' && !turned && log.timestamp - prev.end < 2000 && pageKey(log.url) === pageKey(prev.url)) {
            if (step) prev.dir = step;
            prev.end = log.timestamp;
            prev.count++;
            if (log.scrollPosition) prev.to = log.scrollPosition;
            prev.last = log;
            return;
        }
        // Keystrokes into the same field read as one "Typed" row.
        if (log.type === 'input' && prev && prev.type === 'input' && log.timestamp - prev.end < 3000 && fieldKey(log) === fieldKey(prev.last)) {
            prev.end = log.timestamp;
            prev.count++;
            prev.last = log;
            return;
        }
        rows.push({
            type: String(log.type || 'unknown'),
            start: log.timestamp,
            end: log.timestamp,
            count: 1,
            url: String(log.url || ''),
            from: (turned && prev.to) || log.scrollPosition || null,
            to: log.scrollPosition || null,
            dir: turned ? step : 0,
            log,
            last: log,
        });
    });
    return rows;
}

function fieldKey(log) {
    const el = log.element || {};
    return pageKey(log.url) + ' ' + (el.selector || el.xpath || '');
}

// Form controls are named by placeholder/name; their textContent is option lists or empty.
function isFormControl(el) {
    return !!el && /^(input|select|textarea)$/i.test(String(el.tagName || ''));
}

function controlLabel(el) {
    const attrs = el.attributes || {};
    return String(attrs['aria-label'] || attrs.placeholder || attrs.name || attrs.title || (el.id ? '#' + el.id : '')).slice(0, 60);
}

function interactionKind(type) {
    if (type === 'click' || type === 'scroll' || type === 'drag') return type;
    return type === 'input' || type === 'change' ? 'input' : 'other';
}

function interactionModel(row) {
    const log = row.log;
    const el = log.element || null;
    return {
        type: row.type,
        count: row.count,
        url: row.url,
        span: row.end - row.start,
        from: row.from,
        to: row.to,
        tag: el ? String(el.tagName || '').toLowerCase() : '',
        id: el && el.id ? String(el.id) : '',
        cls: el && typeof el.className === 'string' ? el.className : '',
        text: el ? String(el.text || '').replace(/\s+/g, ' ').trim().slice(0, 300) : '',
        selector: el ? String(el.selector || '') : '',
        xpath: el ? String(el.xpath || '') : '',
        href: el && el.attributes ? String(el.attributes.href || '') : '',
        coords: log.coordinates || log.start || null,
        end: log.end || null,
        viewport: log.viewport ? { w: log.viewport.width, h: log.viewport.height } : null,
        valueLength: row.last.valueLength,
        inputType: row.last.inputType || '',
        value: log.value,
        distance: log.distance,
        duration: log.duration,
    };
}

function snapshotModel(snapshot) {
    const vp = snapshot.viewport || {};
    const vw = vp.width || 1;
    const vh = vp.height || 1;
    const counts = {};
    let inView = 0;
    const els = (snapshot.elements || []).map(el => {
        const pos = el.position || {};
        const x = Number(pos.left) || 0;
        const y = Number(pos.top) || 0;
        const w = Number(pos.width) || 0;
        const h = Number(pos.height) || 0;
        const v = w > 0 && h > 0 && x < vw && y < vh && x + w > 0 && y + h > 0;
        const k = elementKind(el);
        counts[k] = (counts[k] || 0) + 1;
        if (v) inView++;
        return {
            k,
            tag: String(el.tagName || '').toLowerCase(),
            l: elementLabel(el),
            s: String(el.selector || ''),
            xp: String(el.xpath || ''),
            href: el.attributes && el.attributes.href ? String(el.attributes.href) : '',
            x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
            v,
        };
    });
    return { url: String(snapshot.url || ''), vw, vh, els, counts, inView };
}

// Steps to reproduce as Markdown, for repro.md and the timelines' "Copy repro steps" button. Built from the
// export's own data, so whatever Skip in export removed stays out. Typed text appears only as a length.
function reproSteps(data) {
    const rows = interactionRows(data.interactionLogs || []);
    const requests = data.networkLogs || [];
    const t0 = Math.min(...[rows[0] && rows[0].start, requests[0] && requests[0].timestamp].filter(Number.isFinite));
    const at = t => (Number.isFinite(t0) && Number.isFinite(t) ? ` (+${((t - t0) / 1000).toFixed(1)} s)` : '');

    // "link “Pricing”", "field “Email”": the kind reads better in a sentence than the tag.
    const name = el => {
        if (!el) return 'the page';
        const kind = elementKind(el);
        const label = elementLabel(el).slice(0, 60);
        return (kind === 'other' ? String(el.tagName || 'element').toLowerCase() : kind) + (label ? ` “${label}”` : '');
    };
    const steps = [];
    let page = '';
    rows.forEach(row => {
        if (row.url && pageKey(row.url) !== page) {
            steps.push((page ? 'Go to ' : 'Open ') + pageKey(row.url));
            page = pageKey(row.url);
        }
        const target = name(row.log.element);
        const dy = row.from && row.to ? row.to.y - row.from.y : 0;
        if (row.type === 'click') steps.push('Click ' + target);
        else if (row.type === 'input') steps.push('Type in ' + target + (Number.isFinite(row.last.valueLength) ? ` (${row.last.valueLength} characters)` : ''));
        else if (row.type === 'change') steps.push('Change ' + target);
        else if (row.type === 'drag') steps.push('Drag ' + target);
        else if (row.type === 'scroll') steps.push('Scroll' + (dy < 0 ? ' up' : dy > 0 ? ' down' : ''));
    });
    if (!steps.length && requests[0]) steps.push('Open ' + pageKey(requests[0].url));

    const failures = requests.map(log => ({ t: log.timestamp, m: requestModel(log) })).filter(f => f.m.err)
        .map(f => ({ t: f.t, text: `\`${f.m.method} ${f.m.url}\` → ${typeof f.m.status === 'number' ? (f.m.status + ' ' + f.m.statusText).trim() : f.m.error}` }))
        .concat((data.consoleErrors || []).map(e => ({
            t: e.timestamp,
            text: 'Console: ' + String(e.message).split('\n')[0] + (e.url ? ` (${pageKey(e.url)}${e.line ? ':' + e.line : ''})` : '')
        })))
        .sort((a, b) => a.t - b.t);

    const withUa = requests.find(r => r.headers && (r.headers['User-Agent'] || r.headers['user-agent']));
    const ua = withUa ? String(withUa.headers['User-Agent'] || withUa.headers['user-agent']) : '';
    // Edge's User-Agent also says Chrome/, and Android's also says Linux, so those are checked first.
    const browser = /(Edg)\/(\d+)/.exec(ua) || /(Chrome)\/(\d+)/.exec(ua);
    const os = /Android/.exec(ua) || /Windows|Mac OS X|CrOS|Linux/.exec(ua);
    const viewport = ((data.interactionLogs || []).find(log => log.viewport) || {}).viewport;
    const env = [
        browser && (browser[1] === 'Edg' ? 'Edge ' : 'Chrome ') + browser[2],
        os && os[0],
        viewport && `window ${viewport.width} × ${viewport.height}`
    ].filter(Boolean).join(', ');

    return [
        '## Steps to reproduce', '',
        ...(steps.length ? steps.map((s, i) => `${i + 1}. ${s}`) : ['No interactions were recorded.']), '',
        '## What went wrong', '',
        ...(failures.length ? failures.map(f => `- ${f.text}${at(f.t)}`) : ['- Nothing failed: no HTTP errors, failed requests or console errors were recorded.']), '',
        '## Environment', '',
        ...(env ? ['- ' + env] : []),
        `- Recorded ${new Date(data.exportDate).toLocaleString()} with Capture All${data.extensionVersion ? ' v' + data.extensionVersion : ''}`,
        ''
    ].join('\n');
}

// The exported timelines can't load or send anything over the network; only the video next to the file plays.
const TIMELINE_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src 'self' file: blob:; base-uri 'none'; form-action 'none'">`;

// For <script> embedding: no "</script>" or "<!--" can appear inside.
function embedJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Styles for the details views exportKit builds; both exported pages include them and supply the color tokens.
const EXPORT_DETAILS_CSS = `
        [hidden] {
            display: none !important;
        }

        .sr-only {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }

        [data-ripple] {
            position: relative;
            overflow: hidden;
        }

        .ripple {
            position: absolute;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.18;
            pointer-events: none;
            transform: scale(0);
            animation: ink 0.6s var(--ease-out) forwards;
        }

        @keyframes ink {
            to { transform: scale(1); opacity: 0; }
        }

        .filter-chips,
        .mini-chips {
            position: relative;
            display: flex;
            flex-wrap: wrap;
            gap: 2px;
            min-width: 0;
        }

        .chip-glider {
            position: absolute;
            left: 0;
            top: 0;
            height: 26px;
            width: 0;
            border-radius: 7px;
            background: var(--panel-3);
            box-shadow: inset 0 0 0 1px var(--line-2);
            opacity: 0;
            pointer-events: none;
            transition: transform 0.45s var(--spring), width 0.45s var(--spring), height 0.45s var(--spring);
        }

        .fchip,
        .mchip {
            position: relative;
            z-index: 1;
            overflow: hidden;
            flex: none;
            display: inline-flex;
            align-items: center;
            gap: 5px;
            height: 26px;
            padding: 0 9px;
            border: none;
            border-radius: 7px;
            background: transparent;
            color: var(--text-3);
            font-size: 12px;
            font-weight: 550;
            white-space: nowrap;
            cursor: pointer;
            transition: color 0.2s var(--ease-out);
        }

        .fchip span,
        .mchip span {
            font-size: 11px;
            color: var(--text-3);
            font-variant-numeric: tabular-nums;
            transition: color 0.2s;
        }

        .fchip:hover,
        .mchip:hover,
        .fchip[aria-pressed="true"],
        .mchip[aria-pressed="true"] {
            color: var(--text);
        }

        .fchip[aria-pressed="true"] span,
        .mchip[aria-pressed="true"] span {
            color: var(--text-2);
        }

        .fchip.err span {
            color: var(--bad);
        }

        .fchip.toggle {
            margin-left: 6px;
            border: 1px dashed var(--line-2);
        }

        .fchip.toggle[aria-pressed="true"] {
            border-style: solid;
            border-color: rgba(229, 72, 77, 0.45);
            background: var(--accent-soft);
        }

        .rd-inner {
            padding-top: 10px;
        }

        .facts {
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }

        .fact {
            display: inline-flex;
            gap: 5px;
            padding: 2px 8px;
            border: 1px solid var(--line-2);
            border-radius: 6px;
            font-size: 11.5px;
            color: var(--text-3);
        }

        .fact b {
            color: var(--text);
            font-weight: 550;
            overflow-wrap: anywhere;
        }

        .fact.bad b {
            color: var(--bad);
        }

        .fact.strong {
            border-color: color-mix(in srgb, var(--k-select) 45%, transparent);
            background: color-mix(in srgb, var(--k-select) 10%, transparent);
        }

        .rd-error {
            margin-top: 8px;
            color: var(--bad);
            font-family: var(--mono);
            font-size: 11.5px;
        }

        .rd-note {
            margin-top: 6px;
            color: var(--text-3);
            font-size: 11.5px;
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin: 10px 0 2px;
        }

        .copy-btn,
        .act-btn {
            position: relative;
            overflow: hidden;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 26px;
            padding: 0 9px;
            border: 1px solid var(--line-2);
            border-radius: 7px;
            background: var(--panel-2);
            color: var(--text-2);
            font-size: 11.5px;
            font-weight: 550;
            cursor: pointer;
            transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.12s var(--ease-out);
        }

        .copy-btn:hover,
        .act-btn:hover {
            color: var(--text);
            border-color: var(--line-3);
            background: var(--panel-3);
        }

        .copy-btn:active,
        .act-btn:active {
            transform: scale(0.96);
        }

        .act-btn[aria-pressed="true"] {
            color: var(--text);
            border-color: color-mix(in srgb, var(--k-select) 55%, transparent);
            background: color-mix(in srgb, var(--k-select) 12%, transparent);
        }

        .act-ic,
        .ic-swap {
            position: relative;
            display: inline-block;
            width: 13px;
            height: 13px;
        }

        .act-ic svg,
        .ic-swap svg {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            transition: transform 0.4s var(--bounce), opacity 0.2s;
        }

        .ic-swap .i-b {
            opacity: 0;
            transform: scale(0.3) rotate(-45deg);
        }

        .copied {
            color: var(--ok) !important;
            border-color: rgba(61, 214, 140, 0.45) !important;
        }

        .copied .ic-swap .i-a {
            opacity: 0;
            transform: scale(0.3) rotate(45deg);
        }

        .copied .ic-swap .i-b {
            opacity: 1;
            transform: none;
        }

        .dsec {
            margin-top: 6px;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--sunken);
        }

        .dsec > summary {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 6px 10px;
            list-style: none;
            cursor: pointer;
            font-size: 11.5px;
            font-weight: 600;
            color: var(--text-2);
            border-radius: 8px;
            transition: color 0.15s, background 0.15s;
        }

        .dsec > summary::-webkit-details-marker {
            display: none;
        }

        .dsec > summary:hover {
            color: var(--text);
            background: var(--hover);
        }

        .dsec-chev {
            display: inline-flex;
            width: 14px;
            height: 14px;
            transform: rotate(-90deg);
            transition: transform 0.35s var(--spring);
        }

        .dsec-chev svg {
            width: 100%;
            height: 100%;
        }

        .dsec[open] .dsec-chev {
            transform: none;
        }

        .dsec-count {
            margin-left: auto;
            color: var(--text-3);
            font-weight: 500;
            font-variant-numeric: tabular-nums;
        }

        .dsec::details-content {
            height: 0;
            overflow: clip;
            transition: height 0.35s var(--ease-out), content-visibility 0.35s allow-discrete;
        }

        .dsec[open]::details-content {
            height: auto;
        }

        .dsec-body {
            padding: 2px 10px 10px;
        }

        .kv {
            display: grid;
            grid-template-columns: minmax(80px, 32%) minmax(0, 1fr);
            gap: 3px 12px;
            font-family: var(--mono);
            font-size: 11.5px;
            line-height: 1.5;
        }

        .kv dt {
            color: var(--text-3);
            overflow-wrap: anywhere;
        }

        .kv dd {
            color: var(--text);
            overflow-wrap: anywhere;
        }

        .code {
            max-height: 300px;
            overflow: auto;
            padding: 8px 10px;
            border-radius: 6px;
            background: var(--bg);
            color: var(--text-2);
            font: 11.5px/1.55 var(--mono);
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }

        .j-key { color: var(--j-key); }
        .j-str { color: var(--j-str); }
        .j-num { color: var(--j-num); }
        .j-lit { color: var(--j-lit); }

        .sel-line {
            display: block;
            margin-top: 6px;
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 11px;
            overflow-wrap: anywhere;
        }

        /* Snapshots */
        .k-link { --kc: var(--k-link); }
        .k-button { --kc: var(--k-button); }
        .k-field { --kc: var(--k-field); }
        .k-select { --kc: var(--k-select); }
        .k-toggle { --kc: var(--k-toggle); }
        .k-other { --kc: var(--k-other); }

        .snap-map {
            position: relative;
            width: 100%;
            overflow: hidden;
            border: 1px solid var(--line-2);
            border-radius: 6px;
            background: var(--bg) radial-gradient(var(--dots) 1px, transparent 1.5px) 0 0 / 10px 10px;
        }

        .snap-map.thumb {
            border-radius: 4px;
        }

        .snap-map.big {
            width: min(100%, 380px);
            margin-top: 10px;
        }

        .mbox {
            position: absolute;
            border: 1px solid var(--kc);
            border-radius: 2px;
            background: color-mix(in srgb, var(--kc) 14%, transparent);
            transition: opacity 0.2s, box-shadow 0.2s, background 0.2s;
        }

        .snap-map.thumb .mbox {
            border-width: 0.5px;
        }

        .snap-map.big .mbox {
            cursor: pointer;
            animation: fadeIn 0.5s var(--ease-out) both;
        }

        .snap-map .mbox.dim,
        .snap-map.focusing .mbox:not(.hot) {
            opacity: 0.18;
        }

        .snap-map .mbox.hot {
            z-index: 2;
            background: color-mix(in srgb, var(--kc) 35%, transparent);
            box-shadow: 0 0 0 1.5px var(--kc), 0 0 12px var(--kc);
        }

        .kchips {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            margin-top: 6px;
        }

        .kchip {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            padding: 1px 7px;
            border-radius: 5px;
            background: var(--panel-2);
            color: var(--text-2);
            font-size: 11px;
            font-variant-numeric: tabular-nums;
        }

        .kdot,
        .kchip i {
            flex: none;
            width: 7px;
            height: 7px;
            border-radius: 2px;
            background: var(--kc);
        }

        .snap-url {
            margin-top: 6px;
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 11px;
            overflow-wrap: anywhere;
        }

        .el-tools {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 10px;
        }

        .el-search-wrap {
            display: flex;
            align-items: center;
            gap: 7px;
            height: 30px;
            padding: 0 10px;
            border: 1px solid var(--line-2);
            border-radius: 8px;
            background: var(--bg);
            color: var(--text-3);
            transition: border-color 0.2s, box-shadow 0.25s;
        }

        .el-search-wrap:focus-within {
            border-color: var(--line-3);
            box-shadow: 0 0 0 4px rgba(241, 161, 13, 0.1);
        }

        .el-search-ic {
            display: inline-flex;
            width: 13px;
            height: 13px;
        }

        .el-search-ic svg {
            width: 100%;
            height: 100%;
        }

        .el-search {
            flex: 1;
            min-width: 0;
            border: none;
            background: transparent;
            color: var(--text);
            font-size: 12px;
            outline: none;
        }

        .mchip {
            height: 24px;
            padding: 0 8px;
            font-size: 11.5px;
        }

        .el-list {
            position: relative;
            max-height: 320px;
            margin-top: 6px;
            overflow-y: auto;
            overscroll-behavior: contain;
            list-style: none;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: var(--sunken);
            padding: 3px;
        }

        .el-row {
            display: flex;
            align-items: center;
            gap: 9px;
            padding: 5px 6px 5px 8px;
            border-radius: 6px;
            transition: background 0.15s;
            content-visibility: auto;
            contain-intrinsic-size: auto 40px;
        }

        .el-row:hover,
        .el-row.hot {
            background: var(--panel-2);
        }

        .el-row.off {
            opacity: 0.6;
        }

        .el-row.flash {
            animation: flash 1.2s var(--ease-out);
        }

        @keyframes flash {
            0%, 30% { background: color-mix(in srgb, var(--kc) 28%, transparent); box-shadow: inset 0 0 0 1px var(--kc); }
        }

        .el-main {
            flex: 1;
            min-width: 0;
        }

        .el-top {
            display: flex;
            align-items: baseline;
            gap: 7px;
            min-width: 0;
        }

        .el-tag {
            flex: none;
            color: var(--kc);
            font-family: var(--mono);
            font-size: 11px;
        }

        .el-label {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-size: 12px;
            color: var(--text);
        }

        .el-off {
            flex: none;
            padding: 0 5px;
            border-radius: 4px;
            background: var(--panel-3);
            color: var(--text-3);
            font-size: 10.5px;
        }

        .el-sel {
            display: block;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 10.5px;
        }

        .el-row .copy-btn {
            flex: none;
            height: 22px;
            padding: 0 7px;
            opacity: 0;
            transition: opacity 0.15s, color 0.15s, border-color 0.15s;
        }

        .el-row:hover .copy-btn,
        .el-row.hot .copy-btn,
        .el-row .copy-btn:focus-visible,
        .el-row .copy-btn.copied {
            opacity: 1;
        }

        .el-empty {
            padding: 16px;
            color: var(--text-3);
            text-align: center;
        }
`.trim();

// ---- Runs inside the exported pages (inlined with toString), never in the service worker. ----
// Everything captured is rendered through textContent / text nodes, so page content can't execute.

function exportKit() {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ICON = {
        copy: '<svg class="i-a" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.75"/><path d="M10.75 5.25V4a1.25 1.25 0 00-1.25-1.25h-5A1.25 1.25 0 003.25 4v5A1.25 1.25 0 004.5 10.25h.75"/></svg>',
        check: '<svg class="i-b" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
        chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 6.5L8 9l2.5-2.5"/></svg>',
        search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/></svg>',
        eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8z"/><circle cx="8" cy="8" r="2"/></svg>',
    };
    const KINDS = { link: 'Links', button: 'Buttons', field: 'Fields', select: 'Selects', toggle: 'Toggles', other: 'Clickable' };

    function h(tag, props, children) {
        const node = document.createElement(tag);
        Object.keys(props || {}).forEach(key => {
            const value = props[key];
            if (value == null || value === false) return;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'html') node.innerHTML = value; // static markup only (ICON)
            else if (key === 'style') node.style.cssText = value;
            else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? '' : String(value));
        });
        [].concat(children == null ? [] : children).forEach(child => {
            if (child != null && child !== false) node.append(child);
        });
        return node;
    }

    const announcer = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    document.body.append(announcer);
    function announce(text) {
        announcer.textContent = '';
        setTimeout(() => { announcer.textContent = text; }, 30);
    }

    function copyText(text, btn) {
        const done = () => {
            btn.classList.remove('copied');
            void btn.offsetWidth;
            btn.classList.add('copied');
            clearTimeout(btn._copiedTimer);
            btn._copiedTimer = setTimeout(() => btn.classList.remove('copied'), 1400);
            announce('Copied');
        };
        const fallback = () => {
            const area = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
            area.value = text;
            document.body.append(area);
            area.select();
            try {
                if (document.execCommand('copy')) done();
            } catch (e) {
                announce('Copy failed');
            }
            area.remove();
        };
        if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
        else fallback();
    }

    function copyButton(label, getText) {
        const btn = h('button', { class: 'copy-btn', type: 'button', 'data-ripple': true, title: label },
            [h('span', { class: 'ic-swap', html: ICON.copy + ICON.check }), h('span', { text: label })]);
        btn.addEventListener('click', e => {
            e.stopPropagation();
            copyText(getText(), btn);
        });
        return btn;
    }

    // Material-style ink that grows from the pointer; hosts opt in with data-ripple.
    document.addEventListener('pointerdown', e => {
        const host = e.target.closest && e.target.closest('[data-ripple]');
        if (!host || reduceMotion || host.disabled) return;
        const rect = host.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height) * 2.2;
        const ink = h('span', { class: 'ripple', style: 'width:' + size + 'px;height:' + size + 'px;left:' + (e.clientX - rect.left - size / 2) + 'px;top:' + (e.clientY - rect.top - size / 2) + 'px' });
        host.append(ink);
        ink.addEventListener('animationend', () => ink.remove());
    });

    // Cursor-following glow on anything marked data-spotlight (or its rows).
    function spotlight(container, selector) {
        container.addEventListener('pointermove', e => {
            const target = e.target.closest && e.target.closest(selector);
            if (!target) return;
            const rect = target.getBoundingClientRect();
            target.style.setProperty('--mx', (e.clientX - rect.left) + 'px');
            target.style.setProperty('--my', (e.clientY - rect.top) + 'px');
        });
    }

    // Counts up to the number already in the element (so the page reads correctly without this).
    function ticker(el, delay) {
        const to = Number(el.textContent.replace(/[^0-9]/g, ''));
        if (!to || reduceMotion) return;
        const format = n => n.toLocaleString();
        const duration = Math.min(1400, 500 + to * 4);
        el.textContent = '0';
        setTimeout(() => {
            const t0 = performance.now();
            const frame = now => {
                const p = Math.min(1, (now - t0) / duration);
                el.textContent = format(Math.round(to * (1 - Math.pow(2, -10 * p)) / (1 - Math.pow(2, -10))));
                if (p < 1) requestAnimationFrame(frame);
                else el.textContent = format(to);
            };
            requestAnimationFrame(frame);
        }, delay || 0);
    }

    // Odometer digits: each digit keeps its own text (so textContent stays "01:23") and a
    // pseudo-element column 0-9 slides to it.
    function clock(el) {
        let shown = '';
        return function set(text) {
            if (text === shown) return;
            if (text.length !== shown.length) {
                el.replaceChildren();
                for (const ch of text) el.append(h('span', { class: /\d/.test(ch) ? 'dg' : 'sep', text: ch }));
            }
            Array.from(el.children).forEach((span, i) => {
                const ch = text[i];
                if (span.textContent !== ch) span.textContent = ch;
                if (/\d/.test(ch)) span.style.setProperty('--d', ch);
            });
            shown = text;
        };
    }

    // Short cascade for the first rows that become visible.
    function stagger(nodes, max) {
        if (reduceMotion) return;
        nodes.slice(0, max || 14).forEach((node, i) => {
            node.style.setProperty('--i', i);
            node.classList.remove('enter');
            void node.offsetWidth;
            node.classList.add('enter');
            node.addEventListener('animationend', () => node.classList.remove('enter'), { once: true });
        });
    }

    // Moves a highlight pill under the chosen child of a group (tabs, filter chips).
    function glide(glider, target) {
        if (!glider || !target) return;
        // Chip groups can wrap, so their pill also follows the row; the tab underline only slides.
        const wraps = glider.classList.contains('chip-glider');
        glider.style.width = target.offsetWidth + 'px';
        if (wraps) glider.style.height = target.offsetHeight + 'px';
        glider.style.transform = 'translate(' + target.offsetLeft + 'px, ' + (wraps ? target.offsetTop : 0) + 'px)';
        glider.style.opacity = '1';
    }

    function section(title, count, body, open) {
        if (!body) return null;
        const details = h('details', { class: 'dsec' }, [
            h('summary', null, [h('span', { class: 'dsec-chev', html: ICON.chev }), h('span', { text: title }), count != null ? h('span', { class: 'dsec-count', text: String(count) }) : null]),
            h('div', { class: 'dsec-body' }, body),
        ]);
        details.open = !!open;
        return details;
    }

    function kvList(entries) {
        if (!entries || !entries.length) return null;
        return h('dl', { class: 'kv' }, entries.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v == null ? '' : String(v) })]));
    }

    function objectEntries(obj) {
        return obj && typeof obj === 'object' ? Object.keys(obj).map(k => [k, obj[k]]) : [];
    }

    // Small JSON highlighter that builds text nodes, never HTML.
    function codeBlock(text) {
        const pre = h('pre', { class: 'code' });
        const trimmed = text.trim();
        let pretty = text;
        let json = false;
        if (trimmed[0] === '{' || trimmed[0] === '[') {
            try {
                pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
                json = true;
            } catch (e) { /* not JSON, show as-is */ }
        }
        if (!json || pretty.length > 60000) {
            pre.textContent = pretty;
            return pre;
        }
        const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
        let last = 0;
        let m;
        while ((m = re.exec(pretty))) {
            if (m.index > last) pre.append(pretty.slice(last, m.index));
            const cls = m[1] ? (m[2] ? 'j-key' : 'j-str') : (m[3] ? 'j-lit' : 'j-num');
            pre.append(h('span', { class: cls, text: m[1] || m[0] }));
            if (m[2]) pre.append(m[2]);
            last = re.lastIndex;
        }
        pre.append(pretty.slice(last));
        return pre;
    }

    function fact(label, value, cls) {
        if (value == null || value === '') return null;
        return h('span', { class: 'fact' + (cls ? ' ' + cls : '') }, [label ? h('span', { text: label }) : null, h('b', { text: String(value) })]);
    }

    function shellQuote(s) {
        return "'" + String(s).replace(/'/g, "'\\''") + "'";
    }

    function curlFor(req) {
        const parts = ['curl ' + shellQuote(req.url)];
        if (req.method !== 'GET') parts.push('-X ' + req.method);
        objectEntries(req.reqHeaders).forEach(([k, v]) => {
            if (k[0] !== ':') parts.push('-H ' + shellQuote(k + ': ' + v));
        });
        if (req.post) parts.push('--data-raw ' + shellQuote(req.post));
        return parts.join(' \\\n  ');
    }

    function networkDetails(req) {
        let params = [];
        try {
            params = Array.from(new URL(req.url).searchParams.entries());
        } catch (e) { /* not a URL */ }
        const reqHeaders = objectEntries(req.reqHeaders);
        const resHeaders = objectEntries(req.resHeaders);
        const statusLine = [req.status, req.statusText].filter(v => v !== '' && v != null).join(' ');
        return h('div', { class: 'row-details' }, h('div', { class: 'rd-inner' }, [
            h('div', { class: 'facts' }, [
                fact('Status', statusLine, req.err ? 'bad' : ''),
                fact('Type', req.mime),
                fact('Time', req.msText),
                fact('Size', req.sizeText),
            ]),
            req.error ? h('p', { class: 'rd-error', text: req.error }) : null,
            h('div', { class: 'actions' }, [
                copyButton('Copy URL', () => req.url),
                copyButton('Copy as cURL', () => curlFor(req)),
            ]),
            section('Query parameters', params.length, kvList(params), params.length > 0 && params.length <= 12),
            section('Request headers', reqHeaders.length, kvList(reqHeaders), false),
            req.post ? section('Request body', null, [codeBlock(req.post), req.postCut ? h('p', { class: 'rd-note', text: 'Shortened here. The full body is in logs.json.' }) : null], true) : null,
            section('Response headers', resHeaders.length, kvList(resHeaders), false),
            req.body ? section('Response', null, [codeBlock(req.body), req.bodyCut ? h('p', { class: 'rd-note', text: 'Preview only. The full response is in logs.json.' }) : null], !req.post) : null,
            req.bodyOmitted ? h('p', { class: 'rd-note', text: 'Script and style bodies are left out of this page. They are in logs.json.' }) : null,
        ]));
    }

    function interactionDetails(ix) {
        const at = p => p && p.clientX != null ? '(' + p.clientX + ', ' + p.clientY + ')' : '';
        const entries = [];
        if (ix.tag) entries.push(['Element', ix.tag + (ix.id ? '#' + ix.id : '') + (ix.cls ? '.' + ix.cls.trim().split(/\s+/).slice(0, 3).join('.') : '')]);
        if (ix.text) entries.push(['Text', ix.text]);
        if (ix.href) entries.push(['Link', ix.href]);
        if (ix.type === 'click' && ix.coords) entries.push(['Position', at(ix.coords) + (ix.coords.pageX != null ? ' · page (' + ix.coords.pageX + ', ' + ix.coords.pageY + ')' : '')]);
        if (ix.type === 'drag') entries.push(['Drag', at(ix.coords) + ' → ' + at(ix.end) + (ix.distance ? ' · ' + Math.round(ix.distance) + ' px' : '') + (ix.duration ? ' · ' + ix.duration + ' ms' : '')]);
        if (ix.type === 'input') entries.push(['Typed', (ix.valueLength || 0) + ' characters' + (ix.inputType ? ' (' + ix.inputType + ')' : '') + '. Values are never recorded.']);
        if (ix.type === 'change') entries.push(['Value', typeof ix.value === 'boolean' ? (ix.value ? 'checked' : 'unchecked') : (ix.value || 0) + ' characters. Values are never recorded.']);
        if (ix.type === 'scroll') {
            if (ix.from && ix.to) entries.push(['Scroll', '(' + ix.from.x + ', ' + ix.from.y + ') → (' + ix.to.x + ', ' + ix.to.y + ')']);
            entries.push(['Events', ix.count + (ix.span ? ' over ' + (ix.span / 1000).toFixed(1) + ' s' : '')]);
        }
        if (ix.viewport) entries.push(['Viewport', ix.viewport.w + ' × ' + ix.viewport.h]);
        if (ix.url) entries.push(['Page', ix.url]);
        return h('div', { class: 'row-details' }, h('div', { class: 'rd-inner' }, [
            kvList(entries),
            ix.selector || ix.xpath ? h('div', { class: 'actions' }, [
                ix.selector ? copyButton('Copy selector', () => ix.selector) : null,
                ix.xpath ? copyButton('Copy XPath', () => ix.xpath) : null,
            ]) : null,
            ix.selector ? h('code', { class: 'sel-line', text: ix.selector }) : null,
        ]));
    }

    function snapshotMap(snap, cls) {
        const map = h('div', { class: 'snap-map ' + (cls || ''), style: 'aspect-ratio:' + snap.vw + ' / ' + snap.vh });
        snap.els.forEach((el, n) => {
            if (!el.v) return;
            const x = Math.max(0, el.x), y = Math.max(0, el.y);
            const w = Math.min(snap.vw, el.x + el.w) - x, hgt = Math.min(snap.vh, el.y + el.h) - y;
            map.append(h('span', {
                class: 'mbox k-' + el.k, 'data-n': n,
                style: 'left:' + (x / snap.vw * 100) + '%;top:' + (y / snap.vh * 100) + '%;width:' + (w / snap.vw * 100) + '%;height:' + (hgt / snap.vh * 100) + '%',
            }));
        });
        return map;
    }

    // hooks: { hover(n|null), outline(on) } - outline is only offered when there is video.
    function snapshotDetails(snap, hooks) {
        hooks = hooks || {};
        const state = { kind: 'all', query: '' };
        const kinds = Object.keys(KINDS).filter(k => snap.counts[k]);
        const map = snapshotMap(snap, 'big');
        const list = h('ul', { class: 'el-list', role: 'list' });
        const rows = snap.els.map((el, n) => {
            const row = h('li', { class: 'el-row k-' + el.k + (el.v ? '' : ' off'), 'data-n': n }, [
                h('i', { class: 'kdot', 'aria-hidden': 'true' }),
                h('div', { class: 'el-main' }, [
                    h('div', { class: 'el-top' }, [h('code', { class: 'el-tag', text: el.tag }), h('span', { class: 'el-label', text: el.l || '(no text)' }), el.v ? null : h('span', { class: 'el-off', text: 'off-screen' })]),
                    el.s ? h('code', { class: 'el-sel', text: el.s }) : null,
                ]),
                el.s ? copyButton('Copy', () => el.s) : null,
            ]);
            row._text = (el.tag + ' ' + el.l + ' ' + el.s + ' ' + el.href).toLowerCase();
            list.append(row);
            return row;
        });
        const empty = h('li', { class: 'el-empty', text: 'No elements match.', hidden: true });
        list.append(empty);

        const chipGroup = h('div', { class: 'mini-chips', role: 'group', 'aria-label': 'Element type' });
        const glider = h('span', { class: 'chip-glider', 'aria-hidden': 'true' });
        chipGroup.append(glider);
        const chips = [['all', 'All', snap.els.length]].concat(kinds.map(k => [k, KINDS[k], snap.counts[k]])).map(([k, label, n]) => {
            const chip = h('button', { class: 'mchip' + (k !== 'all' ? ' k-' + k : ''), type: 'button', 'aria-pressed': String(k === 'all'), 'data-ripple': true }, [k !== 'all' ? h('i', { class: 'kdot', 'aria-hidden': 'true' }) : null, label + ' ', h('span', { text: String(n) })]);
            chip.addEventListener('click', e => {
                e.stopPropagation();
                state.kind = k;
                chips.forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
                glide(glider, chip);
                apply();
            });
            chipGroup.append(chip);
            return chip;
        });

        const search = h('input', { class: 'el-search', type: 'search', placeholder: 'Find by text, tag or selector', 'aria-label': 'Find an element in this snapshot', autocomplete: 'off', spellcheck: 'false' });
        search.addEventListener('input', () => {
            state.query = search.value.trim().toLowerCase();
            apply();
        });
        search.addEventListener('keydown', e => e.stopPropagation());

        function apply() {
            let shown = 0;
            rows.forEach((row, n) => {
                const el = snap.els[n];
                const ok = (state.kind === 'all' || el.k === state.kind) && (!state.query || row._text.includes(state.query));
                row.hidden = !ok;
                if (ok) shown++;
            });
            map.querySelectorAll('.mbox').forEach(box => {
                const el = snap.els[box.dataset.n];
                box.classList.toggle('dim', !(state.kind === 'all' || el.k === state.kind) || (!!state.query && rows[box.dataset.n].hidden));
            });
            empty.hidden = shown > 0;
        }

        let hot = null;
        function setHot(n) {
            if (n === hot) return;
            hot = n;
            map.classList.toggle('focusing', n != null);
            map.querySelectorAll('.mbox.hot').forEach(b => b.classList.remove('hot'));
            rows.forEach(r => r.classList.remove('hot'));
            if (n != null) {
                const box = map.querySelector('.mbox[data-n="' + n + '"]');
                if (box) box.classList.add('hot');
                rows[n].classList.add('hot');
            }
            if (hooks.hover) hooks.hover(n);
        }
        const nOf = e => {
            const t = e.target.closest && e.target.closest('[data-n]');
            return t ? Number(t.dataset.n) : null;
        };
        list.addEventListener('pointerover', e => setHot(nOf(e)));
        list.addEventListener('pointerleave', () => setHot(null));
        map.addEventListener('pointerover', e => setHot(nOf(e)));
        map.addEventListener('pointerleave', () => setHot(null));
        map.addEventListener('click', e => {
            const n = nOf(e);
            if (n != null) reveal(n);
        });

        function reveal(n) {
            const row = rows[n];
            if (!row) return;
            if (row.hidden) {
                state.kind = 'all';
                state.query = '';
                search.value = '';
                chips.forEach((c, i) => c.setAttribute('aria-pressed', String(i === 0)));
                glide(glider, chips[0]);
                apply();
            }
            list.scrollTo({ top: row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2, behavior: reduceMotion ? 'auto' : 'smooth' });
            row.classList.remove('flash');
            void row.offsetWidth;
            row.classList.add('flash');
        }

        let outlineBtn = null;
        if (hooks.outline) {
            outlineBtn = h('button', { class: 'act-btn', type: 'button', 'aria-pressed': 'true', 'data-ripple': true }, [h('span', { class: 'act-ic', html: ICON.eye }), 'Outline on video']);
            outlineBtn.addEventListener('click', e => {
                e.stopPropagation();
                const on = outlineBtn.getAttribute('aria-pressed') !== 'true';
                outlineBtn.setAttribute('aria-pressed', String(on));
                hooks.outline(on);
            });
        }

        const node = h('div', { class: 'row-details snap-details' }, h('div', { class: 'rd-inner' }, [
            h('div', { class: 'facts' }, [
                fact('', snap.inView + ' in view', 'strong'),
                fact('of', snap.els.length + ' captured'),
                fact('Viewport', snap.vw + ' × ' + snap.vh),
            ]),
            h('p', { class: 'snap-url', text: snap.url }),
            h('div', { class: 'actions' }, [
                outlineBtn,
                copyButton('Copy as JSON', () => JSON.stringify(snap.els.map(el => ({ type: el.k, tag: el.tag, text: el.l, selector: el.s, xpath: el.xp, href: el.href || undefined, rect: { x: el.x, y: el.y, width: el.w, height: el.h }, inView: el.v })), null, 2)),
            ]),
            map,
            h('div', { class: 'el-tools' }, [h('label', { class: 'el-search-wrap' }, [h('span', { class: 'el-search-ic', html: ICON.search }), search]), chipGroup]),
            list,
        ]));
        requestAnimationFrame(() => glide(glider, chips[0]));
        return {
            node,
            reveal,
            hover: setHot,
            relayout() { glide(glider, chips.find(c => c.getAttribute('aria-pressed') === 'true')); },
            setOutline(on) { if (outlineBtn) outlineBtn.setAttribute('aria-pressed', String(!!on)); },
        };
    }

    return { reduceMotion, ICON, h, announce, copyText, copyButton, spotlight, ticker, clock, stagger, glide, networkDetails, interactionDetails, snapshotMap, snapshotDetails };
}

// ---- The session replay page's script (inlined with toString). ----
function replayApp(cfg, kit) {
    const startTime = cfg.startTime;
    const hasVideo = cfg.hasVideo;
    const fallbackDuration = cfg.fallbackDuration;
    const clicks = cfg.clicks;
    const reduceMotion = kit.reduceMotion;
    const $ = id => document.getElementById(id);
    const dataContent = $('dataContent');
    const search = $('logSearch');
    const resultCount = $('resultCount');
    let seekVideo = null;
    let playing = false;
    let xray = null;
    let openSnapshot = null;

    const PLACEHOLDER = { network: 'Filter requests by URL, method or status', interactions: 'Filter interactions by element or text', snapshots: 'Filter snapshots by page' };
    const state = {
        network: { filter: 'all', query: '', hideOpt: false },
        interactions: { filter: 'all', query: '' },
        snapshots: { filter: 'all', query: '' },
    };
    const rowsOf = tab => Array.from($(tab + 'List').querySelectorAll('.log-item[data-timestamp]'));
    // Read once, before any row is expanded, so search matches the row and never its open details.
    const searchText = new WeakMap();
    document.querySelectorAll('.log-item[data-timestamp]').forEach(row => searchText.set(row, row.textContent.toLowerCase()));
    let activeTab = 'network';

    // ---- Header ----
    document.querySelectorAll('[data-tick]').forEach((el, i) => kit.ticker(el, 250 + i * 90));

    // ---- Tabs (click, Space/Enter, or arrow keys inside the tab list) ----
    const tabs = Array.from(document.querySelectorAll('.data-tab'));
    const tabGlider = $('tabGlider');
    function selectTab(tab) {
        const from = tabs.findIndex(t => t.classList.contains('active'));
        const to = tabs.indexOf(tab);
        tabs.forEach(t => {
            const on = t === tab;
            t.classList.toggle('active', on);
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
            $(t.dataset.tab + 'List').style.display = on ? 'block' : 'none';
            $('chips-' + t.dataset.tab).hidden = !on;
        });
        activeTab = tab.dataset.tab;
        kit.glide(tabGlider, tab);
        search.value = state[activeTab].query;
        search.placeholder = PLACEHOLDER[activeTab];
        glideChips(activeTab);
        updateCount(activeTab);
        if (from !== to) {
            const panel = $(activeTab + 'List');
            panel.classList.remove('enter-l', 'enter-r');
            if (!reduceMotion) {
                void panel.offsetWidth;
                panel.classList.add(to > from ? 'enter-r' : 'enter-l');
            }
            dataContent.scrollTop = 0;
            kit.stagger(rowsOf(activeTab).filter(r => !r.hidden));
            lastFollowed = null;
            followNow(true);
        }
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
    $('networkList').addEventListener('animationend', e => e.target.classList.remove('enter-l', 'enter-r'));
    ['interactions', 'snapshots'].forEach(t => $(t + 'List').addEventListener('animationend', e => e.target.classList.remove('enter-l', 'enter-r')));

    // ---- Filters and search ----
    function glideChips(tab) {
        const group = $('chips-' + tab);
        kit.glide(group.querySelector('.chip-glider'), group.querySelector('.fchip[data-f][aria-pressed="true"]'));
    }
    document.querySelectorAll('.filter-chips').forEach(group => {
        const tab = group.id.replace('chips-', '');
        group.addEventListener('click', e => {
            const chip = e.target.closest('.fchip');
            if (!chip) return;
            if (chip.dataset.toggle === 'opt') {
                state.network.hideOpt = chip.getAttribute('aria-pressed') !== 'true';
                chip.setAttribute('aria-pressed', String(state.network.hideOpt));
            } else {
                state[tab].filter = chip.dataset.f;
                group.querySelectorAll('.fchip[data-f]').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
                glideChips(tab);
            }
            applyFilter(tab);
        });
    });
    search.addEventListener('input', () => {
        state[activeTab].query = search.value;
        applyFilter(activeTab);
    });
    search.addEventListener('keydown', e => {
        if (e.key === 'Escape' && search.value) {
            e.stopPropagation();
            search.value = '';
            state[activeTab].query = '';
            applyFilter(activeTab);
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
            const first = rowsOf(activeTab).find(r => !r.hidden);
            if (first) {
                e.preventDefault();
                first.focus();
            }
        }
    });

    function applyFilter(tab) {
        const st = state[tab];
        const q = st.query.trim().toLowerCase();
        const filtering = st.filter !== 'all' || !!q || !!st.hideOpt;
        let shown = 0;
        const rows = rowsOf(tab);
        rows.forEach(row => {
            let ok = st.filter === 'all' || (st.filter === 'err' ? row.dataset.err === '1' : row.dataset.k === st.filter);
            if (ok && st.hideOpt && row.dataset.opt === '1') ok = false;
            if (ok && q) ok = searchText.get(row).includes(q);
            const wasHidden = row.hidden;
            row.hidden = !ok;
            if (ok) shown++;
            if (ok && wasHidden && !reduceMotion) {
                row.classList.add('pop');
                row.addEventListener('animationend', () => row.classList.remove('pop'), { once: true });
            }
        });
        $(tab + 'List').querySelectorAll('.nav-divider').forEach(d => { d.hidden = filtering; });
        const empty = $(tab + 'List').querySelector('.filter-empty');
        if (empty) empty.hidden = shown > 0 || rows.length === 0;
        updateCount(tab, shown, filtering);
    }

    function updateCount(tab, shown, filtering) {
        if (tab !== activeTab) return;
        const total = rowsOf(tab).length;
        if (shown == null) {
            shown = rowsOf(tab).filter(r => !r.hidden).length;
            filtering = shown !== total;
        }
        resultCount.textContent = total ? (filtering ? shown + ' of ' + total : total + (total === 1 ? ' row' : ' rows')) : '';
        resultCount.classList.toggle('filtered', !!filtering);
    }

    document.addEventListener('keydown', e => {
        if (e.target.closest('input, textarea, select')) return;
        if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            search.focus();
            search.select();
        } else if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && followBtn) {
            followBtn.click();
        } else if (e.key === 'Escape' && xray) {
            hideXray();
        }
    });

    // ---- Rows: select to expand details and jump the video to that moment ----
    function collapse(row) {
        row.classList.remove('selected');
        row.setAttribute('aria-expanded', 'false');
        if (row.classList.contains('snap-row') && openSnapshot && openSnapshot.row === row) {
            openSnapshot = null;
            hideXray();
        }
    }
    function details(row) {
        const slot = row.querySelector('.row-slot');
        if (slot.firstChild) return row._details;
        const i = Number(row.dataset.i);
        if (row.classList.contains('net-row')) slot.append(kit.networkDetails(Object.assign({}, cfg.net[i], { url: row.querySelector('.log-url').title })));
        else if (row.classList.contains('ix-row')) slot.append(kit.interactionDetails(cfg.ix[i]));
        else {
            row._details = kit.snapshotDetails(cfg.snaps[i], {
                hover: n => hoverXray(n),
                outline: hasVideo ? on => {
                    if (!on) return hideXray();
                    seekVideo(cfg.snaps[i].t / 1000);
                    showXray(i, true);
                } : null,
            });
            slot.append(row._details.node);
        }
        return row._details;
    }
    function activate(row) {
        const wasOpen = row.classList.contains('selected');
        document.querySelectorAll('.log-item.selected').forEach(el => { if (el !== row) collapse(el); });
        if (wasOpen) {
            collapse(row);
        } else {
            const api = details(row);
            row.classList.add('selected');
            row.setAttribute('aria-expanded', 'true');
            if (api) {
                openSnapshot = { row, api, i: Number(row.dataset.i) };
                requestAnimationFrame(() => api.relayout());
            }
        }
        if (seekVideo) seekVideo((Number(row.dataset.timestamp) - startTime) / 1000);
        if (!wasOpen && openSnapshot && openSnapshot.row === row && hasVideo) showXray(openSnapshot.i, true);
    }
    document.querySelectorAll('.log-item[data-timestamp]').forEach(item => {
        item.addEventListener('click', e => {
            if (e.target.closest('.row-details')) return;
            activate(item);
        });
        item.addEventListener('keydown', e => {
            if (e.target !== item) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activate(item);
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const rows = rowsOf(activeTab).filter(r => !r.hidden);
                const next = rows[rows.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1)];
                if (next) next.focus();
            }
        });
    });
    kit.spotlight(dataContent, '.log-item');

    // ---- Follow playback ----
    const followBtn = $('followBtn');
    const backNow = $('backNow');
    let follow = true;
    let followSuspended = false;
    let lastFollowed = null;
    function syncBackNow() {
        if (backNow) backNow.classList.toggle('show', follow && followSuspended && playing);
    }
    function followNow(force) {
        if (!follow || followSuspended || (!playing && !force)) return;
        const row = $(activeTab + 'List').querySelector('.log-item.active:not([hidden])');
        if (!row || (!force && row === lastFollowed)) return;
        lastFollowed = row;
        const top = row.offsetTop;
        const view = dataContent.clientHeight;
        if (top < dataContent.scrollTop + view * 0.12 || top + row.offsetHeight > dataContent.scrollTop + view * 0.88) {
            dataContent.scrollTo({ top: Math.max(0, top - view * 0.3), behavior: reduceMotion ? 'auto' : 'smooth' });
        }
    }
    if (followBtn) {
        followBtn.addEventListener('click', () => {
            follow = !follow;
            followSuspended = false;
            followBtn.setAttribute('aria-pressed', String(follow));
            syncBackNow();
            lastFollowed = null;
            followNow(true);
        });
        backNow.addEventListener('click', () => {
            followSuspended = false;
            syncBackNow();
            lastFollowed = null;
            followNow(true);
        });
        const suspend = () => {
            if (!follow || !playing || followSuspended) return;
            followSuspended = true;
            syncBackNow();
        };
        dataContent.addEventListener('wheel', suspend, { passive: true });
        dataContent.addEventListener('touchmove', suspend, { passive: true });
    }

    // Initial counts, glider positions and entrance.
    selectTab(tabs[0]);
    kit.stagger(rowsOf('network'), 16);
    window.addEventListener('resize', () => {
        kit.glide(tabGlider, tabs.find(t => t.classList.contains('active')));
        glideChips(activeTab);
        if (openSnapshot) openSnapshot.api.relayout();
    });

    // Snapshot thumbnails in the rows.
    document.querySelectorAll('.snap-thumb[data-i]').forEach(el => el.append(kit.snapshotMap(cfg.snaps[Number(el.dataset.i)], 'thumb')));

    // ---- Snapshot outline on the video (x-ray) ----
    let showXray = () => {};
    let hideXray = () => {};
    let hoverXray = () => {};

    if (hasVideo) {
        const video = $('videoPlayer');
        const container = $('videoContainer');
        const playBtn = $('playBtn');
        const playRing = $('playRing');
        const timelineSlider = $('timelineSlider');
        const timelineProgress = $('timelineProgress');
        const timelineGhost = $('timelineGhost');
        const scrubTip = $('scrubTip');
        const speedControl = $('speedControl');
        const clickLayer = $('clickLayer');
        const xrayLayer = $('xrayLayer');
        const setClock = kit.clock($('timeDisplay'));
        const CLICK_SHOW_SECONDS = 1.2;
        const logItems = Array.from(document.querySelectorAll('.log-item[data-timestamp]'))
            .map(el => ({ el, start: Number(el.dataset.timestamp), end: Number(el.dataset.end || el.dataset.timestamp), snap: el.classList.contains('snap-row') }));
        const markers = clicks.map(click => {
            const marker = kit.h('div', { class: 'click-marker' }, [
                kit.h('span', { class: 'cm-ring' }),
                kit.h('span', { class: 'cm-cursor', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l6.8 16.2 2.3-6.8 6.9-2.4L5 3z"/></svg>' }),
                click.label ? kit.h('span', { class: 'cm-label', text: click.label }) : null,
            ]);
            clickLayer.appendChild(marker);
            return marker;
        });
        let ticks = [];
        let durationPending = false;
        let pendingSeek = null;
        let lastHighlightBucket = -1;
        let activeSnapshots = 0;

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
            if (e.code !== 'Space' || e.target.closest('button, select, input, textarea, .log-item')) return;
            e.preventDefault();
            togglePlay();
        });

        function setPlaying(on) {
            playing = on;
            document.body.classList.toggle('playing', on);
            playBtn.classList.toggle('is-playing', on);
            playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
            if (!on) followSuspended = false;
            else lastFollowed = null; // the list may have been scrolled while paused
            syncBackNow();
        }
        video.addEventListener('play', () => {
            setPlaying(true);
            hideXray();
            requestAnimationFrame(loop);
        });
        video.addEventListener('pause', () => {
            setPlaying(false);
            render();
        });
        video.addEventListener('seeked', render);
        window.addEventListener('resize', () => {
            render();
            if (xray) showXray(xray.index, false);
        });

        // Redraw every frame while playing; timeupdate only fires ~4 times a second.
        function loop() {
            render();
            if (!video.paused && !video.ended) requestAnimationFrame(loop);
        }

        // Scrubber: click or drag; hover shows the time and the nearest marked event.
        function fractionAt(e) {
            const rect = timelineSlider.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        }
        function seekFromPointer(e) {
            seekTo(fractionAt(e) * getDuration());
        }
        timelineSlider.addEventListener('pointerdown', (e) => {
            timelineSlider.setPointerCapture(e.pointerId);
            timelineSlider.classList.add('dragging');
            seekFromPointer(e);
        });
        timelineSlider.addEventListener('pointermove', (e) => {
            if (timelineSlider.hasPointerCapture(e.pointerId)) seekFromPointer(e);
            showTip(e);
        });
        timelineSlider.addEventListener('pointerup', () => timelineSlider.classList.remove('dragging'));
        timelineSlider.addEventListener('pointerleave', () => timelineSlider.classList.remove('hovering'));
        function showTip(e) {
            const f = fractionAt(e);
            const rect = timelineSlider.getBoundingClientRect();
            const total = getDuration();
            const seconds = f * total;
            let near = null;
            let best = 10 / rect.width * total;
            cfg.marks.forEach(mark => {
                const d = Math.abs(mark.t / 1000 - seconds);
                if (d < best) { best = d; near = mark; }
            });
            scrubTip.replaceChildren(kit.h('b', { text: formatTime(near ? near.t / 1000 : seconds) }), near ? kit.h('span', { class: 'tip-' + near.kind, text: near.label }) : null);
            const x = Math.max(scrubTip.offsetWidth / 2, Math.min(rect.width - scrubTip.offsetWidth / 2, f * rect.width));
            scrubTip.style.setProperty('--x', x + 'px');
            timelineGhost.style.width = (f * 100) + '%';
            timelineSlider.classList.add('hovering');
        }
        timelineSlider.addEventListener('keydown', (e) => {
            const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
            if (step) seekTo(currentPosition() + step);
            else if (e.key === 'Home') seekTo(0);
            else if (e.key === 'End') seekTo(getDuration());
            else return;
            e.preventDefault();
        });

        // Magnetic play button: it leans a few pixels toward the pointer.
        if (!reduceMotion) {
            playBtn.addEventListener('pointermove', e => {
                const r = playBtn.getBoundingClientRect();
                const dx = (e.clientX - r.left - r.width / 2) * 0.22;
                const dy = (e.clientY - r.top - r.height / 2) * 0.22;
                playBtn.style.setProperty('--tx', dx.toFixed(1) + 'px');
                playBtn.style.setProperty('--ty', dy.toFixed(1) + 'px');
            });
            playBtn.addEventListener('pointerleave', () => {
                playBtn.style.setProperty('--tx', '0px');
                playBtn.style.setProperty('--ty', '0px');
            });
        }

        // Speed control
        speedControl.addEventListener('change', (e) => {
            video.playbackRate = parseFloat(e.target.value);
        });

        function render() {
            const current = currentPosition();
            const total = getDuration();
            const pct = total ? Math.min(100, (current / total) * 100) : 0;
            timelineProgress.style.width = pct + '%';
            playRing.style.strokeDashoffset = String(100 - pct);
            setClock(formatTime(current) + ' / ' + formatTime(total));
            timelineSlider.setAttribute('aria-valuemax', String(Math.round(total)));
            timelineSlider.setAttribute('aria-valuenow', String(Math.round(current)));
            timelineSlider.setAttribute('aria-valuetext', formatTime(current) + ' of ' + formatTime(total));
            renderClicks(current);
            if (xray && Math.abs(current - xray.at) > 0.6) hideXray();
            const bucket = Math.floor(current * 4);
            if (bucket !== lastHighlightBucket) {
                lastHighlightBucket = bucket;
                highlightCurrentEvents(current * 1000);
                ticks.forEach(tick => tick.el.classList.toggle('passed', tick.t <= current * 1000 + 50));
            }
        }

        function renderTicks() {
            const total = getDuration();
            if (!total) return;
            timelineSlider.querySelectorAll('.click-tick, .snap-tick, .nav-tick').forEach(tick => tick.remove());
            const at = t => Math.max(0, Math.min(100, (t / 1000 / total) * 100)) + '%';
            ticks = [];
            clicks.forEach(click => {
                const tick = kit.h('div', { class: 'click-tick', style: 'left:' + at(click.t) });
                timelineSlider.appendChild(tick);
                ticks.push({ el: tick, t: click.t });
            });
            cfg.marks.forEach(mark => {
                if (mark.kind === 'click') return;
                const tick = kit.h('div', { class: mark.kind + '-tick', style: 'left:' + at(mark.t) });
                timelineSlider.appendChild(tick);
                ticks.push({ el: tick, t: mark.t });
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
        function framePoint(x, y, vw, vh, box) {
            const s = Math.min(box.vW / vw, box.vH / vh);
            const fx = (box.vW - vw * s) / 2 + x * s;
            const fy = (box.vH - vh * s) / 2 + y * s;
            return { x: box.left + fx * box.scale, y: box.top + fy * box.scale };
        }

        function clickPoint(click, box) {
            return framePoint(click.x, click.y, click.vw, click.vh, box);
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
                marker.style.setProperty('--s', String(0.7 + progress * 0.6));
                marker.classList.toggle('flip', point.x > video.clientWidth - 220);
            });
        }

        showXray = function (index, animate) {
            const snap = cfg.snaps[index];
            if (!snap) return;
            if (!video.videoWidth) {
                video.addEventListener('loadeddata', () => showXray(index, animate), { once: true });
                return;
            }
            if (!video.paused) video.pause();
            xray = { index, at: Math.max(0, Math.min(snap.t / 1000, getDuration())) };
            const box = frameBox();
            xrayLayer.replaceChildren();
            xrayLayer.classList.toggle('static', !animate || reduceMotion);
            let order = 0;
            snap.els.forEach((el, n) => {
                if (!el.v) return;
                const a = framePoint(Math.max(0, el.x), Math.max(0, el.y), snap.vw, snap.vh, box);
                const b = framePoint(Math.min(snap.vw, el.x + el.w), Math.min(snap.vh, el.y + el.h), snap.vw, snap.vh, box);
                const node = kit.h('div', {
                    class: 'xbox k-' + el.k + (a.y - box.top < 26 ? ' lbl-in' : ''),
                    'data-n': n,
                    style: 'left:' + a.x + 'px;top:' + a.y + 'px;width:' + Math.max(2, b.x - a.x) + 'px;height:' + Math.max(2, b.y - a.y) + 'px;--i:' + Math.min(order++, 60),
                }, kit.h('span', { class: 'xlabel', text: (el.tag ? el.tag + ' · ' : '') + (el.l || el.s || '') }));
                xrayLayer.append(node);
            });
            const close = kit.h('button', { class: 'xray-close', type: 'button', 'aria-label': 'Hide outlines', 'data-ripple': true, text: '×' });
            close.addEventListener('click', e => {
                e.stopPropagation();
                hideXray();
            });
            xrayLayer.append(kit.h('div', { class: 'xray-badge' }, [kit.h('i', { class: 'xray-dot' }), kit.h('span', { text: snap.inView + ' elements in view' }), kit.h('kbd', { text: 'Esc' }), close]));
            xrayLayer.hidden = false;
            if (openSnapshot) openSnapshot.api.setOutline(true);
        };
        hideXray = function () {
            if (!xray) return;
            xray = null;
            xrayLayer.hidden = true;
            xrayLayer.replaceChildren();
            if (openSnapshot) openSnapshot.api.setOutline(false);
        };
        hoverXray = function (n) {
            xrayLayer.classList.toggle('focusing', n != null);
            xrayLayer.querySelectorAll('.xbox.hot').forEach(b => b.classList.remove('hot'));
            if (n != null) {
                const b = xrayLayer.querySelector('.xbox[data-n="' + n + '"]');
                if (b) b.classList.add('hot');
            }
        };
        xrayLayer.addEventListener('click', e => {
            const b = e.target.closest('.xbox');
            if (b && openSnapshot) openSnapshot.api.reveal(Number(b.dataset.n));
        });
        xrayLayer.addEventListener('pointerover', e => {
            const b = e.target.closest('.xbox');
            if (openSnapshot) openSnapshot.api.hover(b ? Number(b.dataset.n) : null);
        });
        xrayLayer.addEventListener('pointerleave', () => { if (openSnapshot) openSnapshot.api.hover(null); });

        function formatTime(seconds) {
            if (!isFinite(seconds)) seconds = 0;
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
        }

        function highlightCurrentEvents(currentTimeMs) {
            const currentTimestamp = startTime + currentTimeMs;
            let snaps = 0;
            logItems.forEach(({ el, start, end, snap }) => {
                const on = currentTimestamp > start - 1000 && currentTimestamp < end + 1000;
                el.classList.toggle('active', on);
                if (on && snap) snaps++;
            });
            if (snaps > activeSnapshots && playing && !reduceMotion) {
                const badge = document.querySelector('#tab-snapshots .tab-count');
                badge.classList.remove('ping');
                void badge.offsetWidth;
                badge.classList.add('ping');
            }
            activeSnapshots = snaps;
            followNow(false);
        }

        render();
    }
}

/**
 * Generates HTML timeline with embedded video player
 * This creates a split-view interface:
 * - Left side: Video player with controls
 * - Right side: Synchronized logs (Network/Interactions/Snapshots)
 *
 * The video is referenced by file name; the export zip ships it next to this HTML.
 *
 * @param {Object} data - Export data with logs and metadata
 * @param {Blob|null} videoBlob - The video blob (only checked for presence)
 * @param {string|null} videoFileName - The video filename (for relative path reference)
 * @returns {string} HTML content as string
 */
function generateVideoTimelineHTML(data, videoBlob = null, videoFileName = null) {
    console.log('[VideoHTML] Generating video timeline HTML...');

    // The export zip always ships the video next to this HTML, so reference it by filename.
    const videoSrc = videoBlob ? (videoFileName || 'video.webm') : null;
    if (!videoSrc) console.warn('[VideoHTML] No video blob provided');

    const networkLogs = data.networkLogs || [];
    const interactionLogs = data.interactionLogs || [];
    const elementSnapshots = data.elementSnapshots || [];
    let firstEventTime = Infinity;
    let lastEventTime = -Infinity;
    [networkLogs, interactionLogs, elementSnapshots].forEach(list => list.forEach(e => {
        if (e.timestamp < firstEventTime) firstEventTime = e.timestamp;
        if (e.timestamp > lastEventTime) lastEventTime = e.timestamp;
    }));
    if (!Number.isFinite(firstEventTime)) firstEventTime = lastEventTime = Date.now();
    // Anchor the timeline to when the video actually started (video t=0) so highlighted
    // events line up with the footage. Fall back to the first captured event for older
    // exports or when the video start time is unavailable.
    const startTime = data.videoStartTime || firstEventTime;
    const endTime = lastEventTime;
    const duration = Math.max(0, endTime - startTime);

    // Only what the player needs to draw clicks on the video (t = ms since video t=0).
    const clicks = interactionLogs
        .filter(log => log.type === 'click' && log.coordinates && log.viewport)
        .map(log => ({
            t: log.timestamp - startTime,
            x: log.coordinates.clientX,
            y: log.coordinates.clientY,
            vw: log.viewport.width,
            vh: log.viewport.height,
            label: targetLabel(log.element)
        }));

    const net = networkLogs.map(requestModel);
    const ixRows = interactionRows(interactionLogs);
    const ix = ixRows.map(interactionModel);
    const snaps = elementSnapshots.map(s => Object.assign(snapshotModel(s), { t: s.timestamp - startTime }));

    // Moments worth a mark on the scrubber: clicks, snapshots and page changes.
    const marks = clicks.map(c => ({ t: c.t, kind: 'click', label: 'Click' + (c.label ? ' · ' + c.label : '') }))
        .concat(snaps.map(s => ({ t: s.t, kind: 'snap', label: 'Snapshot · ' + s.inView + ' elements in view' })));
    ixRows.forEach((row, i) => {
        if (i > 0 && pageKey(row.url) !== pageKey(ixRows[i - 1].url)) marks.push({ t: row.start - startTime, kind: 'nav', label: 'Page · ' + pathOf(row.url) });
    });

    const recordedAt = new Date(data.exportDate).toLocaleString();
    const pageUrl = (interactionLogs.find(log => log.url) || networkLogs[0] || {}).url;
    const host = hostOf(pageUrl);
    const summary = data.summary || {};
    const filterEmpty = '<li class="log-item filter-empty" hidden>Nothing matches this filter.</li>';
    const chevron = '<span class="chev" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 6.5L8 9l2.5-2.5"/></svg></span>';

    // Request URLs are already in each row's title, so the details script reads them from there.
    const cfg = { startTime, hasVideo: !!videoSrc, fallbackDuration: duration / 1000, clicks, marks, net: net.map(m => Object.assign({}, m, { url: undefined })), ix, snaps };

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    ${TIMELINE_CSP}
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <title>Session replay${host ? ' · ' + escapeHtml(host) : ''} · ${escapeHtml(recordedAt)}</title>
    <style>
        @property --angle {
            syntax: '<angle>';
            inherits: false;
            initial-value: 0deg;
        }

        :root {
            --bg: #0c0c0e;
            --panel: #141417;
            --panel-2: #1b1b1f;
            --panel-3: #222227;
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
            --k-link: #70b8ff;
            --k-button: #ff8589;
            --k-field: #3dd68c;
            --k-select: #f1a10d;
            --k-toggle: #4cc9c0;
            --k-other: #a1a1aa;
            --line-3: #4a4a52;
            --dots: rgba(255, 255, 255, 0.05);
            --sunken: rgba(0, 0, 0, 0.16);
            --hover: rgba(255, 255, 255, 0.025);
            --bad: #ff8589;
            --j-key: #9cc9ff;
            --j-str: #8fe3b6;
            --j-num: #ffc86b;
            --j-lit: #ff9da0;
            --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
            --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
            /* Springs sampled into linear(): soft settles with ~1% overshoot, bouncy with ~9%. */
            --spring: linear(0, 0.0198 1%, 0.0793 2.1%, 0.3115 5.2%, 0.5823 9.3%, 0.7792 13.5%, 0.8979 17.6%, 0.9618 21.8%, 0.9937 26.4%, 1.0082 31.7%, 1.0118 37.9%, 1.0068 50%, 0.9999 75%, 1);
            --bounce: linear(0, 0.0236 1.1%, 0.0951 2.3%, 0.3793 5.8%, 0.6843 10.2%, 0.9021 14.6%, 1.0236 19.3%, 1.0783 23.6%, 1.0915 27.5%, 1.0804 31.9%, 1.0265 41.5%, 0.9978 51.6%, 0.9933 62%, 1.0004 85%, 1);
            --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;
            interpolate-size: allow-keywords;
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

        button, select, input {
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
            animation: fade 0.5s var(--ease-out) both;
        }

        .mark {
            flex: none;
            width: 28px;
            height: 28px;
            border-radius: 8px;
            background: var(--text);
            display: grid;
            place-items: center;
            transition: transform 0.4s var(--bounce);
        }

        .mark:hover {
            transform: rotate(-8deg) scale(1.06);
        }

        .mark span {
            position: relative;
            width: 11px;
            height: 11px;
            border-radius: 50%;
            background: var(--accent);
            box-shadow: 0 0 0 3px var(--text);
        }

        .mark span::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 50%;
            background: var(--accent);
            opacity: 0;
        }

        body.playing .mark span::after {
            animation: ping 1.6s var(--ease-out) infinite;
        }

        @keyframes ping {
            from { transform: scale(1); opacity: 0.7; }
            to { transform: scale(2.6); opacity: 0; }
        }

        .title {
            min-width: 0;
        }

        .title h1 {
            font-size: 14px;
            font-weight: 650;
            letter-spacing: -0.01em;
        }

        .title h1 span {
            display: inline-block;
            animation: blurIn 0.7s var(--ease-out) both;
            animation-delay: calc(80ms + var(--i) * 70ms);
        }

        .title p {
            font-size: 12px;
            color: var(--text-3);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            animation: blurIn 0.7s var(--ease-out) 240ms both;
        }

        .topbar > .copy-btn {
            flex: none;
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
            animation: blurIn 0.6s var(--ease-out) both;
            animation-delay: calc(200ms + var(--i) * 60ms);
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
            grid-template-columns: minmax(0, 1fr) minmax(360px, 38%);
        }

        .video-section {
            display: flex;
            flex-direction: column;
            min-width: 0;
            padding: 16px;
            gap: 12px;
            animation: fade 0.55s var(--ease-out) 60ms both;
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
            background: #060607 radial-gradient(rgba(255, 255, 255, 0.055) 1px, transparent 1.5px) 0 0 / 16px 16px;
            box-shadow: 0 0 0 1px var(--line), 0 24px 48px -24px rgba(0, 0, 0, 0.8);
        }

        /* A light runs around the frame while the video plays. */
        .video-container::after {
            content: '';
            position: absolute;
            inset: 0;
            z-index: 4;
            padding: 1px;
            border-radius: inherit;
            background: conic-gradient(from var(--angle), transparent 0 70%, rgba(229, 72, 77, 0.65) 86%, rgba(255, 255, 255, 0.85) 92%, transparent 100%);
            -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
            -webkit-mask-composite: xor;
            mask-composite: exclude;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.6s var(--ease-out);
            animation: beam 5s linear infinite paused;
        }

        body.playing .video-container::after {
            opacity: 0.85;
            animation-play-state: running;
        }

        @keyframes beam {
            to { --angle: 360deg; }
        }

        video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            cursor: pointer;
        }

        .click-layer,
        .xray-layer {
            position: absolute;
            inset: 0;
            pointer-events: none;
        }

        .click-layer {
            z-index: 2;
        }

        .click-marker {
            position: absolute;
            display: none;
            width: 0;
            height: 0;
        }

        .cm-ring {
            position: absolute;
            left: -20px;
            top: -20px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            border: 2px solid var(--accent);
            background: rgba(229, 72, 77, 0.2);
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), 0 0 22px rgba(229, 72, 77, 0.55);
            transform: scale(var(--s, 1));
        }

        /* Two rings ripple out each time a marker appears (display none -> block restarts them). */
        .cm-ring::before,
        .cm-ring::after {
            content: '';
            position: absolute;
            inset: -2px;
            border-radius: 50%;
            border: 2px solid var(--accent);
            animation: ripple 0.8s var(--ease-out) both;
        }

        .cm-ring::after {
            animation-delay: 0.14s;
        }

        @keyframes ripple {
            from { transform: scale(0.6); opacity: 0.9; }
            to { transform: scale(2.3); opacity: 0; }
        }

        .cm-cursor {
            position: absolute;
            left: -3px;
            top: -3px;
            width: 22px;
            height: 22px;
            filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.6));
            animation: press 0.45s var(--bounce) both;
        }

        .cm-cursor svg {
            width: 100%;
            height: 100%;
            fill: #fff;
            stroke: #0c0c0e;
            stroke-width: 1.4;
            stroke-linejoin: round;
        }

        @keyframes press {
            0% { transform: translate(-6px, -6px) scale(1.2); opacity: 0; }
            55% { transform: scale(0.82); opacity: 1; }
            100% { transform: none; }
        }

        .cm-label {
            position: absolute;
            left: 24px;
            top: 14px;
            max-width: 220px;
            padding: 3px 8px;
            border-radius: 6px;
            background: rgba(12, 12, 14, 0.88);
            border: 1px solid rgba(255, 255, 255, 0.12);
            color: #fff;
            font-size: 11.5px;
            font-weight: 550;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            backdrop-filter: blur(6px);
            animation: labelIn 0.5s var(--ease-out) 0.1s both;
        }

        .click-marker.flip .cm-label {
            left: auto;
            right: 18px;
        }

        @keyframes labelIn {
            from { opacity: 0; transform: translateY(4px); filter: blur(4px); }
        }

        /* Snapshot outlines over the video */
        .xray-layer {
            z-index: 3;
            background: rgba(6, 6, 7, 0.28);
            animation: fadeIn 0.3s var(--ease-out);
        }

        .xbox {
            position: absolute;
            pointer-events: auto;
            cursor: pointer;
            border: 1.5px solid var(--kc);
            border-radius: 3px;
            background: color-mix(in srgb, var(--kc) 9%, transparent);
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
            transition: opacity 0.2s var(--ease-out), background 0.2s var(--ease-out), box-shadow 0.2s var(--ease-out);
            animation: xin 0.5s var(--ease-out) both;
            animation-delay: calc(var(--i) * 10ms);
        }

        .xray-layer.static .xbox,
        .xray-layer.static {
            animation: none;
        }

        @keyframes xin {
            from { opacity: 0; transform: scale(1.08); }
        }

        .xray-layer.focusing .xbox:not(.hot) {
            opacity: 0.2;
        }

        .xbox:hover,
        .xbox.hot {
            z-index: 2;
            background: color-mix(in srgb, var(--kc) 22%, transparent);
            box-shadow: 0 0 0 2px var(--kc), 0 0 20px color-mix(in srgb, var(--kc) 55%, transparent);
        }

        .xlabel {
            position: absolute;
            left: -1.5px;
            bottom: calc(100% + 4px);
            max-width: 260px;
            padding: 2px 7px;
            border-radius: 5px;
            background: var(--kc);
            color: #0c0c0e;
            font-size: 11px;
            font-weight: 650;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0;
            transform: translateY(3px);
            transition: opacity 0.18s var(--ease-out), transform 0.25s var(--spring);
            pointer-events: none;
        }

        .xbox.lbl-in .xlabel {
            bottom: auto;
            top: calc(100% + 4px);
        }

        .xbox:hover .xlabel,
        .xbox.hot .xlabel {
            opacity: 1;
            transform: none;
        }

        .xray-badge {
            position: absolute;
            top: 12px;
            left: 50%;
            z-index: 5;
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 4px 4px 12px;
            border: 1px solid var(--line-2);
            border-radius: 999px;
            background: rgba(20, 20, 23, 0.86);
            backdrop-filter: blur(10px);
            font-size: 12px;
            pointer-events: auto;
            transform: translateX(-50%);
            animation: drop 0.55s var(--bounce) both;
        }

        @keyframes drop {
            from { opacity: 0; transform: translate(-50%, -14px) scale(0.92); }
        }

        .xray-dot {
            width: 7px;
            height: 7px;
            border-radius: 2px;
            background: var(--k-select);
            transform: rotate(45deg);
        }

        .xray-close {
            position: relative;
            overflow: hidden;
            width: 24px;
            height: 24px;
            border: none;
            border-radius: 50%;
            background: var(--panel-3);
            color: var(--text-2);
            font-size: 15px;
            line-height: 1;
            cursor: pointer;
            transition: background 0.15s, color 0.15s, transform 0.3s var(--bounce);
        }

        .xray-close:hover {
            background: var(--line-2);
            color: var(--text);
            transform: rotate(90deg);
        }

        .video-placeholder {
            display: grid;
            justify-items: center;
            gap: 8px;
            padding: 32px;
            text-align: center;
            color: var(--text-3);
            max-width: 340px;
            animation: blurIn 0.7s var(--ease-out) 0.2s both;
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
            position: relative;
            flex: none;
            width: 44px;
            height: 44px;
            border: none;
            border-radius: 50%;
            background: transparent;
            color: var(--bg);
            display: grid;
            place-items: center;
            cursor: pointer;
            transform: translate(var(--tx, 0px), var(--ty, 0px));
            transition: transform 0.45s var(--spring);
        }

        .play-btn::before {
            content: '';
            position: absolute;
            inset: 4px;
            border-radius: 50%;
            background: var(--text);
            transition: transform 0.25s var(--bounce), background 0.2s var(--ease-out);
        }

        .play-btn:hover::before {
            background: #fff;
            transform: scale(1.05);
        }

        .play-btn:active::before {
            transform: scale(0.9);
        }

        .play-btn .ripple {
            color: var(--bg);
            clip-path: circle(18px at 50% 50%);
        }

        .play-btn .ring {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            transform: rotate(-90deg);
            pointer-events: none;
        }

        .ring circle {
            fill: none;
            stroke-width: 2;
        }

        .ring-track {
            stroke: var(--line-2);
        }

        .ring-fill {
            stroke: var(--accent);
            stroke-linecap: round;
            stroke-dasharray: 100;
            stroke-dashoffset: 100;
        }

        .play-btn .ic {
            position: absolute;
            left: 50%;
            top: 50%;
            width: 16px;
            height: 16px;
            margin: -8px 0 0 -8px;
            transition: transform 0.45s var(--bounce), opacity 0.2s var(--ease-out);
        }

        .ic-play {
            margin-left: -7px !important;
        }

        .ic-pause {
            opacity: 0;
            transform: rotate(-90deg) scale(0.4);
        }

        .play-btn.is-playing .ic-play {
            opacity: 0;
            transform: rotate(90deg) scale(0.4);
        }

        .play-btn.is-playing .ic-pause {
            opacity: 1;
            transform: none;
        }

        .time-display {
            flex: none;
            min-width: 100px;
            font-family: var(--mono);
            font-size: 12px;
            line-height: 1.3em;
            color: var(--text-2);
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
        }

        .time-display .dg {
            position: relative;
            display: inline-block;
            width: 1ch;
            height: 1.3em;
            overflow: hidden;
            vertical-align: top;
            color: transparent;
        }

        .time-display .dg::before {
            content: '0\\A 1\\A 2\\A 3\\A 4\\A 5\\A 6\\A 7\\A 8\\A 9';
            position: absolute;
            left: 0;
            top: 0;
            white-space: pre;
            color: var(--text-2);
            transform: translateY(calc(var(--d, 0) * -1.3em));
            transition: transform 0.5s var(--spring);
        }

        .time-display .sep {
            white-space: pre;
        }

        .timeline-slider {
            flex: 1;
            height: 26px;
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
            transition: transform 0.25s var(--spring);
        }

        .timeline-ghost,
        .timeline-progress {
            position: absolute;
            left: 0;
            top: 50%;
            height: 4px;
            margin-top: -2px;
            border-radius: 2px;
            transition: transform 0.25s var(--spring);
        }

        .timeline-ghost {
            width: 0;
            background: rgba(255, 255, 255, 0.16);
            opacity: 0;
            transition: opacity 0.2s, transform 0.25s var(--spring);
        }

        .timeline-slider.hovering .timeline-ghost {
            opacity: 1;
        }

        .timeline-progress {
            background: linear-gradient(90deg, #b8353a, var(--accent) 60%, #ff8589);
            background-size: 200% 100%;
        }

        body.playing .timeline-progress {
            animation: sheen 2.4s linear infinite;
        }

        @keyframes sheen {
            from { background-position: 100% 0; }
            to { background-position: -100% 0; }
        }

        .timeline-slider:hover::before,
        .timeline-slider:hover .timeline-progress,
        .timeline-slider:hover .timeline-ghost,
        .timeline-slider:focus-visible::before,
        .timeline-slider:focus-visible .timeline-progress {
            transform: scaleY(1.6);
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
            transition: transform 0.35s var(--bounce), box-shadow 0.2s;
        }

        .timeline-slider:hover .timeline-handle,
        .timeline-slider:focus-visible .timeline-handle {
            transform: scale(1) scaleY(0.625);
        }

        .timeline-slider.dragging .timeline-handle {
            transform: scale(1.25) scaleY(0.625);
            box-shadow: 0 0 0 7px rgba(229, 72, 77, 0.3), 0 2px 6px rgba(0, 0, 0, 0.5);
        }

        .click-tick,
        .snap-tick,
        .nav-tick {
            position: absolute;
            top: 50%;
            pointer-events: none;
            transition: transform 0.4s var(--bounce), opacity 0.3s, background 0.3s, box-shadow 0.3s;
        }

        .click-tick {
            width: 2px;
            height: 10px;
            margin: -5px 0 0 -1px;
            border-radius: 1px;
            background: #fff;
            opacity: 0.55;
        }

        .click-tick.passed {
            background: #fff;
            opacity: 1;
            transform: scaleY(1.35);
            box-shadow: 0 0 8px rgba(255, 255, 255, 0.7);
        }

        .snap-tick {
            width: 8px;
            height: 8px;
            margin: -13px 0 0 -4px;
            border-radius: 2px;
            background: var(--k-select);
            box-shadow: 0 0 0 2px var(--panel);
            transform: rotate(45deg) scale(0.85);
        }

        .snap-tick.passed {
            transform: rotate(45deg) scale(1.1);
            box-shadow: 0 0 0 2px var(--panel), 0 0 10px var(--k-select);
        }

        .nav-tick {
            width: 6px;
            height: 6px;
            margin: 6px 0 0 -3px;
            border-radius: 50%;
            background: var(--info);
            opacity: 0.75;
        }

        .nav-tick.passed {
            opacity: 1;
            transform: scale(1.3);
        }

        .scrub-tip {
            position: absolute;
            left: 0;
            bottom: calc(100% + 8px);
            z-index: 6;
            display: flex;
            align-items: center;
            gap: 7px;
            max-width: 340px;
            padding: 4px 9px;
            border-radius: 7px;
            background: var(--text);
            color: var(--bg);
            font-size: 11.5px;
            white-space: nowrap;
            pointer-events: none;
            opacity: 0;
            transform: translate(calc(var(--x, 0px) - 50%), 4px) scale(0.96);
            transition: opacity 0.15s var(--ease-out), transform 0.22s var(--spring);
        }

        .scrub-tip b {
            font-family: var(--mono);
            font-weight: 650;
            font-variant-numeric: tabular-nums;
        }

        .scrub-tip span {
            overflow: hidden;
            text-overflow: ellipsis;
            color: #3f3f46;
        }

        .scrub-tip span::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 6px;
            margin-right: 6px;
            border-radius: 50%;
            vertical-align: 1px;
            background: var(--accent);
        }

        .scrub-tip .tip-snap::before {
            border-radius: 1px;
            background: #c27c00;
            transform: rotate(45deg);
        }

        .scrub-tip .tip-nav::before {
            background: #0d74ce;
        }

        .timeline-slider.hovering:not(.dragging) .scrub-tip {
            opacity: 1;
            transform: translate(calc(var(--x, 0px) - 50%), 0) scale(1);
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
            transition: border-color 0.15s, background 0.15s;
        }

        .speed-control:hover {
            border-color: #4a4a52;
            background: var(--panel-3);
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
            position: relative;
            display: flex;
            flex-direction: column;
            min-height: 0;
            min-width: 0;
            border-left: 1px solid var(--line);
            background: var(--panel);
            animation: fade 0.55s var(--ease-out) 120ms both;
        }

        .data-header {
            padding: 12px 12px 0;
            border-bottom: 1px solid var(--line);
        }

        .data-tabs {
            position: relative;
            display: flex;
            gap: 4px;
        }

        .tab-glider {
            position: absolute;
            left: 0;
            bottom: -1px;
            height: 2px;
            width: 0;
            border-radius: 2px;
            background: var(--accent);
            box-shadow: 0 0 12px rgba(229, 72, 77, 0.6);
            opacity: 0;
            transition: transform 0.5s var(--spring), width 0.5s var(--spring);
        }

        .data-tab {
            position: relative;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 10px 11px;
            border: none;
            border-radius: 7px 7px 0 0;
            background: transparent;
            color: var(--text-3);
            font-size: 12.5px;
            font-weight: 550;
            cursor: pointer;
            overflow: hidden;
            transition: color 0.2s var(--ease-out), background 0.2s var(--ease-out);
        }

        .data-tab:hover {
            color: var(--text);
            background: rgba(255, 255, 255, 0.03);
        }

        .data-tab.active {
            color: var(--text);
        }

        .tab-count {
            position: relative;
            padding: 0 6px;
            border-radius: 5px;
            background: var(--panel-2);
            color: var(--text-3);
            font-size: 11px;
            font-variant-numeric: tabular-nums;
            transition: background 0.2s, color 0.2s;
        }

        .data-tab.active .tab-count {
            background: var(--accent-soft);
            color: #ff9ea1;
        }

        .tab-count.ping::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: inherit;
            box-shadow: 0 0 0 2px var(--k-select);
            animation: badgePing 0.9s var(--ease-out) forwards;
        }

        @keyframes badgePing {
            from { opacity: 1; transform: scale(1); }
            to { opacity: 0; transform: scale(1.6); }
        }

        /* Search, follow and filters */
        .panel-tools {
            display: flex;
            gap: 8px;
            padding: 10px 12px 0;
        }

        .search {
            flex: 1;
            min-width: 0;
            display: flex;
            align-items: center;
            gap: 7px;
            height: 32px;
            padding: 0 6px 0 10px;
            border: 1px solid var(--line-2);
            border-radius: 9px;
            background: var(--bg);
            color: var(--text-3);
            cursor: text;
            transition: border-color 0.2s var(--ease-out), box-shadow 0.25s var(--ease-out), background 0.2s;
        }

        .search:focus-within {
            border-color: #55555e;
            background: #0f0f12;
            box-shadow: 0 0 0 4px rgba(229, 72, 77, 0.12);
        }

        .search svg {
            flex: none;
            width: 14px;
            height: 14px;
            transition: color 0.2s, transform 0.4s var(--bounce);
        }

        .search:focus-within svg {
            color: var(--text);
            transform: scale(1.12) rotate(-8deg);
        }

        .search input {
            flex: 1;
            min-width: 0;
            border: none;
            background: transparent;
            color: var(--text);
            font-size: 12.5px;
            outline: none;
        }

        .search input::placeholder {
            color: var(--text-3);
        }

        .search kbd {
            transition: opacity 0.2s;
        }

        .search:focus-within kbd {
            opacity: 0;
        }

        .follow-btn {
            position: relative;
            overflow: hidden;
            flex: none;
            display: inline-flex;
            align-items: center;
            gap: 7px;
            height: 32px;
            padding: 0 11px;
            border: 1px solid var(--line-2);
            border-radius: 9px;
            background: var(--panel-2);
            color: var(--text-3);
            font-size: 12px;
            font-weight: 550;
            cursor: pointer;
            transition: color 0.2s, border-color 0.2s, background 0.2s;
        }

        .follow-btn:hover {
            color: var(--text);
        }

        .follow-dot {
            position: relative;
            width: 7px;
            height: 7px;
            border-radius: 50%;
            background: var(--text-3);
            transition: background 0.2s, transform 0.4s var(--bounce);
        }

        .follow-btn[aria-pressed="true"] {
            color: var(--text);
            border-color: rgba(229, 72, 77, 0.45);
            background: var(--accent-soft);
        }

        .follow-btn[aria-pressed="true"] .follow-dot {
            background: var(--accent);
            transform: scale(1.15);
        }

        body.playing .follow-btn[aria-pressed="true"] .follow-dot::after {
            content: '';
            position: absolute;
            inset: 0;
            border-radius: 50%;
            background: var(--accent);
            animation: ping 1.6s var(--ease-out) infinite;
        }

        .chip-row {
            display: flex;
            align-items: center;
            gap: 10px;
            min-height: 44px;
            padding: 8px 12px 9px;
        }

        ${EXPORT_DETAILS_CSS}

        .chip-row > .filter-chips {
            flex: 1 1 auto;
        }

        .chip-hint {
            color: var(--text-3);
            font-size: 12px;
        }

        .result-count {
            flex: none;
            margin-left: auto;
            font-size: 11.5px;
            color: var(--text-3);
            font-variant-numeric: tabular-nums;
            transition: color 0.2s;
        }

        .result-count.filtered {
            color: var(--text);
            animation: blurIn 0.35s var(--ease-out);
        }

        .data-content {
            position: relative;
            flex: 1;
            overflow-y: auto;
            overscroll-behavior: contain;
            -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
            mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent);
        }

        .scroll-progress {
            position: sticky;
            top: 0;
            z-index: 3;
            height: 2px;
            margin-bottom: -2px;
            background: linear-gradient(90deg, transparent, var(--accent));
            transform: scaleX(0);
            transform-origin: left;
        }

        @supports (animation-timeline: scroll()) {
            .scroll-progress {
                animation: grow linear both;
                animation-timeline: scroll(nearest block);
            }
        }

        @keyframes grow {
            from { transform: scaleX(0); }
            to { transform: scaleX(1); }
        }

        .log-list {
            list-style: none;
            padding: 6px 6px 28px;
        }

        .log-list.enter-r { animation: panelR 0.36s var(--ease-out); }
        .log-list.enter-l { animation: panelL 0.36s var(--ease-out); }

        @keyframes panelR {
            from { opacity: 0; transform: translateX(18px); filter: blur(3px); }
        }

        @keyframes panelL {
            from { opacity: 0; transform: translateX(-18px); filter: blur(3px); }
        }

        .log-item {
            position: relative;
            isolation: isolate;
            display: flex;
            align-items: flex-start;
            gap: 10px;
            padding: 9px 30px 9px 12px;
            border-radius: 9px;
            cursor: pointer;
            outline-offset: -2px;
            transition: background 0.2s var(--ease-out), opacity 0.2s;
        }

        .log-item + .log-item {
            margin-top: 1px;
        }

        /* Cursor spotlight */
        .log-item::before {
            content: '';
            position: absolute;
            inset: 0;
            z-index: -1;
            border-radius: inherit;
            background: radial-gradient(240px circle at var(--mx, -400px) var(--my, -400px), rgba(255, 255, 255, 0.07), transparent 65%);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.25s var(--ease-out);
        }

        .log-item:hover::before {
            opacity: 1;
        }

        /* "Now" bar on the left: grows in for the current moment, red when selected. */
        .log-item::after {
            content: '';
            position: absolute;
            left: 2px;
            top: 9px;
            bottom: 9px;
            width: 2px;
            border-radius: 2px;
            background: var(--text-3);
            transform: scaleY(0);
            transition: transform 0.4s var(--spring), background 0.2s;
        }

        .log-item:hover {
            background: rgba(255, 255, 255, 0.025);
        }

        .log-item.active {
            background: rgba(255, 255, 255, 0.045);
        }

        .log-item.active::after,
        .log-item.selected::after {
            transform: scaleY(1);
        }

        .log-item.selected {
            background: rgba(255, 255, 255, 0.04);
            box-shadow: inset 0 0 0 1px var(--line);
            cursor: default;
        }

        .log-item.selected::after {
            background: var(--accent);
            box-shadow: 0 0 10px rgba(229, 72, 77, 0.7);
        }

        .log-item.enter {
            animation: blurIn 0.55s var(--ease-out) both;
            animation-delay: calc(var(--i, 0) * 24ms);
        }

        .log-item.pop {
            animation: blurIn 0.3s var(--ease-out) both;
        }

        .log-item.empty,
        .log-item.filter-empty {
            justify-content: center;
            padding: 40px 16px;
            color: var(--text-3);
            cursor: default;
            text-align: center;
        }

        .log-item.empty:hover,
        .log-item.filter-empty:hover {
            background: transparent;
        }

        .empty-card {
            display: grid;
            justify-items: center;
            gap: 6px;
            max-width: 300px;
            animation: blurIn 0.6s var(--ease-out) both;
        }

        .empty-card svg {
            width: 30px;
            height: 30px;
            margin-bottom: 4px;
            color: var(--text-3);
            animation: float 3.2s ease-in-out infinite;
        }

        .empty-card b {
            color: var(--text);
            font-weight: 600;
        }

        @keyframes float {
            50% { transform: translateY(-4px); }
        }

        .chev {
            position: absolute;
            right: 8px;
            top: 10px;
            width: 16px;
            height: 16px;
            color: var(--text-3);
            opacity: 0;
            transition: opacity 0.2s, transform 0.4s var(--spring);
        }

        .chev svg {
            width: 100%;
            height: 100%;
        }

        .log-item:hover .chev,
        .log-item:focus-visible .chev,
        .log-item.selected .chev {
            opacity: 1;
        }

        .log-item.selected .chev {
            transform: rotate(180deg);
            color: var(--text);
        }

        .nav-divider {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 10px 4px 4px;
            color: var(--text-3);
            font-size: 11px;
            animation: blurIn 0.5s var(--ease-out) both;
        }

        .nav-divider::before,
        .nav-divider::after {
            content: '';
            flex: 1;
            height: 1px;
            background: linear-gradient(90deg, transparent, var(--line-2));
        }

        .nav-divider::after {
            background: linear-gradient(90deg, var(--line-2), transparent);
        }

        .nav-divider span {
            max-width: 75%;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            font-family: var(--mono);
        }

        .nav-divider span::before {
            content: '';
            display: inline-block;
            width: 6px;
            height: 6px;
            margin-right: 6px;
            border-radius: 50%;
            background: var(--info);
            vertical-align: 1px;
        }

        .log-time {
            flex: none;
            min-width: 44px;
            padding-top: 1px;
            font-family: var(--mono);
            font-size: 11.5px;
            color: var(--text-3);
            font-variant-numeric: tabular-nums;
            transition: color 0.2s;
        }

        .log-item.active .log-time {
            color: var(--text);
        }

        .log-content {
            flex: 1;
            min-width: 0;
        }

        .log-meta {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }

        .log-method,
        .log-status {
            display: inline-flex;
            align-items: center;
            gap: 5px;
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
        .method-OPTIONS { background: transparent; color: var(--text-3); box-shadow: inset 0 0 0 1px var(--line-2); }

        .status-success { background: rgba(61, 214, 140, 0.12); color: var(--ok); }
        .status-redirect { background: rgba(112, 184, 255, 0.12); color: var(--info); }
        .status-error { background: var(--accent-soft); color: #ff8589; }
        .status-pending { background: rgba(241, 161, 13, 0.12); color: var(--warn); }

        .status-pending::before {
            content: '';
            width: 5px;
            height: 5px;
            border-radius: 50%;
            background: currentColor;
            animation: blink 1.2s ease-in-out infinite;
        }

        @keyframes blink {
            50% { opacity: 0.25; }
        }

        .log-perf {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            margin-left: auto;
            min-width: 0;
            font-family: var(--mono);
            font-size: 10.5px;
            color: var(--text-3);
            white-space: nowrap;
        }

        .perf-bar {
            flex: none;
            width: 42px;
            height: 4px;
            border-radius: 2px;
            background: var(--panel-2);
            overflow: hidden;
        }

        .perf-bar i {
            display: block;
            height: 100%;
            width: calc(var(--w) * 100%);
            min-width: 2px;
            border-radius: inherit;
            background: var(--ok);
            transform-origin: left;
            animation: growIn 0.9s var(--ease-out) 0.3s both;
        }

        .perf-bar .speed-ok { background: #9bd65f; }
        .perf-bar .speed-slow { background: var(--warn); }
        .perf-bar .speed-crawl { background: var(--accent); }

        @keyframes growIn {
            from { transform: scaleX(0); }
        }

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

        .net-row[data-opt="1"] .log-url {
            color: var(--text-2);
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
            transition: transform 0.4s var(--bounce);
        }

        .log-item:hover .interaction-icon,
        .log-item.active .interaction-icon {
            transform: scale(1.08) rotate(-6deg);
        }

        .interaction-icon svg {
            width: 14px;
            height: 14px;
        }

        .icon-click {
            background: var(--accent-soft);
            color: var(--accent);
        }

        .icon-input,
        .icon-change {
            background: rgba(61, 214, 140, 0.1);
            color: var(--ok);
        }

        .icon-scroll {
            background: rgba(112, 184, 255, 0.1);
            color: var(--info);
        }

        .interaction-details {
            flex: 1;
            min-width: 0;
        }

        .interaction-type {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12.5px;
            font-weight: 600;
            color: var(--text);
        }

        .times {
            padding: 0 5px;
            border-radius: 4px;
            background: var(--panel-2);
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 10.5px;
            font-weight: 500;
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

        /* Expandable details inside a row */
        .row-slot {
            display: grid;
            grid-template-rows: 0fr;
            transition: grid-template-rows 0.42s var(--ease-out);
        }

        .row-slot > * {
            min-height: 0;
            overflow: hidden;
        }

        .log-item.selected .row-slot {
            grid-template-rows: 1fr;
        }

        .row-details {
            cursor: auto;
            opacity: 0;
            filter: blur(3px);
            transform: translateY(-6px);
            transition: opacity 0.3s var(--ease-out), transform 0.42s var(--ease-out), filter 0.3s var(--ease-out);
        }

        .log-item.selected .row-details {
            opacity: 1;
            filter: none;
            transform: none;
        }

        .snap-thumb {
            flex: none;
            width: 72px;
            margin-top: 2px;
            transition: transform 0.4s var(--spring);
        }

        .log-item:hover .snap-thumb {
            transform: scale(1.06) rotate(-1.5deg);
        }

        .snap-path {
            min-width: 0;
            overflow: hidden;
            white-space: nowrap;
            text-overflow: ellipsis;
            color: var(--text-3);
            font-family: var(--mono);
            font-size: 11.5px;
            font-weight: 500;
        }

        .snap-hint {
            margin: 4px 6px 8px;
            padding: 8px 10px;
            border-radius: 8px;
            background: color-mix(in srgb, var(--k-select) 8%, transparent);
            color: var(--text-2);
            font-size: 12px;
        }

        /* "Back to now" floats up when you scroll away while following. */
        .back-now {
            position: absolute;
            left: 50%;
            bottom: 16px;
            z-index: 5;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 32px;
            padding: 0 14px;
            border: 1px solid var(--line-2);
            border-radius: 999px;
            background: rgba(27, 27, 31, 0.9);
            backdrop-filter: blur(10px);
            color: var(--text);
            font-size: 12px;
            font-weight: 550;
            cursor: pointer;
            box-shadow: 0 12px 28px -10px rgba(0, 0, 0, 0.8);
            opacity: 0;
            visibility: hidden;
            transform: translate(-50%, 16px) scale(0.94);
            transition: opacity 0.2s var(--ease-out), transform 0.45s var(--bounce), visibility 0s 0.45s;
        }

        .back-now.show {
            opacity: 1;
            visibility: visible;
            transform: translate(-50%, 0);
            transition: opacity 0.2s var(--ease-out), transform 0.45s var(--bounce), visibility 0s;
        }

        .back-now svg {
            width: 14px;
            height: 14px;
            animation: nudge 1.4s ease-in-out infinite;
        }

        @keyframes nudge {
            50% { transform: translateY(2px); }
        }

        ::-webkit-scrollbar {
            width: 10px;
            height: 10px;
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

        @keyframes fadeIn {
            from { opacity: 0; }
        }

        @keyframes blurIn {
            from { opacity: 0; transform: translateY(6px); filter: blur(5px); }
        }

        @media (max-width: 900px) {
            body { overflow: auto; }
            .app { height: auto; }
            .video-layout { grid-template-columns: minmax(0, 1fr); }
            .data-tabs { overflow-x: auto; scrollbar-width: none; }
            .data-tab { padding-left: 8px; padding-right: 8px; }
            .video-container { aspect-ratio: 16 / 10; flex: none; }
            .data-section { border-left: none; border-top: 1px solid var(--line); height: 80vh; }
            .chips { display: none; }
            .topbar > .copy-btn { margin-left: auto; }
            .shortcuts { display: none; }
            .controls-row { gap: 10px; }
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
                <h1><span style="--i:0">Session</span> <span style="--i:1">replay</span></h1>
                <p>${host ? escapeHtml(host) + ' · ' : ''}Recorded ${escapeHtml(recordedAt)}</p>
            </div>
            <div class="chips">
                <span class="chip" style="--i:0"><b>${formatDuration(duration)}</b> duration</span>
                <span class="chip" style="--i:1"><b data-tick>${escapeHtml(summary.totalNetworkRequests != null ? summary.totalNetworkRequests : networkLogs.length)}</b> requests</span>
                <span class="chip" style="--i:2"><b data-tick>${escapeHtml(summary.totalInteractions != null ? summary.totalInteractions : interactionLogs.length)}</b> interactions</span>
                ${snaps.length ? `<span class="chip" style="--i:3"><b data-tick>${snaps.length}</b> snapshot${snaps.length === 1 ? '' : 's'}</span>` : ''}
                ${data.extensionVersion ? `<span class="chip version" style="--i:4">v${escapeHtml(data.extensionVersion)}</span>` : ''}
            </div>
        </header>

        <main class="video-layout">
            <section class="video-section" aria-label="Recording">
                <div class="video-container" id="videoContainer">
                    ${videoSrc ? `<video id="videoPlayer" src="${escapeHtml(videoSrc)}" playsinline aria-label="Screen recording of the session"></video><div class="click-layer" id="clickLayer"></div><div class="xray-layer" id="xrayLayer" hidden></div>` : `
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
                        <button class="play-btn" id="playBtn" aria-label="Play" data-ripple>
                            <svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="ring-track" cx="22" cy="22" r="21"/><circle class="ring-fill" id="playRing" cx="22" cy="22" r="21" pathLength="100"/></svg>
                            <svg class="ic ic-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15a1 1 0 001.5.86l12.5-7.5a1 1 0 000-1.72L8.5 3.64A1 1 0 007 4.5z"/></svg>
                            <svg class="ic ic-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="14" y="4" width="4.5" height="16" rx="1.2"/></svg>
                        </button>
                        <div class="time-display" id="timeDisplay" aria-hidden="true">00:00 / 00:00</div>
                        <div class="timeline-slider" id="timelineSlider" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
                            <div class="timeline-ghost" id="timelineGhost"></div>
                            <div class="timeline-progress" id="timelineProgress" style="width: 0%">
                                <div class="timeline-handle"></div>
                            </div>
                            <div class="scrub-tip" id="scrubTip" aria-hidden="true"></div>
                        </div>
                        <select class="speed-control" id="speedControl" aria-label="Playback speed">
                            <option value="0.5">0.5×</option>
                            <option value="1" selected>1×</option>
                            <option value="1.5">1.5×</option>
                            <option value="2">2×</option>
                        </select>
                    </div>
                    <p class="shortcuts"><kbd>Space</kbd> play / pause · <kbd>←</kbd> <kbd>→</kbd> 5 s · <kbd>/</kbd> filter · <kbd>F</kbd> follow · click a row to jump to it</p>
                </div>
                ` : ''}
            </section>

            <aside class="data-section" aria-label="Captured events">
                <div class="data-header">
                    <div class="data-tabs" role="tablist" aria-label="Event type">
                        <button class="data-tab active" data-tab="network" role="tab" id="tab-network" aria-controls="networkList" aria-selected="true" data-ripple>Network <span class="tab-count">${networkLogs.length}</span></button>
                        <button class="data-tab" data-tab="interactions" role="tab" id="tab-interactions" aria-controls="interactionsList" aria-selected="false" tabindex="-1" data-ripple>Interactions <span class="tab-count">${interactionLogs.length}</span></button>
                        <button class="data-tab" data-tab="snapshots" role="tab" id="tab-snapshots" aria-controls="snapshotsList" aria-selected="false" tabindex="-1" data-ripple>Snapshots <span class="tab-count">${snaps.length}</span></button>
                        <span class="tab-glider" id="tabGlider" aria-hidden="true"></span>
                    </div>
                </div>

                <div class="panel-tools">
                    <label class="search">
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/></svg>
                        <input id="logSearch" type="search" placeholder="Filter requests by URL, method or status" aria-label="Filter the list" autocomplete="off" spellcheck="false">
                        <kbd aria-hidden="true">/</kbd>
                    </label>
                    ${videoSrc ? `<button class="follow-btn" id="followBtn" type="button" aria-pressed="true" data-ripple title="Keep the current moment in view while the video plays (F)"><span class="follow-dot" aria-hidden="true"></span>Follow</button>` : ''}
                </div>
                <div class="chip-row">
                    ${networkChips(net)}
                    ${interactionChips(ixRows)}
                    <div class="filter-chips" id="chips-snapshots" hidden><p class="chip-hint">${snaps.length ? (videoSrc ? 'Open a snapshot to outline its elements on the video' : 'Open a snapshot to see its elements') : 'Snapshots list what was clickable on screen'}</p></div>
                    <span class="result-count" id="resultCount" aria-live="polite"></span>
                </div>

                <div class="data-content" id="dataContent">
                    <div class="scroll-progress" aria-hidden="true"></div>
                    <ul class="log-list" id="networkList" role="tabpanel" aria-labelledby="tab-network">
                        ${tight(generateNetworkList(networkLogs, net, startTime))}
                    </ul>
                    <ul class="log-list" id="interactionsList" role="tabpanel" aria-labelledby="tab-interactions" style="display: none;">
                        ${tight(generateInteractionsList(ixRows, startTime))}
                    </ul>
                    <ul class="log-list" id="snapshotsList" role="tabpanel" aria-labelledby="tab-snapshots" style="display: none;">
                        ${tight(generateSnapshotsList(snaps, elementSnapshots, startTime, !!videoSrc))}
                    </ul>
                </div>
                ${videoSrc ? `<button class="back-now" id="backNow" type="button"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v9M4.5 8.5L8 12l3.5-3.5"/></svg>Back to now</button>` : ''}
            </aside>
        </main>
    </div>

    <script>
        const kit = (${exportKit})();
        (${replayApp})(${embedJson(cfg)}, kit);
        document.querySelector('.topbar').append(kit.copyButton('Copy repro steps', () => ${embedJson(reproSteps(data))}));
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

    // Row templates are indented for reading; hundreds of rows don't need that whitespace in the file.
    function tight(html) {
        return html.replace(/>\s+</g, '><');
    }

    function emptyRow(icon, title, text) {
        return `<li class="log-item empty"><div class="empty-card"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><b>${title}</b><span>${text}</span></div></li>`;
    }

    function chipGroup(id, label, chips, extra) {
        const buttons = chips.filter(c => c.f === 'all' || c.n > 0).map(c =>
            `<button class="fchip${c.f === 'err' ? ' err' : ''}" type="button" data-f="${c.f}" aria-pressed="${c.f === 'all'}" data-ripple>${c.label} <span>${c.n}</span></button>`).join('');
        return `<div class="filter-chips" id="${id}" role="group" aria-label="${label}"${id === 'chips-network' ? '' : ' hidden'}><span class="chip-glider" aria-hidden="true"></span>${buttons}${extra || ''}</div>`;
    }

    function networkChips(models) {
        const count = test => models.filter(test).length;
        const preflight = models.filter(m => m.method === 'OPTIONS').length;
        return chipGroup('chips-network', 'Request type', [
            { f: 'all', label: 'All', n: models.length },
            { f: 'api', label: 'API', n: count(m => m.kind === 'api') },
            { f: 'doc', label: 'Pages', n: count(m => m.kind === 'doc') },
            { f: 'code', label: 'JS & CSS', n: count(m => m.kind === 'code') },
            { f: 'media', label: 'Media', n: count(m => m.kind === 'media') },
            { f: 'err', label: 'Errors', n: count(m => m.err) },
        ], preflight ? `<button class="fchip toggle" type="button" data-toggle="opt" aria-pressed="false" data-ripple title="Hide CORS preflight (OPTIONS) requests">Hide preflight <span>${preflight}</span></button>` : '');
    }

    function interactionChips(rows) {
        const count = kind => rows.filter(r => interactionKind(r.type) === kind).length;
        return chipGroup('chips-interactions', 'Interaction type', [
            { f: 'all', label: 'All', n: rows.length },
            { f: 'click', label: 'Clicks', n: count('click') },
            { f: 'input', label: 'Typing', n: count('input') },
            { f: 'scroll', label: 'Scrolls', n: count('scroll') },
            { f: 'drag', label: 'Drags', n: count('drag') },
            { f: 'other', label: 'Other', n: count('other') },
        ]);
    }

    function generateNetworkList(logs, models, startTime) {
        if (!logs || logs.length === 0) {
            return emptyRow('<path d="M3 12h4l3-8 4 16 3-8h4"/>', 'No network requests', 'Requests the page makes while recording show up here.');
        }
        const slowest = models.reduce((max, m) => Math.max(max, m.ms || 0), 1);

        return logs.map((log, i) => {
            const m = models[i];
            const relativeTime = ((log.timestamp - startTime) / 1000).toFixed(1);
            const method = escapeHtml(m.method);
            const rawUrl = m.url;
            const host = hostOf(rawUrl);
            const hostEnd = host ? rawUrl.indexOf(host) + host.length : 0;
            const status = m.status;
            const statusClass = typeof status === 'number'
                ? (status < 300 ? 'status-success' : status < 400 ? 'status-redirect' : 'status-error')
                : (status === 'pending' ? 'status-pending' : 'status-error');
            const speed = m.ms == null ? '' : m.ms < 300 ? '' : m.ms < 1000 ? 'speed-ok' : m.ms < 3000 ? 'speed-slow' : 'speed-crawl';
            const perf = [m.msText, m.sizeText].filter(Boolean).join(' · ');

            return `
                <li class="log-item net-row" data-timestamp="${log.timestamp}" data-i="${i}" data-k="${m.kind}" data-err="${m.err ? 1 : 0}" data-opt="${m.method === 'OPTIONS' ? 1 : 0}" tabindex="0" aria-expanded="false">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="log-content">
                        <div class="log-meta">
                            <span class="log-method method-${method}">${method}</span>
                            <span class="log-status ${statusClass}">${escapeHtml(status)}</span>
                            ${perf ? `<span class="log-perf">${m.ms != null ? `<span class="perf-bar"><i class="${speed}" style="--w:${Math.sqrt(m.ms / slowest).toFixed(3)}"></i></span>` : ''}${escapeHtml(perf)}</span>` : ''}
                        </div>
                        <div class="log-url" title="${escapeHtml(rawUrl)}"><span class="url-host">${escapeHtml(rawUrl.slice(0, hostEnd))}</span>${escapeHtml(rawUrl.slice(hostEnd))}</div>
                        <div class="row-slot"></div>
                    </div>
                    ${chevron}
                </li>
            `;
        }).join('') + filterEmpty;
    }

    function generateInteractionsList(rows, startTime) {
        if (!rows || rows.length === 0) {
            return emptyRow('<path d="M4 3l6.5 16 2.3-6.7L19.5 10 4 3z"/>', 'No interactions', 'Clicks, typing and scrolling on the page show up here.');
        }

        const ICONS = {
            click: '<path d="M4 3l6.5 16 2.3-6.7L19.5 10 4 3z"/>',
            scroll: '<path d="M12 3v18M7.5 7.5L12 3l4.5 4.5M7.5 16.5L12 21l4.5-4.5"/>',
            drag: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
            input: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
            change: '<rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="2.5"/>'
        };

        let lastPage = null;
        return rows.map((row, i) => {
            const log = row.log;
            const relativeTime = ((row.start - startTime) / 1000).toFixed(1);
            const type = row.type;
            const icon = ICONS[type] || ICONS.input;
            const element = log.element || null;
            const text = elementLabel(element).slice(0, 60);
            const tag = element && element.tagName ? `<code>${escapeHtml(String(element.tagName).toLowerCase())}</code>` : '';
            const target = [tag, text && escapeHtml(`“${text}”`)].filter(Boolean).join(' ');

            let label = type.charAt(0).toUpperCase() + type.slice(1);
            let position = '';
            if (type === 'click') {
                label = 'Clicked';
                if (log.coordinates) position = `(${log.coordinates.clientX}, ${log.coordinates.clientY})`;
            } else if (type === 'input') {
                label = 'Typed';
                position = `${row.last.valueLength || 0} chars`;
            } else if (type === 'change') {
                label = typeof log.value === 'boolean' ? (log.value ? 'Checked' : 'Unchecked') : 'Changed';
            } else if (type === 'drag') {
                label = 'Dragged';
                if (log.distance) position = `${Math.round(log.distance)} px`;
            } else if (type === 'scroll') {
                const dy = row.from && row.to ? row.to.y - row.from.y : 0;
                label = dy > 0 ? 'Scrolled down' : dy < 0 ? 'Scrolled up' : 'Scrolled';
                if (row.to) position = row.count > 1 && row.from ? `y ${Math.round(row.from.y)} → ${Math.round(row.to.y)}` : `to (${row.to.x}, ${row.to.y})`;
            } else if (log.coordinates) {
                position = `(${log.coordinates.clientX}, ${log.coordinates.clientY})`;
            }
            const details = [type === 'scroll' ? '' : target, position && `<code>${escapeHtml(position)}</code>`].filter(Boolean).join(' · ');

            const page = pageKey(row.url);
            const divider = page && page !== lastPage
                ? `<li class="nav-divider" aria-hidden="true"><span>${escapeHtml(pathOf(row.url))}</span></li>`
                : '';
            if (page) lastPage = page;

            return `${divider}
                <li class="log-item ix-row" data-timestamp="${row.start}" data-end="${row.end}" data-i="${i}" data-k="${interactionKind(type)}" tabindex="0" aria-expanded="false">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="interaction-icon icon-${escapeHtml(type)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></div>
                    <div class="interaction-details">
                        <div class="interaction-type">${escapeHtml(label)}${row.count > 1 ? `<span class="times">×${row.count}</span>` : ''}</div>
                        ${details ? `<div class="interaction-info">${details}</div>` : ''}
                        <div class="row-slot"></div>
                    </div>
                    ${chevron}
                </li>
            `;
        }).join('') + filterEmpty;
    }

    function generateSnapshotsList(models, snapshots, startTime, withVideo) {
        if (!snapshots || snapshots.length === 0) {
            return emptyRow('<path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
                'No snapshots in this recording',
                'A snapshot lists every link, button and field on screen at one moment, with selectors you can copy. Press Capture in the popup while recording to take one.');
        }

        const hint = `<li class="snap-hint" aria-hidden="true">Each snapshot is what someone could click at that moment. ${withVideo ? 'Open one to outline its elements on the video, then hover the list to find them.' : 'Open one to see its layout and copy selectors.'}</li>`;
        return hint + snapshots.map((snapshot, i) => {
            const m = models[i];
            const relativeTime = ((snapshot.timestamp - startTime) / 1000).toFixed(1);
            const chips = Object.keys(KIND_LABELS).filter(k => m.counts[k]).map(k =>
                `<span class="kchip k-${k}"><i></i>${m.counts[k]} ${KIND_LABELS[k].toLowerCase()}</span>`).join('');

            return `
                <li class="log-item snap-row" data-timestamp="${snapshot.timestamp}" data-i="${i}" data-k="snapshot" tabindex="0" aria-expanded="false">
                    <div class="log-time">${relativeTime}s</div>
                    <div class="snap-thumb" data-i="${i}" aria-hidden="true"></div>
                    <div class="log-content">
                        <div class="interaction-type">Snapshot <span class="snap-path">${escapeHtml(pathOf(m.url))}</span></div>
                        <div class="interaction-info">${m.inView} in view · ${m.els.length} captured</div>
                        <div class="kchips">${chips}</div>
                        <div class="row-slot"></div>
                    </div>
                    ${chevron}
                </li>
            `;
        }).join('') + filterEmpty;
    }
}

function clearAllLogs() {
    networkLogs = [];
    consoleErrors = [];
    videoBlob = null;
    chrome.storage.local.remove(['interactionLogs', 'elementSnapshots', 'recordedVideoBlob']);
    videoStoreRequest('readwrite', store => store.delete(NETWORK_LOGS_ID))
        .catch(e => console.warn('[NetworkLogs] Failed to clear saved network logs:', e));
    console.log('All logs cleared');
}

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.get(['armedSession']).then(({ armedSession }) => {
        if (armedSession && armedSession.tabId === tabId) chrome.storage.local.remove('armedSession');
    });
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