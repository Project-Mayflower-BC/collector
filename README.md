# Colonist Session Collector — debugger experiment

Version **0.4.0**, on `experiment/debugger-capture`. The original page-hook collector is preserved on `main` at `86ad76c`.

This no-build Chrome Manifest V3 extension records messages from your selected Colonist tab using `chrome.debugger` and Chrome DevTools Protocol (CDP) Network events. It installs no content scripts, wraps no page APIs, and creates no page message bridge. When a recording stops, it is saved as a JSON file in your Downloads folder and cleared from the extension. IndexedDB only buffers the recording in progress, so a background-worker restart cannot lose it. There is no backend, telemetry, gameplay automation, or live advice.

**This is not a guarantee of undetectability.** The browser normally displays its debugging notice while attached. An optional Windows launcher below uses the browser's startup flag to suppress that notice in Chrome or Brave. Hiding the notice does not change what a website may observe about debugger attachment. This experiment has not established what Colonist checks. The `debugger` permission is broad at the browser level; application code restricts attachment to HTTPS `colonist.io` and its subdomains, and recorded endpoints to HTTPS/WSS Colonist hosts. The manifest cannot narrow the debugger permission to those hosts.

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

## Install and record

1. In `chrome://extensions`, enable **Developer mode** and **Load unpacked** this `collector` directory. If it is already installed, click **Reload** and accept the added debugger permission if prompted.
2. Refresh any Colonist tabs that were open with the old version. Old page hooks remain in an existing document until that document is reloaded.
3. Select your Colonist tab, open the extension popup, and click **Start on this tab**. Only one tab can be attached at a time. Recording does not start automatically.
4. **Refresh Colonist after starting, then join the game.** The recorder cannot recover traffic or reliably identify WebSockets created before attachment.
   The popup warns until it has observed WebSocket messages. Verify WebSocket entries in Recordings before playing; analytics responses alone do not contain gameplay. Captured messages are a connection check, not proof that the entire game has been recorded.
5. After the game, click **Stop recording** in the popup, or click **Cancel** on the browser's debugging banner. Either way the recording is saved as `colonist-<start time>-<id>.json` in Downloads, and the popup confirms the file name. Stop releases the debugger. The **Capture while attached** checkbox pauses payload capture but keeps the debugger attached.
6. To inspect a game, open **Recordings** and use **Open JSON file**. If a save ever fails, the recording stays in the extension; select it there and click **Save JSON & clear**.

The badge reads **REC** while attached and enabled, **PAUSE** while attached and paused, **ERR** after an unexpected interruption, and **OFF** after an intentional stop. Stop works from the popup even if another tab is selected. Navigating the attached tab outside HTTPS Colonist detaches automatically. Lookalikes such as `colonist.io.example.com` are rejected. Cancelling Chrome's debugging notice is a clean stop (stop code `banner_cancel`, badge **OFF**), so it works as a fallback when the popup will not open. Opening Chrome DevTools or closing the tab may also detach the debugger; that unexpected detachment produces a gap diagnostic. Every stop, expected or not, saves the events captured so far to Downloads. Start again explicitly after an interruption.

## Optional Windows launcher without the debugger banner

Chrome and Brave support the `--silent-debugger-extension-api` startup flag. The extension cannot set it itself. **Save your work and fully exit the chosen browser first**, including any empty collector windows. Run the optional launcher from PowerShell in this directory. Despite its filename, it automatically looks for both browsers (Chrome first, then Brave):

```powershell
.\Start-CollectorChrome.ps1
# Choose Brave when both browsers are installed:
.\Start-CollectorChrome.ps1 -Browser Brave
# For an installation outside the usual locations (also accepts -ChromePath):
.\Start-CollectorChrome.ps1 -BrowserPath 'C:\path\to\brave.exe'
# Optional: use the earlier separate collector profile instead:
.\Start-CollectorChrome.ps1 -Browser Brave -ProfileDirectory "$env:LOCALAPPDATA\ColonistCollector\BraveProfile"
# Check detection without opening a browser or creating a profile:
.\Start-CollectorChrome.ps1 -WhatIf
```

