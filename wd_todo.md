# WinnersDice — Todo / Known Issues

## HIGH PRIORITY

1. **Decide what to do about clothing** — clarify role of clothing in the shop (buy/sell mechanic, pricing, etc.)
   - **Superseded by a full design** — see [`design_wardrobe_helper.md`](design_wardrobe_helper.md) (2026-07-14). Covers `!stuck`/`!redress`, remembers exact worn items, acts-or-advises depending on permissions. DW holding off on implementation — doc is self-contained for a dispatched session.

---

## MEDIUM PRIORITY

2. ~~**Dead code: `BondagePicker` class is never instantiated**~~ — Removed 2026-07-22 as part of "M for more" implementation. `bondagePicker.ts` now contains only the constants and catalog loader that `game.ts` imports (`PICK_SLOTS`, `PickSlot`, `PICK_LIST_TOP_N`, `NEW_ITEMS`, `loadBcItemCatalog`).

---

## LOW PRIORITY

1. **Price tracking** — track what prices items actually sold for during shop negotiations. Design TBD (per-session log, persistent file, or `!prices` command). Downgraded — not sure yet whether this will actually get used.

---

## Known Issues / Limitations

- **Public room type not actually public** — BC silently ignores the Public room-type field on `ChatRoomAdmin`/`Update`. Same root cause as Locked. Needs traffic inspection to find the correct socket mechanism. (2026-07-21)

- **Multi-room: lobby and room bots can silently drift out of sync** — `checkPendingUpdate()` reads and deletes `pending_update.txt` on the first process to hit a checkpoint, so the other process may never see it and keeps running old code. Options: per-role pending-update files, version/build-hash cross-check, or always restart both from the panel. Not urgent.

- **Buyback: no wardrobe detection on re-equip** — BC's `ChatRoomSyncSingle` can't distinguish item added vs removed. Buyback flow skips wardrobe monitoring — player re-equips manually after payment. Revisit if BC ever exposes an "item equipped" event.

- ~~**Buyback bondage: Should work like removing locks and clothing**~~ — Done 2026-07-23. Revamped to 2× fixed cost, no negotiation, mirrors clothing/lock buyback.

## Queued Features / Changes

- ~~**Standardize clothing/wardrobe-change detection between WD and BD**~~ — Done 2026-07-23. Both bots now use Appearance.length baseline-diff in `onSyncSingle`. BD additionally maintains a per-slot `itemStateCache` for lock verification, but that's BD-specific and not needed in WD.

- ~~**Banking + clothing menus whisper-only**~~ — Confirmed complete/obsolete 2026-07-23. Early shop announcements are the intended design.

- **Multi-room: Locked room type doesn't actually lock** — `configureRoomForMatch({locked: true})` runs but BC silently ignores the field. Real fix needs traffic inspection. Leaving as-is for now — Private + Spectator is good enough.

- **Maybe force higher shop prices in later rounds** — spend menu deals more expensive as match progresses, similar to end game 1×/3×/5× multipliers. Design TBD. (2026-07-21)

- ~~**Negotiation Deadlock — Forced Sale**~~ — Resolved 2026-07-23. Winner always gets the last bid, so deadlock can't persist indefinitely.

### End Game — open items

- **`!points` command** — not implemented. Should show current banked balance + current pot on demand, not just at end-game.
- **End game save/resume** — when safeword or reset fires during active end game, consider saving agreed terms for resumption. Design TBD.
- **End game timer/password lock slot** — `executeEndGame()`/`expireEndGame()` use `ItemNeckRestraints` + `CollarLeash` as a stand-in. Revisit once there's a clearer idea of the right BC asset.
- **End game locks: exclusive locks not replaced by timer lock** — fixed 2026-07-22 (`releaseLocksFor(loser)` + 3-second delay before `applyEndGameLocks`). Needs live test to confirm items that had shop-deal locks during the match now get timer password locks correctly.
- **Collar lock at end of game** — fixed 2026-07-22 (`ensureCollarForLeash` now always attempts the timer lock instead of bailing when `LockedBy` is set). Needs live test — if collar had a player-placed lock (not bot-placed), BC will still reject silently.
- **End game locks still not working exactly as intended** — broader design/behavior issue beyond the lock-replacement bug above. Needs playtesting and a design pass. (2026-07-21)

_(add items here as they come up during playtesting)_

---

## Reminders / Pending Tests

- Test safeword in BD (StripDiceBot) — verify BD's Action message pattern catches the safeword event and triggers full bondage removal + game stop.
- Test permission pre-flight: join a game with AllowItem disabled in BC settings and verify the bot blocks the challenge with the correct whisper message.
- **Remove `!testcufflock`** — temp debug command (lines ~900 and ~4197-4198 in game.ts) — remove after live test confirms blocked-lock handling works.

---

## Minor / Polish

