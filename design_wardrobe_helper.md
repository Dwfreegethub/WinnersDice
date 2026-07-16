# WD Wardrobe Helper — Design Doc

Status: **Design only — not started.** DW wants to wait before coding this; saved here so it can be
handed to a dispatched Claude session later with full context, without relying on this conversation
still being available.

## 1. Problem

WinnersDice players are observed (per DW, live-watching test games) to apply bondage *before* removing
much clothing — the opposite order the original clothing-deal design assumed. That means a player can end
up bound (can't physically use their hands in BC to change items) while still wearing most of their
outfit. Right now there's no way for the bot to help them: clothing deals just negotiate a free-text
item description ("their red dress") and wait for *any* appearance change; nothing identifies which BC
appearance Group actually holds the described item, and nothing lets the bot act as a stand-in for a
player who can't reach their own clothes.

Two things prompted this doc:
1. Whether the bot could remove/restore clothing directly (it technically can — same socket call as
   bondage — but BC gates it per-target via `ItemPermission`/`AllowItem`, and real log data shows a
   meaningful chunk of WD's playerbase has that locked down).
2. Whether "which Group is the shirt" is even answerable, given players wear stock BC clothing layers
   (`Cloth`, `Suit`, `ClothLower`, `ClothOuter`, `ClothAccessory`, ...) *and*, very commonly, a Chinese
   community addon ("Luzi") that adds parallel duplicate layers (`Cloth_笨笨蛋Luzi`,
   `Cloth_笨笨笨蛋Luzi2`, ...) plus entirely custom non-clothing slots.

DW's proposal (this doc formalizes it): let the bot passively remember exactly what each player is
wearing (down to Name/Color/Property, not just a count), use that memory to narrow down which Group a
vague request refers to, whisper-confirm when still ambiguous, and use the same memory to restore items
exactly if a bound/stuck player needs help putting something back. Optionally, learn which items tend to
come off together per-player, to narrow faster.

## 2. Scope

- **WD only.** BD was considered and ruled out by DW: "BD there should never be a case when players are
  bound and still have clothing on" — BD's game structure doesn't produce the bound+dressed state this
  is meant to solve.
- Builds on, but does not replace, the existing clothing-deal flow (`startClothingDeal` et al.,
  `game.ts:3736+`) and the existing wardrobe-change wait/detect system (`pendingWardrobeChecks`,
  `startWardrobeCheck`, `completeWardrobeCheck`, `handleRemovedConfirmation`, `onSyncSingle` —
  `game.ts:557-569, 4020-4090, ~6150-6175`).

## 3. Relevant existing code (read before implementing)

- `game.ts:557-569` — `pendingWardrobeChecks: Map<number, {buyer, item, timer, baselineCount}>`. Current
  detection is **count-only**: it fires once total `Appearance.length` drops below the baseline captured
  at deal-close. It does not know *which* Group changed.
- `game.ts:3736-3756` — `startClothingDeal`. `deal.item` is free text parsed by `extractItemAndPrice(raw)`
  — never mapped to a BC Group. The bot has no idea what "their red dress" actually is in BC terms.
- `game.ts:571-573` and `~6156, 6666, 6684` — `roomCharacters: Map<number, BCCharacter>` is kept live
  from every sync, **but is replaced wholesale** on each update. When BC drops a Group from a character's
  `Appearance` array (removed item), the old value is simply gone from the new object — WD currently has
  no memory of what an item *was* once it's removed. (BD has a parallel `itemStateCache` that solves this
  for bondage groups by never clearing non-restraint entries on removal — see `StripDiceBot/src/game.ts:81,
  348-428`. WD has no equivalent yet; §4.1 below ports the idea.)
- `game.ts:6356-6394` — `checkPlayerPermissions(memberNumber, name)`. Already checks
  `OnlineSharedSettings.AllowItem === false` as a hard block at challenge-accept time. Does **not** check
  the finer-grained `ItemPermission` (0-5) or `WhiteList` — this doc adds that check, scoped to the new
  feature (see §4.3).
- `connection.ts:195-222` — `applyItem(target, group, name, color, property)` / `removeItem(target,
  group)`. Both just emit `ChatRoomCharacterItemUpdate`; BC enforces the target's permission server-side,
  silently ignoring the change if blocked. No error comes back — the only way to know it didn't take is
  to check the next sync.
- `connection.ts:268-269` — `getMemberNumber()`, the bot's own member number (needed for the `WhiteList`
  check).
