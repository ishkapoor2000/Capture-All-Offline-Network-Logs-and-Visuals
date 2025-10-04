# Capture All

A Chrome extension that records network logs, user interactions, and screen elements for detailed analysis.

## Features

- **Network Logging**: Captures all HTTP requests and responses with headers, status codes, and timing
- **Click Tracking**: Records click events with precise coordinates (client, page, screen)
- **Scroll Monitoring**: Tracks scroll position and scroll events
- **Drag & Drop Detection**: Captures drag start/end coordinates and distance
- **Element Snapshots**: Records visible interactive elements on the page
- **Export Functionality**: Exports all logs as a structured JSON file

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right)
4. Click "Load unpacked"
5. Select the extension folder

## File Structure

### manifest.json
The extension manifest file that defines:
- Permissions (debugger, storage, tabs, webRequest)
- Background service worker
- Content scripts
- Popup UI configuration

### background.js
Service worker that handles:
- Network logging using Chrome Debugger API
- Debugger attachment/detachment to tabs
- Network event capture (requests, responses, failures)
- Data storage coordination
- Export functionality

### content.js
Content script injected into web pages that:
- Captures user interactions (clicks, scrolls, drags)
- Records element data (XPath, CSS selectors, positions)
- Tracks input changes
- Captures element snapshots on demand
- Throttles scroll events for performance

### popup.html
Extension popup interface with:
- Recording status indicator
- Statistics display (network logs, interactions, snapshots)
- Control buttons (start, stop, capture, export, clear)
- Feature information

### popup.js
Popup logic that:
- Manages recording state
- Updates statistics in real-time
- Communicates with background and content scripts
- Handles user button clicks
- Shows notifications

### styles.css
Styling for the popup interface with:
- Modern, clean design
- Button states and hover effects
- Recording indicator animation
- Responsive layout

## Usage

1. Click the extension icon to open the popup
2. Click "Start Recording" to begin logging
3. Interact with the web page (clicks, scrolls, drags)
4. Click "Capture Elements" to snapshot visible interactive elements
5. Click "Stop Recording" when done
6. Click "Export Logs" to download a JSON file with all data
7. Click "Clear Logs" to reset all stored data

## Exported Data Structure
```json
{
  "exportDate": "ISO timestamp",
  "tabId": 123,
  "networkLogs": [
    {
      "type": "request|response|failed",
      "timestamp": 1234567890,
      "url": "...",
      "method": "GET|POST|...",
      "status": 200,
      "headers": {},
      "requestId": "..."
    }
  ],
  "interactionLogs": [
    {
      "type": "click|scroll|drag|input|change",
      "timestamp": 1234567890,
      "element": {
        "tagName": "BUTTON",
        "id": "submit-btn",
        "className": "btn primary",
        "xpath": "/html/body/div[1]/button[1]",
        "selector": "div > button.btn.primary",
        "text": "Submit",
        "attributes": {},
        "position": {
          "top": 100,
          "left": 50,
          "width": 120,
          "height": 40
        },
        "visible": true
      },
      "coordinates": {
        "clientX": 250,
        "clientY": 150,
        "pageX": 250,
        "pageY": 650,
        "screenX": 300,
        "screenY": 200
      },
      "url": "https://example.com",
      "viewport": {
        "width": 1920,
        "height": 1080,
        "scrollX": 0,
        "scrollY": 500,
        "devicePixelRatio": 1
      }
    }
  ],
  "elementSnapshots": [
    {
      "timestamp": 1234567890,
      "url": "https://example.com",
      "elements": [
        {
          "tagName": "A",
          "id": null,
          "className": "nav-link",
          "xpath": "/html/body/nav/a[1]",
          "selector": "nav > a.nav-link",
          "text": "Home",
          "attributes": {
            "href": "/home"
          },
          "position": {
            "top": 20,
            "left": 100,
            "width": 80,
            "height": 30
          },
          "visible": true
        }
      ],
      "viewport": {
        "width": 1920,
        "height": 1080,
        "scrollX": 0,
        "scrollY": 0,
        "devicePixelRatio": 1
      }
    }
  ],
  "summary": {
    "totalNetworkRequests": 45,
    "totalInteractions": 23,
    "totalElementSnapshots": 3
  }
}
```
Data Captured
Network Logs

