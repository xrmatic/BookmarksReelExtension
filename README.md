# Bookmarks Reel – Chrome Extension

A Chrome (Manifest V3) extension that builds a **screenshot gallery of your bookmarks**.

## Features

| Feature | Details |
|---|---|
| **Scheduled crawling** | Configurable interval (default 60 min). Crawls only when the browser has been idle for the configured threshold. |
| **Screenshot capture** | Opens each bookmark in a temporary off-screen window, waits for the page to load, and captures a JPEG screenshot. |
| **WASM compression** | A WebAssembly module (`wasm/compress.wasm`) pre-processes raw pixel data by quantising each RGB channel to 8 discrete levels, significantly reducing colour entropy before JPEG encoding. The final image is re-encoded at 25 % JPEG quality so that text is just barely readable while file size is minimised. |
| **Gallery popup** | Grid of screenshot cards. Hovering over a card cycles through all saved screenshots for that bookmark every 1.2 s. |
| **Per-bookmark toggle** | Each card has a mini-switch to opt that URL in/out of automatic crawling. |
| **Login-page detection** | Pages that redirect to login screens (detected by URL pattern and the presence of `<input type="password">`) are silently skipped. |
| **Storage management** | Max images per bookmark · max age in days · max total MB. Oldest screenshots are pruned automatically when limits are hit. One-click "Clear All" in Settings. |

---

## Installing

1. Clone or download this repository.
2. (Optional) Build the WASM module – see below.
3. Open **chrome://extensions**, enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.

---

## Building the WASM module

The compiled binary (`wasm/compress.wasm`) is already included. To rebuild from source:

```bash
# Install wabt (WebAssembly Binary Toolkit)
npm install -g wabt

# Compile
wat2wasm wasm/compress.wat -o wasm/compress.wasm
```

### What the WASM module does

`wasm/compress.wat` implements `applyCompressionFilter(ptr, len)`. It iterates over every byte of raw RGBA pixel data held in the shared linear memory and rounds each R, G, B channel to the nearest multiple of 32 (keeping alpha unchanged). This creates only 8 × 8 × 8 = 512 unique RGB colours instead of 16 million, dramatically improving JPEG compression ratios while preserving enough structure for the image to remain recognisable.

---

## File structure

```
manifest.json          Chrome extension manifest (MV3)
background.js          Service worker – crawling, compression, storage
popup.html / .js / .css   Gallery popup
options.html / .js / .css Settings page
wasm/
  compress.wat         WASM source (WebAssembly Text Format)
  compress.wasm        Compiled binary (checked in for convenience)
icons/
  icon16.png  icon32.png  icon48.png  icon128.png
```

---

## Permissions used

| Permission | Reason |
|---|---|
| `bookmarks` | Read the user's bookmark tree |
| `tabs` / `windows` | Open temporary windows for screenshots |
| `idle` | Detect when the browser has been idle |
| `storage` | Persist screenshots and settings |
| `alarms` | Schedule periodic crawls |
| `scripting` | Inject login-detection script into loaded pages |
| `<all_urls>` (host permission) | Open any bookmarked URL in a temporary window |
