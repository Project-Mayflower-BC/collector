# Payload reference and traffic statistics

What a Colonist session sends and receives, how much of it there is, and what the collector stores. Companion to [PROTOCOL.md](PROTOCOL.md), which records how individual findings were validated.

**Evidence base:** 12 local exports recorded 2026-10-11 to 2026-11-02 with collector v0.1.0–v0.3.0. Eight of them contain a four-player base game; four contain no game (lobby browsing, analytics only, or a duplicate). Per-game figures below are averages over those eight games. Exports stay private and outside the repository; no usernames, tokens or chat text are reproduced here.

Enum meanings marked *inferred* come from consistent behaviour across games but have not been checked against the game's UI. Everything else was either validated against screenshots (see PROTOCOL.md) or is a literal observation.

## Typical game at a glance

| | Value |
| --- | --- |
| Game length (from the result) | 11–35 minutes, ~22 on average |
| Recorder events (v0.3.0, everything stored) | 2,480–5,784; ~3,900 on average |
| Export file (v0.3.0) | 3.7–5.8 MB, ~4.7 MB on average |
| Game-channel messages from the server | 749–1,250, ~970 on average |
| Outgoing game actions | 118–185, ~156 on average |
| Heartbeats (both directions) | 1,362–4,516, ~2,750 on average |
| v0.4.0 stored size, replayed over the same exports | 0.8–2.2 MB; 35–75% smaller |

## Traffic categories

Averaged per game. *Stored share* is each category's share of the exported JSON (which keeps raw bytes and a decoded copy). *Wire share* is its share of payload bytes as received.

| Category | Events/game (min–max) | Stored share | Wire share | v0.4.0 |
| --- | --- | --- | --- | --- |
| Outgoing heartbeat | 1,377 (681–2,258) | 22.8% | 7.9% | **Dropped**, counted |
| Incoming heartbeat | 1,377 (681–2,258) | 21.4% | 7.3% | **Dropped**, counted |
| Game state diffs (type 91) | 444 (346–551) | 16.5% | 19.6% | Stored |
| Static assets (`/dist/`, `/cdn-cgi/`) | 4 (0–12) | 14.4% | 34.0% | **Dropped**, counted |
| Profile, friends, ranked HTTP | 12 (0–41) | 6.4% | 13.9% | Stored |
| Other game messages | 201 (161–279) | 5.5% | 5.2% | Stored |
| Game UI hints (types 30–33, 80) | 325 (238–420) | 5.3% | 2.1% | Stored |
| Other HTTP (replay, user state, mode selector) | 2 (0–7) | 3.0% | 6.7% | Stored |
| Outgoing game actions | 156 (118–185) | 2.7% | 1.3% | Stored |
| Account and lobby socket messages | 18 (1–93) | 1.3% | 1.9% | Stored |
| `/api/analytic-events` | 18 (5–46) | 0.3% | <0.1% | **Dropped**, counted |
| Outgoing lobby requests | 11 (0–48) | 0.2% | 0.1% | Stored |
| Collector diagnostics | 9 (1–24) | 0.1% | — | Stored |

Dropped traffic is never written. Its counts (and, for heartbeats, byte totals) are kept in the export's `session.filtered`, for example `{ "heartbeat": { "count": 3204, "bytes": 110538 }, "analytics": { "count": 46, "bytes": 0 } }`. Heartbeats still update the connection-alive indicators. Analytics responses were always the literal `true`. Static assets are sprite-sheet coordinates and translation strings, identical across games.

## WebSocket connection

One socket, `wss://socket.svr.colonist.io/?version=2`. Server messages are MessagePack maps `{ id, data }`. Client messages use a framed layout (see *Outgoing* below).

### Incoming by channel id

| id | Per game | Shape of `data` | Meaning |
| --- | --- | --- | --- |
| `"130"` | ~970 | `{ type, payload, sequence }` | Game channel. `sequence` counts from 1 with no gaps in a complete capture. |
| `"136"` | ~1,377 | `{ timestamp }` | Heartbeat. Not stored from v0.4.0. |
| `"133"` | ~9 | `{ type, payload }` | Own account state: user id, karma, membership, coins, client version. |
| `"135"` | ~1 | `{ type, payload }` | Friends' online status. |
| `"137"` | ~5 (3 of 8 games) | `{ type, messageType }` | Lobby info messages, e.g. `infoMessageUpdated`. |
| `"139"` | ~1 (3 of 8 games) | `{ type, payload }` | Event or queue info: player count, mode, map, end date. |
| `"141"` | ~1 (4 of 8 games) | `{ type, errors }` | Queue access result. |
| none | ~1 | JSON text | Plain JSON notices outside the MessagePack envelope. |