- `types.ts:13-26` — `BCCharacter` already types `ItemPermission?: number`, `WhiteList?: number[]`,
  `OnlineSharedSettings.AllowItem?: boolean` — no new type work needed there.
- `wd_todo.md` HIGH PRIORITY #1 — this doc directly answers/supersedes that item's open question ("Needs
  a live test — add a debug command"); §7 below is that live test, generalized.
- `wd_todo.md` Known Issues — "Buyback: no wardrobe detection on re-equip" (count-only detection can't
  tell add vs remove). §4.2's per-Group diff **solves this as a side effect** — a Group transitioning
  absent→present is an add, present→absent is a removal. Worth closing that known issue when this ships.

## 4. Data findings that shape the design (gathered this session, don't re-derive — just verify still
current before relying on exact numbers)

- **Real appearance Groups seen in production** (WD `run.log` + BD `wrapper_2026-07-13.log`, ~965 synced
  characters): standard BC clothing-relevant groups — `Cloth`, `ClothLower`, `ClothOuter`,
  `ClothAccessory`, `Suit`, `SuitLower`, `Bra`, `Panties`, `Corset`, `Garters`, `Socks`/`SocksLeft`/
  `SocksRight`, `Shoes`, `Gloves`, `Hat`, `Mask`, `Glasses`, `Necklace`, `Jewelry`, `Bracelet`, `Wings`,
  `HairAccessory1/2/3`, `AnkletLeft/Right`, `TailStraps` — plus **~40 addon-added groups**, all suffixed
  `_Luzi` or `_笨笨蛋Luzi`/`_笨笨笨蛋Luzi2`, which either duplicate a stock slot as an extra stacked layer
  (`Cloth_笨笨蛋Luzi`, `Cloth_笨笨笨蛋Luzi2`, `ClothAccessory_笨笨蛋Luzi`, ...) or add slots with no stock
  equivalent at all (extra hair, split left/right eye layers, extra height, body markings, an unlabeled
  "appearance tool" group). Real example: Missy (member #208543) wears `Cloth: CustomTShirt` **and**
  `Suit: FishnetTop` simultaneously — confirms the "dual-layer, ambiguous which Group is 'the shirt'"
  problem is real, not hypothetical.
- **Item `Name` values are usable as labels without any external asset dictionary** — mostly readable
  CamelCase (`FullLatexBra`, `ShoulderlessTop`, `BunnySuit`) or plain Chinese words for CN-origin items
  (女仆胸罩 = "maid bra"). No asset-description lookup table is needed to show a player what an item is.
- **`ItemPermission` is genuinely restrictive for a real chunk of the WD playerbase** — pulled from
  `run.log`: real players observed at levels 1, 2, and 5 (higher = more restrictive), several with an
  empty `WhiteList` (bot not exempted). BD's playerbase skewed much more open (mostly 0). This means: any
  feature that has the bot directly add/remove items on a player **must** degrade gracefully when
  permission is closed — it cannot assume it can always act.
- **The bondage-club-bot-hub reference project** (`D:\Games\BC-Bot\bondage-club-bot-hub-master`, a
  separate, more mature bot framework already sitting on this machine, not part of either bot's own repo)
  solves the permission problem by gating room entry on `character.ItemPermission` being open enough,
  rather than trying to force through a closed permission. Worth the same posture here: don't fight
  the permission system, design around it (act when possible, advise otherwise).

## 5. Design

### 5.1 Group classification — clothing-relevant vs not

Use a **denylist**, not an allowlist, so new/updated addon slots (the Luzi mod gets updated independently
of this bot) are automatically treated as clothing without a code change:

```
A Group is "clothing-relevant" iff it does NOT start with "Item" (that prefix is the bondage/restraint
system, already handled by state.activeBondage/activeLocks) AND it is not in NON_CLOTHING_GROUPS.
```

Seed `NON_CLOTHING_GROUPS` (body/cosmetic/expression groups — confirmed from real sync data this
session; extend if new ones show up in testing):

```ts
const NON_CLOTHING_GROUPS = new Set([
    "ArmsLeft", "ArmsRight", "HandsLeft", "HandsRight", "Height", "BodyStyle", "BodyUpper", "BodyLower",
    "Eyebrows", "Eyes", "Eyes2", "EyeShadow", "Mouth", "Nipples", "Pussy", "Pronouns", "Head", "Blush",
    "Fluids", "Emoticon", "HairFront", "HairBack", "FacialHair", "BodyMarkings", "BodyMarkings2",
    "Decals",
    // Luzi addon cosmetic (non-clothing) slots seen in production:
    "额外身高_Luzi", "额外头发_Luzi", "新前发_Luzi", "新后发_Luzi", "新前发_Luzi_stack",
    "新后发_Luzi_stack", "左眼_Luzi", "右眼_Luzi", "身体痕迹_Luzi", "外观工具",
]);
```

Everything else not starting with `Item` — `Cloth`, `Suit`, `SuitLower`, `Bra`, `Panties`,
`HairAccessory1/2/3`, every `*_Luzi` clothing duplicate, any *future* Luzi slot, etc. — is treated as
clothing. This deliberately over-includes a few borderline cosmetic items (e.g. `HairAccessory*`) rather
than under-include; false positives here just mean an extra candidate in a whisper-confirm list, which is
cheap, vs. a false negative silently missing a real garment.

### 5.2 Wardrobe memory cache (new)

Port BD's `itemStateCache` pattern (`StripDiceBot/src/game.ts:81, 406-428`) into WD as a new field:

```ts
// Full item record (Name/Color/Property) for every appearance Group ever seen on a
// character, keyed by `${memberNumber}:${Group}`. Unlike roomCharacters (replaced
// wholesale each sync, so a removed item's old value is lost), this is updated
// per-Group and — critically — NEVER cleared when a Group disappears from a fresh
// sync. That means it doubles as "last known state" memory for anything ever worn,
// enabling exact restoration later. Populated from the same sync handler that
// updates roomCharacters (~game.ts:6156, 6666, 6684).
private wardrobeItemCache: Map<string, BCAppearanceItem> = new Map();
```

Populate on every full-character sync (same call sites that currently do
`this.roomCharacters.set(memberNumber, data.Character)`): iterate `character.Appearance`, for each item
`wardrobeItemCache.set(`${memberNumber}:${item.Group}`, item)`. Do **not** delete entries for
Groups absent from a fresh sync — that's the whole point (mirrors BD, which only clears its own
`REMOVAL_SLOTS`, i.e. bondage groups; WD's clothing cache should never clear at all).

### 5.3 Per-Group removal detection (upgrade from count-only)

Extend the existing `onSyncSingle`-equivalent handler (`~game.ts:6156-6175`, where `pendingWardrobeChecks`
is currently checked by count) to also do a per-Group diff, independent of any active clothing deal:

For each character sync, compare the fresh `Appearance` array's Group set against what
`wardrobeItemCache` had for that member *before* this update (capture "before" first, then update the
cache, then diff):

- Group present before, absent now, and clothing-relevant (§5.1) → **removed**. Look up the old full item
  record from the cache (already captured, since the cache isn't cleared) and push it to that player's
  removal history (§5.4).
- Group absent before, present now, and clothing-relevant → **added/restored**. This is the "distinguish
  add vs remove" capability the count-only system never had — closes the `wd_todo.md` "Buyback: no
  wardrobe detection on re-equip" known issue as a side effect. Optionally pop the matching entry off the
  removal history if it matches (so a manually-re-equipped item doesn't linger in "recently removed").

This diff should run unconditionally (not just while a clothing deal or wardrobe check is pending) since
the whole point is to have full history available whenever `!stuck`/`!redress` gets used, not just during
an active deal.

### 5.4 Per-player removal history (new)

```ts
interface RemovedClothingEntry {
    group: string;
    item: BCAppearanceItem;   // full Name/Color/Property record from wardrobeItemCache at removal time
    removedAt: number;        // Date.now() at detection
}

// Most-recent-last per player. Not persisted to disk (session-scoped is fine —
// restoring last game's clothes next match isn't a real use case DW asked for;
// revisit if that changes).
private removedClothingHistory: Map<number, RemovedClothingEntry[]> = new Map();
```

Trimmed/cleared on `!reset`, safeword teardown, and match end (`resetGame`/equivalent teardown paths) —
same lifecycle as `pendingWardrobeChecks`.

### 5.5 Permission tiering — can the bot act, or only advise?

New helper, reusing `roomCharacters` (already permission-pre-flight-flagged for this purpose —
see the existing comment at `game.ts:572`) and `checkPlayerPermissions`'s existing `AllowItem` check as a
first gate:

```ts
// True if the bot can directly applyItem/removeItem on this target right now.
// Mirrors the permission logic the bondage-club-bot-hub reference project uses
// (gate on ItemPermission rather than trying to force through a closed one).
private canActOnAppearance(targetMemberNumber: number): boolean {
    const char = this.roomCharacters.get(targetMemberNumber);
    if (!char) return false;
    if (char.OnlineSharedSettings?.AllowItem === false) return false;
    const level = char.ItemPermission ?? 0;
    if (level === 0) return true;
    if (level === 1) return (char.WhiteList ?? []).includes(this.bot.getMemberNumber());
    return false; // levels 2+ : owner/lover/nobody tiers the bot can't realistically satisfy
}
```

Used by both the `!stuck` and `!redress` flows (§5.6, §5.7) to decide: act directly, or fall back to
telling the *other* player exactly what to do by hand (a human partner may have Owner/Lover-tier
permission the bot doesn't).

### 5.6 `!stuck` — narrow down + act or advise

New whisper-only command, usable by either player in an active match (not just during a clothing deal —
a bound player may want help regardless of whether a deal is currently open).

1. Determine the target (the sender, or — if the sender is asking on behalf of a bound partner — the
   opponent; simplest v1: `!stuck` always means "help me", i.e. target = sender; `!stuck them` or similar
   could target the opponent if DW wants that later — start with self-only).
2. Compute candidates = clothing-relevant Groups (§5.1) currently populated (non-empty `Name`) in that
   player's live `roomCharacters` appearance.
3. If a description was given as an argument (`!stuck top`), do a light fuzzy match against candidate
   items' `Name`/Group first — this narrows the list without needing any learned data.
4. If `candidates.length === 1`: skip straight to confirm-and-act (no need to ask, it's not ambiguous).
5. If `candidates.length > 1`: whisper the target (or requester) a numbered list — `Group: formatted
   Name` for each (light label formatting: split CamelCase on capitals; Chinese Names pass through
   unchanged) — and wait for a number reply. (Phase 2, §6, uses learned pairing data to pre-sort/pre-weight
   this list so the likely answer tends to be first.)
6. Once resolved to one Group: check `canActOnAppearance(target)`.
   - **Can act**: `this.bot.removeItem(target, group)`, then verify via the next sync (same
     retry/verify pattern already used in `stripWinnerItem`, `game.ts:5246+` — reuse that structure
     rather than inventing a new one), then confirm to both players in chat/whisper.
   - **Can't act**: whisper the *other* player (the one not stuck) the exact Group + item Name + Color,
     asking them to remove it by hand, since they may have permission the bot doesn't.
7. Either path: the removal, once it actually happens (confirmed via §5.3's diff), lands in
   `removedClothingHistory` exactly like a normal deal-driven removal — no special-casing needed there.

### 5.7 `!redress` — restore from memory

New whisper-only command, same actor rules as `!stuck`.

1. Look up `removedClothingHistory.get(target)`. Empty → whisper "nothing on record to put back."
2. One entry → confirm-and-restore directly. Multiple entries → numbered list (most recent first),
   formatted the same way as `!stuck`'s candidate list, showing Group + Name + Color if non-default.
3. On confirmation, check `canActOnAppearance(target)`:
   - **Can act**: `this.bot.applyItem(target, entry.group, entry.item.Name, entry.item.Color,
     entry.item.Property)`, verify via next sync, remove the entry from history on confirmed success.
   - **Can't act**: whisper the other player the exact Group/Name/Color to re-apply by hand.
4. Optionally offer "restore everything" (iterate the whole history, most-recent-first, same act/advise
   split per item) — nice-to-have, not required for v1.

### 5.8 Deal-time picker upgrade (optional, do last)

Once §5.1–5.4 exist, `startClothingDeal`'s free-text item description (`extractItemAndPrice`,
`game.ts:3799`) could optionally be upgraded to show the buyer a live numbered list of the seller's
actual worn clothing-relevant items (same candidate/format logic as `!stuck`) instead of guessing from
free text. This directly ties `ClothingDeal.item` to a real Group from the start, which makes the
post-deal wardrobe check in §5.3 exact instead of a general diff. Worth doing, but not load-bearing for
the `!stuck`/`!redress` helper flows — can ship after those land and be judged on its own.

## 6. Phase 2 (do only after v1 has real usage data to learn from) — per-player co-removal pairing

Idea (DW): some players' outfits have companion pieces that tend to come off together (a top + a
matching tie/scarf accessory). Track this **per player**, not as a global rule — real outfit data pulled
this session shows outfits are highly individual (Missy's `Cloth: CustomTShirt` + `Suit: FishnetTop`
combo has nothing to do with plenk's `Cloth: FishnetTop` + `ClothOuter: LeatherJacket` combo), so a global
"tops often have scarves" rule would misfire constantly.

Mirrors the existing learned-settings pattern already in BD (`onItemChange`,
`StripDiceBot/src/game.ts:348-361`, feeding `recordItemSetting`/`bondage_usage.json`) — same shape,
applied to clothing co-removal instead of bondage item settings.

```ts
// Persisted (new file, same pattern as bondage_usage.json / players.json — gitignored,
// written via a save*() helper, loaded at startup).
// Keyed by memberNumber, then by groupA -> { groupB -> count }.
// Incremented whenever two clothing-relevant Groups on the same player both flip
// present->absent within a short window (e.g. 60s) of each other (via §5.3's diff).
type CoRemovalData = Record<string /* memberNumber */, Record<string /* groupA */, Record<string /* groupB */, number>>>;
```

Use: when `!stuck`'s candidate list (§5.6 step 5) has more than one entry, sort/weight it by whether any
*already-confirmed-removed-this-match* Group has a high co-removal count with each candidate — put likely
companions first in the numbered list. Also: when `!redress` restores an item, optionally suggest
restoring its learned companion too, if that companion is also currently in the removal history.

Cold-start is expected and fine — a first-time player has no data yet, so the list just falls back to
plain alphabetical/candidate order with no reordering, same as v1 without phase 2 at all.

## 7. Testing plan

Follow the existing precedent set by `!testlock` (`game.ts:3296-3315`, added earlier this session for the
timer-password-lock bug) — a debug/admin command that exercises the real path instantly instead of
needing a full match:

- `!teststrip [@name] [group]` — admin-only, whispers back whether `canActOnAppearance` says act-or-advise
  for the target, then actually calls `removeItem`/`applyItem` on the named (or a prompted-for) Group and
  reports what the next sync shows. This is the literal "live test" `wd_todo.md`'s HIGH PRIORITY #1 has
  been waiting on — implementing it also closes that todo item.
- Manually verify against a real modded (Luzi) account if DW has access to one, to confirm the denylist
  in §5.1 doesn't misclassify any of the addon's slots DW actually sees in practice — the seed list in
  this doc is derived from log data, not exhaustively verified against the live addon.
- Verify `!stuck`/`!redress` behave correctly for a player with `ItemPermission` 0 (act path) and a
  player with `ItemPermission` ≥ 2 or an empty relevant `WhiteList` (advise path) — both cases are known
  to occur in the real playerbase (§4).

## 8. Open questions for DW (resolve before or during implementation, not blocking the doc)

1. Should `!stuck`/`!redress` be usable by *either* player in the match (self or on behalf of the
   opponent), or self-only for v1? (§5.6 step 1 assumes self-only to start.)
2. Should `removedClothingHistory` persist across a reset/reconnect within the same match, or is
   session-scoped (cleared on any teardown) fine? (§5.4 assumes session-scoped.)
3. Any appetite for §5.8 (deal-time picker) in the same pass, or strictly a follow-up?
4. Confirm the `NON_CLOTHING_GROUPS` seed list (§5.1) against a live Luzi-modded account before shipping
   — it's derived from log data gathered this session, not hand-verified against the addon itself.
