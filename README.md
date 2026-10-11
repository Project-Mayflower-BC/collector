# Colonist Session Collector — debugger experiment

Version **0.2.1**, on `experiment/debugger-capture`. The original page-hook collector is preserved on `main` at `86ad76c`.

This no-build Chrome Manifest V3 extension records messages from your selected Colonist tab using `chrome.debugger` and Chrome DevTools Protocol (CDP) Network events. It installs no content scripts, wraps no page APIs, and creates no page message bridge. Recordings stay in local IndexedDB until you export or delete them. There is no backend, telemetry, gameplay automation, or live advice.

**This is not a guarantee of undetectability.** Chrome normally displays its debugging notice while attached. An optional Windows launcher below uses Chrome's own startup flag to suppress that notice in a separate profile. Hiding the notice does not change what a website may observe about debugger attachment. This experiment has not established what Colonist checks. The `debugger` permission is broad at the browser level; application code restricts attachment to HTTPS `colonist.io` and its subdomains, and recorded endpoints to HTTPS/WSS Colonist hosts. The manifest cannot narrow the debugger permission to those hosts.

## Install and record

1. In `chrome://extensions`, enable **Developer mode** and **Load unpacked** this `collector` directory. If it is already installed, click **Reload** and accept the added debugger permission if prompted.
2. Refresh any Colonist tabs that were open with the old version. Old page hooks remain in an existing document until that document is reloaded.
3. Select your Colonist tab, open the extension popup, and click **Start on this tab**. Only one tab can be attached at a time. Recording does not start automatically.
4. **Refresh Colonist after starting, then join the game.** The recorder cannot recover traffic or reliably identify WebSockets created before attachment.
5. After the game, click **Stop recording** in the popup and wait for **0 waiting**. Stop releases the debugger. The **Capture while attached** checkbox pauses payload capture but keeps the debugger attached.
6. Open **Recordings**, click **Refresh**, select the session, and **Export JSON**.

The badge reads **REC** while attached and enabled, **PAUSE** while attached and paused, **ERR** after an unexpected interruption, and **OFF** after an intentional stop. Stop works from the popup even if another tab is selected. Navigating the attached tab outside HTTPS Colonist detaches automatically. Lookalikes such as `colonist.io.example.com` are rejected. Opening Chrome DevTools, cancelling Chrome's debugging notice, or closing the tab may detach the debugger; unexpected detachment produces a gap diagnostic. Start again explicitly after an interruption.

## Optional Windows launcher without the debugger banner

Chrome has a `--silent-debugger-extension-api` startup flag. The extension cannot set it itself. Run the optional launcher from PowerShell in this directory:

```powershell
.\Start-CollectorChrome.ps1
# For a Chrome installation outside the usual locations:
.\Start-CollectorChrome.ps1 -ChromePath 'C:\path\to\chrome.exe'
```

It opens a visible Chrome window with a separate profile at `%LOCALAPPDATA%\ColonistCollector\ChromeProfile`. It does not edit your normal Chrome shortcut, policies or profile. The flag suppresses debugger notices for **all extensions in that browser instance**, so this separate profile is intended for the collector. Close only that profile's windows before relaunching; Chrome can ignore new flags when reusing an already running profile. The script never closes browser windows automatically.

On the first run, load this unpacked extension in the new profile and sign in to Colonist there. Existing recordings remain in their original browser profile; they are not copied. Then start capture and refresh Colonist before playing. The launch flag does not fix disconnections or establish that capture is undetectable. Chromium implements the flag in its [debugger attachment code](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/debugger_api.cc).

## Unexpected stops and recovery

Version 0.2.1 fixes a recovery flaw in 0.2.0: a restarted background worker used to detach the debugger unconditionally. It now checks whether this extension still owns an allowed Colonist attachment and resumes that attachment. Persisted socket metadata is restored only when the page's document identity still matches. A gap marker always records the restart; lost in-memory events cannot be recovered. HTTP requests in flight at the restart may also be lost. If the document changed, refresh Colonist after recovery to capture existing socket endpoints and current state.