### Game channel (`id: "130"`) message types

Ordered by how a game unfolds. *KB/game* is stored size.

| Type | Per game | KB/game | `payload` shape | Meaning |
| --- | --- | --- | --- | --- |
| 6 | 1.9 | 0.9 | boolean | First message of a game (sequence 1); appears again near the result. |
| 1 | 0.9 | 0.8 | `{ gameSettingId, shouldResetGameClient, databaseGameId, serverId, isReconnectingSession, reconnectToken }` | Game reset/connection (sequence 2). Contains a reconnect token: treat exports as private. |
| 59 | 1.9 | 0.9 | array, usually empty | Small notice that can precede the snapshot. |
| **4** | 0.9 | 13.3 | `{ playerColor, playOrder, gameState, playerUserStates, gameDetails, gameSettings, timeLeftInState }` | **Board snapshot** (sequence 3–4). The only complete state; later messages are diffs against it. |
| 78 | 0.9 | 0.5 | `{ isActive, hasUsedDisableRequest }` | Timer/10-second-rule state. |
| **91** | 444 | 480 | `{ diff, timeLeftInState }` | **State diff.** Merge objects; replace arrays. See below. |
| 28 | 59 | 51 | array of `{ owner, tileIndex, distributionType, card }` | Resource payouts after a roll (`distributionType` 1) or a second setup settlement (0). Arrives *before* that roll's log entry. |
| 43 | 109 | 69 | `{ givingPlayer, givingCards, receivingPlayer, receivingCards }` | Card transfer. Player `0` is the bank. Hidden cards appear as `0` (resource) or `10` (development card). |
| 30, 31, 32, 33 | 62–69 each | 30–33 each | array of indices, often empty | UI hints: which corners, edges or hexes the client may currently click. |
| 80 | 64 | 31 | null | UI hint; meaning unverified. |
| 13 | 1.0 | 1.2 | `{ title, body, selectCardFormat, … }` | Prompt: discard cards (count and valid cards). |
| 18 | 0.9 | 0.8 | `{ developmentCardUsed, selectCardFormat }` | Prompt: choose cards for a development card. |
| 20 | 1.0 | 0.9 | `{ developmentCardUsed, selectPlayerFormat, overrideText }` | Prompt: choose a player to rob. |
| 29 | 1.4 | 0.9 | `{ cancelButtonActive, playersToSelect, allowableActionState, isPirate }` | Prompt: select a player. |
| 27, 62, 63, 64, 68, 69, 70 | 0.5–4.6 | ≤2.2 | null or `{}` | Short notifications, meaning unverified. |
| 95 | 2.9 | 1.7 | `{ trigger, outcome, msAllocated }` | Timed-decision notice, e.g. `sevenRoll` / `placed`. |
| 77 | 2.4 (2 games) | 1.6 | `{ type, data }` | Unverified. |
| **45** | 1.0 | 8.4 | `{ endGameState, isReplayAvailable, rankedUserStates }` | **Result.** Totals for dice, resources, development cards, players and activity. Post-game information only. |

### Initial `gameState` (type 4)

Fifteen top-level sections: `diceState`, `bankState`, `mapState`, `currentState`, `tradeState`, `playerStates`, `gameLogState`, `gameChatState`, and one `mechanic…State` each for settlements, cities, roads, development cards, longest road, largest army and the robber.

- `mapState` holds 19 `tileHexStates` `{ x, y, type, diceNumber }`, 54 `tileCornerStates` `{ x, y, z, owner?, buildingType? }`, 72 `tileEdgeStates` `{ x, y, z, owner?, type? }` and 9 `portEdgeStates` `{ x, y, z, type }`.
- **The geometry is identical in every base game recorded:** the same coordinates for every hex, corner, edge and port index. Only hex `type`/`diceNumber` and port `type` vary. That is why a board can be rebuilt from play when the snapshot is missing.
- `playerStates[color]` holds `resourceCards.cards`, `victoryPointsState`, `bankTradeRatiosState`, `cardDiscardLimit`, `isConnected` and `isTakingAction`.

### State diffs (type 91): which sections change

Average diffs per game that touch each section; one diff often touches several.

