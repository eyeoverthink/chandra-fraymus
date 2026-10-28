import {
  openPage, navigatePage, screenshotPage, extractText, extractLinks,
  extractImages, clickElement, fillInput, scrollPage, closePage, evaluateJs,
  waitForSelector, browserStatus,
} from './service.js';

export function createBrowserTools() {
  return [
    {
      name: 'browser_open',
      group: 'browser',
      description: 'Open a new headless browser page at the given URL. Returns a pageId for subsequent operations.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
          userAgent: { type: 'string', description: 'Custom user agent string (optional)' },
        },
        required: ['url'],
      },
      execute: async ({ url, userAgent }) => openPage(url, { userAgent }),
    },
    {
      name: 'browser_navigate',
      group: 'browser',
      description: 'Navigate an open browser page to a new URL.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['pageId', 'url'],
      },
      execute: async ({ pageId, url }) => navigatePage(pageId, url),
    },
    {
      name: 'browser_screenshot',
      group: 'browser',
      description: 'Take a PNG screenshot of the current browser page. Saves to disk and returns the file path.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default: false)' },
        },
        required: ['pageId'],
      },
      execute: async ({ pageId, fullPage }) => screenshotPage(pageId, { fullPage }),
    },
    {
      name: 'browser_extract_text',
      group: 'browser',
      description: 'Extract visible text content from the browser page. Optionally target a CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          selector: { type: 'string', description: 'CSS selector to extract from (default: body)' },
          maxChars: { type: 'number', description: 'Max characters to return (default: 12000)' },
        },
        required: ['pageId'],
      },
      execute: async ({ pageId, selector, maxChars }) => extractText(pageId, { selector, maxChars }),
    },
    {
      name: 'browser_extract_links',
      group: 'browser',
      description: 'Extract all links (href + text) from the current page.',
      parameters: {
        type: 'object',
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
      },
      execute: async ({ pageId }) => extractLinks(pageId),
    },
    {
      name: 'browser_extract_images',
      group: 'browser',
      description: 'Extract all image sources from the current page (src, alt, dimensions).',
      parameters: {
        type: 'object',
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
      },
      execute: async ({ pageId }) => extractImages(pageId),
    },
    {
      name: 'browser_click',
      group: 'browser',
      description: 'Click an element on the page by CSS selector.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          selector: { type: 'string', description: 'CSS selector of element to click' },
        },
        required: ['pageId', 'selector'],
      },
      execute: async ({ pageId, selector }) => clickElement(pageId, selector),
    },
    {
      name: 'browser_fill',
      group: 'browser',
      description: 'Fill an input field on the page.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          selector: { type: 'string', description: 'CSS selector of the input element' },
          value: { type: 'string', description: 'Text to type into the field' },
        },
        required: ['pageId', 'selector', 'value'],
      },
      execute: async ({ pageId, selector, value }) => fillInput(pageId, selector, value),
    },
    {
      name: 'browser_scroll',
      group: 'browser',
      description: 'Scroll the page up or down.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Pixels to scroll (default: 600)' },
        },
        required: ['pageId'],
      },
      execute: async ({ pageId, direction, amount }) => scrollPage(pageId, direction, amount),
    },
    {
      name: 'browser_eval',
      group: 'browser',
      description: 'Execute JavaScript code in the browser page context. Returns the result.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          code: { type: 'string', description: 'JavaScript code to evaluate in the page' },
        },
        required: ['pageId', 'code'],
      },
      execute: async ({ pageId, code }) => evaluateJs(pageId, code),
    },
    {
      name: 'browser_wait',
      group: 'browser',
      description: 'Wait for a CSS selector to appear on the page.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string' },
          selector: { type: 'string' },
          timeout: { type: 'number', description: 'Max wait in ms (default: 5000)' },
        },
        required: ['pageId', 'selector'],
      },
      execute: async ({ pageId, selector, timeout }) => waitForSelector(pageId, selector, timeout),
    },
    {
      name: 'browser_close',
      group: 'browser',
      description: 'Close a browser page.',
      parameters: {
        type: 'object',
        properties: { pageId: { type: 'string' } },
        required: ['pageId'],
      },
      execute: async ({ pageId }) => closePage(pageId),
    },
    {
      name: 'browser_status',
      group: 'browser',
      description: 'Check if the headless browser is running and list open pages.',
      parameters: { type: 'object', properties: {} },
      execute: async () => browserStatus(),
    },
  ];
}
