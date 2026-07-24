# WinnersDice — Matchmaking / Player Pool Design

**Status:** Design phase. Not yet implemented.

---

## Overview

A voluntary opt-in pool that lets registered players beep each other when someone is looking for a WinnersDice match. Registration is bidirectional — you can't use the beep system without also being available to receive beeps. Designed to grow the player community without requiring everyone to be in the WD room at the same time.

---

## Registration

### Commands

| Command | Description |
|---------|-------------|
| `!wd register` | Opt into the pool. Bot friends you to track online status. Confirms via whisper. |
| `!wd unregister` | Remove yourself from the pool. The bot keeps the BC friendship (harmless — see Friending) but stops beeping you. Confirms via whisper. |
| `!wd pause` | Temporarily mark yourself unavailable. You stay registered but won't receive beeps. |
| `!wd resume` | Mark yourself available again. |
| `!wd status` | Whispers your current registration status (registered, paused, strike count). |

Registration is done by whispering the bot **from inside the WD lobby room** — BC whispers are room-scoped, so the player has to be in the room with the bot to register/pause/etc. (This is a one-time action; after that, beeps reach them wherever they are.) The value of the pool is the beep notifications, not remote registration.

### What registration stores (`registered_players.json`)

```json
{
  "players": [
    {
      "memberNumber": 12345,
      "name": "Alice",
      "registeredAt": "2026-07-23T00:00:00Z",
      "paused": false,
      "earlyLeaveCount": 0,
      "blocked": false,
      "lastLookingAt": null,
      "lookingCooldownUntil": null
    }
  ]
}
```

### Friending (must be mutual)

Registration is **bidirectional friending**:

- On `!wd register`, the bot calls `addFriend(memberNumber)`.
- The bot then whispers the player to **friend the bot back** (MissyMissy2) — registration isn't fully active until they do. BC's friend list is mutual-gated, and the presence query (below) only reliably reports players once the friendship is mutual.
- On `!wd unregister`, the bot **does NOT unfriend** — it only removes the player from the pool (`registered_players.json`). See below.

We considered relying on one-directional friending (bot → player) but decided against depending on it: requiring the player to friend the bot back is an explicit, unambiguous opt-in and matches BC's mutual-gating. (Whether one-way friending alone would surface a player in the presence query is left untested on purpose — the design doesn't rely on it.)

**Decoupling friendship from pool membership (decided 2026-07-23).** The bot's friend list also serves the existing challenge-visibility feature (`handleFriendRequest` friends people back so they can see the bot). If unregister called `removeFriend`, it could silently break a friendship the player wants for that feature. So **pool membership and BC friendship are independent**: registration ensures the player is friended and adds them to the pool; unregister (and being blocked) only removes them from the pool. A stale friendship is harmless — beeps only go to players who are *registered + online*. The only cost is the friend list never auto-shrinks; if BC's friend-list cap is ever a problem, add an admin cleanup command. This avoids per-friendship "why were they friended" bookkeeping entirely.

---

## The `!looking` Command

Registered, non-paused, non-blocked players only. Must be used from inside the WD lobby room.

**What happens:**
1. Bot checks the player is registered, not paused, not blocked, and not on cooldown.
2. Bot beeps all other registered players who are currently online and not paused.
3. Bot starts a 3-minute early-leave timer for the caller (see Strike System below).
4. Bot whispers the caller how many players were beeped.

**Beep message sent to each registered online player:**

> [PlayerName] is in the WinnersDice lobby looking for a game! Reply to this message if you're heading over.

### Reply relay (bot-mediated)

The beep is sent **from the bot** (MissyMissy2), so when a recipient replies, the reply beep comes back to the *bot*, not the seeker. The bot relays it. This requires tracking the in-flight call:

```typescript
// One per active !looking call, keyed by seeker member number.
private activeLookingCalls: Map<number, {
    seeker: number;
    beeped: Set<number>;      // who we beeped on the seeker's behalf
    expiresAt: number;        // stop relaying after this (e.g. 10 min)
}> = new Map();
```

- On `!looking`, record `{ seeker, beeped, expiresAt }`.
- On an **incoming** `AccountBeep`, if the sender is in some active call's `beeped` set and the call hasn't expired, relay to that call's seeker:
  - **Seeker still in the lobby** → whisper: `💬 {ResponderName} replied to your game call: "{their message}"` (or `is on their way!` if the reply had no text).
  - **Seeker left the lobby** → beep the seeker instead (fallback), since a whisper can't reach them.
- The relay window (`expiresAt`, ~10 min) is independent of the 3-minute early-leave timer — someone may reply a few minutes after the beep goes out.

> **Build note:** the bot has never sent a beep or acted on an incoming one. `AccountBeep` is currently only logged (`listenAll`), not wired to game logic. Both directions (send shape, incoming-reply parsing) need a live check as the first build step — same "probe before trusting" approach as `!teststrip`/`!testonline`.

### Cooldown

- **Regular players:** 30 minutes between uses of `!looking`. Cooldown is stored in `lookingCooldownUntil`.
- **Admin accounts:** No cooldown — unlimited use, especially useful during testing.
- If a player tries `!looking` while on cooldown, the bot whispers how long is left.

---

## Strike System (Early Leave)

Discourages players from using `!looking` as a throwaway action and immediately leaving, which wastes the beeps sent to registered players.

### How it works

When a player uses `!looking`, a 3-minute timer starts. If they leave the WD lobby before the timer expires, that is an **early leave** and their `earlyLeaveCount` increments. If they stay for 3 full minutes, no action is taken.

