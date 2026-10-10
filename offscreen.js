// Offscreen document script for video recording
// This file runs in an offscreen document because service workers can't use MediaRecorder
// The offscreen document receives messages from background.js to start/stop recording
// It captures the tab's video stream and converts it to a blob for storage

// Global state for MediaRecorder
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null; // Keep reference to stream for cleanup
let keepAliveInterval = null; // Pings the service worker so it isn't torn down mid-recording
let lastStoreOk = false; // Whether the last recording was written to IndexedDB

// Must match the IndexedDB helpers in background.js - both run on the extension origin and
// share the database, so the blob is stored here instead of being base64'd over messaging
// (which hits the 64MB message cap on longer recordings).
const VIDEO_DB_NAME = 'CaptureAllVideoDB';
const VIDEO_DB_VERSION = 1;
const VIDEO_STORE_NAME = 'videos';

function openVideoDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(VIDEO_DB_NAME, VIDEO_DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(VIDEO_STORE_NAME)) {
                db.createObjectStore(VIDEO_STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

async function videoStoreRequest(mode, op) {
    const db = await openVideoDatabase();
    return new Promise((resolve, reject) => {
        const request = op(db.transaction([VIDEO_STORE_NAME], mode).objectStore(VIDEO_STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function putVideo(blob) {
    return videoStoreRequest('readwrite', store => store.put({
        id: 'current-video',
        blob,
        timestamp: Date.now(),
        size: blob.size,
        type: blob.type || 'video/webm'
    }));
}

/**
 * Builds the export zip listed in an IndexedDB record and returns a blob: URL for the background
 * to download (service workers can't create blob URLs).
 * @param {{exportId: string}} payload
 */
async function makeDownloadUrl({ exportId }) {
    const record = await videoStoreRequest('readonly', store => store.get(exportId));
    if (!record || !Array.isArray(record.files)) throw new Error('Export not found in IndexedDB');

    const entries = [];
    for (const file of record.files) {
        let blob = file.blob;
        if (file.videoId) {
            const video = await videoStoreRequest('readonly', store => store.get(file.videoId));
            if (!video || !video.blob) throw new Error('Video not found in IndexedDB');
            blob = video.blob;
        }
        entries.push({ name: file.name, blob });
    }

    const zip = await buildZip(entries);
    await videoStoreRequest('readwrite', store => store.delete(exportId));
    return URL.createObjectURL(zip);
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Writes a standard zip. Text files are deflated with the platform's CompressionStream; the
 * video is already compressed, so it is stored as-is.
 * shortcut: no ZIP64, so each file and the whole zip must stay under 4GB; add ZIP64 records if recordings get that big.
 * @param {{name: string, blob: Blob}[]} entries
 * @returns {Promise<Blob>}
 */
async function buildZip(entries) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, blob } of entries) {
        const raw = new Uint8Array(await blob.arrayBuffer());
        const deflate = !blob.type.startsWith('video/');
        const data = deflate
            ? new Uint8Array(await new Response(blob.stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
            : null;
        const nameBytes = new TextEncoder().encode(name);
        const crc = crc32(raw);
        const compressedSize = deflate ? data.length : raw.length;

        // Fields shared by the local and central headers, starting at the "flags" field.
        const writeCommon = (view, at) => {
            view.setUint16(at, 0x0800, true); // UTF-8 file names
            view.setUint16(at + 2, deflate ? 8 : 0, true);
            view.setUint16(at + 4, dosTime, true);
            view.setUint16(at + 6, dosDate, true);
            view.setUint32(at + 8, crc, true);
            view.setUint32(at + 12, compressedSize, true);
            view.setUint32(at + 16, raw.length, true);
            view.setUint16(at + 20, nameBytes.length, true);
        };

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        writeCommon(local, 6);
        parts.push(local, nameBytes, deflate ? data : blob);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true);
        central.setUint16(6, 20, true);
        writeCommon(central, 8);
        central.setUint32(42, offset, true);
        centralParts.push(central, nameBytes);

        offset += 30 + nameBytes.length + compressedSize;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...centralParts, end], { type: 'application/zip' });
}

/**
 * Pings the background service worker periodically. MV3 service workers are torn down after
 * ~30s of inactivity; while a recording is running that would drop the recording state (the
 * popup would show "Ready" and disable Stop) and stop network logging. Receiving a message
 * resets the worker's idle timer, keeping it alive for the duration of the recording.
 */
function startKeepAlive() {
    stopKeepAlive();
    keepAliveInterval = setInterval(() => {
        chrome.runtime.sendMessage({ type: 'keepalive', target: 'background' }).catch(() => {
            // Background may be momentarily unavailable; the next tick will retry.
        });
    }, 20000); // Well under the ~30s idle timeout
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

/**
 * Message handler for communication with background script
 * Handles two message types:
 * - start-recording: Begins video capture with provided stream ID
 * - stop-recording: Stops recording and processes the video
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only process messages targeted at offscreen document
    if (message.target !== 'offscreen') return;

    if (message.type === 'start-recording') {
        console.log('[Offscreen] Received start-recording message');
        startRecording(message.data.streamId)
            .then(() => {
                console.log('[Offscreen] Recording started successfully');
                sendResponse({ success: true });
            })
            .catch(error => {
                console.error('[Offscreen] Failed to start recording:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Keep channel open for async response
    } else if (message.type === 'stop-recording') {
        console.log('[Offscreen] Received stop-recording message');
        stopRecording()
            .then(() => {
                console.log('[Offscreen] Recording stopped successfully, stored:', lastStoreOk);
                sendResponse({ success: true, stored: lastStoreOk });
            })
            .catch(error => {
                console.error('[Offscreen] Failed to stop recording:', error);
                sendResponse({ success: false, stored: false, error: error.message });
            });
        return true; // Keep channel open for async response
    } else if (message.type === 'make-download-url') {
        makeDownloadUrl(message.data)
            .then(url => sendResponse({ success: true, url }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    } else if (message.type === 'revoke-url') {
        URL.revokeObjectURL(message.data.url);
        sendResponse({ success: true });
    }
});

/**
 * Starts video recording using the provided stream ID
 * This function:
 * 1. Gets media stream from Chrome's tabCapture API using the stream ID
 * 2. Configures MediaRecorder with appropriate codec
 * 3. Sets up event handlers for data chunks and completion
 * 4. Starts recording in 1-second chunks
 * 
 * @param {string} streamId - The media stream ID from tabCapture.getMediaStreamId()
 * @returns {Promise<void>}
 */
async function startRecording(streamId) {
    try {
        console.log('[Offscreen] Starting recording with stream ID:', streamId);
        
        // Clean up any existing recording first
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            console.log('[Offscreen] Stopping existing recording...');
            try {
                mediaRecorder.stop();
            } catch (e) {
                console.warn('[Offscreen] Error stopping existing recorder:', e);
            }
        }
        
        if (mediaStream) {
            console.log('[Offscreen] Stopping existing stream...');
            mediaStream.getTracks().forEach(track => {
                track.stop();
                console.log('[Offscreen] Stopped track:', track.kind);
            });
            mediaStream = null;
        }
        
        // Reset chunks
        recordedChunks = [];
        lastStoreOk = false;
        
        // Validate stream ID
        if (!streamId) {
            throw new Error('Stream ID is required for recording');
        }
        
        // Get media stream from Chrome's tabCapture API
        // IMPORTANT: For Chrome tab capture, the chromeMediaSource/chromeMediaSourceId
        // constraints are only recognized inside a legacy `mandatory` block. Placing them
        // as plain members of `video` makes getUserMedia ignore them (OverconstrainedError),
        // so recording never starts.
        console.log('[Offscreen] Requesting media stream from getUserMedia...');

        // Use the mandatory-constraint format required for Chrome tab capture
        const mediaConstraints = {
            audio: false, // Tab capture audio requires additional setup
            video: {
                mandatory: {
                    chromeMediaSource: 'tab',
                    chromeMediaSourceId: streamId
                }
            }
        };

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
            console.log('[Offscreen] Media stream obtained successfully');
            
            // Validate stream
            if (!mediaStream) {
                throw new Error('Media stream is null');
            }
            
            const videoTracks = mediaStream.getVideoTracks();
            const audioTracks = mediaStream.getAudioTracks();
            
            console.log('[Offscreen] Video tracks:', videoTracks.length);
            console.log('[Offscreen] Audio tracks:', audioTracks.length);
            
            // Check track states
            videoTracks.forEach((track, index) => {
                console.log(`[Offscreen] Video track ${index}:`, {
                    enabled: track.enabled,
                    readyState: track.readyState,
                    muted: track.muted,
                    label: track.label
                });
            });
            
            // Validate that we have at least one video track
            if (videoTracks.length === 0) {
                throw new Error('No video tracks available in media stream');
            }
            
            // Check if tracks are ready
            const activeTracks = videoTracks.filter(track => track.readyState === 'live');
            if (activeTracks.length === 0) {
                console.warn('[Offscreen] No active video tracks, waiting...');
                // Wait a bit for tracks to become active
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Check again
                const stillActive = mediaStream.getVideoTracks().filter(track => track.readyState === 'live');
                if (stillActive.length === 0) {
                    throw new Error('Video tracks never became active');
                }
            }
            
        } catch (getUserMediaError) {
            console.error('[Offscreen] getUserMedia failed:', getUserMediaError);
            console.error('[Offscreen] Error details:', {
                name: getUserMediaError.name,
                message: getUserMediaError.message,
                constraint: getUserMediaError.constraint
            });
            
            // Provide more helpful error message
            let errorMessage = `Failed to get media stream: ${getUserMediaError.message}`;
            if (getUserMediaError.name === 'NotAllowedError') {
                errorMessage = 'Permission denied for media stream. Check extension permissions.';
            } else if (getUserMediaError.name === 'NotFoundError') {
                errorMessage = 'Media stream not found. The tab may have been closed or the stream ID is invalid.';
            } else if (getUserMediaError.name === 'NotReadableError' || getUserMediaError.message.includes('Invalid state')) {
                errorMessage = 'Stream is already in use or invalid. Try refreshing the page.';
            }
            
            throw new Error(errorMessage);
        }

        // Detect and use the best available codec
        // Try VP9 first (best quality), then VP8, then fallback to default
        let recorderOptions = null;
        const codecOptions = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];

        for (const codec of codecOptions) {
            if (MediaRecorder.isTypeSupported(codec)) {
                recorderOptions = { mimeType: codec };
                console.log('[Offscreen] Using codec:', codec);
                break;
            }
        }

        // Fallback to browser default if no codec is explicitly supported
        if (!recorderOptions) {
            recorderOptions = {}; // Browser will choose default
            console.log('[Offscreen] Using browser default codec');
        }

        // Create MediaRecorder instance
        try {
            mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);
            console.log('[Offscreen] MediaRecorder created with mimeType:', mediaRecorder.mimeType);
            console.log('[Offscreen] MediaRecorder state:', mediaRecorder.state);
        } catch (recorderError) {
            console.error('[Offscreen] Failed to create MediaRecorder:', recorderError);
            // Clean up stream
            if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
            }
            throw new Error(`Failed to create MediaRecorder: ${recorderError.message}`);
        }

        // Reset chunks array for new recording
        recordedChunks = [];

        // Handle data chunks as they become available
        // MediaRecorder will call this periodically based on timeslice
        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
                console.log('[Offscreen] Data chunk received:', event.data.size, 'bytes (total chunks:', recordedChunks.length, ', total size:', recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0), 'bytes)');
            } else {
                console.warn('[Offscreen] Received empty data chunk - this may be normal for the first chunk');
            }
        };

        // Handle recording stop - this is when we process the final video
        mediaRecorder.onstop = async () => {
            console.log('[Offscreen] Recording stopped, processing', recordedChunks.length, 'chunks');
            
            try {
                // Check if we have any chunks
                if (recordedChunks.length === 0) {
                    throw new Error('No data chunks recorded. MediaRecorder may not have received any data.');
                }
                
                // Calculate total size
                const totalSize = recordedChunks.reduce((sum, chunk) => sum + chunk.size, 0);
                console.log('[Offscreen] Total recorded size:', totalSize, 'bytes');
                
                if (totalSize === 0) {
                    throw new Error('Recorded video is empty (0 bytes). The stream may not have been active.');
                }
                
                // Combine all chunks into a single blob
                const finalMimeType = mediaRecorder.mimeType || 'video/webm';
                const blob = new Blob(recordedChunks, { type: finalMimeType });
                console.log('[Offscreen] Video blob created:', blob.size, 'bytes, type:', finalMimeType);
                
                // Validate blob size
                if (blob.size === 0) {
                    throw new Error('Recorded video is empty (0 bytes)');
                }

                await putVideo(blob);
                lastStoreOk = true;
                console.log('[Offscreen] Video stored in IndexedDB');
            } catch (processingError) {
                console.error('[Offscreen] Error processing video:', processingError);
            } finally {
                // Recording is done - stop pinging the service worker.
                stopKeepAlive();
                // Always clean up media stream tracks
                if (mediaStream) {
                    mediaStream.getTracks().forEach(track => {
                        track.stop();
                        console.log('[Offscreen] Track stopped:', track.kind, track.label);
                    });
                    mediaStream = null;
                }
            }
        };

        // Handle MediaRecorder errors
        mediaRecorder.onerror = (event) => {
            console.error('[Offscreen] MediaRecorder error:', event.error);
        };

        // Start recording with 1-second chunks
        // This ensures we get data regularly and can handle long recordings
        const timeslice = 1000; // 1 second
        
        // Wait a moment to ensure stream is fully ready
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Check stream state before starting
        const tracks = mediaStream.getVideoTracks();
        if (tracks.length > 0 && tracks[0].readyState !== 'live') {
            console.warn('[Offscreen] Video track not live, waiting...');
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        try {
            mediaRecorder.start(timeslice);
            console.log('[Offscreen] MediaRecorder started, recording in', timeslice, 'ms chunks');
            console.log('[Offscreen] MediaRecorder state after start:', mediaRecorder.state);
            // Keep the service worker alive for the duration of the recording.
            startKeepAlive();
        } catch (startError) {
            console.error('[Offscreen] Error starting MediaRecorder:', startError);
            // Clean up
            if (mediaStream) {
                mediaStream.getTracks().forEach(track => track.stop());
                mediaStream = null;
            }
            throw new Error(`Failed to start MediaRecorder: ${startError.message}`);
        }
        
    } catch (error) {
        console.error('[Offscreen] Error starting recording:', error);

        // Clean up on error
        stopKeepAlive();
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            try {
                mediaRecorder.stop();
            } catch (e) {
                // Ignore
            }
        }
        
        throw error;
    }
}

