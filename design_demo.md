# WinnersDice — Demo Mode Design

**Status:** Design phase. Not yet implemented.

---

## Purpose

A scripted live demonstration that runs inside BC, showing new players how a real WinnersDice match plays out — rolling, the shop, bondage, locks, and end game — without needing to read the help text. The goal is to give curious players enough context to dive into a real game confidently.

A player (not just admin) should be able to trigger the demo when they want to learn the game.

---

## Architecture

### Two accounts

The demo uses the two existing bot accounts (lobby bot + room bot). During the demo:

- **Bot A** plays the "game host" role — runs the scripted game, applies/removes items, sends menus
- **Bot B** plays the "demo player" — the one who gets stripped and bonded; sends scripted replies on a timer

`demo.ts` is a **standalone Node script**, separate from the live bot process. It opens two socket connections and runs a sequential list of scripted steps. It does **not** use game.ts — all menus and messages are hardcoded strings matching the real game's output. This keeps the demo simple and avoids mocking complexity, at the cost of needing to be kept in sync with real menu changes.

### Step sequencer

```typescript
type DemoStep = {
    delayMs: number;           // wait before this step fires
    action: (a: BotConnection, b: BotConnection) => void;
};
```

Steps execute in order. Each step fires after its delay and can send chat, send a whisper, apply/remove items, or do nothing (pure pause for dramatic effect).

### Trigger

- Command: `!demo` whispered to either bot
- Available to any player in the room (not admin-only — the point is player accessibility)
- During the demo, both bots refuse new challenges with a whisper: "A demo is running right now — join the WinnersDice room to watch, or try again in a few minutes."
- Admin `!demo stop` cancels early if something goes wrong

---

## BC Setup (one-time, before first demo run)

- Bot B's avatar should be wearing **8 clothing items** at demo start (enough to strip a few during the shop section)
- Bot B's **AllowItem** must be enabled and Bot A must be on Bot B's whitelist — same permissions as normal players
- Bot B's clothing should be visually interesting — something that looks like a real player's outfit, not a blank avatar

---

## Narration Style

Between game beats, Bot A sends a short public chat line in `(( ))` explaining what watchers just saw. Example:

```
(( — The winner just opened the spend menu. They can buy clothing off their opponent, 
apply bondage, add locks, use toys, or bank points toward end game. — ))
```

This keeps narration clearly OOC, doesn't interrupt the visual flow, and gives context without requiring a separate narrator account.

---

## Screenplay (draft outline)

Approximate total runtime: **6–7 minutes**. Scripted roll values — no randomness.

| Beat | Time | What happens |
|------|------|-------------|
| **Intro** | 0:00 | Bot A announces demo starting in public chat. Bot B enters room. |
| **Challenge** | 0:20 | Bot B whispers `!challenge` → Bot A presents numbered player list → Bot B picks Bot A → challenge sent → accepted → negotiation begins |
| **Negotiation** | 0:50 | Min rounds: 3. Bondage: yes. Toys: no. Both agree to terms. Game starts. |
| **Rolling — basics** | 1:20 | Rolls 1–3. Normal rolls, no streak. Narration explains the d20, what losing a roll means, cumulative stripping. |
| **Streak + multiplier** | 2:00 | Bot B wins two rolls in a row — streak explained. Round 4 has a 2× multiplier. Narration explains boost/streak system. |
| **Natural 1** | 2:30 | Bot B rolls a 1. Narration explains the critical fail. |
| **Natural 20** | 2:50 | Bot B rolls a 20. Narration explains the critical success. |
| **Shop opens** | 3:10 | Winner opens the spend menu. Narration explains the shop concept. |
| **Shop: boost** | 3:25 | Winner buys a boost. Points deducted. Narration: points come from winning rolls. |
| **Shop: clothing** | 3:45 | Winner buys a clothing item off Bot B. Deal negotiated, accepted, item visually removed. Narration explains the negotiation mechanic. |
| **Shop: bondage** | 4:15 | Winner buys a bondage item. Item picker shown (narrated). Bondage applied to Bot B visually. Narration explains slot choices. |
| **Shop: lock** | 4:45 | Winner locks the bondage item. Narration: now the opponent can't remove it themselves. |
| **Shop: buyback** | 5:05 | Bot B uses buyback to recover one clothing item. Narration: losers can spend points too. |
| **End game trigger** | 5:25 | Winner has enough points, triggers end game proposal. 5-question flow narrated briefly. |
| **End game accepted** | 5:50 | Terms accepted. Timer lock applied to Bot B. Game over announcement. |
| **Outro** | 6:10 | Bot A sends public chat: "That's WinnersDice — whisper !challenge [name] to start your own match." |

---

## Technical Notes

- Seeded rolls: demo.ts injects roll outcomes directly rather than using Math.random(). The game logic is not running — the demo just sends the output strings that the real game would produce.
- Timing: each step fires after a fixed delay. Steps that involve item changes add a small buffer (e.g. 1–2 seconds) to let BC propagate the visual before the next narration line.
- If Bot B disconnects mid-demo, demo.ts logs the error and sends a public chat "Demo interrupted — try again shortly."
- The demo does not write to `players.json`, `pair_balances.json`, or any persistent state.

---

## Open Questions

1. **Who can stop the demo early?** Admin only, or also the player who triggered it?
2. **Demo frequency limit?** Should the demo have a cooldown (e.g. once per 30 minutes) to prevent abuse?
3. **Room during demo:** Does the demo run in the lobby room (Bot A's normal room), or does it spin up a temporary demo room?
4. **Screenplay finalization:** The outline above is a starting point — beats and timing need refinement once DW has reviewed the story arc.

---

## Implementation Order

1. Finalize screenplay (DW review)
2. Build `demo.ts` skeleton: two connections, step sequencer, demo-mode flag
3. Wire up `!demo` command on both bots
4. Script each beat as a list of `DemoStep` objects
5. Test run with DW present to tune timing
6. Adjust narration text based on what actually reads well in-room
