// Offscreen document script for video recording
// This file runs in an offscreen document because service workers can't use MediaRecorder
// The offscreen document receives messages from background.js to start/stop recording
// It captures the tab's video stream and converts it to a blob for storage

// Global state for MediaRecorder
let mediaRecorder = null;
let recordedChunks = [];
let mediaStream = null; // Keep reference to stream for cleanup

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
                console.log('[Offscreen] Recording stopped successfully');
                sendResponse({ success: true });
            })
            .catch(error => {
                console.error('[Offscreen] Failed to stop recording:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Keep channel open for async response
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
        
        // Validate stream ID
        if (!streamId) {
            throw new Error('Stream ID is required for recording');
        }
        
        // Get media stream from Chrome's tabCapture API
        // IMPORTANT: For Chrome tab capture, we need to use the correct constraint format
        // The 'mandatory' property is deprecated, use the new format
        console.log('[Offscreen] Requesting media stream from getUserMedia...');
        
        // Use the correct format for Chrome tab capture
        const mediaConstraints = {
            audio: false, // Tab capture audio requires additional setup
            video: {
                // New format for Chrome tab capture
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId
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

                // Convert blob to base64 data URL for transmission
                // This allows us to send it via chrome.runtime.sendMessage
                console.log('[Offscreen] Converting blob to base64...');
                const base64data = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    
                    reader.onloadend = () => {
                        if (reader.result) {
                            console.log('[Offscreen] Base64 conversion complete, length:', reader.result.length);
                            resolve(reader.result);
                        } else {
                            reject(new Error('FileReader returned no result'));
                        }
                    };
                    
                    reader.onerror = (error) => {
                        console.error('[Offscreen] FileReader error:', error);
                        reject(new Error('Failed to read blob: ' + error.message));
                    };
                    
                    reader.readAsDataURL(blob);
                });
                
                // Send video data to background script
                // Background script will store it in IndexedDB
                console.log('[Offscreen] Sending video data to background script...');
                try {
                    await chrome.runtime.sendMessage({
                        type: 'video-data-ready',
                        target: 'background',
                        data: base64data
                    });
                    console.log('[Offscreen] Video data sent to background successfully');
                } catch (sendError) {
                    console.error('[Offscreen] Failed to send video data to background:', sendError);
                    // Don't throw - video was recorded, just failed to send
                    // User can try exporting again
                }
                
            } catch (processingError) {
                console.error('[Offscreen] Error processing video:', processingError);
                // Try to notify background script of the error
                try {
                    await chrome.runtime.sendMessage({
                        type: 'video-data-error',
                        target: 'background',
                        error: processingError.message
                    });
                } catch (e) {
                    // Ignore - background might not be listening
                }
            } finally {
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
            // Try to notify background script
            chrome.runtime.sendMessage({
                type: 'video-recording-error',
                target: 'background',
                error: event.error?.message || 'Unknown MediaRecorder error'
            }).catch(() => {
                // Ignore if background isn't listening
            });
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
