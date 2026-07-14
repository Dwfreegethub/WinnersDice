# WinnersDice — Todo / Known Issues

## HIGH PRIORITY

1. Decide what to do about clothing — clarify role of clothing in the shop (buy/sell mechanic, pricing, etc.)
   - Key question on automatic strip: `removeItem(memberNumber, "Cloth")` uses the same socket event as bondage removal and should work for clothing slots. The unknown is whether BC's server will honor it from a bot that isn't whitelisted. Needs a live test — add a debug command (`!teststrip`) that calls `removeItem` on the Cloth slot to confirm. (Not yet added.)
2. **Price tracking** — track what prices items actually sold for during shop negotiations, so players and admins can see historical pricing data. Design TBD (could be per-session log, persistent file, or whisper on request via !prices). Not implemented — no `!prices` command or price log in `game.ts`.

---

## MEDIUM PRIORITY

2. **Dead code: `BondagePicker` class is never instantiated** — `bondagePicker.ts` is 1279 lines; ~950 implement a full "picker chooses restraints piece by piece" system (mode selection, slot consent, veto, popularity tracking, outfit logging) that is never used at runtime. `game.ts` only imports 4 small helpers/constants (confirmed — no `new BondagePicker(...)` anywhere). Either wire it in or delete it.

3. **`!setstatus` can't set feedback to "declined"** — `validStatuses` (`game.ts`) still omits `"declined"` even though `FeedbackItemStatus` includes it and it's a valid resolved state. Admin has to hand-edit the JSON file.

4. **`pendingChallengeDisambiguation` not cleared on reset/safeword** — It's a class field, not part of `GameState`, so it survives `!reset` and safeword (confirmed — neither `handleReset` nor `handleSafewordUsed` touches it). After a reset, a challenger's next message could be swallowed as a stale disambiguation answer.

---

## Known Issues / Limitations

- **Buyback: no wardrobe detection on re-equip**
  BC's ChatRoomSyncSingle fires on wardrobe changes but cannot distinguish clothing being *added* vs *removed*. When a player buys back their item, there's no way to detect them putting it back on. Buyback flow skips wardrobe monitoring — player just re-equips on their own after payment (confirmed unchanged in `startBuyback`/`handleBuybackResponse`). If we ever find a BC API event that signals item equipped, revisit this.

---

## Queued Features / Changes

- **Standardize clothing/wardrobe-change detection between WD and BD** — WD's trade-handoff detection (`startWardrobeCheck`/`waitingForWardrobe` in `game.ts`) just treats *any* `ChatRoomSyncSingle` for the pending member as proof the item changed hands — no item-count check, no manual confirm command, and only a single one-time 2-minute nudge if it never fires (see "Buyback: no wardrobe detection on re-equip" above — same underlying gap). BD's penalty-removal detection (`markAwaitingRemoval`/`pendingRemovalBaselineCount`, appearance-count baseline vs fresh sync, `!removed` fallback, turn-gating fix) shipped 2026-07-11 in StripDiceBot and is meaningfully more robust. Plan: port BD's baseline-diff pattern into WD, add a manual confirm command, and consider extracting a shared "wardrobe watch" helper both bots import — same precedent as `bondagePicker.ts` (already built to be portable). On hold — DW wants to field-test the BD changes live first before touching WD or extracting shared code. Tracked in both bots' todo files so it doesn't get lost.

- **Banking + clothing menus whisper-only** — All bank menus (continue/spend/endgame), spend menus, and clothing negotiation messages should be sent via whisper, not public chat. Still not the case: `startClothingDeal`/`proposeClothingDealToOpponent` and most `start*Deal` entry points intentionally `sendChat` an opening announcement (see "Early shop announcements" in Completed, 2026-07-09). That was a deliberate design choice made *after* this item was written, so it may be obsolete — worth a quick DW call on whether to drop this item or scope it down to just the bank/continue/endgame prompts (which already look whisper-only).