By default, it opens your regular browser using its normal profile selection, retaining that profile's extensions, sign-in and recordings. With multiple profiles, select the one where the collector is installed. The launcher no longer forces a new, empty profile. It does not edit browser shortcuts or policies. The flag suppresses debugger notices for **all extensions in that browser instance**. The script refuses to launch while that browser is already running because an existing instance can ignore new flags; it never closes browser windows automatically. `-WhatIf` previews detection and reports running instances without opening a browser. In Brave, manage the extension through `brave://extensions`.

An explicit `-ProfileDirectory` still opens a separate user-data directory. A new directory has no extensions or sign-in until you set them up there; recordings are not copied between profiles. Then start capture and refresh Colonist before playing. The launch flag does not fix disconnections or establish that capture is undetectable. Chromium implements the flag in its [debugger attachment code](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/debugger_api.cc), and Brave lists it in its [command-line flag reference](https://support.brave.app/hc/en-us/articles/360044860011-How-Do-I-Use-Command-Line-Flags-in-Brave).

## Unexpected stops and recovery

Version 0.2.1 fixes a recovery flaw in 0.2.0: a restarted background worker used to detach the debugger unconditionally. It now checks whether this extension still owns an allowed Colonist attachment and resumes that attachment. Persisted socket metadata is restored only when the page's document identity still matches. A gap marker always records the restart; lost in-memory events cannot be recovered. HTTP requests in flight at the restart may also be lost. If the document changed, refresh Colonist after recovery to capture existing socket endpoints and current state.

A connection check every 15 seconds while attached detects a lost debugger connection even if an `onDetach` event is missed. It reads the frame tree without evaluating code in the page. It stops when recording stops and does not attach to another tab or reconnect automatically after Chrome cancels a session.

Unexpected stops leave a red **ERR** badge. The popup shows the time, reason, and last payload time; the notice survives worker and browser restarts. Session metadata includes `endReason`, `stopCode`, `detachReason` where Chrome supplies one, and `interrupted`. The viewer can search and display diagnostic text directly. Chrome's detach reasons are coarse and may not establish the underlying cause.

If it stops during a game, open the popup to read the reason, and export the interrupted trace. Start a new recording explicitly and refresh Colonist if you want to capture the remaining game; the missing interval stays missing. The cause of the original reported halfway stop remains unconfirmed. A later live-game export validates capture from setup through the result; a separate analytics-only export demonstrates why refreshing after attachment matters.

One recording represents one debugger attachment, including Colonist page reloads and potentially multiple games. Navigation, pause/resume, start, stop, and interruptions are recorded as diagnostics. A mid-game or resumed trace may lack earlier actions or the board. It is not automatically a complete replay.

## Background worker restarts (0.3.0)

A live Brave session on 2026-10-19 lost its background worker eight times in 25 minutes while the debugger stayed attached. The first loss came 18 seconds after the start, while the page was reloading, so the game's WebSocket creation was never seen and every later game message was ignored. The popup also had to wait for each restart to finish before it could show anything. Brave left no crash report, and the trigger is still unknown. Version 0.3.0 tolerates these restarts:

- Debugger events that wake a stopped worker are held and replayed once recovery finishes, instead of being dropped.
- A socket first seen through its frames is recorded with `unverified: true` and `url: null`, and its messages are kept. The attached tab is still a verified Colonist page. Sockets rejected at creation stay excluded. The viewer counts unverified sockets as capture warnings.
- Each restart's gap marker records `workerDownSince` and how long the worker was gone. The trace also logs `tab` diagnostics when you switch away from or back to the Colonist tab in its window, so restarts can be compared with tab switches.
- The popup draws from stored state at once, and status requests no longer wait for recovery. While recovering, it shows **Reconnecting…** and Stop stays available.

Saving uses an offscreen extension document, because service workers cannot create blob URLs and data URLs are limited to about 2 MB. The local copy is deleted only after the browser reports the download complete.

## Filtering and game checks (0.4.0)

Version 0.4.0 stops storing traffic with no game or player information. This makes a typical game file 35–75% smaller, measured by replaying the filter over recorded games. See [PAYLOADS.md](PAYLOADS.md) for per-type counts and byte shares.

- **Not stored:** heartbeats in both directions (`{ id: "136", data: { timestamp } }`, about two per second), `/api/analytic-events`, and static assets under `/dist/` and `/cdn-cgi/` (sprite sheets, translation strings). Their counts are kept in `session.filtered`, and heartbeats still count as connection activity.
- **Still stored:** the game channel, outgoing actions, account and lobby socket messages, and all profile, friends, ranked, replay and user-state endpoints.
- **Game checks:** the popup shows a line such as `Game: 312 game messages · board snapshot ✓ · no gaps` and warns when the game channel started late, has no board snapshot, skipped server messages, or stopped before the result. Warnings are also written to the trace as `game-warning` events. The viewer runs the same check on older exports. If the snapshot is missing, refresh Colonist. A mid-game refresh is expected to make the server resend the full state, but no recording has confirmed this yet.
- **Decoding fix:** outgoing frames on sockets first seen mid-stream (`unverified`, no URL) now decode. Before, such a recording kept all its outgoing frames, including game actions, as binary. Raw bytes were always intact, so reopening an older export applies the fix.

## Inspect and export

The viewer searches decoded JSON/MessagePack and event metadata. Select an event to inspect the decoded value alongside its original captured representation. **Refresh** loads newly persisted events. Existing v0.1.x recordings remain readable.

Export and deletion of the current recording are blocked while it is attached or has pending work. The popup's waiting count includes HTTP body retrieval and storage writes that have not been acknowledged. Storage errors and queue drops are shown in the popup; diagnostics and drop totals are also visible in the viewer. An unsaved recording survives page closes and browser restarts; uninstalling the extension removes it, but not files already in Downloads.

## What is captured

| Source | Captured |
| --- | --- |
| WebSockets reported on the attached page target, to WSS Colonist endpoints | Incoming/outgoing text and binary messages except heartbeats; opcode, per-connection ID, connect/open/close/error metadata |
| HTTPS Colonist requests classified by Chrome as Fetch or XHR, except analytics and static assets | JSON, MessagePack, octet-stream and plain-text response bodies; method, status, URL and MIME type |
| Collector lifecycle | Start, stop, navigation, pause/resume, interruptions and capture failures |

WebSocket opcode 1 is stored as text. Other opcodes are already base64 in CDP and are preserved as base64. Control messages, when reported, are labelled `control`, not game messages. CDP's frame events represent entire WebSocket messages. The byte-copy browser test checks outgoing typed-array data even when the caller immediately mutates the original array.

HTTP bodies come from `Network.getResponseBody` after completion. They are Chrome's browser-visible representation after HTTP decoding, not encrypted packets or guaranteed original wire bytes. Chrome can evict bodies or refuse retrieval; this is recorded as an explicit error. Request bodies, cookies, and headers are never persisted; only MIME type and HTTP status are selected from response metadata. No request interception or cache disabling is used by the extension.

Credential-like query parameters and URL userinfo are redacted. **Payload bodies remain unredacted** and may contain your private hand, chat, player identifiers or application authentication data. Keep exports private and inspect them before sharing.

## Export format and protocol

Exports retain `schema: "colonist-session-collector/v1"`, with `extensionVersion: "0.4.0"`. Version 0.4.0 adds `session.filtered` (counts of traffic not stored), `session.game` (game-channel continuity state and warnings), and `game-warning` collector events with a `code`. Sessions add `captureMode: "chrome-debugger"`, `captureDropped`, last activity/health times, and stop details after a stop. Version 0.2.2 also records `webSocketMessageCount` (observed incoming/outgoing data messages, including those later dropped by the queue) and `lastWebSocketMessageAt`; older sessions may lack them. Events retain `sequence`, ISO `timestamp`, `transport`, `kind`, `direction`, `url`, and `payload`; WebSocket events additionally include `opcode` and Chrome's monotonic `cdpTimestamp` where supplied.

`sequence` is assigned at observation time, before asynchronous HTTP body retrieval; exports sort by it. It is the recorder's sequence, not Colonist's protocol sequence. Sequence gaps can result from queue overflow. Do not infer a game sequence from it.

The decoder supports JSON, standard MessagePack, and the observed outgoing Colonist client framing, including alphanumeric routes and numeric lobby actions with header `[2, 7]`. Large integers, binary/extension values and non-finite floats have JSON-safe tags. Unknown frames retain their captured representation. Decoding success alone does not validate a game schema. See [protocol observations](PROTOCOL.md) for the earlier screenshot validation and a complete live-game capture using this debugger experiment.

## Limits and reliability

- This is a capture/reverse-engineering tool, not yet a rules-validated replay or blunder evaluator. One live four-player game has been checked from the initial board through the result with consecutive server messages; this does not establish completeness for every game, browser context or reconnect scenario.
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
