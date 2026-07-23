# WinnersDice — Multi-Room Architecture Design

_Written 2026-07-16. Design TBD items are noted inline._

---

## Overview

The current single-bot setup handles negotiations and matches in one BC room. The multi-room architecture splits this into:

- **One lobby bot** — handles all challenges and negotiations. Never moves rooms. Once negotiation is complete, writes a handoff file and tells players which room to go to.
- **One (or more) room bots** — each lives permanently in its own private BC room. Polls for handoff files, claims a match, runs it, writes the result back. Always-on via PM2.

Starting with **1 lobby bot + 1 room bot**. The design is built to make adding more room bots straightforward.

---

## Bot Identity

Each process knows its role via a `BOT_ROLE` environment variable in `secrets.ts` and `index.ts`:

```
BOT_ROLE=main        → lobby bot
BOT_ROLE=gamebot1    → first room bot
BOT_ROLE=gamebot2    → second room bot (future)
```

Each bot logs in as a different BC account. The lobby bot uses the current DWGameBot credentials. Room bots need their own BC accounts (one per room bot).

---

## Handoff File Queue

All coordination happens through a shared file directory — no shared in-memory state, no direct inter-process calls.

```
WinnersDice/
  handoffs/
    pending/     ← lobby bot writes here
    claimed/     ← room bot atomically renames here on claim
    results/     ← room bot writes match outcomes here
    results/processed/  ← main bot moves files here after handling
```

`handoffs/` is gitignored.

### HandoffEntry (types.ts)

```typescript
interface HandoffEntry {
    id: string;                  // UUID or timestamp-based
    createdAt: string;           // ISO timestamp
    expiresAt: string;           // e.g. createdAt + 5 minutes
    players: {
        challenger: { memberNumber: number; name: string };
        opponent:   { memberNumber: number; name: string };
    };
    config: GameConfig;          // minRounds, stripping, bondage, toys, services
    roomType: "spectator" | "private" | "locked";
    startingBalances: { challenger: number; opponent: number }; // carried-over balance, if any — baked in here since pair_balances.json is lobby-bot-only
    claimedBy?: string;          // set to BOT_ROLE at claim time
}
```

### MatchResultEntry (types.ts)

```typescript
interface MatchResultEntry {
    handoffId: string;
    completedAt: string;
    winner: number;              // memberNumber
    loser: number;
    winnerPointsEarned: number;
    loserPointsLost: number;
    endReason: "normal" | "mercy" | "safeword" | "disconnect" | "reset";
    pairBalances: Record<string, number>;
}
```

---

## Room Types

Room type is chosen during negotiation (new question, added last in `NEGOTIATION_ORDER`). It sets both the BC room configuration and the bot's behavior toward newcomers.

### Spectator (Public)

- BC room set to **Public** (visible and joinable by anyone).
- When someone joins who isn't one of the two players, the bot whispers them a brief summary of the rules the players negotiated, and points them to the main lobby room for more info.
- Spectators should watch and not interfere unless invited by the players.
- **Future hook:** spectators may be included in service deals or end-of-game scenarios — design TBD.

### Private (Hidden)

