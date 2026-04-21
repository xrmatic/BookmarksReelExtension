/**
 * Bookmarks Reel – Background Service Worker
 *
 * Responsibilities:
 *  • Read the user's bookmark tree
 *  • Schedule crawl alarms and listen for browser-idle events
 *  • Open an off-screen window per bookmark, capture a screenshot, then close it
 *  • Detect login-redirect pages and skip them
 *  • Compress each screenshot with a WASM pre-processor + OffscreenCanvas JPEG encoding
 *  • Manage storage limits (max images/bookmark, max age, max total MB)
 *  • Handle messages from the popup and options pages
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const CRAWL_ALARM        = 'bookmarks-reel-crawl';
const CLEANUP_ALARM      = 'bookmarks-reel-cleanup';
const MS_PER_DAY         = 86_400_000;   // milliseconds in one day
const STORAGE_PRUNE_RATIO = 0.25;        // fraction of screenshots removed when storage cap is exceeded

const DEFAULT_SETTINGS = {
  enabled:               true,
  crawlIntervalMinutes:  60,
  idleThresholdSeconds:  60,
  maxImagesPerBookmark:  5,
  maxImageAgeDays:       30,
  maxTotalStorageMB:     50,
  skipLoginPages:        true,
  disabledBookmarks:     [],   // bookmark IDs excluded from crawling
};

// ─── WASM Compressor ──────────────────────────────────────────────────────────

let wasmExports = null;

async function initWasm() {
  try {
    const url      = chrome.runtime.getURL('wasm/compress.wasm');
    const response = await fetch(url);
    const buffer   = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buffer, {});
    wasmExports = instance.exports;
    console.log('[BookmarksReel] WASM compressor loaded');
  } catch (e) {
    console.warn('[BookmarksReel] WASM not available – using Canvas-only compression:', e.message);
  }
}

/**
 * Run the WASM colour-quantisation filter on raw RGBA pixel data in-place.
 * Rounds each R/G/B channel to the nearest multiple of 32, creating 8 discrete
 * levels per channel.  This reduces entropy in the image and significantly
 * improves subsequent JPEG compression ratios.
 */
function applyWasmFilter(imageData) {
  if (!wasmExports) return;
  const { memory, applyCompressionFilter, getMemorySize } = wasmExports;
  if (!applyCompressionFilter) return;

  const data   = imageData.data;   // Uint8ClampedArray
  const memMax = getMemorySize ? getMemorySize() : memory.buffer.byteLength;

  if (data.length > memMax) {
    console.warn('[BookmarksReel] Image too large for WASM buffer – skipping WASM step');
    return;
  }

  const memView = new Uint8Array(memory.buffer);
  memView.set(data, 0);
  applyCompressionFilter(0, data.length);
  data.set(memView.subarray(0, data.length));
}

// ─── Image Compression ───────────────────────────────────────────────────────

/**
 * Compress a JPEG data-URL captured by captureVisibleTab.
 *
 * Pipeline:
 *   1. Decode the raw screenshot via createImageBitmap
 *   2. Down-scale to ≤ 960 × 600 on an OffscreenCanvas
 *   3. Apply WASM colour-quantisation (reduces colour entropy)
 *   4. Re-encode as JPEG at `quality` (0.25 by default ≈ "barely readable text")
 *   5. Return the compressed data-URL
 *
 * Falls back gracefully if WASM is unavailable.
 */
async function compressScreenshot(dataUrl, quality = 0.25) {
  try {
    // Decode
    const response    = await fetch(dataUrl);
    const blob        = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    // Scale
    const MAX_W = 960;
    const MAX_H = 600;
    let { width, height } = imageBitmap;
    if (width > MAX_W)  { height = Math.round(height * MAX_W / width);  width = MAX_W; }
    if (height > MAX_H) { width  = Math.round(width  * MAX_H / height); height = MAX_H; }

    // Draw
    const canvas = new OffscreenCanvas(width, height);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, 0, 0, width, height);
    imageBitmap.close();

    // WASM pre-processing
    if (wasmExports) {
      const imageData = ctx.getImageData(0, 0, width, height);
      applyWasmFilter(imageData);
      ctx.putImageData(imageData, 0, 0);
    }

    // JPEG encode
    const compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });

    // Blob → base64 data-URL (FileReader is unavailable in service workers)
    const ab     = await compressedBlob.arrayBuffer();
    const bytes  = new Uint8Array(ab);
    let binary   = '';
    const CHUNK  = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch (err) {
    console.error('[BookmarksReel] Compression failed:', err);
    return dataUrl;   // Return original on failure
  }
}

// ─── Login-page Detection ────────────────────────────────────────────────────

