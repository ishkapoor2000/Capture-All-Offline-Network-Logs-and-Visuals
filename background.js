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
        }
    } catch (error) {
        console.error('Failed to initialize debugger detachment listener:', error);
    }
}

// Initialize listeners when service worker starts
initializeDebuggerListeners();

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Background received message:', message);

    switch (message.action) {
        case 'startRecording':
            startRecording(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true; // Keep message channel open for async response

        case 'stopRecording':
            stopRecording(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'getStatus':
            sendResponse({ 
                isRecording: isRecording,
                networkLogsCount: networkLogs.length
            });
            break;

        case 'exportLogs':
            exportAllLogs(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'clearLogs':
            clearAllLogs();
            sendResponse({ success: true });
            break;

        case 'captureElements':
            captureElements(message.tabId)
                .then(() => sendResponse({ success: true }))
                .catch(error => sendResponse({ success: false, error: error.message }));
            return true;

        case 'logInteraction':
            // Store interaction data
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
            return true; // Keep message channel open for async response

        default:
            console.warn('Unknown message action:', message.action);
            sendResponse({ success: false, error: 'Unknown action' });
    }
});

async function startRecording(tabId) {
    try {
        console.log('Starting recording for tab:', tabId);
        
        // Attach debugger to tab
        await chrome.debugger.attach({ tabId: tabId }, "1.3");
        console.log('Debugger attached to tab:', tabId);
        
        // Enable network domain
        await chrome.debugger.sendCommand({ tabId: tabId }, "Network.enable");
        console.log('Network domain enabled for tab:', tabId);
        
        // Enable runtime domain for better error handling
        await chrome.debugger.sendCommand({ tabId: tabId }, "Runtime.enable");
        console.log('Runtime domain enabled for tab:', tabId);
        
        attachedTabs.add(tabId);
        isRecording = true;
        networkLogs = []; // Clear previous logs
        
        console.log('Recording started successfully for tab:', tabId);
    } catch (error) {
        console.error('Error starting recording:', error);
        throw error;
    }
}

async function captureElements(tabId) {
    try {
        console.log('Capturing elements for tab:', tabId);
        
        // Send message to content script to capture elements
        await chrome.tabs.sendMessage(tabId, { action: 'captureElements' });
        
        console.log('Element capture initiated for tab:', tabId);
    } catch (error) {
        console.error('Error capturing elements:', error);
        throw error;
    }
}

function onDebuggerEvent(source, method, params) {
    // Only process events from attached tabs
    if (!attachedTabs.has(source.tabId)) {
        return;
    }

    console.log('Debugger event:', method, params);

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
        case 'Runtime.exceptionThrown':
            handleRuntimeException(params, source.tabId);
            break;
    }
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

function handleNetworkResponse(params, tabId) {
    // Find the corresponding request
    const requestIndex = networkLogs.findIndex(log => 
        log.requestId === params.requestId && log.type === 'request'
    );
    
    if (requestIndex !== -1) {
        networkLogs[requestIndex].response = {
            status: params.response.status,
            statusText: params.response.statusText,
            headers: params.response.headers,
            timestamp: Date.now()
        };
        console.log('Network response logged:', params.response.status, networkLogs[requestIndex].url);
    }
}

function handleNetworkLoadingFinished(params, tabId) {
    // Find the corresponding request
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
    // Find the corresponding request
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

function handleRuntimeException(params, tabId) {
    const logEntry = {
        type: 'exception',
        timestamp: Date.now(),
        exception: params.exception,
        tabId: tabId
    };
    
    networkLogs.push(logEntry);
    console.log('Runtime exception logged:', params.exception.description);
}

async function stopRecording(tabId) {
    try {
        console.log('Stopping recording for tab:', tabId);
        
        if (attachedTabs.has(tabId)) {
            await chrome.debugger.detach({ tabId: tabId });
            attachedTabs.delete(tabId);
            console.log('Debugger detached from tab:', tabId);
        }
        
        isRecording = false;
        console.log('Recording stopped successfully for tab:', tabId);
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

        const timestamp = Date.now();
        
        // Export JSON file
        const jsonString = JSON.stringify(exportData, null, 2);
        const jsonDataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonString);
        
        await chrome.downloads.download({
            url: jsonDataUrl,
            filename: `capture_all_logs_${timestamp}.json`,
            saveAs: true
        });

        // Generate and export HTML file
        const htmlContent = generateTimelineHTML(exportData);
        const htmlDataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent);
        
        await chrome.downloads.download({
            url: htmlDataUrl,
            filename: `capture_all_timeline_${timestamp}.html`,
            saveAs: true
        });

        console.log('Export completed successfully - both JSON and HTML files generated');
    } catch (error) {
        console.error('Error exporting logs:', error);
        throw error;
    }
}