Request: URL, method, headers, POST data, initiator
Response: URL, status code, status text, headers, MIME type
Failed: Request ID, error text, cancellation status

Interaction Types

Click: Element data, coordinates (client/page/screen), viewport info
Scroll: Scroll position (x/y), scroll target, viewport info
Drag: Start/end coordinates, distance, duration, element data
Input: Element data, value length, input type
Change: Element data, value/checked state

Element Data

Tag name, ID, class names
XPath and CSS selector
Text content (truncated to 100 chars)
Relevant attributes (href, src, alt, title, etc.)
Position and dimensions
Visibility status

Technical Details
Chrome Debugger API
The extension uses Chrome's Debugger API to capture network events:

Attaches to active tab with protocol version 1.3
Enables Network domain for event monitoring
Listens for: requestWillBeSent, responseReceived, loadingFailed

Event Throttling

Scroll events are throttled to 100ms to prevent performance issues
Drag detection requires 5+ pixel movement to distinguish from clicks

Element Identification

XPath: Full path from document root
CSS Selector: Up to 5 levels deep with classes
Both methods ensure element can be re-located for automation

Storage

Uses chrome.storage.local for interaction logs and snapshots
Network logs stored in memory (service worker)
All data cleared on browser restart or manual clear

Permissions Explained

activeTab: Access current tab content
storage: Store interaction logs locally
tabs: Query and interact with browser tabs
webRequest: Monitor network requests (deprecated, using debugger instead)
debugger: Attach debugger for network monitoring
host_permissions: Access all URLs for content script injection

Limitations

Network logging requires debugger attachment (may show developer tools icon)
Cannot capture CORS-blocked requests in certain scenarios
Service worker may reset on browser restart (network logs lost)
Stored data uses browser's local storage quota

Privacy & Security

All data is stored locally in the browser
No data is sent to external servers
Sensitive input values are not captured (only length/state)
Network request/response bodies can be large - be mindful of storage

Use Cases

User behavior analysis
UX research and testing
Bug reproduction and debugging
Test automation script generation
Performance monitoring
Accessibility testing

Troubleshooting
Recording won't start

Check if another debugger is already attached
Try refreshing the page and starting again
Ensure no other extensions are interfering

Missing interaction events

Content script may not have loaded
Check browser console for errors
Verify page allows content script injection

Export file is empty

Ensure recording was active during interaction
Check if logs were cleared accidentally
Verify storage permissions are granted

Future Enhancements
Possible improvements:

Screenshot capture on key events
Video recording integration
Heatmap visualization
Real-time dashboard
CSV export format
Filtering and search capabilities
Session replay functionality

Development
To modify the extension:

Make changes to the source files
Go to chrome://extensions/
Click the refresh icon on the extension card
Test your changes

For debugging:

Background script: Click "Inspect views: service worker"
Content script: Use browser DevTools on the page
Popup: Right-click popup → Inspect

License
Free to use and modify for personal and commercial projects.
Support
For issues or questions, please check:

Chrome Extension documentation: https://developer.chrome.com/docs/extensions/
Debugger API: https://developer.chrome.com/docs/extensions/reference/api/debugger


---

## Summary

This extension provides a complete solution for recording:

1. **Network Activity** - All HTTP requests/responses via Chrome Debugger API
2. **User Interactions** - Clicks, scrolls, drags with precise coordinates
3. **Element Information** - XPath, selectors, positions for automation
4. **Page Context** - URL, viewport, timestamps for each event

The data is exported as structured JSON, ready for analysis with tools like Python, Excel, or custom analytics platforms. All 6 files work together to provide seamless recording and export functionality.