const LOGIN_URL_PATTERNS = [
  /\/login\b/i,  /\/log-in\b/i, /\/signin\b/i, /\/sign-in\b/i,
  /\/auth\b/i,   /\/oauth/i,    /\/sso\//i,    /\/authenticate/i,
  /accounts\.google\.com/i, /login\.microsoftonline\.com/i,
  /appleid\.apple\.com/i,   /\/account\/login/i,
  /[?&]redirect_to=/i,      /[?&]returnUrl=/i,
];

async function isLoginPage(tabId, url) {
  // 1. URL heuristic
  if (LOGIN_URL_PATTERNS.some(p => p.test(url))) return true;

  // 2. DOM heuristic – inject a tiny function into the loaded page
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        if (document.querySelectorAll('input[type="password"]').length > 0) return true;
        const t = document.title.toLowerCase();
        if (t.includes('sign in') || t.includes('log in') || t.includes('login')) return true;
        const forms = document.querySelectorAll('form');
        for (const f of forms) {
          const a = (f.action || '').toLowerCase();
          if (a.includes('login') || a.includes('signin') || a.includes('sign_in')) return true;
        }
        return false;
      },
    });
    if (results?.[0]?.result === true) return true;
  } catch {
    /* scripting may fail on chrome:// or restricted pages – treat as non-login */
  }

  return false;
}

// ─── Bookmark Utilities ───────────────────────────────────────────────────────

function flattenBookmarks(nodes, acc = []) {
  for (const node of nodes) {
    if (node.url) acc.push(node);
    if (node.children) flattenBookmarks(node.children, acc);
  }
  return acc;
}

function isHttp(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// ─── Tab / Window Helpers ─────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Wait for `tabId` to reach status "complete", or time out after `ms`.
 * Resolves (never rejects) so the caller can always continue.
 */
async function waitForTabLoad(tabId, ms = 15000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const timer  = setTimeout(finish, ms);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        // Allow extra time for JS to paint the first frame
        setTimeout(finish, 1500);
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);

    // Already loaded?
    chrome.tabs.get(tabId)
      .then(tab => { if (tab.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); setTimeout(finish, 1500); } })
      .catch(finish);
  });
}

// ─── Crawling ─────────────────────────────────────────────────────────────────

let crawlInProgress = false;

async function crawlAllBookmarks() {
  if (crawlInProgress) return;
  crawlInProgress = true;
  try {
    const settings     = await getSettings();
    const bookmarkTree = await chrome.bookmarks.getTree();
    const bookmarks    = flattenBookmarks(bookmarkTree);

    for (const bm of bookmarks) {
      if (!bm.url || !isHttp(bm.url)) continue;
      if (settings.disabledBookmarks?.includes(bm.id)) continue;
      await crawlBookmark(bm, settings);
      await sleep(2000);   // polite gap between requests
    }
  } finally {
    crawlInProgress = false;
  }
}

