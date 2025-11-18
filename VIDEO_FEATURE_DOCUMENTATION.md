# Video + Logs Feature - Technical Documentation

## Overview

The "Video + Logs" feature allows users to record both screen video and all network/interaction logs simultaneously. This creates a comprehensive session replay that combines visual recording with detailed event logs.

## Architecture

### Component Flow

```
User clicks "Start Recording" (Video Mode)
    ↓
popup.js → background.js (startVideoCapture)
    ↓
Chrome tabCapture API → Get Media Stream ID
    ↓
Create Offscreen Document (for MediaRecorder)
    ↓
offscreen.js → MediaRecorder captures video
    ↓
Video chunks → Blob → Base64 → IndexedDB
    ↓
Export: Video file + HTML timeline with synchronized logs
```

### Key Components

1. **background.js** - Orchestrates video recording, manages IndexedDB storage (includes inline IndexedDB helper functions)
2. **offscreen.js** - Handles MediaRecorder (can't run in service worker)
3. **popup.js** - UI controls for starting/stopping video recording

## Technical Implementation

### 1. Video Storage (IndexedDB)

**Problem Solved:** Chrome storage has a ~10MB limit, but videos can be much larger.

**Solution:** Use IndexedDB to store video blobs directly.

**Implementation:**
- `openVideoDatabase()` - Opens/creates IndexedDB database
- `storeVideoBlob()` - Stores video blob (converts base64 to Blob if needed)
- `getVideoBlob()` - Retrieves video blob from IndexedDB
- `deleteVideoBlob()` - Cleans up after export

**Location:** `background.js` lines 278-448

### 2. Offscreen Document Management

**Problem Solved:** Service workers can't use MediaRecorder API.

**Solution:** Create an offscreen document that can use MediaRecorder.

**Implementation:**
- `createOffscreenDocument()` - Creates/reuses offscreen document with retry logic
- Waits for document to be ready (1 second)
- Retries message sending up to 3 times with exponential backoff
- Properly closes document after recording stops

**Location:** `background.js` lines 55-124

### 3. Video Capture Flow

**startVideoCapture(tabId):**
1. Validates tab URL (http/https only)
2. Gets media stream ID from `chrome.tabCapture.getMediaStreamId()`
3. Creates offscreen document
4. Sends stream ID to offscreen document
5. Stores metadata in chrome.storage

**Location:** `background.js` lines 126-198

**stopVideoCapture(tabId):**
1. Sends stop message to offscreen document
2. Waits for video processing (3 seconds)
3. Cleans up metadata from chrome.storage
4. Closes offscreen document

**Location:** `background.js` lines 200-276

### 4. MediaRecorder Configuration

**Problem Solved:** Audio configuration was incorrect, codec detection needed improvement.

**Solution:** 
- Disable audio (tab capture audio requires special setup)
- Better codec detection (VP9 → VP8 → default)
- Proper error handling and validation

**Implementation in offscreen.js:**
- `startRecording(streamId)` - Sets up MediaRecorder with proper constraints
- Validates video tracks exist
- Detects best available codec
- Records in 1-second chunks for reliability
- Converts blob to base64 for transmission

**Location:** `offscreen.js` lines 20-200

### 5. Video Export

**Problem Solved:** Large videos couldn't be embedded in HTML, async retrieval was broken.

**Solution:**
- Export video as separate file
- HTML references video file (or embeds if small enough)
- Proper async/await chain for video retrieval

**Implementation:**
- `exportAllLogs()` - Retrieves video from IndexedDB, exports as separate file
- `generateVideoTimelineHTML()` - Creates HTML with video player
- Small videos (<10MB): Embedded as data URL
- Large videos: Reference as relative file path

**Location:** `background.js` lines 723-842 (exportAllLogs), 1773-1817 (generateVideoTimelineHTML)

### 6. Video Validation

**Added validations:**
- Check if video blob exists
- Validate blob is actually a Blob instance
- Check blob size > 0
- Warn about very large videos (>500MB)

**Location:** `background.js` lines 754-790

## Data Flow

### Recording Flow

1. **User starts recording** (Video mode)
   - `popup.js` → `startVideoRecording()`
   - Calls `background.js` → `startVideoCapture()`
   - Gets stream ID from tabCapture API
   - Creates offscreen document
   - Sends stream ID to offscreen document

2. **Offscreen document starts recording**
   - `offscreen.js` → `startRecording(streamId)`
   - Gets media stream via getUserMedia
   - Creates MediaRecorder with best codec
   - Starts recording in 1-second chunks
   - Stores chunks in `recordedChunks` array

3. **User stops recording**
   - `popup.js` → `stopRecording()`
   - Calls `background.js` → `stopVideoCapture()`
   - Sends stop message to offscreen document
   - `offscreen.js` → `stopRecording()`
   - MediaRecorder stops, `onstop` handler fires
   - Combines chunks into Blob
   - Converts to base64
   - Sends to background via `video-data-ready` message

4. **Background stores video**
   - `background.js` receives `video-data-ready` message
   - Converts base64 to Blob
   - Stores in IndexedDB via `storeVideoBlob()`
   - Sets flag in chrome.storage

### Export Flow

1. **User clicks Export** (Video mode)
   - `popup.js` → `exportLogs()`
   - Calls `background.js` → `exportAllLogs(tabId, 'video')`

2. **Retrieve and export video**
   - `getVideoBlob('current-video')` retrieves from IndexedDB
   - Validates video blob
   - Creates object URL
   - Downloads as separate `.webm` file

3. **Generate HTML**
   - `generateVideoTimelineHTML()` called with video blob and filename
   - Determines if video should be embedded or referenced
   - Generates HTML with video player and synchronized logs
   - Downloads HTML file

## File Structure

```
background.js
├── Video Storage Functions (IndexedDB)
│   ├── openVideoDatabase()
│   ├── storeVideoBlob()
│   ├── getVideoBlob()
│   └── deleteVideoBlob()
├── Offscreen Document Management
│   └── createOffscreenDocument()
├── Video Capture Control
│   ├── startVideoCapture()
│   └── stopVideoCapture()
├── Video Data Handler
│   └── video-data-ready message listener
└── Export Functions
    ├── exportAllLogs()
    └── generateVideoTimelineHTML()

offscreen.js
├── Message Handler
│   └── chrome.runtime.onMessage listener
├── Recording Functions
│   ├── startRecording(streamId)
│   └── stopRecording()
└── MediaRecorder Event Handlers
    ├── ondataavailable
    ├── onstop
    └── onerror
```

## Key Functions Reference

### background.js

#### `createOffscreenDocument(streamId, tabId)`
- Creates or reuses offscreen document
- Includes retry logic for message passing
- Waits for document to be ready

#### `startVideoCapture(tabId)`
- Validates tab can be recorded
- Gets media stream ID
- Sets up offscreen document
- Returns success/error status

#### `stopVideoCapture(tabId)`
- Stops recording
- Waits for processing
- Cleans up resources

#### `storeVideoBlob(videoData, videoId)`
- Stores video in IndexedDB
- Converts base64 to Blob if needed
- Handles large files

#### `getVideoBlob(videoId)`
- Retrieves video from IndexedDB
- Returns Blob or null

#### `exportAllLogs(tabId, mode)`
- Retrieves all data (logs + video)
- Exports video as separate file
- Generates JSON and HTML exports

#### `generateVideoTimelineHTML(data, videoBlob, videoFileName)`
- Creates HTML with video player
- Embeds small videos, references large ones
- Synchronizes logs with video playback

### offscreen.js

#### `startRecording(streamId)`
- Gets media stream from getUserMedia
- Configures MediaRecorder
- Starts recording in chunks
- Sets up event handlers

#### `stopRecording()`
- Stops MediaRecorder
- Waits for processing
- Returns promise when complete

## Error Handling

### Video Storage Errors
- IndexedDB failures are caught and logged
- Falls back gracefully if storage fails
- User notified via console logs

### MediaRecorder Errors
- Codec detection failures → fallback to default
- Stream errors → cleanup and notify
- Recording errors → logged and reported to background

### Export Errors
- Video retrieval failures → continue without video
- File download errors → logged but export continues
- HTML generation errors → caught and reported

## Performance Considerations

1. **Video Size**
   - Large videos (>500MB) may take time to process
   - IndexedDB handles large blobs efficiently
   - Base64 conversion adds ~33% size overhead

2. **Memory Usage**
   - Video stored in IndexedDB, not memory
   - Chunks processed incrementally
   - Object URLs cleaned up after export

3. **Recording Duration**
   - No hard limit on recording length
   - 1-second chunks prevent memory issues
   - Long recordings may produce large files

## Limitations

1. **Audio Recording**
   - Currently disabled (requires additional setup)
   - Can be enabled with proper Chrome permissions

2. **Video Format**
   - Always WebM format (VP8/VP9 codec)
   - Browser-dependent codec support

3. **File Size**
   - Very large videos (>500MB) may cause issues
   - Browser may reject very large data URLs

4. **Tab Restrictions**
   - Only http/https pages can be recorded
   - Chrome internal pages (chrome://) cannot be recorded

## Troubleshooting

### Video not recording
- Check browser console for errors
- Verify tab is http/https
- Check offscreen document was created
- Look for MediaRecorder errors

### Video not exporting
- Check IndexedDB for video blob
- Verify video size is reasonable
- Check download permissions
- Look for export errors in console

### Video playback issues
- Ensure video file is in same directory as HTML
- Check browser supports WebM format
- Verify video file wasn't corrupted
- Try opening video file directly

## Future Improvements

1. **Audio Support**
   - Add audio capture with proper Chrome permissions
   - Mix audio with video stream

2. **Video Compression**
   - Add compression options
   - Allow quality/bitrate settings

3. **Streaming Export**
   - Stream video chunks during recording
   - Reduce memory usage for long recordings

4. **Multiple Format Support**
   - Export to MP4 format
   - Allow format selection

5. **Video Editing**
   - Trim video segments
   - Add annotations
   - Highlight important moments

## Testing Checklist

- [x] Video recording starts successfully
- [x] Video data stored in IndexedDB
- [x] Video retrieved after recording stops
- [x] Export generates video file
- [x] HTML video player loads correctly
- [x] Timeline synchronization works
- [x] Large videos handled correctly
- [x] Error handling for failed recordings
- [x] Offscreen document cleanup works
- [x] Video validation prevents invalid exports

## Summary of Fixes

1. ✅ **IndexedDB Storage** - Replaced chrome.storage with IndexedDB for large videos
2. ✅ **Async Flow** - Fixed async/await chain in export functions
3. ✅ **Offscreen Lifecycle** - Added retry logic and proper cleanup
4. ✅ **MediaRecorder Config** - Fixed audio/video constraints and codec detection
5. ✅ **Separate Video Export** - Video exported as separate file, HTML references it
6. ✅ **Video Validation** - Added blob validation and error handling
7. ✅ **Comprehensive Logging** - Added detailed logs throughout video flow

All fixes have been implemented with human-readable comments and documentation.