A connection check every 15 seconds while attached detects a lost debugger connection even if an `onDetach` event is missed. It reads the frame tree without evaluating code in the page. It stops when recording stops and does not attach to another tab or reconnect automatically after Chrome cancels a session.

Unexpected stops leave a red **ERR** badge. The popup shows the time, reason, and last payload time; the notice survives worker and browser restarts. Session metadata includes `endReason`, `stopCode`, `detachReason` where Chrome supplies one, and `interrupted`. The viewer can search and display diagnostic text directly. Chrome's detach reasons are coarse and may not establish the underlying cause.

If it stops during a game, open the popup to read the reason, and export the interrupted trace. Start a new recording explicitly and refresh Colonist if you want to capture the remaining game; the missing interval stays missing. No live-game export establishing the cause of the reported halfway stop has been supplied yet.

One recording represents one debugger attachment, including Colonist page reloads and potentially multiple games. Navigation, pause/resume, start, stop, and interruptions are recorded as diagnostics. A mid-game or resumed trace may lack earlier actions or the board. It is not automatically a complete replay.

## Inspect and export

The viewer searches decoded JSON/MessagePack and event metadata. Select an event to inspect the decoded value alongside its original captured representation. **Refresh** loads newly persisted events. Existing v0.1.x recordings remain readable.

Export and deletion of the current recording are blocked while it is attached or has pending work. The popup's waiting count includes HTTP body retrieval and storage writes that have not been acknowledged. Storage errors and queue drops are shown in the popup; diagnostics and drop totals are also visible in the viewer. Recordings survive page closes and browser restarts; uninstalling the extension removes its local storage.

## What is captured

| Source | Captured |
| --- | --- |
| WebSockets reported on the attached page target, to WSS Colonist endpoints | Incoming/outgoing text and binary messages; opcode, per-connection ID, connect/open/close/error metadata |
| HTTPS Colonist requests classified by Chrome as Fetch or XHR | JSON, MessagePack, octet-stream and plain-text response bodies; method, status, URL and MIME type |
| Collector lifecycle | Start, stop, navigation, pause/resume, interruptions and capture failures |

WebSocket opcode 1 is stored as text. Other opcodes are already base64 in CDP and are preserved as base64. Control messages, when reported, are labelled `control`, not game messages. CDP's frame events represent entire WebSocket messages. The byte-copy browser test checks outgoing typed-array data even when the caller immediately mutates the original array.

HTTP bodies come from `Network.getResponseBody` after completion. They are Chrome's browser-visible representation after HTTP decoding, not encrypted packets or guaranteed original wire bytes. Chrome can evict bodies or refuse retrieval; this is recorded as an explicit error. Request bodies, cookies, and headers are never persisted; only MIME type and HTTP status are selected from response metadata. No request interception or cache disabling is used by the extension.

Credential-like query parameters and URL userinfo are redacted. **Payload bodies remain unredacted** and may contain your private hand, chat, player identifiers or application authentication data. Keep exports private and inspect them before sharing.

## Export format and protocol

Exports retain `schema: "colonist-session-collector/v1"`, with `extensionVersion: "0.2.1"`. Sessions add `captureMode: "chrome-debugger"`, `captureDropped`, last activity/health times, and stop details after a stop. Events retain `sequence`, ISO `timestamp`, `transport`, `kind`, `direction`, `url`, and `payload`; WebSocket events additionally include `opcode` and Chrome's monotonic `cdpTimestamp` where supplied.

`sequence` is assigned at observation time, before asynchronous HTTP body retrieval; exports sort by it. It is the recorder's sequence, not Colonist's protocol sequence. Sequence gaps can result from queue overflow. Do not infer a game sequence from it.

