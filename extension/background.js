const CHANDRA_WS = 'ws://127.0.0.1:8787/ws/extension';
let ws = null;
let reconnectTimer = null;
let extensionId = null;

function connect() {
  if (ws && ws.readyState <= 1) return;
  try {
    ws = new WebSocket(CHANDRA_WS);
  } catch { scheduleReconnect(); return; }

  ws.onopen = () => {
    console.log('[Chandra] Connected to server');
    clearTimeout(reconnectTimer);
    sendTabs();
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'connected') { extensionId = msg.extensionId; broadcastStatus(true); return; }

    if (msg.id) {
      let result;
      try { result = await handleCommand(msg); }
      catch (e) { result = { id: msg.id, error: e.message }; }
      result.id = msg.id;
      ws.send(JSON.stringify(result));
    }
  };

  ws.onclose = () => { broadcastStatus(false); scheduleReconnect(); };
  ws.onerror = () => { ws.close(); };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 5000);
}

async function handleCommand(msg) {
  switch (msg.type) {
    case 'screenshot': return screenshotTab(msg.tabId);
    case 'getText': return getTabText(msg.tabId, msg.selector);
    case 'getHtml': return getTabHtml(msg.tabId, msg.selector);
    case 'getLinks': return getTabLinks(msg.tabId);
    case 'getImages': return getTabImages(msg.tabId);
    case 'click': return clickInTab(msg.tabId, msg.selector);
    case 'eval': return evalInTab(msg.tabId, msg.code);
    case 'navigate': return navigateTab(msg.tabId, msg.url);
    default: return { error: `Unknown command: ${msg.type}` };
  }
}

async function screenshotTab(tabId) {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
  return { dataUrl, tabId: tid };
}

async function getTabText(tabId, selector = 'body') {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel) => document.querySelector(sel)?.innerText || '',
    args: [selector],
  });
  return { text: (result?.result || '').slice(0, 50000), tabId: tid };
}

async function getTabHtml(tabId, selector = 'body') {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel) => document.querySelector(sel)?.innerHTML || '',
    args: [selector],
  });
  return { html: (result?.result || '').slice(0, 50000), tabId: tid };
}

async function getTabLinks(tabId) {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: () => Array.from(document.querySelectorAll('a[href]')).slice(0, 200).map(a => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 100) })),
  });
  return { links: result?.result || [], tabId: tid };
}

async function getTabImages(tabId) {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: () => Array.from(document.querySelectorAll('img[src]')).slice(0, 100).map(img => ({ src: img.src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight })),
  });
  return { images: result?.result || [], tabId: tid };
}

async function clickInTab(tabId, selector) {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (sel) => { const el = document.querySelector(sel); if (el) el.click(); },
    args: [selector],
  });
  return { ok: true, tabId: tid };
}

async function evalInTab(tabId, code) {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tid },
    func: (c) => { try { return eval(c); } catch (e) { return { error: e.message }; } },
    args: [code],
  });
  return { result: result?.result, tabId: tid };
}

async function navigateTab(tabId, url) {
  const tid = tabId ? Number(tabId) : (await getActiveTab()).id;
  await chrome.tabs.update(tid, { url });
  return { ok: true, tabId: tid, url };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendTabs() {
  if (!ws || ws.readyState !== 1) return;
  const tabs = await chrome.tabs.query({});
  ws.send(JSON.stringify({
    type: 'tabs',
    tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })),
  }));
}

function broadcastStatus(connected) {
  chrome.runtime.sendMessage({ type: 'status', connected, extensionId }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(() => sendTabs());
chrome.tabs.onRemoved.addListener(() => sendTabs());
chrome.tabs.onActivated.addListener(() => sendTabs());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ connected: ws && ws.readyState === 1, extensionId });
    return true;
  }
  if (msg.type === 'reconnect') { connect(); sendResponse({ ok: true }); return true; }
  if (msg.type === 'disconnect') {
    if (ws) ws.close();
    sendResponse({ ok: true });
    return true;
  }
});

connect();
