# WinnersDice — Todo / Known Issues

## HIGH PRIORITY

### Bugs that affect active play (fix before next live session)

1. **Spend-menu double-deal guards are inconsistent** — `clothing` has no guard at all; each spend option checks a different subset of active deals; `toys` misses `serviceDeal`. A buyer waiting on a counter-offer can accidentally open a second deal. Fix: all spend-menu paths should check for ANY active deal before proceeding.

2. **`!endgame`/`!bank`/`!press` don't block while a deal is in progress** — Service deals and mercy are explicitly blocked, but mid-clothing/bondage/lock/toy deals are not. Triggering `!endgame` mid-negotiation orphans the deal object in state while the match moves to end-game. Fix: add a `blockedByActiveDeal()` guard mirroring `blockedByServiceDeal()`.

3. **Clothing deal seller can't cancel** — If the seller (opponent) types `!cancel` or `0` mid-negotiation, nothing happens — no response, bot looks frozen. Every other deal type lets both sides cancel symmetrically. `handleCancel` has no `clothingDeal` branch; it falls through to `handleShopCancel` which only works for the buyer. Fix: add `handleClothingDealCancel` and wire it in.

4. **End-game execute/block leaks points** — `executeEndGame` and `blockEndGame` both deduct points from both players and credit them nowhere — they just vanish. Mercy explicitly conserves every point via `resolveMercy`. Fix: decide where those points go and implement once the end-game per-pair bank stub is done.

5. **Lock deal counter-offer prompts still say "removal price"** — The opening offer now correctly says "pay X to lock, removal costs 2×," but all four counter-offer re-prompts still say "what removal price would you like to counter with?" — a player countering 300 will think removal costs 300 when it'll cost 600. Quick fix: update the four prompt strings.

6. **Toy deal "loser can't decline" is bypassed by `!cancel`** — The design intentionally blocks a plain decline from the loser, but `handleCancel` lets the loser call `handleToyDealCancel` unconditionally — same effect, no charge. Fix: either block the loser from cancelling mid-negotiation, or drop the pretense and remove the "can't decline" message.

7. **Lock deal has no pre-offer affordability check** — Toy and service verify the proposer can afford their number before sending it to the other side. Locks only catch the shortfall at `finalizeLockDeal`, after a full back-and-forth. Quick fix: add the same check in `handleLockPriceChoice`.

8. **`onMemberLeave` has no game hook** — If a player disconnects mid-negotiation or mid-match, the game doesn't know. Nothing pauses or times out; the other player is left hanging indefinitely. `index.ts` only updates the room roster map — it never calls into `game.ts`.

### Existing high-priority items

9. Decide what to do about clothing — clarify role of clothing in the shop (buy/sell mechanic, pricing, etc.)
   - Key question on automatic strip: `removeItem(memberNumber, "Cloth")` uses the same socket event as bondage removal and should work for clothing slots. The unknown is whether BC's server will honor it from a bot that isn't whitelisted. Needs a live test — add a debug command (`!teststrip`) that calls `removeItem` on the Cloth slot to confirm.
10. Clean up help more — possibly context-sensitive help based on current game phase/menu state
11. **Price tracking** — track what prices items actually sold for during shop negotiations, so players and admins can see historical pricing data. Design TBD (could be per-session log, persistent file, or whisper on request via !prices).

---

## MEDIUM PRIORITY

1. **Clothing deal uses weak single-counter negotiation** — Bondage/lock/toy/service all use the shared 5-step engine with Rule A (first-counter cap) and Rule B (10%-gap-close floor). Clothing hand-rolls a single exchange: seller gets one counter, buyer can only accept/decline. `ClothingDeal` structurally lacks `negotiationStep`/`initiatorFloor`/`responderCeiling`. Consider upgrading to the shared negotiation engine.