The decoder supports JSON, standard MessagePack, and the observed outgoing Colonist client framing, including alphanumeric routes. Large integers, binary/extension values and non-finite floats have JSON-safe tags. Unknown frames retain their captured representation. Decoding success alone does not validate a game schema. See [protocol observations](PROTOCOL.md) for the two earlier real-game captures and screenshot validation; those captures used the baseline collector, not this debugger experiment.

## Limits and reliability

- This is a capture/reverse-engineering tool, not yet a rules-validated replay or blunder evaluator. No live Colonist game has yet been validated with this experimental version.
- Only the selected page target is attached. Same-process frame traffic reported on that target can appear; separate worker, service-worker, and out-of-process iframe targets are not auto-attached. WebTransport, document/image/media bodies, third-party endpoints, and cached application state are excluded.
- Payloads over 16 MiB are explicitly omitted. HTTP retrieval is limited to eight concurrent requests; additional bodies receive omission diagnostics. Chrome's configured HTTP buffers are 16 MiB per resource / 64 MiB total; these limits do not bound Chrome's entire memory usage or large WebSocket event delivery.
- The write queue is bounded to 2,000 events / approximately 32 MiB of serialized UTF-16 content, including unacknowledged writes. Overflow increments a persisted drop count even if no later traffic arrives. Storage retries use the same event keys and back off up to 30 seconds. HTTP/socket tracking maps are bounded to 2,000 entries each, with eviction diagnostics.
- Chrome 118+ keeps active debugger sessions alive in extension service workers. If the worker nevertheless restarts within the browser session, the recorder uses a session-storage ledger to verify and restore its existing attachment with a gap marker. It never automatically makes a new attachment after cancellation. Browser crashes/restarts reset that ledger and can lose pending events; a missing stop marker is not proof of a complete recording.
- Disk failures, closing Chrome, crashes, debugger interruption and body eviction can cause loss. The extension does not promise complete recording in these cases. `unlimitedStorage` avoids the ordinary extension storage quota but does not prevent disk failures. Export/delete old recordings as needed.
- No undetectability or ban avoidance has been tested or established. Removing page hooks removes those particular modifications; it does not prove that debugger capture is invisible.

## Development and tests

The extension itself has no build step or runtime dependencies.

```powershell
node --test tests/*.test.mjs
```

The browser smoke test requires Playwright with Chromium, `faye-websocket`, and Python with `cryptography` installed in your development environment. Its TLS certificate/key are generated in memory for that run; it does not modify a certificate trust store. Set the following variables only when using packages outside normal lookup paths:

```powershell
$env:PLAYWRIGHT_MODULE = 'C:\path\to\node_modules\playwright'
$env:TEST_PYTHON = 'C:\path\to\python.exe'
node tests/browser-smoke.mjs
```

The smoke test uses a fresh isolated profile and a loopback-only TLS/WebSocket fixture. Test-only DNS rules map Colonist hostnames to loopback, and the isolated browser accepts the ephemeral test certificate. It does not contact Colonist or use your signed-in profile. Tests exercise actual CDP text/binary events, fetch/XHR body retrieval, URL redaction, domain boundaries, pause/resume, bursts, same-site reloads, automatic detachment, explicit stop, unexpected target closure, persistent stop reasons, duplicate-write safety, search and downloaded exports. They also check native page API identities, the absence of the old marker/message bus, recovery checkpoints, and 65 seconds with the extension UI closed. Set `COLLECTOR_IDLE_MS` to change the idle-test duration. Unit regressions simulate worker restarts, changed documents, ownership loss and storage failures. Profiles and a viewer screenshot are saved under ignored `tmp/`. The optional launcher is syntax-checked separately; the browser fixture uses default debugger-banner behavior.

Private captures, screenshots and signing keys remain excluded by `.gitignore`. Review staged filenames before committing; renaming private data can bypass filename-based ignore rules.

References: [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger), [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [extension worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).