1. ~~**`!help shop` bondage description is misleading**~~ — Fixed 2026-07-23. Now reads "you pay full price; they receive half — bot takes the rest."
2. ~~**Service deal doesn't disclose the 50/50 split to the seller**~~ — Fixed 2026-07-23. Seller now sees "you'd receive X pts (half)" on initial offer, on each counter-whisper, and a settlement confirmation whisper on deal close.

---

## Code Cleanup

### Quick wins
- [ ] Deduplicate the room-config literal in `connection.ts`'s `joinRoom()` and `makeRoomPrivate()` using BD's `roomConfig()` helper pattern
- [ ] Replace raw `console.error('[CRASH] ...', err)` in `index.ts`'s crash handlers with `logError()` for standard timestamp formatting

### Medium effort
- [ ] Split `handleConversational()` by game phase
- [~] Add `gamesLost` field + `!leaderboard` command — `gamesLost` added to `PlayerRecord`, `!leaderboard` / `!lb` implemented (top 5 winners + losers, your record). Backfill on load. Needs live test; polish (win rate, min games threshold) TBD later.

---

## Completed

### Completed 2026-07-22
- **`!challenge` usability** — no-arg `!challenge` now whispers a numbered list of players in the room (pick by number or type the name). `@` prefix no longer required. Name matching upgraded to fuzzy: exact → startsWith → includes, so partial names work.
- **"M for more" in bondage and toy pickers** — pick list now shows `M. More` when the catalog has more items than fit on one page. Pressing M pages through the full sorted list (popular → random fill) in PICK_LIST_TOP_N-sized chunks, with relative numbering (1–9 per page) and a page counter in the header. The full list is generated once at slot-pick time and stored in the deal so the order is stable. BondagePicker dead code removed from `bondagePicker.ts` (1279 → ~75 lines). Applies to both bondage and toys.
- **`!pause` / `!resume`** — either match participant can pause/resume the bot. While paused, all conversational input and game commands are silently ignored (`!pause` and `!resume` themselves still work; safeword fires via BC's event system regardless). Both players whispered on state change. Listed in `!help game`.
- **Bot shows menu while waiting for offer response** — `handlePostBankAnswer` was missing a guard for active bondage/lock/toy/clothing deals. Added check: while any of those deals is active, the buyer gets "⏳ Waiting for the other player to respond" and nothing else executes. Also prevents a second offer being queued before the first is answered.
- **End game: exclusive locks not replaced by timer lock** — `releaseLocksFor(loser.memberNumber)` now called before `applyEndGameLocks`, with a 3-second `setTimeout` delay so BC can process the unlocks before timer password locks are applied. `ensureCollarForLeash` now always attempts the lock instead of bailing when collar already has a lock.
- **`!setstatus` couldn't set feedback to "declined"** — `validStatuses` in `game.ts` was missing `"declined"` even though `FeedbackItemStatus` in `types.ts` included it.
- **`pendingChallengeDisambiguation` not cleared on reset/safeword** — class field not part of `GameState`, so it survived `!reset` and safeword. Added explicit null to both handlers.

### Completed 2026-07-16
- **End-game bidding reworked**: Q1 is the winner's real target. Loser spends to cut time, winner spends to raise it back. Explicit decline option added. Both sides' whispers include actual reply options and current caps.
- **Better context on "What next?" and shop screens**: `H`/help shows scoped tips, not the full shop catalog.

### Completed 2026-07-13
- **In-room standby + `!done` command**: Q2 = stay in room → bot whispers winner it's standing by, `!done` ends early.
- **Clothing deal upgraded to 5-step negotiation engine**: counter/accept flow rewired with Rule A and Rule B, matching all other deal types.

### Completed 2026-07-10
- **Per-pair points carryover** (`pair_balances.json`)
- **End-game points-vanish bug fixed** (by design clarification — points are burned intentionally)
- **Disconnect handling** (`onMemberLeave`, 3-min countdown, reconnect cancels)
- **"quit" as scoped early-exit during disconnect countdown**
- **`sendLongWhisper` BCX-safe split prefix**
- **Global `()` OOC normalization**
- **Phase-aware `!help`/`H`** — context-sensitive across all game states

### Completed 2026-07-09
- Spend-menu double-deal guards, clothing deal seller cancel, lock deal counter prompts, toy deal loser can't decline bypass, lock deal pre-offer affordability check
- Early shop announcements, standardized cancel/back, toys picker redesigned, shop counter-offer rules, max 20 rolls per round
- Shared pot model, streak + boost system, real-time balance tracking, wardrobe block, buyback, natural 20/1, conversational commands, round multiplier, bot/self-roll mode
- End game: 5-question proposal, up-to-5-step negotiation, block/execution, timer/password lock on leash + optional extra slots

### Verified already implemented (2026-07-10 code review)
- Challenge acceptance prompt, clothing offer confirmation to buyer, post-wardrobe-change options prompt, toys shop option
