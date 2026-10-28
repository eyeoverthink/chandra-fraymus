// Chandra-FRAYMUS content script
// Injected into all pages to support DOM operations from the extension bridge.
// The background service worker uses chrome.scripting.executeScript for most tasks,
// but this content script provides a persistent presence for message-based DOM access.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'extractText') {
    const el = document.querySelector(msg.selector || 'body');
    sendResponse({ text: (el?.innerText || '').slice(0, 50000) });
    return true;
  }
  if (msg.type === 'extractHtml') {
    const el = document.querySelector(msg.selector || 'body');
    sendResponse({ html: (el?.innerHTML || '').slice(0, 50000) });
    return true;
  }
  if (msg.type === 'extractLinks') {
    const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 200)
      .map(a => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 100) }));
    sendResponse({ links });
    return true;
  }
  if (msg.type === 'extractImages') {
    const images = Array.from(document.querySelectorAll('img[src]')).slice(0, 100)
      .map(img => ({ src: img.src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight }));
    sendResponse({ images });
    return true;
  }
  if (msg.type === 'clickElement') {
    const el = document.querySelector(msg.selector);
    if (el) el.click();
    sendResponse({ ok: !!el });
    return true;
  }
});
