# End-Game Bondage Clearance — Design Doc

**Status:** Design finalized 2026-07-24 — ready to build.

---

## Problem

Right now the winner of any round can request end-game and have **all their own
bondage and locks removed for free** at execution, regardless of how the match
was going. That undercuts the deal economy: the loser placed that bondage
expecting to be paid if the winner ever wanted it off (via buyback). Free
removal at end-game lets the winner skip that entirely.

---

## Solution (settled)

A **pre-game negotiation term**: "must the winner clear their bondage before
end-game?" Decided by both players during match setup, **immutable once the
match starts**. When enabled, the winner cannot *end the match* while they still
have match-placed bondage on — but they are never *forced* to pay; they can keep
playing, keep shopping, or concede via `!mercy` instead.

### Where the term lives
- New `GameConfig` field (e.g. `clearBondageAtEndgame: boolean`), added to the
  pre-game negotiation order and agreed via the existing settings/consent flow.
- **Only asked when `bondage` is enabled** — irrelevant otherwise.
- Cannot be changed after the match begins.

---

## Flow

1. **Winner requests `!endgame`** (from the post-bank menu, or right after a
   roll).
2. Bot checks: is `clearBondageAtEndgame` on **and** does the winner have any
   match-placed bondage (`activeBondage` where `wearer === winner`)?
   - **No bondage** (or term off) → proceeds to the normal end-game proposal.
   - **Bondage present** → **blocked** (proposal does NOT start). The winner
     stays exactly where they were and gets a message like:
     > "You still have bondage on. With clearance enabled, you have to buy it
     > all back before you can call end-game. Open the shop → 'buy back bondage'
     > to clear it (you'll pay, [loser] gets paid). You don't have to — you can
     > keep playing, or **!mercy** to concede instead."
     - If they typed `!endgame` **before banking** (straight after a roll), the
       message also tells them to **bank first**, since the shop needs a bank
       session.
3. **Winner clears their bondage** through the existing bondage-buyback flow
   (`startBondageBuyback` / `handleBondageBuybackResponse`) — standard economy,
   no special-casing (see Economics). They can clear some, all, or none; only
   *all* unlocks end-game.
4. **Winner requests `!endgame` again** → bot re-checks → no bondage → the normal
   proposal begins.

No soft-lock: a broke winner simply can't end via `!endgame` and keeps playing
(or mercies). Ending the match was never mandatory.

---

## Economics (settled)

- **Clearance uses the exact same bondage-buyback as any other time** — no
  special split. Winner pays `2× applyPrice (+ lock fee)`; the loser (placer)
  gets back `1× applyPrice`; the bot keeps the rest. Loser gets paid back what
  they invested instead of nothing — that's the fairness win.
  - *(Separate, later:* DW wants to revisit/lower the general buyback payback
    price — that's a global buyback tweak, not part of this feature.)*
- **Loser's pending funds become spendable at end-game.** `!endgame` already
  banks the *winner's* pot before the proposal; we now **also settle the
  loser's `pendingBalance` into their balance at proposal start**, so the money
  the winner just paid to clear is immediately usable by the loser to bid the
  time down. This is the **only** point pending funds unlock — during normal
  play they stay pending as today. Applies to every end-game, not just
  clearance games.

---

## Mercy

- Clearance gates `!endgame` **only**. `!mercy` is a separate concession path and
  is **not** affected — and the block message above explicitly reminds the
  bound winner that mercy is an option.
- Mercy is self-penalizing (forfeit half your points + owe a service), so it
  isn't an exploit route around clearance.
- **Follow-up (after this ships):** DW wants a full review of exactly what
  happens in the mercy flow — tracked separately, not part of this build.

---

## Code touch points

- `types.ts` — `GameConfig.clearBondageAtEndgame: boolean`.
- Pre-game negotiation — add the key to the order + a question, gated on
  `bondage` being enabled; agreed via existing settings/consent handling;
  frozen at match start (same as other config).
- `handleEndgame` — pre-proposal gate: if term on and winner has `activeBondage`,
  block with the clear-first + mercy-reminder message (and bank-first hint when
  called from the pre-bank state). Otherwise proceed as today.
- `startEndGameProposal` (or wherever the proposal begins) — settle the loser's
  `pendingBalance` into their balance before bidding starts.
- Removal itself reuses the existing bondage-buyback code — no new removal logic.

## Scope notes

- Applies only to bondage **placed during the match** (`activeBondage`), never
  items the winner wore in.
- Loser's locks on the winner's bondage are included (buyback already folds in
  the lock-removal fee).
- The loser stays bound at end-game as always — this only concerns the winner's
  bondage.
- Non-clearance games are unchanged (winner still gets free removal at
  execution).
