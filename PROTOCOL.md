# Protocol observations

Evidence: the first local export recorded on 2026-10-11 UTC, containing one human and three bots in a four-player base game. The private export is kept outside the repository. These observations apply to that recording; numeric identifiers and layouts may change across Colonist versions or modes.

## Capture validation

- 2,480 recorder events over approximately 11 minutes 56 seconds; recorder sequences 1–2,480 are continuous. No omitted payload, capture error, pause, or reported bridge drop appears.
- One WebSocket connection to `wss://socket.svr.colonist.io/?version=2`; 1,580 incoming messages and 870 outgoing messages. The recording ends with the connection still open.
- All incoming WebSocket bodies decode: 1,578 MessagePack envelopes and two JSON messages. After adding client-header support, all 870 outgoing bodies also decode. Successful decoding is separate from interpreting an action correctly.
- The incoming game channel has `id: "130"` (a string here), with 883 consecutive `data.sequence` values, 1–883. It includes the initial state and the end-game result. This supports completeness of this game's numbered channel; it does not prove the hook covers every browser execution context.
- The export contains 21 XHR and seven fetch responses as well, including unrelated-to-game assets such as translations. Consumers should select game messages explicitly.

## Incoming game envelopes

```text
{ id: "130", data: { type, payload, sequence } }
```

| Type | Observed contents |
| --- | --- |
| 4 | Initial `payload.gameState`, `playerColor`, `playOrder`, `playerUserStates`, `gameSettings`, `gameDetails` |
| 91 | 405 incremental updates in `payload.diff`, plus `timeLeftInState` |
| 45 | `payload.endGameState`, replay-availability flag and ranking metadata |

The initial map has 19 hexes, 54 corners, 72 edges and nine ports with coordinate fields. Subsequent map updates use these indexed objects and often omit coordinates. Retain the initial map when applying updates. Arrays such as card lists must be replaced rather than merged element by element. Deletion/null semantics for every state field have not been verified.

The state updates cover placements/buildings/roads, dice, turn/action state, robber location, resource cards, bank cards, development cards, trades, structured game logs, and chat. Not every server message is a state update: available choices, animations and other notifications are also present.

## Outgoing client framing

All outgoing binary messages in this recording follow this observed layout:

```text
[headerByte0, headerByte1, routeByteLength] + UTF-8 route + MessagePack body
```

| First two bytes | Route | Body shape |
| --- | --- | --- |
| `[2, 2]`, `[2, 10]`, `[2, 11]`, `[2, 12]` | `lobby` | Lobby actions or requests |
| `[2, 7]` | `lobby` | Numeric `{ action, payload }` lobby requests; observed in the debugger capture below |
| `[3, 1]` | Server route (numeric in the first sample; alphanumeric in the second) | `{ action, payload, sequence }` |
| `[4, 8]` | Empty | `{ id: "136", data: { timestamp } }` |

There are 178 game-action frames, 681 heartbeat frames and 11 lobby frames. Game-action frames also include transient interaction messages, so 178 is not a count of strategic decisions. Header-byte meanings and most action-enum meanings remain unverified. Keep their literal values rather than guessing names. Correlation with subsequent state changes is needed to distinguish a preview, request, rejected action and accepted action.

## Hidden information and hindsight

The recording preserves the player's information boundary even in this bot game:

- The human's resource-card arrays contain resource IDs 1–5; every nonempty opponent resource-card array observed contains only `0` placeholders. Their lengths expose card counts, not resource identities.
- Opponent development-card arrays use `10` placeholders; the human's observed development cards contain actual IDs `11` and `12`. The bank's development deck also contains placeholders, not its true order.
- Structured logs expose public resource gains and trades. A robbery between two opponents is represented with a hidden card back; robberies involving the human include that player's private result. Resource tracking therefore needs uncertainty after private events.
- A single chat entry occurs; this sample does not validate negotiation, promises, deception, or human table-targeting analysis.
- End-game statistics include dice totals, per-player resource/activity totals, victory-point categories and a winner. Keep post-game information separate from the information available when grading a decision.

The result marks the human as the winner. It reports 62 turns including setup; structured logs contain 54 dice rolls. Settings include a 10-point target, discard limit seven, `diceSetting: 1` and `friendlyRobber: true`. The meaning of the numeric dice setting has not been verified, so a later RNG evaluator must resolve it before selecting a probability model.

This first sample validates useful raw capture and decoding. It does not yet provide a rules-validated replay, calibrated win probabilities, or defensible blunder grades. The second sample below adds multiplayer and screenshot checks; reconnect recordings are still needed.

