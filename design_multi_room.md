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
- Keeps casual outsiders out, nothing more.

### Locked

- BC room set to **Hidden + Locked** (admin-only entry and exit via BC room configuration).
- The bot controls the lock. Admins retain access at all times.
- **Entry window:** the room must be **unlocked** while players are traveling to it. The bot unlocks when it claims the handoff and invites the players. Once **both players are present**, the bot re-locks the room.
- **Safeword:** BC's native safeword lets players leave a locked room without needing the bot to intervene. This works for most players. BCX add-ons can block safeword — that's a player-side configuration choice outside the bot's control.
- **Future add-ons:** additional locked-room features TBD (e.g. stricter enforcement, room-specific rules).

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
   - Spectator → set room to Public
   - Private → set room to Hidden
   - Locked → set room to Hidden + Locked (unlock for entry window)
3. Whisper both players: "Your game room is ready — join [room name] to begin."

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
3. Configure room back to default state (Hidden, unlocked, ready for next match)
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

### Phase 3 — Room bot

8. On startup: configure BC room to default state (Hidden, unlocked)
9. Poll `handoffs/pending/`; claim with atomic rename
10. On claim: configure room for `roomType`, whisper players to join
11. Track player arrival; start match once both present; re-lock if locked type
12. At match end: write result, unlock room, resume polling

### Phase 4 — Spectator behavior

13. Monitor `onMemberJoin`; whisper non-players with rules summary + pointer to main room

### Phase 5 — PM2 ecosystem config

14. Write `ecosystem.config.js`; document startup in README

---

## Deferred / Future

- **Leash mechanic** — test whether BC leash-drag socket events interact with room transitions; could be used to "pull" a player into the game room instead of just whispering them. Not blocking anything.
- **Spectator participation** — spectators invited into service deals or end-of-game scenarios. Design TBD.
- **Multiple room bots** — add more entries to PM2 config + BC accounts. No code changes needed beyond secrets.ts.
- **bondage_usage.json / feedback_status.json ownership** — decide main-bot-only vs per-bot before Phase 3.
- **Entry timeout duration** — how long to wait for players to arrive before writing a disconnect result. TBD.
- ~~**Room type default**~~ — resolved 2026-07-16: defaults to Private on mismatch.