- BC room set to **Hidden** (not listed in the room browser, can't be found by search).
- Players can come and go freely — no lock.
- **Room name is randomized** (decided 2026-07-16): being Hidden only keeps the room out of search/browse — anyone who's ever seen the exact name can still join it directly. Since there's no lock on this tier, the name is the only thing doing the work, so a static name is not enough. At claim time the room bot renames its room from the static base name (e.g. `"WD Room 1"`) to `"<base name>##"` — a random 2-digit suffix (00-99) appended with no separator, e.g. `"WD Room 142"` (decided 2026-07-16, simplified from an earlier space + 3-digit design after hitting BC's room-name length cap) — then renames it back to the plain base name once the match ends and the room is ready for the next handoff. Spectator and Locked keep the static base name — Spectator has no privacy to protect, and Locked's actual barrier is the room lock, not the name.

### Locked

- BC room set to **Hidden + Locked** (admin-only entry and exit via BC room configuration).
- The bot controls the lock. Admins retain access at all times.
- **Entry window:** the room must be **unlocked** while players are traveling to it. The bot unlocks when it claims the handoff and invites the players. Once **both players are present**, the bot re-locks the room.
- **Safeword:** BC's native safeword lets players leave a locked room without needing the bot to intervene. This works for most players. BCX add-ons can block safeword — that's a player-side configuration choice outside the bot's control.
- **Future add-ons:** additional locked-room features TBD (e.g. stricter enforcement, room-specific rules).

---

## Lobby Fallback (single-room-bot capacity)

Added 2026-07-18, while there's still only one room bot (`gamebot1`) — see "Multiple room bots" below. Since all three room types above hand off to that same room bot, only one match can run at a time no matter which type players pick, and a second couple negotiating in parallel would just queue in `handoffs/pending/` with no visible progress until the first match ends.

To use the lobby bot's own idle capacity in the meantime: right before the room-type question (`promptNextSetting`'s `key === null` branch, lobby bot only), the negotiation checks `listClaimedHandoffs().length > 0` — i.e. is the room bot already mid-match. If so, it asks both players (independently, like the consent question) whether they're OK playing right in the public lobby room instead of waiting. Either "no" cancels the match outright (no private fallback exists to offer). Both "yes" sets `playInLobby` on the negotiation, skips the room-type question entirely (moot — it's public lobby play either way), and `finishNegotiation()` calls `launchMatch()` directly instead of writing a handoff — the same code path the pre-multi-room single-bot build always used, kept alive today as `botRole !== "main"`'s fallback.

While that in-lobby match runs, the lobby bot's own `state.phase` is `"playing"`, so it can't negotiate a third challenge until it wraps up (same constraint the old single-bot build always had) — `!challenge` during that window gets a "match currently being played here" whisper instead of being silently ignored.

This whole mechanic becomes unnecessary once a second room bot exists — `listClaimedHandoffs()` would rarely find every room bot busy at once, and even those brief windows have a nowhere-else-to-go answer that's no worse than the queue behavior today.

---

## Full Flow

### 1. Negotiation (lobby bot)

Negotiation proceeds as normal through the existing `NEGOTIATION_ORDER`. A new final question is added:

> "What kind of room would you like? (1) Spectator — public, anyone can watch  (2) Private — hidden, just you two  (3) Locked — hidden and locked, admin-only access"

Both players answer independently; if they don't match, the bot defaults to Private and tells both players (decided 2026-07-16).

### 2. Handoff write (lobby bot)

After `finishNegotiation()`:
- Build `HandoffEntry` with player info, `GameConfig`, `roomType`, and expiry (5 min from now)
- Write to `handoffs/pending/<id>.json`
- Whisper both players: "A game room is being prepared — you'll receive an invite shortly."
- Lobby bot returns to idle; it does **not** call `startMatch()`

### 3. Claim (room bot)

Room bot polls `handoffs/pending/` every ~5 seconds.

On finding a file:
1. Check `expiresAt` — skip if expired
2. Attempt atomic `rename` to `handoffs/claimed/<id>.json`
3. If rename succeeds: this bot owns the match. Proceed.
4. If rename fails (file already gone): another bot claimed it — back off

### 4. Room setup (room bot)

After claiming:
1. Read handoff file
2. Configure BC room based on `roomType`:
   - Spectator → set room to Public, name stays the static base name
   - Private → set room to Hidden, **rename to `"<base name>##"` with a fresh random 2-digit suffix, no separator**
   - Locked → set room to Hidden + Locked (unlock for entry window), name stays the static base name
3. Whisper both players the room name to join (for Private, this is the freshly-generated randomized name — it isn't known ahead of time and isn't guessable from a previous match).

### 5. Player arrival (room bot)

Room bot monitors `ChatRoomSync`/`onMemberJoin` events:
- For each player that arrives, track presence
- For spectator rooms: whisper any non-player newcomers with spectator rules
- Once **both players are present**: if locked room, re-lock it. Start the match.
- **Entry timeout:** if one or both players don't arrive within N minutes (TBD), write a result with `endReason: "disconnect"` and unlock/reset the room

