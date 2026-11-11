# Colonist Session Collector

A no-build Chrome Manifest V3 extension for recording the network messages delivered to your own Colonist tab. Recordings stay in the extension's local IndexedDB until you explicitly export or delete them. There is no backend, telemetry, replay scraping, or gameplay automation.

## Choosing a branch

Two capture approaches are kept side by side until one is chosen:

| | `main`: page-hook injection (v0.1.3) | `experiment/debugger-capture`: Chrome debugger (v0.4.0) |
| --- | --- | --- |
| How it captures | Content scripts wrap the page's `WebSocket`, `fetch` and XHR | `chrome.debugger` reads CDP Network events; nothing is injected into the page |
| Starting | Automatic on every Colonist page load | Explicit **Start on this tab**, then refresh Colonist |
| Visible to the page | Yes: wrapped page APIs and a message bridge | No page changes, but Chrome shows a debugging banner (optional launcher hides it) |
| Permissions | `storage`, `unlimitedStorage` | adds `debugger`, `downloads`, `offscreen` |
| Saving | Stays in the extension until exported | Saved to Downloads as JSON on stop |
| Heartbeat/analytics filtering, game-gap checks | No | Yes |
| Validated against a full live game | Recordings used for PROTOCOL.md | Complete game from setup to result, plus worker-restart recovery |

## Install in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `collector` directory (the directory containing `manifest.json`).
4. Pin **Colonist Session Collector** using Chrome's extensions menu if desired.
5. Refresh any already-open Colonist tab. Start recording before joining a game so the initial state is included.

Recording is enabled by default. Injection is restricted to HTTPS `colonist.io` and its subdomains; capture additionally filters endpoints to HTTPS/WSS Colonist hosts. Lookalike hosts such as `colonist.io.example.com` do not match. The toolbar badge reads **REC** when recording is enabled globally, not a guarantee that the current tab is capturing.

Click the extension icon to pause/resume or open **Recordings**. The popup reports the current Colonist tab's saved and pending events, when available. On other sites it only provides access to saved recordings and the global setting.

## Inspect and export

1. Open **Recordings** from the popup.
2. Select a recording. One recording represents one page load, which may contain multiple games if Colonist navigates without reloading.
3. Click **Refresh** to load newly persisted events. Search matches metadata and decoded payload content.
4. Select an event to inspect decoded JSON/MessagePack and the original payload.
5. Click **Export JSON** to download the selected recording. Export reads the latest persisted data; it does not force an in-flight page buffer to flush. For a stable export, pause after the game finishes and wait for the popup's waiting count to reach zero. That count includes payloads still being encoded, queued events, and events whose storage write has not yet been acknowledged.

Pause/resume transitions are included in the event tape. A resumed or mid-game recording may lack the original board or earlier actions; it must not be treated as a complete replay. Reloading starts a separate recording. Existing recordings survive page closes and browser restarts; removing the extension removes its local storage. Pause recording or close the source tab before deleting an active recording, since subsequent events can recreate it.

## What is captured

| Source | Captured |
| --- | --- |
| Page-created WebSockets to Colonist hosts | Incoming and outgoing messages, connect/open/close/error metadata, per-connection IDs |
| Page `fetch` to Colonist hosts | Response bodies with JSON, MessagePack, octet-stream, or plain-text content types; method, status, URL and content type |
| Page XMLHttpRequest to Colonist hosts | The same response types and metadata; JSON response objects are serialized |

Binary WebSocket data is copied at observation time and exported as base64. Text remains text. HTTP bodies are observed through response clones so the game can consume the original responses normally. XHR JSON is the browser's parsed object serialized back to JSON; HTTP response bytes are the browser-visible body after HTTP decompression, not raw encrypted network packets.

Cookies and HTTP request/response headers are not collected, other than response content type. Credential-like URL query parameters are redacted. Raw payload bodies are intentionally not rewritten and can contain your private hand, chat, player identifiers, or authentication material supplied by the application. Treat exports as private session data and inspect them before sharing.

## Export format

```json
{
  "schema": "colonist-session-collector/v1",
  "extensionVersion": "0.1.3",
  "exportedAt": "2026-10-11T00:00:00.000Z",
  "session": {
    "id": "a-document-uuid",
    "tabId": 1,
    "pageUrl": "https://colonist.io/",
    "startedAt": "2026-10-11T00:00:00.000Z",
    "updatedAt": "2026-10-11T00:01:00.000Z",
    "eventCount": 1,
    "bridgeDropped": 0
  },
  "events": [{
    "sessionId": "a-document-uuid",
    "sequence": 1,
    "timestamp": "2026-10-11T00:00:00.000Z",
    "monotonicMs": 123.4,
    "transport": "websocket",
    "connectionId": "ws-1",
    "kind": "message",
    "direction": "incoming",
    "url": "wss://socket.svr.colonist.io/?version=2",
    "payload": { "encoding": "text", "data": "{\"type\":4}", "byteLength": 10 },
    "decoded": { "format": "json", "value": { "type": 4 } }
  }]
}
```

