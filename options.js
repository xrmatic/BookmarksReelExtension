/**
 * Bookmarks Reel – Options / Settings Page
 */

'use strict';

const DEFAULT_SETTINGS = {
  enabled:               true,
  crawlIntervalMinutes:  60,
  idleThresholdSeconds:  60,
  maxImagesPerBookmark:  5,
  maxImageAgeDays:       30,
  maxTotalStorageMB:     50,
  skipLoginPages:        true,
  disabledBookmarks:     [],
};

// ─── DOM ──────────────────────────────────────────────────────────────────────

const fields = {
  enabled:       document.getElementById('enabled'),
  crawlInterval: document.getElementById('crawlInterval'),
  idleThreshold: document.getElementById('idleThreshold'),
  skipLogin:     document.getElementById('skipLogin'),
  maxImages:     document.getElementById('maxImages'),
  maxAge:        document.getElementById('maxAge'),
  maxStorage:    document.getElementById('maxStorage'),
};

const notice        = document.getElementById('status');
const btnSave       = document.getElementById('btn-save');
const btnClearAll   = document.getElementById('btn-clear-all');
const storageBar    = document.getElementById('storage-bar-fill');
const storageText   = document.getElementById('storage-usage-text');

// ─── Notice helper ────────────────────────────────────────────────────────────

let noticeTimer = null;
function showNotice(msg, type = 'info', ms = 3000) {
  notice.textContent = msg;
  notice.className   = `notice ${type}`;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => notice.classList.add('hidden'), ms);
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

// ─── Populate form from settings object ──────────────────────────────────────

function applyToForm(s) {
  fields.enabled.checked       = s.enabled !== false;
  fields.crawlInterval.value   = s.crawlIntervalMinutes;
  fields.idleThreshold.value   = s.idleThresholdSeconds;
  fields.skipLogin.checked     = s.skipLoginPages !== false;
  fields.maxImages.value       = s.maxImagesPerBookmark;
  fields.maxAge.value          = s.maxImageAgeDays;
  fields.maxStorage.value      = s.maxTotalStorageMB;
}

// ─── Read form into settings object ──────────────────────────────────────────

function readForm(existing) {
  return {
    ...existing,
    enabled:               fields.enabled.checked,
    crawlIntervalMinutes:  Math.max(5,   parseInt(fields.crawlInterval.value, 10)  || 60),
    idleThresholdSeconds:  Math.max(15,  parseInt(fields.idleThreshold.value, 10)  || 60),
    skipLoginPages:        fields.skipLogin.checked,
    maxImagesPerBookmark:  Math.max(1,   parseInt(fields.maxImages.value, 10)       || 5),
    maxImageAgeDays:       Math.max(1,   parseInt(fields.maxAge.value, 10)           || 30),
    maxTotalStorageMB:     Math.max(5,   parseInt(fields.maxStorage.value, 10)       || 50),
  };
}

// ─── Storage meter ───────────────────────────────────────────────────────────

async function refreshStorageMeter(maxMB) {
  try {
    const r = await sendMsg({ type: 'GET_STORAGE_INFO' });
    const usedMB  = r.bytesInUse / (1024 * 1024);
    const limitMB = maxMB || DEFAULT_SETTINGS.maxTotalStorageMB;
    const pct     = Math.min(100, (usedMB / limitMB) * 100).toFixed(1);

    storageBar.style.width  = `${pct}%`;
    storageBar.style.background = pct > 80 ? '#d93025' : pct > 60 ? '#f29900' : '#4285f4';
    storageText.textContent = `${usedMB.toFixed(2)} MB used of ${limitMB} MB (${pct}%)`;
  } catch {
    storageText.textContent = 'Unable to read storage usage.';
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

let currentSettings = { ...DEFAULT_SETTINGS };

async function init() {
  try {
    const res = await sendMsg({ type: 'GET_BOOKMARKS' });
    currentSettings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
    applyToForm(currentSettings);
    await refreshStorageMeter(currentSettings.maxTotalStorageMB);
  } catch (e) {
    showNotice(`Failed to load settings: ${e.message}`, 'error', 8000);
  }
}

// ─── Save ────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  try {
    const updated = readForm(currentSettings);
    await sendMsg({ type: 'SAVE_SETTINGS', settings: updated });
    currentSettings = updated;
    showNotice('Settings saved ✓', 'success');
    await refreshStorageMeter(updated.maxTotalStorageMB);
  } catch (e) {
    showNotice(`Error saving: ${e.message}`, 'error');
  } finally {
    btnSave.disabled = false;
  }
});

// ─── Clear all ───────────────────────────────────────────────────────────────

btnClearAll.addEventListener('click', async () => {
  if (!confirm('Delete ALL saved screenshots? This cannot be undone.')) return;
  btnClearAll.disabled = true;
  try {
    await sendMsg({ type: 'CLEAR_SCREENSHOTS' });
    showNotice('All screenshots cleared ✓', 'success');
    await refreshStorageMeter(currentSettings.maxTotalStorageMB);
  } catch (e) {
    showNotice(`Error: ${e.message}`, 'error');
  } finally {
    btnClearAll.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', init);