| Section | Per game | | Section | Per game |
| --- | --- | --- | --- | --- |
| `gameLogState` | 296 | | `gameChatState` | 33 |
| `currentState` (turn, action state) | 268 | | `mechanicDevelopmentCardsState` | 29 |
| `tradeState` | 167 | | `mechanicRoadState` | 27 |
| `playerStates` | 159 | | `mechanicSettlementState` | 24 |
| `diceState` | 129 | | `mechanicLongestRoadState` | 17 |
| `bankState` | 121 | | `mechanicRobberState` | 17 |
| `mapState` | 50 | | `mechanicCityState` | 7 |
| | | | `mechanicLargestArmyState` | 1 |

Diffs are partial: `diceState` can arrive as `{ diceThrown: true, dice2: 3 }` with `dice1` unchanged. Track dice from the roll log entry (type 10) instead.

### Game log entries (`gameLogState[n].text`)

| Log type | Per game | Fields | Meaning |
| --- | --- | --- | --- |
| 47 | 122 | `playerColor, cardsToBroadcast, distributionType` | Resources received |
| 44 | 73 | — | Separator/turn marker |
| 10 | 65 | `playerColor, firstDice, secondDice` | Dice roll |
| 5 | 34 | `playerColor, pieceEnum, isVp` | Built a piece |
| 118 | 32 | `playerColor, wantedCardEnums, offeredCardEnums` | Trade offer |
| 11 | 17 | `playerColor, pieceEnum, tileInfo` | Placement on tile |
| 116 | 17 | `playerColor, givenCardEnums, receivedCardEnums` | Bank/port trade |
| 4 | 16 | `playerColor, pieceEnum` | Placed a piece (setup) |
| 1 | 10 | `playerColor` | Turn start |
| 16 | 9 | `playerColorThief, playerColorVictim, cardBacks` | Robbery between other players (cards hidden) |
| 115 | 8 | `playerColor, acceptingPlayerColor, givenCardEnums, receivedCardEnums` | Player trade accepted |
| 49 | 7 | `tileInfo` | Robber/tile event |
| 20 | 7 | `playerColor, cardEnum` | Development card played |
| 15, 14, 21 | 1–5 | `playerColor, cardEnums` | Card movements involving you (steal, discard) |
| 55 | 5 | `playerColor, cardEnums, areResourceCards` | Discard |
| 117 | 4 | `playerColorCreator, playerColorOffered, wantedCardEnums, offeredCardEnums` | Directed trade offer |
| 86 | 0.5 | `playerColor, amountStolen, cardEnum` | Monopoly result |
| 113, 114 | ≤0.5 | `playerColor, embargoedPlayerColor` | Embargo |
| 66, 68 | ≤1.4 | `achievementEnum` (and old/new color) | Longest road / largest army changes |
| 0, 22, 24, 45, 58, 60, 64, 73, 74, 87 | ≤1.8 | various | Rare; unverified |

Log type numbering is literal; names are *inferred* from field contents.

### Enums

| Field | Values |
| --- | --- |
| Resource card / hex `type` | 0 desert or hidden card, 1 wood, 2 brick, 3 sheep, 4 wheat, 5 ore (validated against screenshots) |
| Development card | 10 hidden; 11 knight *(inferred: triggers the rob prompt)*; 12 victory point *(inferred: never played)*; 15 year of plenty *(inferred: pick-two prompt)*; 13 and 14 are road building and monopoly, not yet told apart |
| Player color | Small integers 1–5; colors vary per game (for example red 1, blue 2, orange 3, gray 5 in one game) |
| Bank | Player `0` in card transfers |

## Hidden information

Checked across all eight games. Opponents' private information never reaches the client.

| | Your cards | Opponents' cards |
| --- | --- | --- |
| Resource hand | Real values 1–5 | Always `0`; only the count is visible |
| Unplayed development cards | Real values 11–15 | Always `10` |
| Development card bought | Revealed | `[10]` |
| Bank development deck | `10` placeholders; order not sent | |
| Robbery between two opponents | | `givingCards: [0]` (1–25 per game) |
| Robbery involving you | Real card | |
| Post-game replay (`/api/replay/data-from-game-id`) | Built for your view of the game (`eventsPerspectives`) | Still `0` and `10` |

What can legitimately be reconstructed is what an attentive player could track at a table: payouts, trades, bank trades, builds, discards, monopoly totals and played development cards. Hands are exact except after hidden robberies between opponents.

## Outgoing messages

```text
[headerByte0, headerByte1, routeLength] + route (UTF-8) + MessagePack body
```

