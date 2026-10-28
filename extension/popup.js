const statusBox = document.getElementById('statusBox');
const dot = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const extId = document.getElementById('extId');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');

function updateUI(connected, eid) {
  if (connected) {
    statusBox.className = 'status connected';
    dot.className = 'dot on';
    statusText.textContent = 'Connected to Chandra';
    extId.textContent = eid ? `Extension ID: ${eid}` : '';
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
  } else {
    statusBox.className = 'status disconnected';
    dot.className = 'dot off';
    statusText.textContent = 'Disconnected';
    extId.textContent = '';
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
  }
}

chrome.runtime.sendMessage({ type: 'getStatus' }, (resp) => {
  if (resp) updateUI(resp.connected, resp.extensionId);
  else updateUI(false);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') updateUI(msg.connected, msg.extensionId);
});

connectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' });
  statusText.textContent = 'Connecting...';
});

disconnectBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'disconnect' });
  updateUI(false);
});