/**
 * Stops video recording and triggers processing
 * This function:
 * 1. Checks if MediaRecorder is active
 * 2. Stops the recording (triggers onstop handler)
 * 3. Waits for processing to complete
 * 
 * @returns {Promise<void>}
 */
async function stopRecording() {
    return new Promise((resolve, reject) => {
        if (!mediaRecorder) {
            console.warn('[Offscreen] No MediaRecorder instance to stop');
            resolve();
            return;
        }

        if (mediaRecorder.state === 'inactive') {
            console.log('[Offscreen] MediaRecorder already inactive');
            resolve();
            return;
        }

        console.log('[Offscreen] Stopping MediaRecorder, current state:', mediaRecorder.state);
        
        // Store original onstop handler
        const originalOnStop = mediaRecorder.onstop;
        
        // Wrap onstop to resolve our promise when processing completes
        mediaRecorder.onstop = async function() {
            console.log('[Offscreen] MediaRecorder stopped, processing video...');
            
            // Call original handler if it exists
            if (originalOnStop) {
                try {
                    await originalOnStop.apply(this, arguments);
                } catch (error) {
                    console.error('[Offscreen] Error in original onstop handler:', error);
                }
            }
            
            // Resolve promise after processing
            // Give it a moment for async operations to complete
            setTimeout(() => {
                console.log('[Offscreen] Recording stop complete');
                resolve();
            }, 500);
        };
        
        // Set timeout in case onstop never fires
        const timeout = setTimeout(() => {
            console.warn('[Offscreen] Stop timeout - onstop handler did not fire');
            resolve(); // Resolve anyway to prevent hanging
        }, 15000); // 15 second timeout (increased for large videos)
        
        // Stop the recorder
        try {
            lastStoreOk = false;
            mediaRecorder.stop();
            console.log('[Offscreen] Stop command sent to MediaRecorder');
            
            // Clear timeout if onstop fires normally
            // (We'll clear it in the onstop handler, but also here as backup)
            const checkInterval = setInterval(() => {
                if (mediaRecorder.state === 'inactive') {
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                }
            }, 100);
        } catch (stopError) {
            clearTimeout(timeout);
            console.error('[Offscreen] Error stopping MediaRecorder:', stopError);
            reject(new Error(`Failed to stop recording: ${stopError.message}`));
        }
    });
}

// Log that offscreen document is ready
console.log('[Offscreen] Offscreen document loaded and ready for video recording');