| `earlyLeaveCount` after increment | Response |
|----------------------------------|----------|
| 1 | Silently tracked. No message yet. |
| 2 | **Warning 1** (on next `!looking` attempt): "Please stay at least 3 minutes after using !looking — people need time to see the beep and get to the room." |
| 3 | **Warning 2**: Same message plus "One more time and you'll be removed from the matchmaking service." |
| 4 | **Blocked**: Player is removed from the pool (but not unfriended — see Friending) and whispered an explanation the next time they interact with the bot. `blocked: true` also stops them re-registering until an admin `!wd unblock`s them. |

### Decay on good behavior (decided 2026-07-23)

A strike is earned by leaving early; it comes **off** by behaving well, so a one-off mistake doesn't stick forever:

- When a player uses `!looking` and **stays the full 3 minutes** (the timer expires without an early leave), decrement `earlyLeaveCount` by 1 (floored at 0).
- A `blocked` player (count 4) does **not** auto-recover this way — they're out of the pool and can't `!looking`, so they can't earn the good-behavior credit. Only an admin `!wd unblock` / `!wd clearstrikes` brings them back. (This is deliberate: blocking is the hard stop.)

**Notes:**
- The warning is delivered at the start of their next `!looking` call, not at the moment they leave. This avoids confusing timing.
- Admin accounts are not subject to strikes.
- The count persists across bot restarts in `registered_players.json`.
- `!wd clearstrikes @name` (admin) resets a player's count immediately if warranted.

---

## Online Status Tracking

**Verified 2026-07-23** via the `!testonline` probe: BC has **no passive friend-presence push**, but the account can *query* presence and it works well. `connection.queryOnlineFriends()` emits `AccountQuery { Query: "OnlineFriends" }` and BC replies with a single `AccountQueryResult` containing every online friend — member number, name, **and the room each is currently in**.

So presence is **pull, not push**: the bot queries on demand rather than maintaining a live set from events.

- On `!looking`, the bot calls `queryOnlineFriends()`, then beeps the intersection of {registered, not paused, not blocked} with {returned as online}.
- No `onlineRegisteredPlayers` set to keep in sync — the query is the source of truth at the moment `!looking` runs.
- Bonus: because the result includes each friend's current room, the bot can later tell whether an online player is already in another game/room if that's ever useful.

This resolves the original open question of "what if no one is online" — the query returns an empty (or self-only) list and the bot can tell the seeker directly.

---

## Persistence

`registered_players.json` is stored in the WD bot directory alongside `players.json` and `pair_balances.json`. It should be added to `.gitignore` (same policy as other player-data files — never committed).

---

## Admin Commands

| Command | Description |
|---------|-------------|
| `!wd pool` | List all registered players and their current status (online/offline, paused, strike count). Admin only. |
| `!wd clearstrikes @name` | Reset a player's early-leave strike count. Admin only. |
| `!wd unblock @name` | Remove a block and re-add a player to the pool. Admin only. |

---

## Open Questions

1. ~~**Reply handling:**~~ **Resolved 2026-07-23 — the bot relays.** When a registered player replies to the beep, the bot forwards it to the seeker as a whisper (falling back to a beep if the seeker has left the lobby). See "Reply relay" under The `!looking` Command for the session-tracking this requires. _(Note: the bot has never sent a beep or acted on an incoming one — both need a live check during the build.)_
2. ~~**What if no one is online?**~~ **Resolved 2026-07-23.** Presence is queryable (see Online Status Tracking), so `!looking` whispers the seeker the online count and, if it's zero, "No registered players are currently online right now."
3. ~~**Room requirement:**~~ **Resolved 2026-07-23.** `!looking` requires the caller to be in the WD lobby — the early-leave strike system depends on it, and whisper commands need in-room presence anyway. Registration is likewise in-room.
4. ~~**Strike reset on good behavior:**~~ **Resolved 2026-07-23 — strikes decay.** A strike comes off when the player behaves well (see Strike System); admin `!wd clearstrikes` can still wipe them manually.

### Beep behavior — VERIFIED 2026-07-23 (via `!testbeep`)
- ~~**Friending collision**~~ — Resolved: friendship is decoupled from pool membership (see Friending). No per-friendship bookkeeping.
- **Sending:** `connection.beep(memberNumber, message)` emits `AccountBeep { MemberNumber, BeepType: "", Message }`. Confirmed the beep arrives at the target **with the text**.
- **Receiving:** incoming beeps arrive as `AccountBeep` with keys `MemberNumber` (sender), `MemberName`, `ChatRoomSpace`, `ChatRoomName`, `Private`, `BeepType`, `Message`.
  - For a **human** beep, `Message` is a plain **string** (verified: `"test 3"`).
  - For an **addon** beep (e.g. `BeepType: "GGC_BEEP"`), `Message` is a structured **object** (a protocol payload). The relay must **ignore these** — only act when `typeof Message === "string"`.
- **Reply = a fresh beep to the sender.** A registered player replying to the bot's `!looking` beep produces a normal cross-account `AccountBeep` to the bot (same as a direct beep). So the relay reads `data.MemberNumber` + `data.Message` (string only).
- **Offline beep delivery** — not needed (we only beep online players); untested.

---

## Implementation Notes

- Add `beep(memberNumber, message)` to `connection.ts` (one `socket.emit("AccountBeep", ...)` call).
- `registered_players.json` is separate from `players.json` — registration persists across match resets.
- BC friend list has a server-side size limit (unknown exact cap, but should be fine for a small community pool).
- Build after the core WD feature set is stable, since this requires the bot to be running reliably before inviting people to depend on it.