## Second recording: screenshot validation

A second export from 2026-10-11 UTC was compared with three user-provided screenshots: the first placement, completed setup, and the finish. The screenshots were external checks; board reconstruction used captured payloads only.

- 3,584 continuous recorder events and 919 consecutive incoming game-channel messages. No reported bridge drops. Capture begins with a resume marker, but it precedes the game's initial snapshot; this game includes setup and its result.
- All 3,519 WebSocket message bodies decode with v0.1.2: 2,130 incoming and 1,389 outgoing. The second sample's server route contains a letter. The v0.1.1 numeric-only route check had unnecessarily left 185 outgoing game-action frames as binary; raw bytes were retained.
- All 19 resource/number hexes and nine port positions/types match the visible board. Axial projection uses `screenX = sqrt(3) * (x + y/2)` and `screenY = 1.5*y` for unit-radius pointy-top hexes. Corner `z=0` is north, `z=1` south; edge `z=0/1/2` is NW/W/SW. All 54 corners are unique and all 72 edges map to two valid corners.
- The first placement is orange at corner 41, adjacent to sheep-8, wheat-4 and ore-10, with road 53. It matches the first-placement screenshot.
- Completed setup at recorder event 416/server sequence 60 matches all eight settlements and eight roads. The initial robber is on desert hex 13.
- Four public starting grants match resources derived independently from each player's second-settlement geometry: red receives two wood and one sheep; gray receives brick, wheat and ore; blue receives wheat and wood; orange receives brick and wood. Coastal settlements correctly receive only two cards here.
- At the result, recorder event 3368/server sequence 916, the final map matches the finish screenshot, including the robber on brick-6 hex 15. Red has four settlements, two cities and 11 roads; blue two settlements, two cities and nine roads; orange three settlements, one city and five roads; gray one settlement, three cities and six roads.
- Color IDs in this sample are red=1, blue=2, orange=3 and gray=5. The recording player's color is blue=2. Red is the reported winner.
- The `gameChatState` patches contain 27 text messages, with content at `entry.text.message` and sender color at `entry.text.from`. Seventeen are from blue and ten from orange. Blue's outgoing chat frames use action 0 and are echoed into the incoming chat state, so a future transcript builder must avoid double-counting outgoing requests and incoming echoes. Some incoming messages contain HTML entities; render decoded text safely rather than inserting payload HTML.

This second sample uses `diceSetting: 0`, `hideBankCards: true`, and `friendlyRobber: false`, unlike the first sample. All four initial `playerUserStates` have `isBot: false`; later disconnect/substitution behavior has not been fully interpreted. This gives additional protocol coverage but does not establish a bot-performance benchmark.

The local validation script and board diagrams are under ignored `tmp/`; neither private export nor screenshots are copied into the repository. The replay adapter still needs broader validation of reconnection/reset and null/deletion behavior before being treated as a general rules-validated replay.

## Debugger capture: complete game and analytics-only control

A v0.2.1 debugger export recorded on 2026-10-11 UTC contains 3,392 continuous recorder events, including 999 consecutive incoming game-channel messages numbered 1–999. The initial snapshot precedes the first placement, has no occupied corners, and includes 19 hexes, 54 corners, 72 edges and nine ports. The next map changes contain all eight setup settlements and eight setup roads. The trace includes 406 state diffs, ten chat text entries and a type-45 result at server sequence 998, followed by a final state update. Reported duration is about 17 minutes with 74 turns including setup. No capture errors, omitted payloads, drops or interruptions are reported. This is evidence of a complete numbered game channel, not a general guarantee across all targets or contexts.

Seventeen outgoing messages initially appeared as binary because their `[2, 7, 5]` header was outside the decoder's accepted families. Removing the three-byte header and five-byte `lobby` route yields valid MessagePack for all seventeen: seven numeric payloads, seven empty objects and three objects with `date` and `notificationCountToSend: 25`. All precede the first settlement placement. The latter likely request notifications; exact semantics of the other numeric action codes are unverified. v0.2.2 accepts this observed header without assigning action names. Original bytes remain unchanged, and existing local recordings are decoded afresh when viewed/exported.

A separate recording lasted about 16 minutes but contained only start/stop and eleven `/api/analytic-events` responses with value `true`. It had no WebSocket messages or navigation marker despite an attached, healthy debugger. The file does not establish the cause, but is consistent with attachment after an existing socket was created and no subsequent refresh. v0.2.2 warns when no socket data messages have been observed, and the viewer flags recordings containing none. This check does not prove receipt of setup or an end result when sockets are present. Both exports remain private and outside the repository.