| Header | Route | Per game | Body | Meaning |
| --- | --- | --- | --- | --- |
| `[4, 8]` | empty | ~1,377 | `{ id: "136", data: { timestamp } }` | Heartbeat. Not stored from v0.4.0. |
| `[3, 1]` | server id, e.g. `018F07` | ~156 | `{ action, payload, sequence }` | Game action |
| `[2, 2]`, `[2, 7]`, `[2, 10]`, `[2, 11]`, `[2, 12]` | `lobby` | ~11 | `{ action, payload }` or `{ type, … }` | Lobby, queue and notification requests |

Game actions by `action` code (average per game; payload shape observed):

| Action | Per game | Payload | | Action | Per game | Payload |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 9.6 | string (chat) | | 15 | 2.9 | number |
| 2 | 15.0 | boolean | | 16 | 1.6 | number |
| 3 | 2.6 | number | | 17–19, 21 | ≤1.5 | boolean/number |
| 5 | 2.4 | number | | 47 | 17.0 | boolean |
| 6 | 15.6 | boolean | | 48 | 2.5 | number |
| 7 | 1.6 | array of numbers | | 49 | 17.6 | `{ creator, isBankTrade, counterOfferInResponseToTradeId, offeredResources, wantedResources }` (trade offer) |
| 8 | 5.9 | array of numbers | | 50 | 23.4 | `{ id, response }` (trade response) |
| 9, 10, 14 | 1–3 | boolean | | 51 | 2.6 | `{ tradeId, playerToExecuteTradeWith }` (execute trade) |
| 11 | 3.9 | number | | 53, 64 | 1–2 | number/boolean |
| 12 | 2.6 | number | | 62 | 8.3 (2 games) | boolean |
| | | | | 66 | 7.8 | number or null |
| | | | | 69 | 0.4 | `{ reportReason, reportedPlayerColor }` |

Action names other than chat and trades are unverified. Correlate with the following state diff before naming them.

## HTTP endpoints

Stored size per game (averaged over all eight games, including games where the endpoint never appeared).

| Endpoint | Per game | KB/game | v0.4.0 |
| --- | --- | --- | --- |
| `/dist/locales/en_strings.{hash}.json` | 0.5 | 311 | Dropped (static) |
| `/api/profile/{user}/history` | 0.8 | 160 | Stored |
| `/dist/assets/game_spritesheet_{n}.{hash}.json` | 3.8 | 109 | Dropped (static) |
| `/api/replay/data-from-game-id` | 0.3 | 73 | Stored: full game history from your view, including the initial board |
| `/api/mode-selector` | 0.8 | 12 | Stored |
| `/api/analytic-events` | 18.3 | 9 | Dropped (analytics) |
| `/api/profile/{user}/ranked/{season}` | 1.6 | 7 | Stored |
| `/api/profile/ranked-seasons` | 1.4 | 7 | Stored |
| `/api/profile/friends` | 1.1 | 6 | Stored |
| `/api/profile/{user}/overview` | 3.3 | 2 | Stored |
| `/api/profile/{user}/sticky-player-info` | 3.3 | 2 | Stored |
| `/api/user-state`, `/api/user-state/create` | 0.9 | 2 | Stored |
| `/api/profile-edit/*`, `/api/header/friend-requests-received` | <1 | ≤1.4 | Stored |
| `/data/rooms.json` | 0.3 | 1 | Stored |
| `/cdn-cgi/challenge-platform/…` | 0.1 | 0.1 | Dropped (static) |

## Capture completeness checks

From v0.4.0 the recorder checks the game channel as it records. The viewer runs the same check on any export, including older ones.

| Warning | Trigger | Seen in |
| --- | --- | --- |
| `late_start` | First game message has sequence > 1 and is not a snapshot | 1 of 8 games (first message was sequence 12) |
| `missing_snapshot` | A state diff, or 10 messages, before any type-4 snapshot | Same game |
| `sequence_gap` | Sequence jumps forward | 1 of 8 games: 147 messages lost in four gaps during background-worker restarts |
| `no_result` | Recording stopped after a game started but before type 45 | None of the eight games |

A navigation or a new socket starts a new stream, so reloads and consecutive games do not raise gaps. The warnings appear in the popup and as `game-warning` events in the trace; the running state is in `session.game`.

When the snapshot is missing, most of the board can still be inferred. Each type-28 payout gives a hex and its resource, and the next roll log gives the number. Tested on a complete game, this recovered 16 of 19 hexes with no errors; on the game that lacked a snapshot it recovered 18 of 19, with the remaining hex the desert. Port types follow from `portEdgeStates[i].owner` and the owner's `bankTradeRatiosState` changes, for ports someone builds on.
