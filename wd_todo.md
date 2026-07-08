# WinnersDice — Todo / Known Issues

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

### End Game — Winner-Initiated (from bank/shop)
When the winner calls end game from the bank, the bot runs a structured negotiation:

**Winner's proposal (bot asks a series of questions):**
1. How many points do you want to spend toward time? (points → time, non-1:1 ratio, TBD)
2. Stay in this room or take the loser somewhere else?
3. If staying: public (open for others to watch/participate) or private?
4. Locks on the loser? (which slots, what type — timer locks for time tracking, password locks hand password to winner)
5. Free-text description of what the winner plans to do

**Loser's response:**
- Both players can see each other's point balances at the top of the proposal
- Loser can spend points to reduce the time, or spend enough to cancel the end game entirely
- One round of back-and-forth adjustment allowed

**If blocked (loser spends enough to cancel):**
- Both players lose ALL points spent on the proposal and the block — no refunds
- Game continues as normal

**If accepted:**
- Terms execute: timer locks placed, password locks give password to winner
- Note: investigate whether BC has a dedicated slot for timer locks just for time tracking
- Leftover points from both players bank to a per-player-pair persistent account

**Per-pair points bank:**
- Points persist across sessions between those exact two players
- Future idea: "public points" usable against any opponent, but earned/spent at higher cost

**`!points` command (also needed in regular shop):**
- Show both players' current balances — needed for informed decision-making in end-game negotiation

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
- Wrap unprotected `fs` calls in try/catch and log failures: `saveFeedbackStatus()`, `savePlayerRecords()`, `handleFeedback()`'s `fs.appendFileSync`, `checkPendingUpdate()`'s `fs.unlinkSync`
- Fix `logger.ts` double timezone-shift bug (ported BD's `centralTimeString()` pattern)
- Fix feedback rejoin regression with `REVIEWING_FEEDBACK_STATUSES` + `reviewingAckDate` de-dup pattern (ported from BD)

---

## Code Cleanup

_Source: `bc_bot_framework_report.md` prioritized action list (§5). Live-risk items first — fix these before the framework extraction (see `StripDiceBot/todo_framework.md`)._

### Quick wins
- [ ] Deduplicate the room-config literal in `connection.ts`'s `joinRoom()` (139-155) and `makeRoomPrivate()` (157-176) using BD's existing `roomConfig()` helper pattern (`StripDiceBot/src/connection.ts:147-162`)
- [ ] Replace raw `console.error('[CRASH] ...', err)` in `index.ts`'s crash handlers (`index.ts:8-16`) with `logError()` so crash logs get the project's standard timestamp formatting like every other log line

### Medium effort
- [ ] Split `handleConversational()` (`game.ts:329-425`, ~96 lines) by game phase: in-progress clothing-deal dispatch, post-bank free-text answers, mid-negotiation counter-value capture, mid-negotiation numeric-proposal capture, plain-English yes/no/counter/roll synonyms
- [ ] Add `gamesLost` field + a `!leaderboard` command for parity with BD — `PlayerRecord` in `types.ts:231-239` currently has no `gamesLost`; BD's leaderboard command is at `StripDiceBot/src/game.ts:2564-2590`
