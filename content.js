// Content script for capturing user interactions and element data

let isRecordingInteractions = false;
let lastScrollTime = 0;
const SCROLL_THROTTLE = 100; // ms
let isContextValid = true;

// Test if extension context is valid
function checkContext() {
    try {
        if (chrome.runtime && chrome.runtime.id) {
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// Initialize when the page loads
function init() {
    // Check if recording is active
    if (!checkContext()) return;

    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
        if (chrome.runtime.lastError) {
            console.warn('Extension context may be invalid:', chrome.runtime.lastError);
            isContextValid = false;
            return;
        }
        if (response && response.isRecording) {
            startInteractionRecording();
        }
    });
}

// Respond to ping to check if script is loaded
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'ping') {
        sendResponse({ pong: true });
        return true;
    }

    if (request.action === 'startInteractionRecording') {
        startInteractionRecording();
        sendResponse({ success: true });
    } else if (request.action === 'stopInteractionRecording') {
        stopInteractionRecording();
        sendResponse({ success: true });
    } else if (request.action === 'captureElements') {
        captureCurrentElements();
        sendResponse({ success: true });
    }
    return true;
});

function startInteractionRecording() {
    isRecordingInteractions = true;
    isContextValid = checkContext();

    // Add event listeners
    document.addEventListener('click', handleClick, true);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('mousedown', handleDragStart, true);
    document.addEventListener('mouseup', handleDragEnd, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleChange, true);

    console.log('Interaction recording started');
}

function stopInteractionRecording() {
    isRecordingInteractions = false;

    // Remove event listeners
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('scroll', handleScroll, true);
    document.removeEventListener('mousedown', handleDragStart, true);
    document.removeEventListener('mouseup', handleDragEnd, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleChange, true);

    console.log('Interaction recording stopped');
}

function handleClick(event) {
    if (!isRecordingInteractions) return;

    const elementData = getElementData(event.target);
    const coordinates = {
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        screenX: event.screenX,
        screenY: event.screenY
    };

    logInteraction({
        type: 'click',
        element: elementData,
        coordinates: coordinates,
        url: window.location.href,
        viewport: getViewportData()
    });
}

function handleScroll(event) {
    if (!isRecordingInteractions) return;

    const now = Date.now();
    if (now - lastScrollTime < SCROLL_THROTTLE) return;
    lastScrollTime = now;

    logInteraction({
        type: 'scroll',
        scrollPosition: {
            x: window.scrollX,
            y: window.scrollY
        },
        scrollTarget: event.target === document ? 'window' : getElementData(event.target),
        url: window.location.href,
        viewport: getViewportData()
    });
}

let dragStart = null;

function handleDragStart(event) {
    if (!isRecordingInteractions) return;

    dragStart = {
        element: getElementData(event.target),
        coordinates: {
            clientX: event.clientX,
            clientY: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY
        },
        timestamp: Date.now()
    };
}

function handleDragEnd(event) {
    if (!isRecordingInteractions || !dragStart) return;

    const dragEnd = {
        coordinates: {
            clientX: event.clientX,
            clientY: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY
        },
        timestamp: Date.now()
    };

    const distance = Math.sqrt(
        Math.pow(dragEnd.coordinates.clientX - dragStart.coordinates.clientX, 2) +
        Math.pow(dragEnd.coordinates.clientY - dragStart.coordinates.clientY, 2)
    );

    // Only log if moved more than 5 pixels (to distinguish from clicks)
    if (distance > 5) {
        logInteraction({
            type: 'drag',
            element: dragStart.element,
            start: dragStart.coordinates,
            end: dragEnd.coordinates,
            distance: distance,
            duration: dragEnd.timestamp - dragStart.timestamp,
            url: window.location.href,
            viewport: getViewportData()
        });
    }

    dragStart = null;
}

function handleInput(event) {
    if (!isRecordingInteractions) return;

    logInteraction({
        type: 'input',
        element: getElementData(event.target),
        valueLength: event.target.value ? event.target.value.length : 0,
        inputType: event.inputType,
        url: window.location.href
    });
}

