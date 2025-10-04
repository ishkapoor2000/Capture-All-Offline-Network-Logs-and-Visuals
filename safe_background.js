// Background service worker for network logging and debugger attachment

let isRecording = false;
let networkLogs = [];
let attachedTabs = new Set();
let debuggerListenerAdded = false;

// Initialize debugger event listeners when extension loads
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

    // Handle debugger detachment
    try {
        if (typeof chrome !== 'undefined' && chrome.debugger && chrome.debugger.onDetach) {
            chrome.debugger.onDetach.addListener((source, reason) => {
                console.log('Debugger detached:', reason);
                if (attachedTabs.has(source.tabId)) {
                    attachedTabs.delete(source.tabId);
                    isRecording = false;
                }
            });
            console.log('Debugger detach listener initialized');
        }
    } catch (error) {
        console.error('Failed to initialize debugger detach listener:', error);
    }
}

// Initialize on service worker startup
initializeDebuggerListeners();

// Listen for messages from popup and content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
        try {
            if (request.action === 'startRecording') {
                await startRecording(request.tabId);
                sendResponse({ success: true });
            } else if (request.action === 'stopRecording') {
                await stopRecording(request.tabId);
                sendResponse({ success: true });
            } else if (request.action === 'getStatus') {
                sendResponse({ isRecording, logsCount: networkLogs.length });
            } else if (request.action === 'exportLogs') {
                await exportAllLogs(request.tabId);
                sendResponse({ success: true });
            } else if (request.action === 'clearLogs') {
                clearAllLogs();
                sendResponse({ success: true });
            } else if (request.action === 'logInteraction') {
                // Store interaction data
                try {
                    const result = await chrome.storage.local.get(['interactionLogs']);
                    const logs = result.interactionLogs || [];
                    logs.push({
                        ...request.data,
                        timestamp: Date.now()
                    });
                    await chrome.storage.local.set({ interactionLogs: logs });
                    sendResponse({ success: true });
                } catch (error) {
                    console.error('Error storing interaction:', error);
                    sendResponse({ success: false, error: error.message });
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
            sendResponse({ success: false, error: error.message });
        }
    })();

    return true; // Keep the message channel open for async response
});

async function startRecording(tabId) {
    isRecording = true;
    networkLogs = [];

    try {
        // Check if debugger API is available
        if (!chrome.debugger) {
            throw new Error('Debugger API not available');
        }

        // First, try to detach if already attached (cleanup)
        try {
            await chrome.debugger.detach({ tabId });
            await new Promise(resolve => setTimeout(resolve, 100));
        } catch (e) {
            // Ignore if not attached
        }

        // Attach debugger to the tab
        await chrome.debugger.attach({ tabId }, '1.3');
        attachedTabs.add(tabId);

        // Enable Network domain
        await chrome.debugger.sendCommand({ tabId }, 'Network.enable');

        console.log('Recording started for tab:', tabId);
    } catch (error) {
        console.error('Error starting recording:', error);
        isRecording = false;

        // Clean up
        if (attachedTabs.has(tabId)) {
            try {
                await chrome.debugger.detach({ tabId });
            } catch (e) {
                // Ignore
            }
            attachedTabs.delete(tabId);
        }

        throw error;
    }
}

function onDebuggerEvent(source, method, params) {
    if (!isRecording) return;

    try {
        // Capture network requests
        if (method === 'Network.requestWillBeSent') {
            networkLogs.push({
                type: 'request',
                timestamp: Date.now(),
                requestId: params.requestId,
                url: params.request.url,
                method: params.request.method,
                headers: params.request.headers,
                postData: params.request.postData,
                initiator: params.initiator
            });
        } else if (method === 'Network.responseReceived') {
            networkLogs.push({
                type: 'response',
                timestamp: Date.now(),
                requestId: params.requestId,
                url: params.response.url,
                status: params.response.status,
                statusText: params.response.statusText,
                headers: params.response.headers,
                mimeType: params.response.mimeType
            });
        } else if (method === 'Network.loadingFailed') {
            networkLogs.push({
                type: 'failed',
                timestamp: Date.now(),
                requestId: params.requestId,
                errorText: params.errorText,
                canceled: params.canceled
            });
        }
    } catch (error) {
        console.error('Error in debugger event handler:', error);
    }
}

async function stopRecording(tabId) {
    isRecording = false;

    try {
        if (attachedTabs.has(tabId)) {
            await chrome.debugger.detach({ tabId });
            attachedTabs.delete(tabId);
        }
        console.log('Recording stopped for tab:', tabId);
    } catch (error) {
        console.warn('Error stopping recording:', error);
        attachedTabs.delete(tabId);
    }
}

async function exportAllLogs(tabId) {
    try {
        // Get interaction logs from storage
        const result = await chrome.storage.local.get(['interactionLogs', 'elementSnapshots']);
        const interactionLogs = result.interactionLogs || [];
        const elementSnapshots = result.elementSnapshots || [];

        const exportData = {
            exportDate: new Date().toISOString(),
            tabId: tabId,
            networkLogs: networkLogs,
            interactionLogs: interactionLogs,
            elementSnapshots: elementSnapshots,
            summary: {
                totalNetworkRequests: networkLogs.length,
                totalInteractions: interactionLogs.length,
                totalElementSnapshots: elementSnapshots.length
            }
        };

        // Convert to JSON string
        const jsonString = JSON.stringify(exportData, null, 2);

        // Create data URL (service worker compatible)
        const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonString);

        // Download the file
        await chrome.downloads.download({
            url: dataUrl,
            filename: `capture_all_logs_${Date.now()}.json`,
            saveAs: true
        });

        console.log('Export completed successfully');
    } catch (error) {
        console.error('Error exporting logs:', error);
        throw error;
    }
}

function clearAllLogs() {
    networkLogs = [];
    chrome.storage.local.remove(['interactionLogs', 'elementSnapshots']);
    console.log('All logs cleared');
}

// Clean up on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
    if (attachedTabs.has(tabId)) {
        stopRecording(tabId).catch(err => console.error('Error cleaning up tab:', err));
    }
});

// Service worker lifecycle logging
self.addEventListener('install', (event) => {
    console.log('Service worker installed');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service worker activated');
    event.waitUntil(clients.claim());
});

console.log('Background service worker loaded');