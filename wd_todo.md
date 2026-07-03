# WinnersDice — Todo / Known Issues

## Known Issues / Limitations

- **Safeword handler: first live test did not work as expected** — needs debugging. Check whether the `SafewordUsed` socket event is actually firing, or whether the Action message pattern matching is off.

- **Buyback: no wardrobe detection on re-equip**
  BC's ChatRoomSyncSingle fires on wardrobe changes but cannot distinguish clothing being *added* vs *removed*. When a player buys back their item, there's no way to detect them putting it back on. Buyback flow skips wardrobe monitoring — player just re-equips on their own after payment. If we ever find a BC API event that signals item equipped, revisit this.

---

## Queued Features / Changes

- **Banking + clothing menus whisper-only**
  All bank menus (continue/spend/endgame), spend menus, and clothing negotiation messages should be sent via whisper, not public chat. Currently some of these go to chat.

- **Clothing offer confirmation to buyer**
  After a clothing offer is sent to the opponent for approval, the buyer gets no feedback. Add a whisper to the buyer immediately: "⏳ Your offer for [item] at [price] pts has been sent to [Opponent]. Waiting for their response..."

- **Post-wardrobe-change options prompt**
  After the game unpauses (wardrobe change detected), neither player gets told what happens next. After announcing "[Opponent] handed over [item]! Game resumes.", immediately whisper the current player their available options (e.g. the spend menu again if they're still in a spend session, or the continue/endgame prompt if they were post-bank).

### Negotiation Deadlock — Forced Sale
- After 2 rounds of back-and-forth counter offers with no agreement, bot intervenes with a forced sale
- Forced sale price = highest number offered during the negotiation × configurable multiplier (default 2×)
- Buyer gets the item at that price; deal closes automatically (no further negotiation)
- Admin commands:
  - Toggle to disable forced-sale and revert to current behavior (negotiation just ends with no sale): `!setnegotiate off` / `!setnegotiate on`
  - Set the multiplier: `!setmultiplier 2` / `!setmultiplier 2.5` / `!setmultiplier 3` (options: 2×, 2.5×, 3×)
- Both settings configurable per game session by admin
- Design concerns to resolve before implementing:
  - **Winner abuse**: buyer could lowball intentionally (e.g. offer 1 pt) just to trigger the forced sale at 2× = 2 pts, effectively stealing the item
    - Possible guard: forced sale price must meet a minimum floor (e.g. original asking price, or a bot-set minimum based on item tier)
  - **Loser abuse**: seller could counter with an absurdly high number they know the buyer can't afford, hoping to make the forced sale price unreachable
    - Possible guard: forced sale price is capped at buyer's current spendingBalance, or counter offers above a reasonable ceiling are rejected by the bot
  - These edge cases need design thought before coding — DW to revisit

_(add items here as they come up during playtesting)_

---

## Reminders / Pending Tests

- Test safeword in BD (StripDiceBot) — verify BD's Action message pattern catches the safeword event and triggers full bondage removal + game stop.
- Re-test safeword in WD after debugging.
- Test permission pre-flight: join a game with AllowItem disabled in BC settings and verify the bot blocks the challenge with the correct whisper message.

---

## Completed

- Shared pot model (one pot, winner takes all on bank)
- Streak + Boost two-component system (streak resets on loss, boost -1 per loss)
- Real-time balance tracking across multi-purchase spend sessions
- Balance enforcement before any purchase
- Wardrobe block on clothing deal (game pauses until ChatRoomSyncSingle fires)
- Buyback (2× price, 50/50 split, no wardrobe block on re-equip)
- Streak Boost purchase tiers (+1–+5)
- Natural 20 / Rolling 1 special outcomes
- Conversational commands (yes/no/counter without !)
- Round vs roll distinction + round multiplier
- Bot or self-roll mode

---

## Code Cleanup

_Source: `bc_bot_framework_report.md` prioritized action list (§5). Live-risk items first — fix these before the framework extraction (see `StripDiceBot/todo_framework.md`)._

### Live risk — fix first
- [ ] **Wrap unprotected `fs` calls in try/catch and log failures**: `saveFeedbackStatus()` (`game.ts:1993-1995`), `savePlayerRecords()` (`game.ts:2094-2096`), `handleFeedback()`'s `fs.appendFileSync` (`game.ts:1907`), `checkPendingUpdate()`'s `fs.unlinkSync` (`game.ts:2169`) — match BD's pattern. Because the top-level `unhandledRejection`/`uncaughtException` handlers call `process.exit(1)`, a single transient disk error during something as routine as saving a feedback note currently kills the whole bot mid-match for every player in the room.
- [ ] **Fix `logger.ts` double timezone-shift bug** — `log()`/`logError()` (`logger.ts:16-17, 20-21`) call `.toLocaleTimeString()` on a `Date` already shifted by `centralNow()`, re-applying the host machine's local timezone on top. Port BD's `centralTimeString()` fix verbatim (`StripDiceBot/src/logger.ts:19-24`).
- [ ] **Fix feedback rejoin regression** — `notifyFeedbackStatus()` (`game.ts:1997-2026`) has no de-duplication, so a player with unresolved feedback gets the full "we're reviewing it" whisper every single time they rejoin the room. Port BD's `REVIEWING_FEEDBACK_STATUSES` + `reviewingAckDate` de-dup pattern (`StripDiceBot/src/game.ts:2639-2650`).

### Quick wins
- [ ] Deduplicate the room-config literal in `connection.ts`'s `joinRoom()` (139-155) and `makeRoomPrivate()` (157-176) using BD's existing `roomConfig()` helper pattern (`StripDiceBot/src/connection.ts:147-162`)
- [ ] Replace raw `console.error('[CRASH] ...', err)` in `index.ts`'s crash handlers (`index.ts:8-16`) with `logError()` so crash logs get the project's standard timestamp formatting like every other log line

### Medium effort
- [ ] Split `handleConversational()` (`game.ts:329-425`, ~96 lines) by game phase: in-progress clothing-deal dispatch, post-bank free-text answers, mid-negotiation counter-value capture, mid-negotiation numeric-proposal capture, plain-English yes/no/counter/roll synonyms
- [ ] Design and add a turn/inactivity timeout for "self" roll mode — `playRound()` (`game.ts:882-897`) and `handleRoll()` (`game.ts:899-935`) wait indefinitely if either player goes AFK, hanging the match. No existing BD pattern to port 1:1 (BD's turn timer is tied to its enum-based turn engine) — needs its own small design pass.
- [ ] Add `gamesLost` field + a `!leaderboard` command for parity with BD — `PlayerRecord` in `types.ts:231-239` currently has no `gamesLost`; BD's leaderboard command is at `StripDiceBot/src/game.ts:2564-2590`
- [ ] Add a top-of-file negotiation-protocol overview comment — `NegotiationState`, `nextNegotiationKey()`, `promptNextSetting()`, `handlePropose/Accept/Counter/Decline` are each commented locally, but nothing explains up front that three different sub-protocols cycle through the same state (yes/no toggles, propose/accept/counter/decline, final plain bot/self question)