function handleChange(event) {
    if (!isRecordingInteractions) return;

    logInteraction({
        type: 'change',
        element: getElementData(event.target),
        value: event.target.type === 'checkbox' || event.target.type === 'radio'
            ? event.target.checked
            : (event.target.value ? event.target.value.length : 0),
        url: window.location.href
    });
}

function getElementData(element) {
    if (!element) return null;

    const rect = element.getBoundingClientRect();

    return {
        tagName: element.tagName,
        id: element.id || null,
        className: element.className || null,
        xpath: getXPath(element),
        selector: getCssSelector(element),
        text: element.textContent ? element.textContent.substring(0, 100) : null,
        attributes: getRelevantAttributes(element),
        position: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
        },
        visible: isElementVisible(element)
    };
}

function getXPath(element) {
    if (element.id) {
        return `//*[@id="${element.id}"]`;
    }

    if (element === document.body) {
        return '/html/body';
    }

    let path = '';
    let current = element;

    while (current && current !== document.body) {
        let index = 1;
        let sibling = current.previousElementSibling;

        while (sibling) {
            if (sibling.tagName === current.tagName) {
                index++;
            }
            sibling = sibling.previousElementSibling;
        }

        path = `/${current.tagName.toLowerCase()}[${index}]${path}`;
        current = current.parentElement;
    }

    return `/html/body${path}`;
}

function getCssSelector(element) {
    if (element.id) {
        return `#${element.id}`;
    }

    const path = [];
    let current = element;

    while (current && current !== document.body && path.length < 5) {
        let selector = current.tagName.toLowerCase();

        if (current.className && typeof current.className === 'string') {
            const classes = current.className.trim().split(/\s+/).slice(0, 2);
            selector += classes.map(c => `.${c}`).join('');
        }

        path.unshift(selector);
        current = current.parentElement;
    }

    return path.join(' > ');
}

function getRelevantAttributes(element) {
    const attrs = {};
    const relevantAttrs = ['href', 'src', 'alt', 'title', 'name', 'type', 'value', 'placeholder'];

    relevantAttrs.forEach(attr => {
        if (element.hasAttribute(attr)) {
            attrs[attr] = element.getAttribute(attr);
        }
    });

    return attrs;
}

function isElementVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0';
}

function getViewportData() {
    return {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio
    };
}

function captureCurrentElements() {
    if (!checkContext()) {
        console.warn('Cannot capture elements - extension context invalidated');
        return;
    }

    const elements = document.querySelectorAll('a, button, input, select, textarea, [onclick], [role="button"]');
    const elementData = [];

    elements.forEach(el => {
        if (isElementVisible(el)) {
            elementData.push(getElementData(el));
        }
    });

    try {
        chrome.storage.local.get(['elementSnapshots'], (result) => {
            if (chrome.runtime.lastError) {
                console.warn('Could not save element snapshot:', chrome.runtime.lastError);
                return;
            }
            const snapshots = result.elementSnapshots || [];
            snapshots.push({
                timestamp: Date.now(),
                url: window.location.href,
                elements: elementData,
                viewport: getViewportData()
            });
            chrome.storage.local.set({ elementSnapshots: snapshots });
        });
    } catch (error) {
        console.warn('Error capturing elements:', error);
    }
}

function logInteraction(data) {
    // Check if context is still valid
    if (!checkContext()) {
        console.warn('Extension context invalidated, stopping recording');
        stopInteractionRecording();
        isContextValid = false;
        return;
    }

    try {
        chrome.runtime.sendMessage({
            action: 'logInteraction',
            data: data
        }, (response) => {
            // Handle potential errors silently
            if (chrome.runtime.lastError) {
                // Context lost, stop recording
                isContextValid = false;
                stopInteractionRecording();
            }
        });
    } catch (error) {
        console.warn('Error logging interaction:', error);
        isContextValid = false;
        stopInteractionRecording();
    }
}

// Initialize on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}