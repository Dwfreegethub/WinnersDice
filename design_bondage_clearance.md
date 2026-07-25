# End-Game Bondage Clearance — Design Doc

**Status:** Design phase. Not yet implemented.

---

## Problem

The current end-game flow removes the winner's active bondage for free at execution. This creates a loophole: a winner can accumulate bondage during the match and then trigger end-game without any cost, bypassing the buyback economy entirely.

---

## Proposed Solution

Add a new end-game negotiation term — **bondage clearance** — that both players must agree on before the time negotiation begins. If set to "must clear," the winner is required to buy back all their active bondage before `!endgame` can be triggered.

---

## Flow

1. **New negotiation term** — during end-game proposal, a new question is added (position TBD in Q1–Q5 sequence): "Must [winner] clear their bondage before end-game? (yes/no)" Both players must agree on this term, same as the other proposal questions.

2. **Winner types `!endgame` with "must clear" agreed** — bot checks whether the winner has any active bondage from the match.
   - If no bondage: proceeds normally.
   - If bondage exists: bot blocks and says something like — "You still have bondage on — clear it before end-game can proceed. Reply 1 to open the buyback menu."

3. **Winner buys back their bondage** — using the existing buyback flow. Payment goes to the loser (as points, landing in loser's `pendingBalance`).

4. **Winner types `!endgame` again** — bot re-checks, no bondage found, proposal proceeds. Balances reflect the buyback payments already made.

---

## Open Question: Pending Balance in Negotiations

When the winner buys back their bondage, the payment lands in the loser's `pendingBalance` (not yet settled into their spendable balance — that normally happens at the next bank). During the subsequent end-game time negotiation, the loser bids points to lower the time.

**Should the loser's `pendingBalance` count toward their time-bid budget?**

Arguments for yes:
- The loser earned it legitimately during this match; it's just timing
- The loser paid upfront (placed the bondage) and shouldn't be penalized by settlement lag
- Makes the "must clear" option more meaningful — winner pays, loser gets real leverage

Arguments for no:
- `pendingBalance` isn't settled yet; keeping it locked maintains consistency with the rest of the economy
- Simpler — no special handling needed during end-game negotiation
- Loser still benefits at the next match via pair carryover

**Decision needed** before implementation.

---

## Why This Matters

This is more than a quality-of-life fix. Bondage applied during the match is part of the deal economy — a loser placed those items with the expectation of being paid if the winner wanted them removed. Free removal at end-game undercuts that. Requiring clearance closes the loophole and makes bondage a real economic lever for both sides.

---

## Code Complexity

Small-to-medium. Touch points:
- `EndGameProposal` in `types.ts` — new field (`requireWinnerClearance: boolean | null`)
- New proposal stage — question added to Q1–Q5 sequence
- `handleEndgame` — pre-check for active winner bondage if clearance required
- Redirect to buyback menu with shortcut option
- No changes to time negotiation caps or deduction math — buyback happens before proposal, balances update naturally

The removal itself uses existing buyback code. No new removal logic needed.

---

## Notes

- The loser remains bound at end-game as always — this change only affects the winner's bondage
- Applies only to bondage placed during the match (tracked in `activeBondage`) — not items the winner was already wearing when they entered
- Locks placed by the loser on the winner's bondage are included (winner would need to pay the lock removal price as well via existing lock buyout flow)