- **Negotiation Deadlock — Forced Sale** — not implemented (no `!setnegotiate`/`!setmultiplier` commands, no forced-sale logic in any deal type).
  - After 2 rounds of back-and-forth counter offers with no agreement, bot intervenes with a forced sale
  - Forced sale price = highest number offered during the negotiation × configurable multiplier (default 2×)
  - Buyer gets the item at that price; deal closes automatically (no further negotiation)
  - Admin commands: `!setnegotiate off`/`on`, `!setmultiplier 2`/`2.5`/`3`, both per-session
  - Design concerns to resolve before implementing (winner/loser abuse via lowball/absurd counters) — DW to revisit

### End Game — Winner-Initiated (from bank/shop) — IMPLEMENTED, remaining open items
See Completed for the full flow. Points committed during execute/block are intentionally burned (credited to neither player) — see "Per-pair points carryover" in Completed for the separate mechanic that persists each player's leftover *match* balance between matches. Still open:

- **`!points` command** — not implemented; players currently only see balances via the whispers sent at the start of the end game proposal and inside the delivered proposal, not on demand. Should show both: current banked balance, and the current pot (what they'd gain by `!bank` right now) — a quick on-demand check during any live round, not just at end-game.
- **End game save/resume**: when safeword or reset is called during active end game, consider saving the agreed terms so the session can be resumed later. Design TBD — revisit later.
- **End game timer/password lock slot**: `executeEndGame()`/`expireEndGame()` use `ItemNeckRestraints` + `CollarLeash` as a stand-in. Revisit once there's a clearer idea of what BC asset should represent the timer lock.

_(add items here as they come up during playtesting)_

---

## Reminders / Pending Tests

- Test safeword in BD (StripDiceBot) — verify BD's Action message pattern catches the safeword event and triggers full bondage removal + game stop.
- Test permission pre-flight: join a game with AllowItem disabled in BC settings and verify the bot blocks the challenge with the correct whisper message.

---

## Completed

### Completed 2026-07-13
- **End-game 10% gap-close rule**: `applyEndGameLoserCounter`/`applyEndGameWinnerCounter` now enforce a 10% gap-close requirement on every counter, regardless of gap size. Player is told the minimum if they go under.
- **End-game bidding hints**: loser's proposal delivery whisper now explains the negotiation mechanics (1pt/min cost, how the loser's counter affects their own balance, block mechanic, 5-step binding rules, gap-close rule) and shows both players' current balances. Winner gets a parallel whisper with their floor and balance.
- **In-room standby + `!done` command**: when Q2 = stay in this room, bot whispers the winner it's standing by and they can type `!done` to end early. `!done` cancels the timer and calls `expireEndGame()` immediately. Only active in in-room end games.
- **Clothing deal upgraded to 5-step negotiation engine** — `ClothingDeal` in `types.ts` now has `negotiationStep`, `initiatorFloor`, `responderCeiling`. Counter/accept flow rewired through `applyInitiatorOffer`/`applyResponderCounter` with Rule A (first-counter cap) and Rule B (10%-gap-close floor), matching all other deal types. Cancel remains symmetric for both parties.