### 6. Match runs (room bot)

Match runs normally using existing game logic. Room bot does **not** write to `players.json` or `pair_balances.json` directly — those are owned by the lobby bot.

`feedback.log` (appendFileSync) is safe to write from any bot simultaneously.

`bondage_usage.json` and `feedback_status.json` — **decision pending:** main-bot-only or per-bot files.

### 7. Result write (room bot)

At match end (normal, mercy, safeword, disconnect, reset):
1. Write `MatchResultEntry` to `handoffs/results/<id>.json`
2. If locked room: unlock it
3. Configure room back to default state (Hidden, unlocked, static base name — undoes the Private random-suffix rename if one was applied)
4. Resume polling `handoffs/pending/` for next handoff

### 8. Result processing (lobby bot)

Lobby bot polls `handoffs/results/` periodically (same interval as room bot's poll, or slightly longer):
1. Read each result file
2. Update `players.json` (win/loss record)
3. Update `pair_balances.json`
4. Move result file to `handoffs/results/processed/`
5. Optionally whisper both players a match summary

---

## PM2 Configuration

Room bots are always-on — PM2 keeps them running. Lobby bot also managed by PM2.

```js
// ecosystem.config.js
module.exports = {
    apps: [
        {
            name: "lobby-bot",
            script: "build/index.js",
            env: { BOT_ROLE: "main" },
            error_file: "logs/lobby-error.log",
            out_file: "logs/lobby-out.log",
        },
        {
            name: "gamebot-1",
            script: "build/index.js",
            env: { BOT_ROLE: "gamebot1" },
            error_file: "logs/gamebot1-error.log",
            out_file: "logs/gamebot1-out.log",
        },
        // Add gamebot-2, gamebot-3 here when scaling up
    ]
};
```

Build once, then: `pm2 start ecosystem.config.js`

Adding a room bot = add a new entry here + a new BC account in secrets.ts.

---

## Shared File Ownership

| File | Owner | Notes |
|---|---|---|
| players.json | Lobby bot only | Written after result processing |
| pair_balances.json | Lobby bot only | Written after result processing |
| handoffs/ | Both | Lobby writes pending; room bot claims+results |
| feedback.log | Any bot | appendFileSync is safe concurrent |
| bondage_usage.json | TBD | Decision pending |
| feedback_status.json | TBD | Decision pending |

---

## Implementation Order

### Phase 1 — Foundation (new branch: `multi-room` off `dev`) — done 2026-07-16

1. ~~Add `BOT_ROLE` to `secrets.ts` and `index.ts`; branch behavior on it~~
2. ~~Add `HandoffEntry` and `MatchResultEntry` to `types.ts`~~
3. ~~Add helper functions: `writeHandoff()`, `claimHandoff()` (atomic rename), `writeResult()`~~
4. ~~Create `handoffs/` directory structure; add to `.gitignore`~~

### Phase 2 — Lobby bot changes — done 2026-07-16

5. ~~Add room type question to negotiation (`NEGOTIATION_ORDER`)~~
6. ~~In `finishNegotiation()`: write handoff instead of calling `startMatch()`~~
7. ~~Add results polling loop; update `players.json` and `pair_balances.json` from results~~

### Phase 3 — Room bot — built and live-tested 2026-07-16. Spectator + Private confirmed working; Locked does NOT actually lock yet (known gap, left in place — see wd_todo.md)

8. ~~On startup: configure BC room to default state (Hidden, unlocked)~~ — turned out to not need an explicit reset call; `joinRoom()`'s own `ChatRoomCreate` already establishes this baseline, and calling `configureRoomForMatch` any earlier (e.g. at construction) would fire before the room exists.
9. ~~Poll `handoffs/pending/`; claim with atomic rename~~ — `pollForHandoff()`, every 5s, only while idle and not already holding a claim.
10. ~~On claim: configure room for `roomType`, whisper players to join~~ — `setupClaimedRoom()`. The "whisper players to join" half turned out to need a round-trip: the room bot can't reliably whisper players who are still in the *lobby* room (BC whispers are room-scoped), so instead the room bot writes the resolved `roomName` back into the claimed handoff file, and a new lobby-bot-side poll (`relayClaimedRoomInvites()`, every 5s against `handoffs/claimed/`) picks it up and does the actual whispering once it's known.
11. ~~Track player arrival; start match once both present; re-lock if locked type~~ — `checkHandoffArrival()`, hooked into both `onMemberJoin` and `onRoomSync` (the latter covers both players already being present at a reconnect-triggered resync). 5-minute entry timeout (`expireHandoffEntry`) matches the handoff's own expiry window.
12. ~~At match end: write result, unlock room, resume polling~~ — `writeRoomBotResult()` + `resetRoomBotForNextMatch()`, called from every match-ending path (finishMatch, resolveMercy, safeword, disconnect-timeout, admin `!reset`) via a `this.activeHandoff` check, so `botRole === "main"`'s existing direct-play behavior is untouched.

**Corrections/additions made while building this that the earlier design text didn't cover:**
- `MatchResultEntry.winner`/`loser` are `number | null` (mirrors `finishMatch`'s existing tie handling) — a tie, or an aborted match (safeword/reset/disconnect), has no winner to credit. `pairBalances` is the authoritative score, not these two fields, and it's only populated for `"normal"`/`"mercy"` endings — safeword/reset/disconnect never save carryover, matching the single-bot convention already documented on `PairBalanceEntry`.
- Room bots now explicitly refuse `!challenge` (`"This room is reserved for a specific match..."`) — without this, a bystander in the room bot's own room could start a real negotiation there that would play out directly (old single-bot behavior) instead of through the handoff queue, since `WinnersDiceGame` is the same class for both roles.
- **Confirmed live 2026-07-16 — does NOT work:** `connection.ts`'s `configureRoomForMatch()` sends a `Locked: boolean` field in the `ChatRoomAdmin`/`Update` payload. The code ran correctly (claimed as `"locked"`, both players detected, the re-lock call fired), but BC silently ignored `Locked` the same way it ignored `Name` on a plain Update. Unlike the rename, leave+recreate isn't a viable fix here — both players are already in the room by the time it needs to lock, and leaving would very likely eject them. Left as a known gap (see wd_todo.md) rather than guessing again at another unverified field/mechanism; real fix needs the actual correct protocol call, which would need either real BC client/server source or inspecting live socket traffic from a manual lock via BC's own UI.
- **Confirmed live 2026-07-16 (Spectator test):** `ChatRoomAdmin`/`Update`'s `Visibility` field does take effect — Room 1 correctly went Public, and an uninvited third party found and joined it.
- **Confirmed live 2026-07-16 (Private test):** `ChatRoomAdmin`/`Update` does **NOT** rename an existing room — the `Name` field is silently ignored (the room stayed under its old name; players were told a room name that didn't exist). Fixed by giving Private its own path: `leaveRoom()` + `createRoom(newName)` instead of `configureRoomForMatch`, both when claiming a Private handoff and when resetting back to the static base name afterward. `leaveRoom()` (`ChatRoomLeave`) is itself unverified against this bot's own history — same caveat as `Locked`, needs a live test.
- **Confirmed live 2026-07-16:** BC room names are capped at exactly **20 characters** — `"WinnersDice Room 1 3"` (20 chars) works, `"WinnersDice Room 1 265"` (22 chars) fails with `"InvalidRoomData"`. `secrets.ts`'s gamebot1 `roomName` was shortened to `"WD Room 1"`, and the Private suffix simplified to 2 digits with no separator (`"WD Room 142"`, 11 chars total) — plenty of margin, and 00-99 is enough randomness at this scale. Next room bot follows the same pattern: `"WD Room 2"`. `resolveRoomName()` warns (doesn't block) if a final name ever exceeds 20 chars.

### Phase 4 — Spectator behavior

13. Monitor `onMemberJoin`; whisper non-players with rules summary + pointer to main room

### Phase 5 — PM2 ecosystem config

14. Write `ecosystem.config.js`; document startup in README

---

## Blocked-Lock Preflight + High-Security Fallback (2026-07-20)

The end game locks the loser with a `TimerPasswordPadlock`. If a player has that item in their `BlockItems` (`char.BlockItems.ItemMisc.TimerPasswordPadlock`), the lock silently fails and the whole claimed-time payoff breaks with no error. BC only broadcasts `BlockItems` at room-join, so the bot can't detect a mid-room change — but a mid-room *unblock* does take effect when the lock is actually applied (verified live 2026-07-20 via `!testcufflock`).

Flow:
- **Detect** right after the challenge is accepted (`handleChallengeAcceptAnswer` → `beginLockBlockCheck`), before the settings questions, so a problem is caught before anyone wastes time on the full Q&A. `hasPadlockBlocked(n)` reads the cached character's `BlockItems`.
- **Resolve gate** (`lockBlockStage`): each blocked player replies `unblock`/`!lockready` (they re-enabled it — trusted, since we can't re-detect and the apply just works) or `highsec` (request the alternative). High-Security needs **both** players' yes (`handleHighSecConsent`), per the game's consent rules.
- **High-Security end game**: `applyEndGameLocks` uses `buildHighSecurityLockProperty` — `LockedBy: "HighSecurityPadlock"`, `MemberNumberListKeys: "<bot>,<winner>"` (winner holds a key, can release any time), no password/timer. The bot's own `setTimeout → expireEndGame` still auto-removes it, same as the timer-password case.
- **Multi-room**: the decision happens on the lobby bot but the lock is applied on the room bot, so `useHighSecurityLock` rides in `HandoffEntry` (lobby sets it in `handOffMatch`, room bot reads it in `startClaimedMatch → launchMatch`).
- **Loser move-out consent** (`awaiting_loser_move_consent`, High-Security only): a High-Security lock has no visible timer and the bot can't reach the loser once they leave the room, so if the winner chose "move", the loser is asked (`closeEndGameDeal` → `handleLoserMoveConsent`) to confirm they're OK leaving (trusting the winner to unlock) or to keep the session in-room so the bot auto-releases. "No" overrides `location→stay`, `inRoom→true`.

Temp `!testcufflock [@name] [keyNumber]` admin command exists for verifying this — remove after live-testing the real feature.

## Deferred / Future

- **Leash mechanic** — test whether BC leash-drag socket events interact with room transitions; could be used to "pull" a player into the game room instead of just whispering them. Not blocking anything.
- **Spectator participation** — spectators invited into service deals or end-of-game scenarios. Design TBD.
- **Multiple room bots** — add more entries to PM2 config + BC accounts. No code changes needed beyond secrets.ts.
- **bondage_usage.json / feedback_status.json ownership** — still shared (both roles read/write the same path, since both processes run from the same directory). Not fixed — worst case is last-writer-wins on usage stats or a feedback dedup flag, not a functional break, so this stayed deferred rather than blocking Phase 3.
- ~~**Entry timeout duration**~~ — resolved 2026-07-16: 5 minutes, matching the handoff's own expiry window.
- ~~**Room type default**~~ — resolved 2026-07-16: defaults to Private on mismatch.
- **Live testing** — none of Phase 3 has been run against a real BC connection yet (claim race between multiple room bots, the room rename/lock calls, the arrival tracking, all of it). Needs a real test pass with `gamebot1` actually running before trusting this in front of players.
- **Found + fixed live 2026-07-17:** a claim that never resolves (room bot process killed/crashed mid-match, no `!reset`) leaves its `handoffs/claimed/` file behind forever — and every lobby bot restart re-whispered its (possibly stale) room name to both players again, since the "already relayed" tracking is in-memory only. Fixed two ways: `listPendingHandoffs()` now deletes expired pending entries instead of leaving them to accumulate, and a room bot reaps its own orphaned claims (writes an aborted `"reset"` result, resets the room) the first time it's idle after connecting.