function generateTimelineHTML(data) {
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
            background: #f5f5f5;
            color: #333;
            line-height: 1.6;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 2rem;
            text-align: center;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
            font-weight: 300;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.9;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }

        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .summary-card {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
        }

        .summary-card h3 {
            color: #667eea;
            margin-bottom: 0.5rem;
            font-size: 2rem;
        }

        .summary-card p {
            color: #666;
            font-size: 0.9rem;
        }

        .timeline-container {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            margin-bottom: 2rem;
        }

        .timeline-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            flex-wrap: wrap;
            gap: 1rem;
        }

        .timeline-title {
            font-size: 1.5rem;
            color: #333;
        }

        .timeline-controls {
            display: flex;
            gap: 1rem;
            align-items: center;
            flex-wrap: wrap;
        }

        .control-group {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .control-group label {
            font-size: 0.9rem;
            color: #666;
        }

        .control-group select,
        .control-group input {
            padding: 0.5rem;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 0.9rem;
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
            font-size: 0.9rem;
            transition: background 0.2s;
        }

        .playback-btn:hover {
            background: #5a6fd8;
        }

        .playback-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
        }

        .timeline-wrapper {
            overflow-x: auto;
            border: 1px solid #e0e0e0;
            border-radius: 8px;
            background: white;
        }

        .timeline {
            position: relative;
            min-height: 400px;
            min-width: 1200px;
            overflow: hidden;
        }

        .timeline-track {
            position: relative;
            height: 50px;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            align-items: center;
            padding: 0 1rem;
        }

        .timeline-track:last-child {
            border-bottom: none;
        }

        .track-label {
            width: 150px;
            font-weight: 600;
            color: #333;
            font-size: 0.9rem;
            flex-shrink: 0;
        }

        .track-content {
            flex: 1;
            position: relative;
            height: 100%;
            overflow: hidden;
        }

        .timeline-event {
            position: absolute;
            height: 30px;
            border-radius: 4px;
            display: flex;
            align-items: center;
            padding: 0 0.4rem;
            font-size: 0.7rem;
            color: white;
            cursor: pointer;
            transition: all 0.2s;
            min-width: 60px;
            max-width: 200px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.2);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .timeline-event:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            z-index: 5;
        }

        .timeline-event.network {
            background: linear-gradient(135deg, #4CAF50, #45a049);
        }

        .timeline-event.interaction {
            background: linear-gradient(135deg, #2196F3, #1976D2);
        }

        .timeline-event.snapshot {
            background: linear-gradient(135deg, #FF9800, #F57C00);
        }

        .cursor-track {
            position: relative;
            height: 40px;
            border-bottom: 1px solid #e0e0e0;
            display: flex;
            align-items: center;
            padding: 0 1rem;
            background: linear-gradient(90deg, #f8f9fa 0%, #e9ecef 100%);
        }

        .cursor-marker {
            position: absolute;
            width: 3px;
            height: 100%;
            background: #ff4444;
            border-radius: 2px;
            box-shadow: 0 0 10px rgba(255, 68, 68, 0.5);
            transition: left 0.1s ease;
            z-index: 10;
        }

        .cursor-marker::before {
            content: '';
            position: absolute;
            top: -5px;
            left: -3px;
            width: 9px;
            height: 9px;
            background: #ff4444;
            border-radius: 50%;
            box-shadow: 0 0 5px rgba(255, 68, 68, 0.8);
        }

        .cursor-marker::after {
            content: '';
            position: absolute;
            top: 0;
            left: -1px;
            width: 5px;
            height: 100%;
            background: linear-gradient(180deg, rgba(255, 68, 68, 0.8) 0%, rgba(255, 68, 68, 0.2) 100%);
            border-radius: 2px;
        }

        .event-details {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            margin-top: 2rem;
            display: none;
        }

        .event-details.show {
            display: block;
        }

        .event-details h3 {
            color: #333;
            margin-bottom: 1rem;
            font-size: 1.3rem;
        }

        .event-details .detail-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
        }

        .detail-section {
            background: #f8f9fa;
            padding: 1.5rem;
            border-radius: 8px;
        }

        .detail-section h4 {
            color: #667eea;
            margin-bottom: 1rem;
            font-size: 1.1rem;
        }

        .detail-item {
            margin-bottom: 0.8rem;
        }

        .detail-label {
            font-weight: 600;
            color: #555;
            font-size: 0.9rem;
        }

        .detail-value {
            color: #333;
            font-size: 0.9rem;
            word-break: break-all;
        }

        .detail-value pre {
            background: #e9ecef;
            padding: 0.5rem;
            border-radius: 4px;
            font-size: 0.8rem;
            overflow-x: auto;
        }

        .network-status {
            display: inline-block;
            padding: 0.2rem 0.5rem;
            border-radius: 4px;
            font-size: 0.8rem;
            font-weight: 600;
        }

        .status-success {
            background: #d4edda;
            color: #155724;
        }

        .status-error {
            background: #f8d7da;
            color: #721c24;
        }

        .status-pending {
            background: #fff3cd;
            color: #856404;
        }

        .interaction-type {
            display: inline-block;
            padding: 0.2rem 0.5rem;
            border-radius: 4px;
            font-size: 0.8rem;
            font-weight: 600;
            background: #e3f2fd;
            color: #1976d2;
        }

        .coordinates {
            font-family: monospace;
            background: #f1f3f4;
            padding: 0.2rem 0.4rem;
            border-radius: 3px;
            font-size: 0.8rem;
        }

        .element-info {
            background: #fff3e0;
            padding: 1rem;
            border-radius: 6px;
            margin-top: 1rem;
        }

        .element-info h5 {
            color: #f57c00;
            margin-bottom: 0.5rem;
        }

        .element-info pre {
            background: #f5f5f5;
            padding: 0.5rem;
            border-radius: 4px;
            font-size: 0.8rem;
            overflow-x: auto;
        }

        .playback-info {
            background: #e3f2fd;
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            text-align: center;
        }

        .playback-info .current-time {
            font-size: 1.2rem;
            font-weight: 600;
            color: #1976d2;
        }

        .playback-info .total-time {
            color: #666;
            font-size: 0.9rem;
        }

        .current-event-info {
            background: #fff3e0;
            padding: 1rem;
            border-radius: 8px;
            margin-bottom: 1rem;
            border-left: 4px solid #ff9800;
        }

        .current-event-info h4 {
            color: #f57c00;
            margin-bottom: 0.5rem;
            font-size: 1rem;
        }

        .current-event-info .event-summary {
            font-size: 0.9rem;
            color: #666;
        }

        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }

            .header h1 {
                font-size: 2rem;
            }

            .timeline-header {
                flex-direction: column;
                align-items: stretch;
            }

            .timeline-controls {
                justify-content: center;
            }

            .summary-cards {
                grid-template-columns: 1fr;
            }

            .event-details .detail-grid {
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
        <div class="summary-cards">
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
                <h3 id="sessionDuration">0s</h3>
                <p>Session Duration</p>
            </div>
        </div>

        <div class="timeline-container">
            <div class="timeline-header">
                <h2 class="timeline-title">Interactive Timeline</h2>
                <div class="timeline-controls">
                    <div class="control-group">
                        <label for="timeRange">Filter:</label>
                        <select id="timeRange">
                            <option value="all">All Events</option>
                            <option value="network">Network Only</option>
                            <option value="interaction">Interactions Only</option>
                            <option value="snapshot">Snapshots Only</option>
                        </select>
                    </div>
                    <div class="control-group">
                        <label for="playbackSpeed">Speed:</label>
                        <select id="playbackSpeed">
                            <option value="0.5">0.5x</option>
                            <option value="1" selected>1x</option>
                            <option value="2">2x</option>
                            <option value="5">5x</option>
                            <option value="10">10x</option>
                        </select>
                    </div>
                    <div class="playback-controls">
                        <button id="playBtn" class="playback-btn">▶️ Play</button>
                        <button id="pauseBtn" class="playback-btn" disabled>⏸️ Pause</button>
                        <button id="resetBtn" class="playback-btn">🔄 Reset</button>
                    </div>
                </div>
            </div>
            
            <div class="playback-info">
                <div class="current-time" id="currentTime">00:00</div>
                <div class="total-time" id="totalTime">Total: 00:00</div>
            </div>

            <div class="current-event-info" id="currentEventInfo" style="display: none;">
                <h4>Current Event</h4>
                <div class="event-summary" id="currentEventSummary"></div>
            </div>
            
            <div class="timeline-wrapper">
                <div id="timeline" class="timeline">
                    <!-- Timeline content will be generated here -->
                </div>
            </div>
        </div>

        <div id="eventDetails" class="event-details">
            <!-- Event details will be shown here -->
        </div>
    </div>

    <script>
        // Embedded data from Capture All
        const captureData = ${JSON.stringify(data, null, 2)};
        
        class TimelineVisualizer {
            constructor() {
                this.events = [];
                this.currentTime = 0;
                this.isPlaying = false;
                this.playbackSpeed = 1;
                this.startTime = 0;
                this.endTime = 0;
                this.animationId = null;
                this.filteredEvents = [];
                this.currentEvent = null;
                
                this.processData();
                this.initializeEventListeners();
                this.renderTimeline();
                this.updateSessionDuration();
            }

            processData() {
                this.events = [];
                
                // Process network logs
                if (captureData.networkLogs) {
                    captureData.networkLogs.forEach(log => {
                        this.events.push({
                            type: 'network',
                            timestamp: log.timestamp,
                            data: log,
                            displayName: \`\${log.method} \${this.getUrlPath(log.url)}\`,
                            status: log.response ? log.response.status : 'pending'
                        });
                    });
                }

                // Process interaction logs
                if (captureData.interactionLogs) {
                    captureData.interactionLogs.forEach(log => {
                        this.events.push({
                            type: 'interaction',
                            timestamp: log.timestamp,
                            data: log,
                            displayName: this.getInteractionDisplayName(log),
                            interactionType: log.type
                        });
                    });
                }

                // Process element snapshots
                if (captureData.elementSnapshots) {
                    captureData.elementSnapshots.forEach(snapshot => {
                        this.events.push({
                            type: 'snapshot',
                            timestamp: snapshot.timestamp,
                            data: snapshot,
                            displayName: \`Element Snapshot (\${snapshot.elements.length} elements)\`,
                            elementCount: snapshot.elements.length
                        });
                    });
                }

                // Sort events by timestamp
                this.events.sort((a, b) => a.timestamp - b.timestamp);

                // Set time range
                if (this.events.length > 0) {
                    this.startTime = this.events[0].timestamp;
                    this.endTime = this.events[this.events.length - 1].timestamp;
                }
                
                this.filteredEvents = [...this.events];
            }

            getUrlPath(url) {
                try {
                    const urlObj = new URL(url);
                    return urlObj.pathname + urlObj.search;
                } catch {
                    return url;
                }
            }

            getInteractionDisplayName(log) {
                switch (log.type) {
                    case 'click':
                        if (log.clientX !== undefined && log.clientY !== undefined) {
                            return \`Click (\${log.clientX}, \${log.clientY})\`;
                        } else if (log.pageX !== undefined && log.pageY !== undefined) {
                            return \`Click (\${log.pageX}, \${log.pageY})\`;
                        } else {
                            return 'Click';
                        }
                    case 'scroll':
                        if (log.scrollX !== undefined && log.scrollY !== undefined) {
                            return \`Scroll (\${log.scrollX}, \${log.scrollY})\`;
                        } else {
                            return 'Scroll';
                        }
                    case 'drag':
                        return \`Drag \${log.distance || 0}px\`;
                    case 'input':
                        return \`Input: \${log.value ? log.value.substring(0, 15) + '...' : 'empty'}\`;
                    case 'keydown':
                        return \`Key: \${log.key || 'Unknown'}\`;
                    case 'mousemove':
                        return 'Mouse Move';
                    default:
                        return log.type || 'Unknown';
                }
            }

            updateSessionDuration() {
                const duration = this.endTime - this.startTime;
                document.getElementById('sessionDuration').textContent = this.formatDuration(duration);
                document.getElementById('totalTime').textContent = \`Total: \${this.formatTime(this.endTime - this.startTime)}\`;
            }

            formatDuration(ms) {
                if (ms < 1000) return \`\${ms}ms\`;
                if (ms < 60000) return \`\${(ms / 1000).toFixed(1)}s\`;
                return \`\${(ms / 60000).toFixed(1)}m\`;
            }

            formatTime(ms) {
                const seconds = Math.floor(ms / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return \`\${minutes.toString().padStart(2, '0')}:\${remainingSeconds.toString().padStart(2, '0')}\`;
            }

            initializeEventListeners() {
                document.getElementById('timeRange').addEventListener('change', (e) => {
                    this.filterEvents(e.target.value);
                });

                document.getElementById('playbackSpeed').addEventListener('change', (e) => {
                    this.playbackSpeed = parseFloat(e.target.value);
                });

                document.getElementById('playBtn').addEventListener('click', () => {
                    this.startPlayback();
                });

                document.getElementById('pauseBtn').addEventListener('click', () => {
                    this.pausePlayback();
                });

                document.getElementById('resetBtn').addEventListener('click', () => {
                    this.resetPlayback();
                });
            }

            renderTimeline() {
                const timeline = document.getElementById('timeline');
                timeline.innerHTML = '';

                // Create cursor track
                const cursorTrack = document.createElement('div');
                cursorTrack.className = 'cursor-track';
                cursorTrack.innerHTML = \`
                    <div class="track-label">Playback Cursor</div>
                    <div class="track-content">
                        <div class="cursor-marker" id="cursorMarker"></div>
                    </div>
                \`;
                timeline.appendChild(cursorTrack);

                // Create event tracks
                const tracks = [
                    { type: 'network', label: 'Network Requests', events: this.filteredEvents.filter(e => e.type === 'network') },
                    { type: 'interaction', label: 'User Interactions', events: this.filteredEvents.filter(e => e.type === 'interaction') },
                    { type: 'snapshot', label: 'Element Snapshots', events: this.filteredEvents.filter(e => e.type === 'snapshot') }
                ];

                tracks.forEach(track => {
                    if (track.events.length === 0) return;

                    const trackElement = document.createElement('div');
                    trackElement.className = 'timeline-track';
                    
                    const label = document.createElement('div');
                    label.className = 'track-label';
                    label.textContent = track.label;
                    
                    const content = document.createElement('div');
                    content.className = 'track-content';
                    
                    track.events.forEach(event => {
                        const eventElement = this.createEventElement(event);
                        content.appendChild(eventElement);
                    });
                    
                    trackElement.appendChild(label);
                    trackElement.appendChild(content);
                    timeline.appendChild(trackElement);
                });
            }

            createEventElement(event) {
                const element = document.createElement('div');
                element.className = \`timeline-event \${event.type}\`;
                
                // Calculate position based on timestamp
                const relativeTime = event.timestamp - this.startTime;
                const position = (relativeTime / (this.endTime - this.startTime)) * 100;
                
                element.style.left = \`\${position}%\`;
                element.textContent = event.displayName;
                element.title = event.displayName; // Tooltip for full text
                
                // Add click handler
                element.addEventListener('click', () => {
                    this.showEventDetails(event);
                });
                
                return element;
            }

            filterEvents(filter) {
                if (filter === 'all') {
                    this.filteredEvents = [...this.events];
                } else {
                    this.filteredEvents = this.events.filter(e => e.type === filter);
                }
                this.renderTimeline();
            }

            startPlayback() {
                if (this.isPlaying) return;
                
                this.isPlaying = true;
                document.getElementById('playBtn').disabled = true;
                document.getElementById('pauseBtn').disabled = false;
                
                this.animate();
            }

            pausePlayback() {
                this.isPlaying = false;
                document.getElementById('playBtn').disabled = false;
                document.getElementById('pauseBtn').disabled = true;
                
                if (this.animationId) {
                    cancelAnimationFrame(this.animationId);
                }
            }

            resetPlayback() {
                this.pausePlayback();
                this.currentTime = 0;
                this.updateCursor();
                this.updateCurrentTime();
                this.updateCurrentEvent();
            }

            animate() {
                if (!this.isPlaying) return;
                
                const now = Date.now();
                const deltaTime = now - (this.lastFrameTime || now);
                this.lastFrameTime = now;
                
                this.currentTime += deltaTime * this.playbackSpeed;
                
                if (this.currentTime >= (this.endTime - this.startTime)) {
                    this.currentTime = this.endTime - this.startTime;
                    this.pausePlayback();
                }
                
                this.updateCursor();
                this.updateCurrentTime();
                this.updateCurrentEvent();
                
                this.animationId = requestAnimationFrame(() => this.animate());
            }

            updateCursor() {
                const cursor = document.getElementById('cursorMarker');
                if (!cursor) return;
                
                const position = (this.currentTime / (this.endTime - this.startTime)) * 100;
                cursor.style.left = \`\${position}%\`;
            }

            updateCurrentTime() {
                document.getElementById('currentTime').textContent = this.formatTime(this.currentTime);
            }

            updateCurrentEvent() {
                const currentTimestamp = this.startTime + this.currentTime;
                const currentEvent = this.events.find(event => 
                    event.timestamp <= currentTimestamp && 
                    (this.events[this.events.indexOf(event) + 1]?.timestamp > currentTimestamp || 
                     this.events.indexOf(event) === this.events.length - 1)
                );

                if (currentEvent && currentEvent !== this.currentEvent) {
                    this.currentEvent = currentEvent;
                    this.showCurrentEventInfo(currentEvent);
                }
            }

            showCurrentEventInfo(event) {
                const currentEventInfo = document.getElementById('currentEventInfo');
                const currentEventSummary = document.getElementById('currentEventSummary');
                
                if (event) {
                    currentEventInfo.style.display = 'block';
                    currentEventSummary.innerHTML = \`
                        <strong>\${event.type.charAt(0).toUpperCase() + event.type.slice(1)}:</strong> 
                        \${event.displayName} 
                        <span style="color: #999; font-size: 0.8rem;">(\${this.formatDuration(event.timestamp - this.startTime)})</span>
                    \`;
                } else {
                    currentEventInfo.style.display = 'none';
                }
            }

            showEventDetails(event) {
                const detailsContainer = document.getElementById('eventDetails');
                detailsContainer.innerHTML = '';
                detailsContainer.className = 'event-details show';
                
                const title = document.createElement('h3');
                title.textContent = \`\${event.type.charAt(0).toUpperCase() + event.type.slice(1)} Event Details\`;
                detailsContainer.appendChild(title);
                
                const grid = document.createElement('div');
                grid.className = 'detail-grid';
                
                // Common details
                const commonSection = this.createDetailSection('Event Information', {
                    'Timestamp': new Date(event.timestamp).toLocaleString(),
                    'Type': event.type,
                    'Relative Time': this.formatDuration(event.timestamp - this.startTime)
                });
                grid.appendChild(commonSection);
                
                // Type-specific details
                if (event.type === 'network') {
                    const networkSection = this.createNetworkDetails(event.data);
                    grid.appendChild(networkSection);
                } else if (event.type === 'interaction') {
                    const interactionSection = this.createInteractionDetails(event.data);
                    grid.appendChild(interactionSection);
                } else if (event.type === 'snapshot') {
                    const snapshotSection = this.createSnapshotDetails(event.data);
                    grid.appendChild(snapshotSection);
                }
                
                detailsContainer.appendChild(grid);
                
                // Scroll to details
                detailsContainer.scrollIntoView({ behavior: 'smooth' });
            }

            createDetailSection(title, details) {
                const section = document.createElement('div');
                section.className = 'detail-section';
                
                const heading = document.createElement('h4');
                heading.textContent = title;
                section.appendChild(heading);
                
                Object.entries(details).forEach(([label, value]) => {
                    const item = document.createElement('div');
                    item.className = 'detail-item';
                    
                    const labelEl = document.createElement('div');
                    labelEl.className = 'detail-label';
                    labelEl.textContent = label;
                    
                    const valueEl = document.createElement('div');
                    valueEl.className = 'detail-value';
                    
                    if (typeof value === 'object') {
                        const pre = document.createElement('pre');
                        pre.textContent = JSON.stringify(value, null, 2);
                        valueEl.appendChild(pre);
                    } else {
                        valueEl.textContent = value;
                    }
                    
                    item.appendChild(labelEl);
                    item.appendChild(valueEl);
                    section.appendChild(item);
                });
                
                return section;
            }

            createNetworkDetails(networkLog) {
                const details = {
                    'URL': networkLog.url,
                    'Method': networkLog.method,
                    'Request ID': networkLog.requestId
                };
                
                if (networkLog.response) {
                    details['Status'] = networkLog.response.status;
                    details['Status Text'] = networkLog.response.statusText;
                    details['Response Time'] = this.formatDuration(networkLog.response.timestamp - networkLog.timestamp);
                }
                
                if (networkLog.headers) {
                    details['Headers'] = networkLog.headers;
                }
                
                if (networkLog.postData) {
                    details['Request Body'] = networkLog.postData;
                }
                
                return this.createDetailSection('Network Request', details);
            }

            createInteractionDetails(interactionLog) {
                const details = {
                    'Type': interactionLog.type,
                    'Timestamp': new Date(interactionLog.timestamp).toLocaleString()
                };
                
                if (interactionLog.clientX !== undefined) {
                    details['Client Coordinates'] = \`(\${interactionLog.clientX}, \${interactionLog.clientY})\`;
                }
                
                if (interactionLog.pageX !== undefined) {
                    details['Page Coordinates'] = \`(\${interactionLog.pageX}, \${interactionLog.pageY})\`;
                }
                
                if (interactionLog.screenX !== undefined) {
                    details['Screen Coordinates'] = \`(\${interactionLog.screenX}, \${interactionLog.screenY})\`;
                }
                
                if (interactionLog.scrollX !== undefined) {
                    details['Scroll Position'] = \`(\${interactionLog.scrollX}, \${interactionLog.scrollY})\`;
                }
                
                if (interactionLog.distance !== undefined) {
                    details['Drag Distance'] = \`\${interactionLog.distance}px\`;
                }
                
                if (interactionLog.value !== undefined) {
                    details['Input Value'] = interactionLog.value;
                }
                
                if (interactionLog.element) {
                    details['Element'] = interactionLog.element;
                }
                
                return this.createDetailSection('User Interaction', details);
            }

            createSnapshotDetails(snapshot) {
                const details = {
                    'URL': snapshot.url,
                    'Element Count': snapshot.elements.length,
                    'Viewport': \`\${snapshot.viewport.width}x\${snapshot.viewport.height}\`,
                    'Scroll Position': \`(\${snapshot.viewport.scrollX}, \${snapshot.viewport.scrollY})\`
                };
                
                const section = this.createDetailSection('Element Snapshot', details);
                
                // Add element details
                if (snapshot.elements.length > 0) {
                    const elementInfo = document.createElement('div');
                    elementInfo.className = 'element-info';
                    
                    const heading = document.createElement('h5');
                    heading.textContent = 'Captured Elements';
                    elementInfo.appendChild(heading);
                    
                    const elementList = document.createElement('div');
                    snapshot.elements.slice(0, 10).forEach((element, index) => {
                        const elementDiv = document.createElement('div');
                        elementDiv.style.marginBottom = '0.5rem';
                        elementDiv.innerHTML = \`
                            <strong>\${index + 1}.</strong> 
                            <span class="coordinates">\${element.tagName}</span>
                            \${element.text ? \` - "\${element.text.substring(0, 50)}\${element.text.length > 50 ? '...' : ''}"\` : ''}
                            \${element.id ? \` (ID: \${element.id})\` : ''}
                        \`;
                        elementList.appendChild(elementDiv);
                    });
                    
                    if (snapshot.elements.length > 10) {
                        const moreDiv = document.createElement('div');
                        moreDiv.textContent = \`... and \${snapshot.elements.length - 10} more elements\`;
                        moreDiv.style.fontStyle = 'italic';
                        moreDiv.style.color = '#666';
                        elementList.appendChild(moreDiv);
                    }
                    
                    elementInfo.appendChild(elementList);
                    section.appendChild(elementInfo);
                }
                
                return section;
            }
        }

        // Initialize the visualizer when the page loads
        document.addEventListener('DOMContentLoaded', () => {
            new TimelineVisualizer();
        });
    </script>
</body>
</html>`;
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