`sequence` is assigned when a message is observed, before asynchronous binary decoding; export sorts by that sequence. It is a recorder sequence, **not** Colonist's protocol sequence. Preserve any protocol sequence present inside payloads when building a future replay adapter. The decoder handles standard MessagePack types; large 64-bit integers, binary values, extension values, and non-finite floats use JSON-safe tagged objects. Unknown frames keep their original bytes and report a decoding error; a successful parse does not establish the game's schema.

Version 0.1.1 also recognizes the outgoing client header observed in the first real four-player recording. These events have `decoded.format: "colonist-client-msgpack"`, literal `headerBytes`, `route`, and the decoded body in `value`. This fallback runs only for outgoing Colonist WebSocket events and accepts the observed frame families; unknown variants remain binary. Existing recordings are decoded again when viewed/exported, so they do not need to be recorded again. Reload the extension in `chrome://extensions` and reopen Recordings to use the updated decoder. See [protocol observations](PROTOCOL.md) for the evidence and remaining unknowns.

Version 0.1.2 accepts alphanumeric game-server routes as observed in the second recording; they are not always numeric.

Version 0.1.3 includes unfinished payload encoding and unacknowledged storage writes in the popup's waiting count, and persists bridge-drop diagnostics even if no further events arrive.

## Boundaries and reliability

- This is an initial recording/reverse-engineering tool, not a verified game-state parser or evaluator. Protocol field meanings from the Discord notes remain hypotheses until checked against actual recordings.
- It observes top-frame page JavaScript. WebSockets/fetch inside Web Workers, Service Workers, unmatched frames, cached application state, or other execution contexts are not intercepted. Connections created before injection are not attached; refreshing after installation is essential.
- Images, media, document responses, HTTP request bodies, arbitrary third-party traffic, and WebTransport frames are not captured.
- Each individual payload is limited to 16 MiB. Larger payloads get an explicit `omitted` event rather than being silently truncated. Decode inspection additionally limits nesting and item counts; raw bytes remain available within the capture limit.
- Startup buffering is limited to 256 events / approximately 32 MiB of serialized content. The bridge queue is limited to 2,000 events / approximately 32 MiB. Overflow is reported in diagnostics/session metadata. Normal writes run in short batches, with retries and idempotent storage keys.
- Closing a tab/crashing can lose events still being decoded or delivered. Storage failures appear in the popup. There is no promise of a complete recording after a pause, missed startup, overflow, or crash.
- `unlimitedStorage` prevents the normal extension quota from being the immediate limit, but disk space/storage failures remain possible. No automatic deletion policy is applied; export and delete old sessions as needed.
- Page-context instrumentation and its message bridge are visible to the page, which can interfere with them. The bridge is not a trusted or tamper-proof audit source.

## Development and checks

No bundler or dependency installation is required to load the extension.

```powershell
node --test tests/*.test.mjs
```

The browser smoke test requires Playwright and its Chromium browser. It loads the unpacked extension in an isolated, temporary profile and mocks all HTTPS/WebSocket traffic. It does **not** contact Colonist, use your signed-in browser, or play a game.

```powershell
# If Playwright is installed normally:
node tests/browser-smoke.mjs

# Or point at an existing Playwright package:
$env:PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright'
node tests/browser-smoke.mjs
```

The smoke test checks text/binary WebSockets, byte-copy fidelity, pending Blob encoding, HTTP/XHR responses, endpoint scoping, pause/resume, duplicate-write safety, persistence after closing the source tab, decoded search, and the downloaded export. Test profiles and a screenshot are saved under ignored `tmp/`.

Private recordings belong outside Git. The ignore rules exclude `colonist-*.json`, local `recordings/`, `captures/`, `exports/`, `tmp/`, screenshots named `Screenshot*`, environment files and extension signing keys. Renaming a private capture to a different filename can bypass these rules, so review the file list before staging.

Implementation references: [Chrome content scripts](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts), [Chrome storage](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies). The page-world hook is used because [webRequest does not expose individual WebSocket messages](https://developer.chrome.com/docs/extensions/reference/api/webRequest).