### Completed Today (2026-07-10)
- **Per-pair points carryover**: `pair_balances.json` (gitignored, same pattern as `players.json`) tracks each player's leftover balance independently per opponent, keyed by the sorted member-number pair. Written at `finishMatch`/`resolveMercy` only — safeword and admin `!reset` do NOT write it. At challenge-accept time (`promptCarryoverOrBeginSettings`), if a saved entry exists for the pair, both players are asked whether to use it; both must agree or both start at zero and the saved entry is deleted outright. A's balance against B never affects A's balance against C.
- **End-game points-vanish bug fixed (by clarification, not mechanics change)**: `executeEndGame`/`blockEndGame` already deducted committed points correctly — the bug was that they vanished with no record. Per DW's call, this is intentional: end-game negotiation points are burned, not banked to either player. Replaced the `[STUB]`/`TODO` log line with an explicit "burned by design" log, and `EndGameProposal.winnerPointsCommitted`/`loserPointsCommitted` (previously set but never read) now surface in the deal-closing chat announcement and teardown announcement.
- **Disconnect handling (`onMemberLeave`)**: `index.ts` calls `game.onMemberLeave(memberNumber)` alongside its roster cleanup. Pre-game: aborts immediately, same teardown as `!reset`. Mid-match: starts a 3-minute countdown (`GameState.disconnectTimer`), whispers the remaining player they can wait it out or say "quit"/`!safeword` to end early. Reconnect in time cancels the timer (`onMemberJoin`) and resumes normally; otherwise it tears down like a safeword with a disconnect-flavored message. No `finishMatch`/`recordGameCompletion`/`savePairCarryover` on any disconnect path.
- **"quit" as a scoped early-exit command**: while a disconnect countdown is active, the remaining player can type `quit`, `(quit)`, or `!quit` to trigger `endGameDueToDisconnect` immediately — checked in `handleChatMessage` before any other routing, and only recognized while `state.disconnectTimer` is set. Not a globally-recognized command otherwise. The countdown whisper was updated to advertise "quit" instead of `!safeword`.
- **`sendLongWhisper` BCX-safe split prefix**: every split chunk (only the multi-message path — single whispers are untouched) is now prefixed with `"- "` so a chunk can never start with `!`, regardless of where the line-boundary split lands. Protects all 11 call sites that share this helper (help text, bondage/toy pick lists, end-game proposal delivery, feedback status whispers), not just the near-miss `!help shop` case that was flagged.
- **Global `()` OOC normalization**: `handleChatMessage` now strips one layer of enclosing parens from every incoming message before any dispatch, so BC's OOC convention — `(help)`, `(H)`, etc. — is parsed the same as the bare word internally. This only affects what the bot reads; the player's own message still displays with the parens intact to the room. The pre-existing `(quit)` handling for the disconnect countdown still works (now redundant with the global strip, but left alone since it's harmless).
- **Phase-aware `!help`/"help"/"H"**: bare `!help` (no topic arg) and conversational `help`/`H` (and their now-normalized `(help)`/`(H)` forms) route through a new `handleContextHelp` dispatcher instead of always showing the generic top-level menu:
  - Idle / pre-game negotiation: unchanged — still the old generic `handleHelp` menu (`!help setup` etc. still work exactly as before, untouched).
  - Mid-round (`awaitingDecision`): short hint — bank/press/endgame/mercy and when endgame/mercy unlock.
  - Shop/bank menus (`awaitingPostBank`, spend menu open or not): shows the existing `!help shop` page, then re-displays whichever menu was open. Both menu whispers (`postBankPromptText`, `openSpendMenu`) now list `H. help` as a visible option.
  - Deal negotiations (bondage/lock/toy/service) during the accept/counter back-and-forth: role-aware hint — standard accept/counter/cancel for bondage/lock/service and the toy winner, a no-cancel variant for the toy loser. Clothing deals are intentionally out of scope (not part of the original ask).
  - End-game Q1–Q5: per-question hint, then re-asks the current question (mirrors the shop-menu pattern).
  - End-game proposal/counter-offer (`negotiating` stage): single hint, no repeat (per the approved design — only shop/bank and Q1–Q5 repeat the prompt).
  - `!help admin` unchanged — always available via whisper, admin-gated as before.

### Verified already implemented (found via full code review, 2026-07-10 — no todo update at the time they landed)
- **Challenge acceptance prompt** — `beginNegotiation` whispers the opponent "Do you accept? (yes/no)" and nothing else proceeds until they answer (`handleChallengeAcceptAnswer`).
- **Clothing offer confirmation to buyer** — `proposeClothingDealToOpponent` whispers the buyer "⏳ Offer sent to [Opponent]. Waiting for their response..." immediately after the offer goes out.
- **Post-wardrobe-change options prompt** — `sendPostWardrobeMenu`, called once a wardrobe change clears the pending check, whispers "Game resumes — here's what you can do next:" plus the relevant menu.
- **Toys — shop option for the active banker** — fully built: `ToyDeal` negotiation via the spend menu, toy catalog loaded from `ItemHandheld_toys_list.txt`, duration selection, and automatic removal via `ActiveToy`'s timer. This queued item was a stale duplicate of the toy system already logged under Completed (2026-07-09) below.

### Completed 2026-07-09 — confirmed via code review (bugs #1–3 and #5–7 from the original numbering, committed to dev)
- **Spend-menu double-deal guards fixed** — `hasActiveDeal()`/`blockedByShopDeal()` now checked uniformly: all six spend-menu entry points (`startClothingDeal`, `startBondageDeal`, `startLockDeal`, `startServiceDeal`, `startToyDeal`, `startBuyback`) plus `startBoostPurchase`, and `!bank`/`!press`/`!endgame`, all guard against ANY active deal before proceeding.
- **Clothing deal seller can now cancel** — `handleClothingDealCancel` is wired into `handleCancel` for both `deal.buyer` and `deal.opponent` symmetrically with the other deal types.
- **Lock deal counter-offer prompts fixed** — all four re-prompts now read "What price would you like to counter with to lock [slots]? (removal will cost 2× that)" instead of the old "removal price" wording.
- **Toy deal "loser can't decline" bypass fixed** — `handleToyDealCancel` now explicitly blocks the loser ("You can't cancel this deal — reply with 'yes' to accept or 'counter <number>' to negotiate the price.").
- **Lock deal pre-offer affordability check added** — `handleLockPriceChoice` now checks `state.spendingBalance < n` before sending the offer to the opponent, instead of only catching it at finalization.

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
- End game: 5-question winner proposal, up-to-5-step time negotiation with the loser, block/execution outcomes, timer/password lock (standard duration, no loser vote) on the loser's leash slot plus optional extra lock slots — all sharing the same password, and safeword/reset teardown

---

## Minor / Polish

1. **`!help shop` bondage description is misleading** — still says "you pay half goes to them" (`handleHelpShop`), which reads like the payer only pays half. They pay the full price; the opponent receives half back.

2. **Service deal doesn't disclose the 50/50 split to the seller** — Lock, toy, and bondage all tell the responder "you'll receive X points (half)" upfront and at settlement. Service's proposal (`proposeServiceDealToSeller`) and finalization (`finalizeServiceDeal`) still never mention the split — seller discovers it by checking their pending balance.

---

## Code Cleanup

_Source: `bc_bot_framework_report.md` prioritized action list (§5). Live-risk items first — fix these before the framework extraction (see `StripDiceBot/todo_framework.md`)._

### Quick wins
- [ ] Deduplicate the room-config literal in `connection.ts`'s `joinRoom()` (139-155) and `makeRoomPrivate()` (157-176) using BD's existing `roomConfig()` helper pattern (`StripDiceBot/src/connection.ts:147-162`)
- [ ] Replace raw `console.error('[CRASH] ...', err)` in `index.ts`'s crash handlers (`index.ts:8-16`) with `logError()` so crash logs get the project's standard timestamp formatting like every other log line

### Medium effort
- [ ] Split `handleConversational()` (`game.ts:329-425`, ~96 lines) by game phase: in-progress clothing-deal dispatch, post-bank free-text answers, mid-negotiation counter-value capture, mid-negotiation numeric-proposal capture, plain-English yes/no/counter/roll synonyms
- [ ] Add `gamesLost` field + a `!leaderboard` command for parity with BD — `PlayerRecord` in `types.ts:231-239` currently has no `gamesLost`; BD's leaderboard command is at `StripDiceBot/src/game.ts:2564-2590`