2. **Dead code: `BondagePicker` class is never instantiated** — `bondagePicker.ts` is 1279 lines; ~950 implement a full "picker chooses restraints piece by piece" system (mode selection, slot consent, veto, popularity tracking, outfit logging) that is never used at runtime. `game.ts` only imports 4 small helpers/constants. Either wire it in or delete it.

3. **`!setstatus` can't set feedback to "declined"** — `validStatuses` omits `"declined"` even though `FeedbackItemStatus` includes it and it's a valid resolved state. Admin has to hand-edit the JSON file.

4. **`pendingChallengeDisambiguation` not cleared on reset/safeword** — It's a class field, not part of `GameState`, so it survives `!reset` and safeword. After a reset, a challenger's next message could be swallowed as a stale disambiguation answer.

---

## Known Issues / Limitations

- **Safeword handler: first live test did not work as expected** — needs debugging. Check whether the `SafewordUsed` socket event is actually firing, or whether the Action message pattern matching is off.

- **Buyback: no wardrobe detection on re-equip**
  BC's ChatRoomSyncSingle fires on wardrobe changes but cannot distinguish clothing being *added* vs *removed*. When a player buys back their item, there's no way to detect them putting it back on. Buyback flow skips wardrobe monitoring — player just re-equips on their own after payment. If we ever find a BC API event that signals item equipped, revisit this.

---

## Queued Features / Changes

- **Challenge acceptance prompt**
  When a player is challenged, the first thing the bot asks them is whether they accept the challenge (yes/no) before proceeding to any negotiation or game setup.

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

