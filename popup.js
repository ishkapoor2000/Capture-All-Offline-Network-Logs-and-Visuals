// Popup script for controlling the extension

let currentTabId = null;
let isRecording = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Get current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  
  // Check if it's a recordable page
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
    document.getElementById('startBtn').disabled = true;
    showNotification('Cannot record on browser internal pages', true);
  }
  
  // Update initial status
  updateStatus();
  updateStats();
  
  // Set up button listeners
  document.getElementById('startBtn').addEventListener('click', startRecording);
  document.getElementById('stopBtn').addEventListener('click', stopRecording);
  document.getElementById('captureBtn').addEventListener('click', captureElements);
  document.getElementById('exportBtn').addEventListener('click', exportLogs);
  document.getElementById('clearBtn').addEventListener('click', clearLogs);
  
  // Update stats every 2 seconds while popup is open
  setInterval(updateStats, 2000);
});

async function updateStatus() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('Could not get status:', chrome.runtime.lastError);
      return;
    }
    
    if (response) {
      isRecording = response.isRecording;
      const indicator = document.getElementById('statusIndicator');
      const statusText = document.getElementById('statusText');
      const startBtn = document.getElementById('startBtn');
      const stopBtn = document.getElementById('stopBtn');
      
      if (isRecording) {
        indicator.classList.add('recording');
        statusText.textContent = 'Recording';
        startBtn.disabled = true;
        stopBtn.disabled = false;
      } else {
        indicator.classList.remove('recording');
        statusText.textContent = 'Not Recording';
        startBtn.disabled = false;
        stopBtn.disabled = true;
      }
    }
  });
}

async function updateStats() {
  chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response) {
      document.getElementById('networkCount').textContent = response.networkLogsCount || 0;
    }
  });
  
  chrome.storage.local.get(['interactionLogs', 'elementSnapshots'], (result) => {
    if (chrome.runtime.lastError) return;
    const interactionLogs = result.interactionLogs || [];
    const elementSnapshots = result.elementSnapshots || [];
    
    document.getElementById('interactionCount').textContent = interactionLogs.length;
    document.getElementById('snapshotCount').textContent = elementSnapshots.length;
  });
}

// Check if content script is injected
async function isContentScriptInjected(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
    return response && response.pong === true;
  } catch (error) {
    return false;
  }
}

// Inject content script programmatically
async function injectContentScript(tabId) {
  try {
    const injected = await isContentScriptInjected(tabId);
    if (injected) {
      console.log('Content script already injected');
      return true;
    }
    
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    
    console.log('Content script injected successfully');
    
    // Wait a bit for script to initialize
    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
  } catch (error) {
    console.error('Failed to inject content script:', error);
    return false;
  }
}

async function startRecording() {
  try {
    // Get the current tab again to ensure it's valid
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tab.id;
    
    // Check if it's a chrome:// or chrome-extension:// page
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
      showNotification('Cannot record on browser internal pages', true);
      return;
    }
    
    // Start network recording
    const response = await chrome.runtime.sendMessage({ 
      action: 'startRecording', 
      tabId: currentTabId 
    });
    
    if (!response || !response.success) {
      throw new Error(response?.error || 'Failed to start network recording');
    }
    
    // Inject and start interaction recording
    const injected = await injectContentScript(currentTabId);
    
    if (injected) {
      try {
        await chrome.tabs.sendMessage(currentTabId, { 
          action: 'startInteractionRecording' 
        });
        showNotification('Recording started (network + interactions)');
      } catch (error) {
        console.warn('Could not start interaction recording:', error.message);
        showNotification('Recording started (network only - interaction tracking unavailable)');
      }
    } else {
      showNotification('Recording started (network only - could not inject interaction tracker)');
    }
    
    updateStatus();
  } catch (error) {
    console.error('Failed to start recording:', error);
    showNotification('Failed to start: ' + error.message, true);
  }
}

async function stopRecording() {
  try {
    // Stop network recording
    const response = await chrome.runtime.sendMessage({ 
      action: 'stopRecording', 
      tabId: currentTabId 
    });
    
    // Stop interaction recording in content script
    try {
      await chrome.tabs.sendMessage(currentTabId, { 
        action: 'stopInteractionRecording' 
      });
    } catch (error) {
      console.warn('Could not stop interaction recording:', error.message);
    }
    
    updateStatus();
    showNotification('Recording stopped');
  } catch (error) {
    console.error('Failed to stop recording:', error);
    showNotification('Failed to stop: ' + error.message, true);
  }
}

async function captureElements() {
  try {
    // Ensure content script is injected
    const injected = await injectContentScript(currentTabId);
    
    if (!injected) {
      showNotification('Failed to inject content script', true);
      return;
    }
    
    await chrome.tabs.sendMessage(currentTabId, { 
      action: 'captureElements' 
    });
    showNotification('Elements captured');
    setTimeout(updateStats, 500);
  } catch (error) {
    console.warn('Could not capture elements:', error);
    showNotification('Failed to capture elements: ' + error.message, true);
  }
}

async function exportLogs() {
  try {
    await chrome.runtime.sendMessage({ 
      action: 'exportLogs', 
      tabId: currentTabId 
    });
    showNotification('JSON and HTML timeline files exported successfully!');
  } catch (error) {
    console.error('Export failed:', error);
    showNotification('Export failed: ' + error.message, true);
  }
}

async function clearLogs() {
  if (confirm('Are you sure you want to clear all logs?')) {
    try {
      await chrome.runtime.sendMessage({ action: 'clearLogs' });
      showNotification('Logs cleared');
      setTimeout(updateStats, 300);
    } catch (error) {
      showNotification('Failed to clear logs', true);
    }
  }
}

function showNotification(message, isError = false) {
  const info = document.querySelector('.info');
  
  // Remove existing notifications
  const existingNotifications = info.querySelectorAll('.notification');
  existingNotifications.forEach(n => n.remove());
  
  const notification = document.createElement('div');
  notification.className = 'notification' + (isError ? ' error' : '');
  notification.textContent = message;
  info.appendChild(notification);
  
  setTimeout(() => {
    notification.remove();
  }, 4000);
}