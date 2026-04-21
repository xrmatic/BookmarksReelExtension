/**
 * Bookmarks Reel – Popup Script
 *
 * Renders the screenshot gallery, handles hover-cycling through saved images,
 * per-bookmark toggle, immediate crawl requests, and the global auto-crawl switch.
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

const CYCLE_INTERVAL_MS = 1200;   // ms between image transitions while hovering
const SCREENSHOT_BATCH  = 5;      // bookmarks whose screenshots are loaded in parallel

// ─── State ────────────────────────────────────────────────────────────────────

let allBookmarks = [];
let settings     = {};

// Per-card cycle state: { bookmarkId → { screenshots, index, timer } }
const cycleState = new Map();

// ─── DOM helpers ──────────────────────────────────────────────────────────────

const $  = id  => document.getElementById(id);
const qs = sel => document.querySelector(sel);

const gallery      = $('gallery');
const loadingEl    = $('loading');
const emptyEl      = $('empty-state');
const statusBar    = $('status-bar');
const searchInput  = $('search');
const globalToggle = $('global-toggle');
const btnCrawlAll  = $('btn-crawl-all');
const cardTemplate = $('card-template');

// ─── Status helpers ───────────────────────────────────────────────────────────

let statusTimer = null;
function showStatus(msg, isError = false, duration = 3000) {
  statusBar.textContent = msg;
  statusBar.classList.remove('hidden', 'error');
  if (isError) statusBar.classList.add('error');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusBar.classList.add('hidden'), duration);
}

// ─── Message helper ───────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise((res, rej) =>
    chrome.runtime.sendMessage(msg, r => {
      if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
      if (!r?.ok) return rej(new Error(r?.error || 'Unknown error'));
      res(r);
    })
  );
}

// ─── Favicon URL ──────────────────────────────────────────────────────────────

function faviconUrl(pageUrl) {
  try {
    const origin = new URL(pageUrl).origin;
    // Chrome's built-in favicon service (MV3)
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(origin)}&sz=32`;
  } catch { return ''; }
}

// ─── Card building ────────────────────────────────────────────────────────────

function buildCard(bm) {
  const frag = cardTemplate.content.cloneNode(true);
  const card = frag.querySelector('.card');

  card.dataset.bookmarkId = bm.id;

  // toggle disabled state
  const isDisabled = settings.disabledBookmarks?.includes(bm.id);
  if (isDisabled) card.classList.add('disabled');

  // image wrap
  const wrap    = card.querySelector('.card-image-wrap');
  const img     = card.querySelector('.card-img');
  const counter = card.querySelector('.card-img-counter');
  wrap.classList.add('no-screenshot');
  img.alt = bm.title || bm.url;

  // metadata
  const favicon = card.querySelector('.favicon');
  favicon.src   = faviconUrl(bm.url);
  favicon.onerror = () => { favicon.style.display = 'none'; };

  const titleEl = card.querySelector('.card-title');
  titleEl.textContent = bm.title || bm.url;
  titleEl.href        = bm.url;

  const urlEl       = card.querySelector('.card-url');
  try { urlEl.textContent = new URL(bm.url).hostname; }
  catch { urlEl.textContent = bm.url; }

  // crawl toggle
  const toggle   = card.querySelector('.card-toggle');
  toggle.checked = !isDisabled;
  toggle.addEventListener('change', () => onToggleBookmark(bm.id, toggle.checked, card));

  // action buttons
  card.querySelector('.btn-crawl-one').addEventListener('click', e => {
    e.stopPropagation();
    onCrawlOne(bm.id, card);
  });
  card.querySelector('.btn-clear-one').addEventListener('click', e => {
    e.stopPropagation();
    onClearOne(bm.id, card, wrap, img, counter);
  });

  // hover cycling
  wrap.addEventListener('mouseenter', () => startCycle(bm.id, img, counter, wrap));
  wrap.addEventListener('mouseleave', () => stopCycle(bm.id, img, counter, wrap));

  gallery.appendChild(frag);
  return card;
}

// ─── Screenshot cycling ───────────────────────────────────────────────────────

function startCycle(bookmarkId, img, counter, wrap) {
  const state = cycleState.get(bookmarkId);
  if (!state || state.screenshots.length < 2) return;
  stopCycle(bookmarkId, img, counter, wrap);   // clear any existing timer

  let idx = state.index;
  const step = () => {
    idx = (idx + 1) % state.screenshots.length;
    state.index = idx;
    crossfade(img, state.screenshots[idx].dataUrl);
    counter.textContent = `${idx + 1} / ${state.screenshots.length}`;
  };

  state.timer = setInterval(step, CYCLE_INTERVAL_MS);
  cycleState.set(bookmarkId, state);
}

function stopCycle(bookmarkId, img, counter, wrap) {
  const state = cycleState.get(bookmarkId);
  if (!state) return;
  clearInterval(state.timer);
  state.timer = null;
  // Revert to most-recent screenshot
  if (state.screenshots.length > 0) {
    state.index = 0;
    img.src = state.screenshots[0].dataUrl;
    counter.textContent = state.screenshots.length > 1
      ? `1 / ${state.screenshots.length}`
      : '';
  }
}

function crossfade(img, newSrc) {
  img.classList.add('fading');
  setTimeout(() => {
    img.src = newSrc;
    img.classList.remove('fading');
  }, 150);
}

// ─── Load screenshots for a card ──────────────────────────────────────────────

async function loadScreenshots(bookmarkId) {
  const res = await sendMsg({ type: 'GET_SCREENSHOTS', bookmarkId });
  const shots = res.screenshots || [];

  const card  = gallery.querySelector(`[data-bookmark-id="${bookmarkId}"]`);
  if (!card) return;

  const wrap    = card.querySelector('.card-image-wrap');
  const img     = card.querySelector('.card-img');
  const counter = card.querySelector('.card-img-counter');

  if (shots.length > 0) {
    wrap.classList.remove('no-screenshot');
    img.src = shots[0].dataUrl;
    counter.textContent = shots.length > 1 ? `1 / ${shots.length}` : '';
    cycleState.set(bookmarkId, { screenshots: shots, index: 0, timer: null });
  } else {
    wrap.classList.add('no-screenshot');
    img.src = '';
    counter.textContent = '';
    cycleState.delete(bookmarkId);
  }
}

// ─── Action handlers ─────────────────────────────────────────────────────────

async function onToggleBookmark(bookmarkId, enabled, card) {
  try {
    await sendMsg({ type: 'TOGGLE_BOOKMARK', bookmarkId, enabled });
    card.classList.toggle('disabled', !enabled);
    if (!settings.disabledBookmarks) settings.disabledBookmarks = [];
    if (enabled) settings.disabledBookmarks = settings.disabledBookmarks.filter(id => id !== bookmarkId);
    else if (!settings.disabledBookmarks.includes(bookmarkId)) settings.disabledBookmarks.push(bookmarkId);
  } catch (e) {
    showStatus(`Error: ${e.message}`, true);
  }
}

async function onCrawlOne(bookmarkId, card) {
  showStatus('Capturing screenshot…', false, 15000);
  try {
    await sendMsg({ type: 'CRAWL_NOW', bookmarkId });
    await loadScreenshots(bookmarkId);
    showStatus('Screenshot captured ✓');
  } catch (e) {
    showStatus(`Crawl failed: ${e.message}`, true);
  }
}

async function onClearOne(bookmarkId, card, wrap, img, counter) {
  try {
    await sendMsg({ type: 'CLEAR_SCREENSHOTS', bookmarkId });
    cycleState.delete(bookmarkId);
    wrap.classList.add('no-screenshot');
    img.src = '';
    counter.textContent = '';
    showStatus('Screenshots cleared');
  } catch (e) {
    showStatus(`Error: ${e.message}`, true);
  }
}

// ─── Global crawl-all ─────────────────────────────────────────────────────────

btnCrawlAll.addEventListener('click', async () => {
  btnCrawlAll.disabled = true;
  showStatus('Crawling all bookmarks – this may take a while…', false, 60000);
  try {
    await sendMsg({ type: 'CRAWL_NOW' });   // fire & forget in background
    showStatus('Crawl started in the background ✓');
  } catch (e) {
    showStatus(`Error: ${e.message}`, true);
  } finally {
    btnCrawlAll.disabled = false;
  }
});

// ─── Global toggle ────────────────────────────────────────────────────────────

globalToggle.addEventListener('change', async () => {
  settings.enabled = globalToggle.checked;
  try {
    await sendMsg({ type: 'SAVE_SETTINGS', settings });
  } catch (e) {
    showStatus(`Error saving settings: ${e.message}`, true);
  }
});

// ─── Search / filter ─────────────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  const q = searchInput.value.toLowerCase().trim();
  gallery.querySelectorAll('.card').forEach(card => {
    const id  = card.dataset.bookmarkId;
    const bm  = allBookmarks.find(b => b.id === id);
    const txt = `${bm?.title ?? ''} ${bm?.url ?? ''}`.toLowerCase();
    card.style.display = (q === '' || txt.includes(q)) ? '' : 'none';
  });
});

// ─── Initialise ──────────────────────────────────────────────────────────────

async function init() {
  try {
    const res = await sendMsg({ type: 'GET_BOOKMARKS' });
    allBookmarks = res.bookmarks || [];
    settings     = res.settings  || {};

    globalToggle.checked = settings.enabled !== false;

    loadingEl.remove();

    const httpBookmarks = allBookmarks.filter(bm => {
      try { const u = new URL(bm.url); return u.protocol === 'http:' || u.protocol === 'https:'; }
      catch { return false; }
    });

    if (httpBookmarks.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    // Build cards
    httpBookmarks.forEach(bm => buildCard(bm));

    // Load screenshots in parallel (batched to avoid flooding storage)
    for (let i = 0; i < httpBookmarks.length; i += SCREENSHOT_BATCH) {
      const batch = httpBookmarks.slice(i, i + SCREENSHOT_BATCH);
      await Promise.all(batch.map(bm => loadScreenshots(bm.id)));
    }
  } catch (err) {
    loadingEl?.remove();
    showStatus(`Failed to load bookmarks: ${err.message}`, true, 10000);
    emptyEl.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', init);