async function crawlBookmark(bookmark, settings) {
  let windowId = null;
  try {
    // Open a small window positioned far off-screen so it doesn't interrupt the user
    const win = await chrome.windows.create({
      url:     bookmark.url,
      left:    -10000,
      top:     0,
      width:   1280,
      height:  800,
      focused: false,
      type:    'normal',
    });
    windowId    = win.id;
    const tabId = win.tabs[0].id;

    await waitForTabLoad(tabId);

    const tab = await chrome.tabs.get(tabId);
    const finalUrl = tab.url || bookmark.url;

    // Skip login redirects
    if (settings.skipLoginPages && await isLoginPage(tabId, finalUrl)) {
      console.log(`[BookmarksReel] Skipping login page: ${bookmark.url}`);
      return;
    }

    // Capture
    const raw        = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
    const compressed = await compressScreenshot(raw);

    // Persist
    await storeScreenshot(bookmark.id, {
      url:       finalUrl,
      title:     tab.title || bookmark.title,
      dataUrl:   compressed,
      timestamp: Date.now(),
    }, settings);

    console.log(`[BookmarksReel] Captured: ${bookmark.title}`);
  } catch (err) {
    console.error(`[BookmarksReel] Error crawling ${bookmark.url}:`, err.message);
  } finally {
    if (windowId !== null) {
      chrome.windows.remove(windowId).catch(() => {});
    }
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function screenshotKey(bookmarkId) { return `screenshots_${bookmarkId}`; }

async function storeScreenshot(bookmarkId, data, settings) {
  const key   = screenshotKey(bookmarkId);
  const store = await chrome.storage.local.get(key);
  let list    = store[key] || [];

  list.unshift(data);   // newest first

  const max = settings?.maxImagesPerBookmark ?? DEFAULT_SETTINGS.maxImagesPerBookmark;
  if (list.length > max) list = list.slice(0, max);

  await chrome.storage.local.set({ [key]: list });
  await enforceStorageCap(settings);
}

async function enforceStorageCap(settings) {
  const maxBytes = (settings?.maxTotalStorageMB ?? DEFAULT_SETTINGS.maxTotalStorageMB) * 1024 * 1024;
  let used;
  try { used = await chrome.storage.local.getBytesInUse(null); }
  catch { return; }

  if (used <= maxBytes) return;

  // Collect all stored screenshots with their age
  const all    = await chrome.storage.local.get(null);
  const keys   = Object.keys(all).filter(k => k.startsWith('screenshots_'));
  let entries  = [];
  for (const k of keys) {
    (all[k] || []).forEach((s, i) => entries.push({ key: k, index: i, ts: s.timestamp }));
  }
  entries.sort((a, b) => a.ts - b.ts);   // oldest first

  const toRemove = Math.ceil(entries.length * STORAGE_PRUNE_RATIO);
  for (let i = 0; i < toRemove; i++) {
    const { key } = entries[i];
    const list = (await chrome.storage.local.get(key))[key] || [];
    list.pop();   // remove oldest entry
    if (list.length === 0) await chrome.storage.local.remove(key);
    else                   await chrome.storage.local.set({ [key]: list });
  }
}

async function cleanupByAge(settings) {
  const maxAge = (settings?.maxImageAgeDays ?? DEFAULT_SETTINGS.maxImageAgeDays) * MS_PER_DAY;
  const cutoff = Date.now() - maxAge;
  const all    = await chrome.storage.local.get(null);
  const keys   = Object.keys(all).filter(k => k.startsWith('screenshots_'));
  for (const k of keys) {
    const filtered = (all[k] || []).filter(s => s.timestamp > cutoff);
    if (filtered.length !== (all[k] || []).length) {
      if (filtered.length === 0) await chrome.storage.local.remove(k);
      else                       await chrome.storage.local.set({ [k]: filtered });
    }
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function getSettings() {
  const d = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
}

// ─── Alarm Scheduling ────────────────────────────────────────────────────────

async function scheduleAlarms() {
  const s = await getSettings();
  await chrome.alarms.clearAll();
  chrome.alarms.create(CRAWL_ALARM,   { periodInMinutes: s.crawlIntervalMinutes, delayInMinutes: 1 });
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 60, delayInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  const s = await getSettings();
  if (alarm.name === CRAWL_ALARM) {
    if (!s.enabled) return;
    const state = await chrome.idle.queryState(s.idleThresholdSeconds);
    if (state === 'idle' || state === 'locked') await crawlAllBookmarks();
  }
  if (alarm.name === CLEANUP_ALARM) {
    await cleanupByAge(await getSettings());
  }
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await scheduleAlarms();
  await initWasm();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  await initWasm();
});

// Also init WASM when the service worker is first loaded
initWasm();

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {

        case 'GET_BOOKMARKS': {
          const tree      = await chrome.bookmarks.getTree();
          const bookmarks = flattenBookmarks(tree);
          const settings  = await getSettings();
          sendResponse({ ok: true, bookmarks, settings });
          break;
        }

        case 'GET_SCREENSHOTS': {
          const key  = screenshotKey(msg.bookmarkId);
          const data = await chrome.storage.local.get(key);
          sendResponse({ ok: true, screenshots: data[key] || [] });
          break;
        }

        case 'TOGGLE_BOOKMARK': {
          const settings  = await getSettings();
          let   disabled  = settings.disabledBookmarks || [];
          if (msg.enabled) disabled = disabled.filter(id => id !== msg.bookmarkId);
          else if (!disabled.includes(msg.bookmarkId)) disabled.push(msg.bookmarkId);
          settings.disabledBookmarks = disabled;
          await chrome.storage.local.set({ settings });
          sendResponse({ ok: true });
          break;
        }

        case 'CRAWL_NOW': {
          if (msg.bookmarkId) {
            const [bm] = await chrome.bookmarks.get(msg.bookmarkId);
            if (bm) await crawlBookmark(bm, await getSettings());
          } else {
            crawlAllBookmarks();   // fire & forget – may take a while
          }
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_SCREENSHOTS': {
          if (msg.bookmarkId) {
            await chrome.storage.local.remove(screenshotKey(msg.bookmarkId));
          } else {
            const all  = await chrome.storage.local.get(null);
            const keys = Object.keys(all).filter(k => k.startsWith('screenshots_'));
            await chrome.storage.local.remove(keys);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'SAVE_SETTINGS': {
          await chrome.storage.local.set({ settings: msg.settings });
          await scheduleAlarms();
          sendResponse({ ok: true });
          break;
        }

        case 'GET_STORAGE_INFO': {
          const bytesInUse = await chrome.storage.local.getBytesInUse(null);
          sendResponse({ ok: true, bytesInUse });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true;   // keep message channel open for async response
});