- **Context-sensitive `!help`**
  `!help` should respond based on current game phase rather than always showing the full help text.
  - Pre-game / idle: full help, possibly broken into submenus (like StripDiceBot's help is structured)
  - Mid-round (phase = `"playing"`, `awaitingDecision` is set): show roll/gameplay help only
  - Banking phase (`awaitingPostBank` is set): show banking options help only
  - Negotiation phase: show negotiation commands help only
  Reference BD's help subcommand structure in `D:\Games\BC-Bot\StripDiceBot\src\` for the submenu pattern.

### Toys — shop option for the active banker (future feature)
- The player currently in the bank (spending phase) can buy toys to use on their opponent
- Items include: vibrator, feather, BDSM implements
- Each toy has a point cost and a duration (time the toy can be applied/used)
- Similar to the bondage shop option, but for toys/implements rather than restraints
- Design questions still open:
  - Exact item list and BC asset names
  - Cost and duration values per item
  - Whether duration is in rounds or real time
  - Whether the toy gets removed automatically by the bot (like exclusive locks) or has a manual removal flow

_(add items here as they come up during playtesting)_

### End Game — Winner-Initiated (from bank/shop) — IMPLEMENTED
See `Completed` below — the 5-question proposal, up-to-5-step negotiation, block/execution flow, lock-time vote, timer/password lock, and safeword/reset teardown are all in `game.ts`. Remaining open items from the original design, now tracked as their own TODOs:

- **Per-pair points bank** — currently a stub (see "End game per-pair bank" below); points committed on execution/block are just deducted and logged, not persisted anywhere.
- **`!points` command** — not implemented; players currently only see balances via the whispers sent at the start of the end game proposal and inside the delivered proposal, not on demand.

- **End game anti-stalling**: consider requiring each counter to close at least 25% of the gap between the two sides' positions. Only implement if stalling becomes a real problem in playtesting.

- **End game save/resume**: when safeword or reset is called during active end game, consider saving the agreed terms so the session can be resumed later. Design TBD.

- **End game per-pair bank**: `executeEndGame()` currently just deducts both sides' committed points and logs a `[STUB]` line — implement the persistent per-pair points bank described above instead of discarding them.

- **End game timer/password lock slot**: `bc_items.json` has no literal "ItemLeash" BC group — `executeEndGame()`/`expireEndGame()` currently use `ItemNeckRestraints` + `CollarLeash` as a stand-in. Revisit once there's a clearer idea of what BC asset should represent the timer lock.

---

## Reminders / Pending Tests

- Test safeword in BD (StripDiceBot) — verify BD's Action message pattern catches the safeword event and triggers full bondage removal + game stop.
- Re-test safeword in WD after debugging.
- Test permission pre-flight: join a game with AllowItem disabled in BC settings and verify the bot blocks the challenge with the correct whisper message.

---

## Completed

### Completed Today (2026-07-09)
- Early shop announcements: all spend menu options (bondage, clothing, locks, toys, buyback, boost, services) now announce to the room when entered
- Standardized cancel/back: `0` backs out of any numbered menu, `0` cancels price entry, `cancel`/`!cancel` works in free-form text fields; service deal cancel bug fixed
- Toys picker redesigned to match bondage: popular list of 9 items + random fill, fuzzy match with confirm, `list` shows full catalog, `0` backs out
- Shop counter-offer rules: first counter capped at 2× if original offer > 500; subsequent counters must close gap by ≥10% when gap > 50 pts; bot shows minimum and auto-applies it if player goes below
- Max rolls per round: capped at 20 (`MAX_ROLLS_PER_ROUND` constant, easy to change)
- Merged endgame branch → master and dev; runtime files gitignored (players.json, wrapper.output, etc.)

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
- Wrap unprotected `fs` calls in try/catch and log failures: `saveFeedbackStatus()`, `savePlayerRecords()`, `handleFeedback()`'s `fs.appendFileSync`, `checkPendingUpdate()`'s `fs.unlinkSync`
- Fix `logger.ts` double timezone-shift bug (ported BD's `centralTimeString()` pattern)
- Fix feedback rejoin regression with `REVIEWING_FEEDBACK_STATUSES` + `reviewingAckDate` de-dup pattern (ported from BD)
- End game: 5-question winner proposal, up-to-5-step time negotiation with the loser, block/execution outcomes, a 30-second lock-time vote (loser(s) nudge the suggested duration ±5 min per vote before it's applied), timer/password lock on the loser's leash slot plus optional extra lock slots, and safeword/reset teardown (per-pair bank still a stub — see Queued Features)

---

## Minor / Polish

1. **`!help shop` bondage description is misleading** — currently says "you pay half goes to them" which reads like the payer only pays half. They pay the full price; the opponent receives half back.

2. **`EndGameProposal.winnerPointsCommitted`/`loserPointsCommitted` are set but never read** — presumably meant to feed a `!points` command or the per-pair bank stub. Either use them or remove them.

3. **Service deal doesn't disclose the 50/50 split to the seller** — Lock and toy both tell the responder "you'll receive X points (half)" upfront and at settlement. Service's proposal and finalization never mention the split — seller discovers it by checking their pending balance.

---

## Code Cleanup

_Source: `bc_bot_framework_report.md` prioritized action list (§5). Live-risk items first — fix these before the framework extraction (see `StripDiceBot/todo_framework.md`)._

### Quick wins
- [ ] Deduplicate the room-config literal in `connection.ts`'s `joinRoom()` (139-155) and `makeRoomPrivate()` (157-176) using BD's existing `roomConfig()` helper pattern (`StripDiceBot/src/connection.ts:147-162`)
- [ ] Replace raw `console.error('[CRASH] ...', err)` in `index.ts`'s crash handlers (`index.ts:8-16`) with `logError()` so crash logs get the project's standard timestamp formatting like every other log line

### Medium effort
- [ ] Split `handleConversational()` (`game.ts:329-425`, ~96 lines) by game phase: in-progress clothing-deal dispatch, post-bank free-text answers, mid-negotiation counter-value capture, mid-negotiation numeric-proposal capture, plain-English yes/no/counter/roll synonyms
- [ ] Add `gamesLost` field + a `!leaderboard` command for parity with BD — `PlayerRecord` in `types.ts:231-239` currently has no `gamesLost`; BD's leaderboard command is at `StripDiceBot/src/game.ts:2564-2590`
