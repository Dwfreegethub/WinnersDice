import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { log, logError, centralTimestamp } from "./logger";
import { secrets, botRole, mainRoomName } from "./secrets";
import { readPendingUpdate, getSeenVersion, markVersionSeen } from "./pendingUpdate";
import {
    ActiveBondage,
    ActiveEndGame,
    ActiveLock,
    ActiveToy,
    BCCharacter,
    BCAppearanceItem,
    RemovedClothingEntry,
    RegisteredPlayer,
    Player,
    BondageDeal,
    ClothingDeal,
    DiceRoll,
    EndGameProposal,
    FeedbackItemStatus,
    FeedbackStatusEntry,
    GameConfig,
    GameState,
    HandoffEntry,
    LockDeal,
    MatchResultEntry,
    MercyRequest,
    NegotiationKey,
    NegotiationState,
    PairBalanceEntry,
    PairSettingsEntry,
    PlayerRecord,
    ChangelogEntry,
    PlayerSettingsEntry,
    SavedGameConfig,
    PlayerState,
    RoomType,
    RoundResult,
    ServiceDeal,
    SoldItem,
    SpendOption,
    ToyDeal,
} from "./types";
import { PICK_SLOTS, PickSlot, PICK_LIST_TOP_N, NEW_ITEMS, loadBcItemCatalog } from "./bondagePicker";
import { writeHandoff, listPendingHandoffs, claimHandoff, writeResult, listPendingResults, markResultProcessed, listClaimedHandoffs } from "./handoff";

const FEEDBACK_STATUS_LABELS: Record<FeedbackItemStatus, string> = {
    pending: "⏳ Pending review",
    reviewing: "🔍 Reviewing",
    testing: "🧪 Testing",
    implemented: "✅ Implemented",
    declined: "❌ Declined",
    partly_implemented: "🔧 Partly implemented",
};

// Statuses that count as "resolved" - shown to the submitter only once.
const RESOLVED_FEEDBACK_STATUSES: ReadonlySet<FeedbackItemStatus> = new Set([
    "implemented",
    "declined",
    "partly_implemented",
]);

// Statuses that are still "in progress" - covered by a single bundled
// "we're reviewing it" ack rather than a per-item whisper.
const REVIEWING_FEEDBACK_STATUSES: ReadonlySet<FeedbackItemStatus> = new Set([
    "pending",
    "reviewing",
    "testing",
]);

// ============================================================
// WinnersDice
// ============================================================
//
// A 2-player push-your-luck dice game built around a point
// economy, pre-game negotiation of stakes, and a banking
// mechanic.
// ============================================================

const NEGOTIATION_ORDER: NegotiationKey[] = ["minRounds", "stripping", "bondage", "toys", "services"];

// Determines which setting still needs to be agreed on, in order.
// Note: bondage application and lock duration are no longer negotiated up
// front — the other player always applies it, and lock time comes from
// purchases made during the game.
function nextNegotiationKey(config: Partial<GameConfig>): NegotiationKey | null {
    for (const key of NEGOTIATION_ORDER) {
        if (!(key in config)) return key;
    }
    return null;
}

function settingLabel(key: NegotiationKey): string {
    switch (key) {
        case "minRounds": return "Minimum rounds";
        case "stripping": return "Stripping";
        case "bondage": return "Bondage";
        case "bondageAppliedBy": return "Bondage application";
        case "lockDuration": return "Lock duration (minutes)";
        case "toys": return "Toys";
        case "services": return "Actions & Services";
    }
}

// The natural-language question asked when a numeric setting needs a value.
function numericQuestion(key: NegotiationKey): string {
    switch (key) {
        case "minRounds": return "how many minimum rounds before the winner can end the game? (default 3)";
        case "lockDuration": return "how long should bondage last? (in minutes, default 10)";
        default: return `what value would you like for ${settingLabel(key).toLowerCase()}?`;
    }
}

// Re-prompt used when a player's reply to a numeric question contained no number.
function numericReprompt(key: NegotiationKey): string {
    switch (key) {
        case "minRounds": return "I didn't catch a number — how many rounds would you like?";
        case "lockDuration": return "I didn't catch a number — how many minutes should bondage last?";
        default: return "I didn't catch a number — what value would you like?";
    }
}

// Extracts the first integer found in free-form text, e.g. "4 rounds" -> 4,
// "30 minutes" -> 30, "I'd like 4" -> 4. Returns null if no number is found.
function extractNumber(text: string): number | null {
    const match = text.match(/-?\d+/);
    if (!match) return null;
    return parseInt(match[0], 10);
}

// Settings that are simple yes/no toggles, asked directly to both players.
// Anything not in this set is settled via the !propose/!accept/!counter/!decline flow.
const YES_NO_KEYS = new Set<NegotiationKey>(["stripping", "bondage", "toys", "services"]);

function isYesNoKey(key: NegotiationKey): boolean {
    return YES_NO_KEYS.has(key);
}

function yesNoQuestion(key: NegotiationKey): string {
    switch (key) {
        case "stripping": return "Enable stripping?";
        case "bondage": return "Enable bondage and locks?";
        case "toys": return "Enable toys?";
        case "services": return "Enable actions & services?";
        default: return `Enable ${settingLabel(key)}?`;
    }
}

// The single up-front consent question asked before the individual yes/no
// settings — if both players agree, all four are enabled at once and the
// individual questions are skipped entirely. Falls back to those individual
// questions if either player says no.
const CONSENT_ALL_QUESTION =
    "WinnersDice is an adult game involving stripping, bondage, use of locks and restraints, sexual situations, " +
    "and potentially actions & services or being under the other player's control for a period of time. " +
    "Do you both agree to all of this? (yes / no)";

// Asked instead of ROOM_TYPE_QUESTION when the (single) room bot is already
// mid-match — see promptNextSetting's lobbyFallbackStage check. Both players
// answer independently; either "no" cancels the match.
const LOBBY_FALLBACK_QUESTION =
    "The private room is currently in use by another match — right now we can only offer public play here in the lobby. " +
    "Want to play here instead? (yes/no)";

// Final negotiation question — see design_multi_room.md. Both players answer
// independently; a mismatch falls back to "private" (handleRoomTypeAnswer).
const ROOM_TYPE_QUESTION =
    "Last question — what kind of room would you like?\n" +
    "1) Spectator — public, anyone can watch\n" +
    "2) Private — hidden, just you two\n" +
    "3) Locked — hidden and locked, admin-only access\n" +
    "(reply with 1, 2, or 3)";

function parseRoomTypeAnswer(text: string): RoomType | null {
    const trimmed = text.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "spectator" || trimmed === "public") return "spectator";
    if (trimmed === "2" || trimmed === "private" || trimmed === "hidden") return "private";
    if (trimmed === "3" || trimmed === "locked" || trimmed === "lock") return "locked";
    return null;
}

function rollD20(): number {
    return Math.floor(Math.random() * 20) + 1;
}

// Default cap on each player's earned streak, used until an admin changes it
// with !setstreak between games.
const DEFAULT_MAX_STREAK = 10;

// How many past updates changelog.json keeps, and how many of those
// !changelog whispers back. Showing fewer than we keep means a player
// returning after a long absence gets the recent highlights, not all history.
const CHANGELOG_MAX_ENTRIES = 40;
const CHANGELOG_ENTRIES_SHOWN = 5;

// Cost in points to purchase +1 through +5 boost (index 0 = level 1).
const BOOST_PRICES = [40, 100, 225, 500, 1000];

// Maximum total boost a player can hold at once.
const MAX_BOOST = 5;

// Quick-pick duration options (minutes) offered when a toy deal's price is
// agreed — the winner can also type any custom number of minutes.
const TOY_DURATION_OPTIONS = [5, 10, 15, 30];

// How long the bot waits for a wardrobe change after a clothing deal is
// agreed before nudging the buyer to follow up directly.
const WARDROBE_CHECK_TIMEOUT_MS = 2 * 60 * 1000;

// How long the challenged player has to answer yes/no before a challenge expires.
const CHALLENGE_ACCEPTANCE_TIMEOUT_MS = 30 * 1000;

// How long the remaining player has to wait (or safeword out early) after
// their opponent disconnects mid-match before the game auto-ends — see
// onMemberLeave/expireDisconnectTimer.
const DISCONNECT_TIMEOUT_MS = 3 * 60 * 1000;
// How long the room bot waits for the winner to confirm they're done before
// it resets the room for the next match anyway (see pendingRoomReset).
const ROOM_RESET_CONFIRM_TIMEOUT_MS = 3 * 60 * 1000;
// How long the bot waits for both players to confirm the settings once they're
// in the room before the first roll — the match is cancelled if they don't
// (see pendingMatchStart / beginMatchStartConfirm).
const MATCH_START_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

// If true, a placer who removes bondage they placed (!removebondage) can
// re-apply that same item to the same slot for free (!reapplybondage),
// as long as nothing else has filled the slot in the meantime.
const ALLOW_FREE_REAPPLY = true;

// Lock removal costs this multiple of the price agreed when the lock deal
// was struck — same multiplier as clothing buyback (buying back a sold
// item costs double its sale price; see handleBuybackResponse).
const LOCK_REMOVAL_MULTIPLIER = 2;

// When stripping the winner's bondage at end of game, items are removed one
// at a time with this delay between each so the client isn't hit with
// several simultaneous item updates.
const END_GAME_STRIP_STAGGER_MS = 1000;

// After each removal, how long to wait before checking the winner's synced
// appearance to confirm the item actually came off.
const END_GAME_STRIP_VERIFY_DELAY_MS = 1000;

// Total attempts (initial + retries) before giving up on a stuck item and
// telling the winner to remove it manually.
const END_GAME_STRIP_MAX_ATTEMPTS = 3;

// Hard cap on how many rolls (initial roll + presses) a round can go through
// before the current winner must bank or end the match — prevents a single
// round from pressing indefinitely.
const MAX_ROLLS_PER_ROUND = 20;

// ============================================================
// END GAME
// ============================================================

// BC group names a winner can request an additional Exclusive lock on
// during the end game proposal (Q4). These mirror a subset of PICK_SLOTS'
// groups; ItemLeash is deliberately excluded from this list — it's reserved
// for the timer/password lock applied automatically on execution.
const END_GAME_LOCK_SLOTS = ["ItemLegs", "ItemFeet", "ItemArms", "ItemHands", "ItemTorso", "ItemMouth", "ItemHead", "ItemNeck"];

// bc_items.json has no literal "ItemLeash" group — BC's closest real
// equivalent is ItemNeckRestraints, which includes a leash-style item.
// Used for the winner's timer/password lock on the loser (see executeEndGame).
const END_GAME_LEASH_GROUP = "ItemNeckRestraints";
const END_GAME_LEASH_ITEM = "CollarLeash";

// ── Wardrobe helper (see design_wardrobe_helper.md) ──────────────────────
// Body/cosmetic/expression appearance groups that are NOT clothing. Used as a
// DENYLIST: a group is "clothing-relevant" iff its name does NOT start with
// "Item" (that prefix is the bondage/restraint system, handled elsewhere) AND
// it is not in this set. A denylist means new/updated addon clothing slots
// (e.g. the "Luzi" community addon, updated independently of this bot) are
// treated as clothing automatically, without a code change. Over-including a
// borderline cosmetic item just adds a cheap extra candidate to a confirm
// list; under-including would silently miss a real garment — so we err toward
// including. Seeded from real production sync data; extend if new ones show up.
const NON_CLOTHING_GROUPS = new Set<string>([
    "ArmsLeft", "ArmsRight", "HandsLeft", "HandsRight", "Height", "BodyStyle", "BodyUpper", "BodyLower",
    "Eyebrows", "Eyes", "Eyes2", "EyeShadow", "Mouth", "Nipples", "Pussy", "Pronouns", "Head", "Blush",
    "Fluids", "Emoticon", "HairFront", "HairBack", "FacialHair", "BodyMarkings", "BodyMarkings2",
    "Decals",
    // Luzi addon cosmetic (non-clothing) slots seen in production:
    "额外身高_Luzi", "额外头发_Luzi", "新前发_Luzi", "新后发_Luzi", "新前发_Luzi_stack",
    "新后发_Luzi_stack", "左眼_Luzi", "右眼_Luzi", "身体痕迹_Luzi", "外观工具",
]);

// When the loser has no collar for the leash to attach to, we add this one.
// Deliberately a plain, un-typed collar (LeatherCollar has no style/type
// record): a lock-only Property is a COMPLETE valid property for it, so the
// lock sticks on a fresh apply — the same reason the leash locks fine. A
// typed collar (e.g. a shock collar) would get rebuilt to unlocked defaults
// by BC when applied with a property that omits its type record. See
// ensureCollarForLeash.
const END_GAME_FRESH_COLLAR_ITEM = "LeatherCollar";

// How long a !stuck / !redress numbered pick waits for the player's reply
// before it's dropped.
const WARDROBE_PICK_TIMEOUT_MS = 2 * 60 * 1000;

// Matchmaking (see design_matchmaking.md).
const LOOKING_COOLDOWN_MS = 30 * 60 * 1000;   // between !looking uses (admins exempt)
const LOOKING_RELAY_WINDOW_MS = 10 * 60 * 1000; // relay beep-replies to the seeker for this long
const LOOKING_STAY_MS = 3 * 60 * 1000;        // must stay this long after !looking or it's an early leave

// Word bank for the end-game timer/password lock's password (see
// buildTimerPasswordLockProperty). Deliberately letters-only — BC's
// TimerPasswordPadlock appears to reject/silently fail to save a password
// that starts with (or is composed of) digits, confirmed via live testing.
// Also capped at 8 characters — BC appears to reject longer passwords too.
const END_GAME_LOCK_PASSWORD_WORDS = [
    "OBEDIENT", "NAUGHTY", "COLLARED", "BONDAGE", "SUBSPACE",
    "KITTEN", "BRATTY", "DEVIOUS", "BOUND", "TEASED",
    "PET", "MISTRESS", "HELPLESS", "SQUIRM", "BLINDED",
    "SHACKLED", "WHIMPER", "CAPTIVE", "LEASHED", "EDGED",
];

// Words ignored when extracting a clothing item name from free-form text,
// e.g. "I'd like their red dress for 50 points" -> "red dress".
const ITEM_NAME_FILLER_WORDS = new Set([
    "i'd", "id", "i", "i'll", "ill", "would", "want", "wanna", "like", "to", "buy", "get", "take",
    "their", "your", "his", "her", "the", "a", "an", "for", "please", "and", "of", "item", "that",
    "this", "points", "point", "pts", "pt", "with",
]);

// Extracts a clothing item name and an offered price from free-form text,
// e.g. "I'd like their red dress for 50 points" -> { item: "red dress", price: 50 }.
// Either field may be null if it couldn't be found.
function extractItemAndPrice(text: string): { item: string | null; price: number | null } {
    const price = extractNumber(text);

    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9'\s]/g, " ")
        .split(/\s+/)
        .filter(w => w && !ITEM_NAME_FILLER_WORDS.has(w) && !/^-?\d+$/.test(w));

    const item = words.length > 0 ? words.join(" ") : null;
    return { item, price };
}

// ============================================================
// STRUCTURED PRICE NEGOTIATION (bondage, lock, and toy deals)
// ============================================================
//
// A fixed 5-step negotiation shared by every price-bearing deal type:
//   1. Initiator (the winner/buyer, or the placer in a bondage removal deal)
//      makes an opening offer -> sets their FLOOR; their own later offers
//      can only go up from here.
//   2. Responder (the loser/wearer) counters -> sets their CEILING; their
//      own later counters can only go down from here.
//   3. Initiator counters -> must be >= their opening offer (the floor).
//   4. Responder counters -> must be <= their step-2 counter (the ceiling).
//   5. Initiator sets a final price -> must be >= their step-3 counter.
//      Binding — finalizes immediately, no further response needed.
// At any point, if the responder's counter crosses the initiator's most
// recent offer (responder counter <= initiator offer), or the initiator's
// counter crosses the responder's most recent counter (initiator offer >=
// responder counter), the deal closes instantly at the responder's price —
// they've met in the middle (or the responder undercut what was on the table).
// ============================================================

// Shape shared by BondageDeal, LockDeal, and ToyDeal for the fields this
// negotiation engine reads/writes.
interface PriceNegotiation {
    negotiationStep: number;
    price: number | null;
    counterPrice: number | null;
    initiatorFloor: number | null;
    responderCeiling: number | null;
}

// Deliberately a single flat interface rather than a discriminated union —
// `error` is only ever set when `ok` is false, but keeping it optional on
// one shape (instead of a `{ok:false;error} | {ok:true;...}` union) sidesteps
// a control-flow narrowing failure TypeScript 6.0.3 hits on this file at this
// size (verified: identical union narrowing works fine in isolation, but
// silently fails to narrow `!result.ok` once embedded in the full class).
interface OfferOutcome {
    ok: boolean;
    // Set only when ok is false — always present in that case by construction.
    error?: string;
    // Set only when ok is true and this was the final, binding step-5 offer.
    final?: boolean;
    // Set only when ok is true and the deal closed instantly at `price`
    // (the responder's own price — either their fresh counter, or their
    // earlier ceiling that the initiator's counter just crossed).
    matched?: boolean;
    price?: number;
    // Set only when ok is true and the submitted amount was silently
    // adjusted (Rule A's first-counter cap, or Rule B's gap-closing floor)
    // — the caller should whisper this to whoever just countered.
    notice?: string;
}

// Shop-negotiation-only counter-offer rules (not used by the initial
// challenge negotiation or the end-game proposal, which have their own
// independent negotiation code). Gap threshold below which either rule stops
// constraining the next counter.
const COUNTER_GAP_FLOOR = 50;
// Subsequent counters (second counter onwards) must close at least this
// fraction of the current gap between seller ask and buyer bid.
const COUNTER_GAP_CLOSE_FRACTION = 0.10;

// Rule A: when the original offer (the deal's opening price) is > 500, the
// responder's first counter-offer is capped at 2x that original offer.
function applyFirstCounterCap(originalOffer: number, amount: number): { amount: number; notice?: string } {
    if (originalOffer <= 500) return { amount };
    const cap = originalOffer * 2;
    if (amount <= cap) return { amount };
    return {
        amount: cap,
        notice: `Your first counter can't be more than 2× the original offer of ${originalOffer}. Using the maximum of ${cap} instead.`,
    };
}

// Rule B: from the second counter-offer onwards, the mover must close the
// gap between the current outstanding ask and bid by at least 10% (rounding
// the minimum movement to the nearest integer). `movingUp` is true when the
// mover's own value is increasing toward the other side (the initiator's
// turn); false when it's decreasing (the responder's turn). Returns null if
// the gap is small enough that any counter is valid.
function gapCloseMinimum(ownPrevValue: number, otherValue: number, movingUp: boolean): number | null {
    const gap = Math.abs(otherValue - ownPrevValue);
    if (gap <= COUNTER_GAP_FLOOR) return null;
    const movement = Math.round(gap * COUNTER_GAP_CLOSE_FRACTION);
    return movingUp ? ownPrevValue + movement : ownPrevValue - movement;
}

function applyGapCloseRule(ownPrevValue: number, otherValue: number, amount: number, movingUp: boolean): { amount: number; notice?: string } {
    const minimum = gapCloseMinimum(ownPrevValue, otherValue, movingUp);
    if (minimum === null) return { amount };
    if (movingUp ? amount >= minimum : amount <= minimum) return { amount };
    return { amount: minimum, notice: `That's below the minimum — using ${minimum} instead.` };
}

// The "Minimum counter: X pts" hint appended to the prompt shown when asking
// whoever's about to submit the next counter-offer for their number — empty
// before Rule B is in effect (opening offer, or the very first counter-offer,
// which is governed by Rule A instead) or while the gap is small enough to
// leave any counter valid.
function counterOfferHint(deal: PriceNegotiation): string {
    if (deal.negotiationStep !== 2 && deal.negotiationStep !== 3 && deal.negotiationStep !== 4) return "";
    const bid = deal.price;
    const ask = deal.counterPrice;
    if (bid === null || ask === null) return "";
    const movingUp = deal.negotiationStep === 2 || deal.negotiationStep === 4;
    const minimum = gapCloseMinimum(movingUp ? bid : ask, movingUp ? ask : bid, movingUp);
    if (minimum === null) return "";
    return ` Minimum counter: ${minimum} pts (must close the gap by at least 10%).`;
}

// Called with the initiator's (winner's, or removal-deal placer's) offer.
// Valid at step 0 (opening offer), step 2 (their first counter, >= floor),
// and step 4 (their final, binding counter, >= their step-3 counter).
function applyInitiatorOffer(deal: PriceNegotiation, amount: number): OfferOutcome {
    if (deal.negotiationStep === 0) {
        deal.price = amount;
        deal.initiatorFloor = amount;
        deal.negotiationStep = 1;
        return { ok: true };
    }

    if (deal.negotiationStep === 2) {
        if (amount < deal.initiatorFloor!) {
            return { ok: false, error: `Your counter must be higher than your opening offer of ${deal.initiatorFloor}.` };
        }

        const { amount: adjusted, notice } = applyGapCloseRule(deal.price!, deal.counterPrice!, amount, true);

        if (adjusted >= deal.responderCeiling!) {
            deal.negotiationStep = 3;
            return { ok: true, matched: true, price: deal.responderCeiling!, notice };
        }
        deal.price = adjusted;
        deal.negotiationStep = 3;
        return { ok: true, notice };
    }

    if (deal.negotiationStep === 4) {
        if (amount < deal.price!) {
            return { ok: false, error: `Your final price must be at least your previous counter of ${deal.price}.` };
        }

        const { amount: adjusted, notice } = applyGapCloseRule(deal.price!, deal.counterPrice!, amount, true);

        deal.price = adjusted;
        deal.negotiationStep = 5;
        return { ok: true, final: true, notice };
    }

    return { ok: false, error: "This negotiation has already concluded." };
}

// Called with the responder's (loser's, or removal-deal wearer's) counter.
// Valid at step 1 (their first counter, sets the ceiling — subject to Rule
// A's first-counter cap) and step 3 (their second counter, <= their step-2
// counter / ceiling — subject to Rule B's gap-closing requirement).
function applyResponderCounter(deal: PriceNegotiation, amount: number): OfferOutcome {
    if (deal.negotiationStep === 1) {
        const { amount: capped, notice } = applyFirstCounterCap(deal.initiatorFloor!, amount);

        deal.counterPrice = capped;
        deal.responderCeiling = capped;
        deal.negotiationStep = 2;
        if (capped <= deal.initiatorFloor!) {
            return { ok: true, matched: true, price: capped, notice };
        }
        return { ok: true, notice };
    }

    if (deal.negotiationStep === 3) {
        if (amount > deal.responderCeiling!) {
            return { ok: false, error: `Your counter must be lower than your previous counter of ${deal.responderCeiling}.` };
        }

        const { amount: adjusted, notice } = applyGapCloseRule(deal.counterPrice!, deal.price!, amount, false);

        deal.counterPrice = adjusted;
        deal.negotiationStep = 4;
        if (adjusted <= deal.price!) {
            return { ok: true, matched: true, price: adjusted, notice };
        }
        return { ok: true, notice };
    }

    return { ok: false, error: "This negotiation has already concluded." };
}

function formatValue(key: NegotiationKey, value: any): string {
    if (typeof value === "boolean") return value ? "yes" : "no";
    return String(value);
}

// Returns the parsed value on success, or an error message string on failure.
function parseProposalValue(key: NegotiationKey, raw: string): { value: any } | string {
    const v = raw.trim().toLowerCase();
    switch (key) {
        case "minRounds": {
            const n = extractNumber(v);
            if (n === null || n < 1 || n > 20) return "Minimum rounds must be a number between 1 and 20.";
            return { value: n };
        }
        case "lockDuration": {
            const n = extractNumber(v);
            if (n === null || n < 1 || n > 120) return "Lock duration must be a number of minutes between 1 and 120.";
            return { value: n };
        }
        case "bondageAppliedBy": {
            if (v === "bot" || v === "player") return { value: v };
            return "Please propose 'bot' or 'player'.";
        }
        default: {
            if (v === "yes" || v === "y" || v === "true") return { value: true };
            if (v === "no" || v === "n" || v === "false") return { value: false };
            return "Please propose 'yes' or 'no'.";
        }
    }
}

// ============================================================
// TOY CATALOG
// ============================================================

interface ToyCatalogEntry {
    // BC asset name for applyItem()/removeItem() (ItemHandheld group).
    assetName: string;
    // Display label shown to players.
    label: string;
}

// Parses one line of ItemHandheld_toys_list.txt: either a plain English
// name (e.g. "Flogger") or "ChineseName (English translation)". The display
// label is the English name (or the parenthesized translation); the BC
// asset name is whatever comes before the first space/paren.
function parseToyCatalogLine(line: string): ToyCatalogEntry | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const match = trimmed.match(/^(\S+)\s*\(([^)]+)\)\s*$/);
    if (match) {
        return { assetName: match[1], label: match[2].trim() };
    }
    return { assetName: trimmed.split(/\s+/)[0], label: trimmed };
}

// Curated popular toys shown by default in the toy picker, mirroring
// buildBondagePickList's top-N list — toys have no per-item usage tracking,
// so this is a static curated set instead of a usage-ranked one. Filled out
// to PICK_LIST_TOP_N with random catalog picks not already in this list.
const POPULAR_TOY_ASSET_NAMES = [
    "Flogger",
    "Crop",
    "Paddle",
    "Cane",
    "Whip",
    "Vibrator",
    "VibratingWand",
    "Feather",
    "CattleProd",
];

// Missing/invalid file disables the toys menu option entirely (empty array)
// rather than crashing the bot — mirrors loadBcItemCatalog's behavior.
function loadToyCatalog(filePath: string, log: (message: string) => void): ToyCatalogEntry[] {
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const entries: ToyCatalogEntry[] = [];
        for (const line of raw.split(/\r?\n/)) {
            const entry = parseToyCatalogLine(line);
            if (entry) entries.push(entry);
        }
        return entries;
    } catch (err) {
        log(`WARNING: Could not load ${filePath} — toys menu disabled: ${err}`);
        return [];
    }
}

export class WinnersDiceGame {
    private bot: BCConnection;
    private roomMembers: Map<number, Player>;
    private state: GameState;

    private feedbackStatus: Record<string, FeedbackStatusEntry> = {};
    private feedbackNotified: Set<number> = new Set();
    private readonly feedbackStatusPath = path.join(__dirname, "..", "feedback_status.json");
    private readonly feedbackLogPath = path.join(__dirname, "..", "feedback.log");

    private playerRecords: Record<string, PlayerRecord> = {};
    private readonly playerRecordsPath = path.join(__dirname, "..", "players.json");
    private readonly changelogPath = path.join(__dirname, "..", "changelog.json");

    // Matchmaking pool (main/lobby bot only — see design_matchmaking.md),
    // keyed by member number. Persisted separately from players.json so
    // registration survives match resets.
    private registeredPlayers: Record<string, RegisteredPlayer> = {};
    private readonly registeredPlayersPath = path.join(__dirname, "..", "registered_players.json");

    // In-flight !looking calls, keyed by seeker member number: who we beeped on
    // their behalf and until when replies should be relayed back to them.
    private activeLookingCalls: Map<number, { seeker: number; beeped: Set<number>; expiresAt: number }> = new Map();
    // Pending 3-minute "stay" timers per seeker (early-leave detection).
    private lookingStayTimers: Map<number, NodeJS.Timeout> = new Map();

    // Per-pair leftover point carryover — see PairBalanceEntry.
    private pairBalances: Record<string, PairBalanceEntry> = {};
    private readonly pairBalancesPath = path.join(__dirname, "..", "pair_balances.json");

    // Per-player and per-pair saved negotiation settings — see SavedGameConfig,
    // PlayerSettingsEntry, PairSettingsEntry (types.ts). Written at finishNegotiation().
    private playerSettings: Record<number, PlayerSettingsEntry> = {};
    private readonly playerSettingsPath = path.join(__dirname, "..", "player_settings.json");
    private pairSettings: Record<string, PairSettingsEntry> = {};
    private readonly pairSettingsPath = path.join(__dirname, "..", "pair_settings.json");

    // Cap on streak for the *next* match, admin-settable via !setstreak.
    private defaultMaxStreak: number = DEFAULT_MAX_STREAK;

    // True for the current match when the loser's end-game lock must be a
    // High-Security padlock instead of the default TimerPasswordPadlock —
    // because a player had TimerPasswordPadlock blocked and both agreed to the
    // alternative (see the lock-block resolve gate). Set fresh in launchMatch()
    // from the negotiation/handoff, read in applyEndGameLocks().
    private matchUsesHighSecurityLock: boolean = false;

    // Wardrobe-change checks awaiting a ChatRoomSyncSingle for the opponent
    // in a clothing deal, keyed by the opponent's member number.
    // baselineCount is their Appearance.length captured when the deal
    // closed (see startWardrobeCheck) — onSyncSingle only treats a fresh
    // sync as confirmation once the count actually drops below it, rather
    // than trusting any resync event. Null when no cached appearance was
    // available at that moment (falls back to trust-any-sync).
    private pendingWardrobeChecks: Map<number, {
        buyer: number;
        item: string;
        timer: NodeJS.Timeout;
        baselineCount: number | null;
    }> = new Map();

    // Full character data from the most recent room sync or join event, keyed
    // by member number. Used for permission pre-flight checks.
    private roomCharacters: Map<number, BCCharacter> = new Map();

    // ── Wardrobe helper state (see design_wardrobe_helper.md) ────────────
    // Last-known full item record (Name/Color/Property) for every appearance
    // Group ever seen on a match participant, keyed `${memberNumber}:${Group}`.
    // Unlike roomCharacters (replaced wholesale each sync, so a removed item's
    // old value is lost), this is updated per-Group and NEVER cleared when a
    // Group disappears — so it doubles as "last known state" memory, letting
    // !redress re-apply an item exactly even after it's been off for a while.
    private wardrobeItemCache: Map<string, BCAppearanceItem> = new Map();

    // Per-player history of clothing-relevant items the bot detected coming
    // off during the current match, most-recent-last. Feeds !redress. Session-
    // scoped: survives a reconnect (teardown paths don't run on reconnect) but
    // is cleared on reset / safeword / match end, same lifecycle as
    // pendingWardrobeChecks.
    private removedClothingHistory: Map<number, RemovedClothingEntry[]> = new Map();

    // Groups removed as part of the most recent completed clothing deal, per
    // player. Set in completeWardrobeCheck once ingestAppearance has already
    // diffed the sync. Used to float shop-deal items to the top of !stuck /
    // !redress lists and to auto-apply for admins. Cleared with the rest of
    // wardrobe helper state on reset / safeword / match end.
    private lastShopRemovedGroups: Map<number, string[]> = new Map();

    // A !stuck / !redress numbered pick awaiting the invoker's reply. Self-only
    // in v1, so memberNumber is both the invoker and the target.
    private pendingWardrobeAction: {
        memberNumber: number;
        kind: "stuck" | "redress";
        options: Array<{ group: string; item: BCAppearanceItem }>;
        timer: NodeJS.Timeout;
    } | null = null;

    // Admin !testredress numbered pick awaiting the admin's reply. Unlike
    // pendingWardrobeAction, invoker (adminNumber) and target differ.
    private pendingTestRedress: {
        adminNumber: number;
        target: number;
        options: Array<{ group: string; item: BCAppearanceItem }>;
        timer: NodeJS.Timeout;
    } | null = null;

    // Full BC item catalog (group -> item names), shared read-only reference
    // living one level above both bots' repos. Missing/invalid file disables
    // bondage purchases rather than crashing the bot (itemCatalog.size === 0).
    private readonly itemCatalog: Map<string, string[]>;

    // Per-slot popularity counts driving the bondage item picker's top-N list,
    // separate from StripDiceBot's own usage data.
    private bondageUsage: Record<string, Record<string, number>> = {};
    private readonly bondageUsagePath = path.join(__dirname, "..", "bondage_usage.json");

    // Toy catalog for the spend menu's "toys" option, loaded once at startup.
    // Empty (length 0) disables the toys menu option entirely.
    private readonly toyCatalog: ToyCatalogEntry[];

    // Set while a !challenge's target name matches more than one room member,
    // OR while !challenge was used with no argument (listing all room members).
    // Holds the challenger's numbered reply until they pick one.
    private pendingChallengeDisambiguation: { challengerNumber: number; candidates: Player[] } | null = null;

    // True while the end game proposal's Q4 is waiting for the winner's
    // comma-separated slot list, after they answered "yes" to placing locks.
    // Only meaningful while state.endGameProposal.proposalStage === "q4_locks".
    private endGameAwaitingLockSlotsInput: boolean = false;

    // Multi-room mode (BOT_ROLE !== "main" — see design_multi_room.md): the
    // handoff this room bot has claimed and is either waiting on player
    // arrival for, or actively running the match for. Null while idle/polling.
    private activeHandoff: HandoffEntry | null = null;
    private handoffEntryTimer: NodeJS.Timeout | null = null;
    // Room bot only: after a match's end-game session wraps up, the room reset
    // (leave/recreate the room for the next match) is held until the winner
    // confirms they're done — so the room isn't yanked out from under players
    // who are still in it. activeHandoff stays set during this window, which
    // keeps pollForHandoff from claiming a new match. Auto-resets on timeout.
    private pendingRoomReset: { winnerMemberNumber: number; timer: NodeJS.Timeout } | null = null;
    // Set between launchMatch and the first roll: both players must confirm the
    // settings before rolling begins (see beginMatchStartConfirm). Tracks who's
    // confirmed so far; the match is cancelled if both don't confirm in time.
    private pendingMatchStart: { confirms: Set<number>; timer: NodeJS.Timeout } | null = null;
    // True once this room bot has checked handoffs/claimed/ for orphaned
    // claims left over from a previous run that was killed/crashed mid-match
    // without going through a normal end path — see reapOwnOrphanedClaims.
    private hasReapedOrphanedClaims = false;

    // Lobby bot (BOT_ROLE=main): handoff ids already relayed to their two
    // players via relayClaimedRoomInvites, so a repeat poll doesn't re-whisper
    // them. In-memory only — worst case on a lobby-bot restart is one
    // harmless repeat whisper, not lost state.
    private relayedRoomInvites: Set<string> = new Set();

    constructor(bot: BCConnection, roomMembers: Map<number, Player>) {
        this.bot = bot;
        this.roomMembers = roomMembers;
        this.state = this.createIdleState();
        this.itemCatalog = loadBcItemCatalog(path.join(__dirname, "..", "..", "bc_items.json"), (msg) => log(msg));
        this.toyCatalog = loadToyCatalog(path.join(__dirname, "..", "ItemHandheld_toys_list.txt"), (msg) => log(msg));
        this.loadBondageUsage();
        this.loadFeedbackStatus();
        this.loadPlayerRecords();
        this.loadRegisteredPlayers();
        this.loadPairBalances();
        this.loadPlayerSettings();
        this.loadPairSettings();

        // Multi-room mode (BOT_ROLE=main): poll for match results room bots
        // have written, on the same cadence as a room bot's own pending-handoff
        // poll (see design_multi_room.md). Also relay each claimed match's
        // resolved room name to its two players as soon as it's known.
        if (botRole === "main") {
            setInterval(() => this.processHandoffResults(), 10_000);
            setInterval(() => this.relayClaimedRoomInvites(), 5_000);
        } else {
            // Room bot: poll for handoffs to claim. joinRoom() (index.ts,
            // via BCConnection.connect()/joinRoom()) already creates the
            // room in the correct default state (Hidden, unlocked, static
            // base name) — nothing to reset here at construction time,
            // since the room doesn't exist yet until that connects.
            setInterval(() => this.pollForHandoff(), 5_000);
        }
    }

    private createIdleState(): GameState {
        return {
            phase: "idle",
            config: null,
            players: null,
            pot: 0,
            currentRound: 1,
            rollNumber: 1,
            awaitingDecision: null,
            awaitingPostBank: null,
            spendMenuOpen: false,
            clothingDeal: null,
            serviceDeal: null,
            bondageDeal: null,
            activeBondage: [],
            removableBondage: [],
            activeLocks: [],
            lockDeal: null,
            toyDeal: null,
            activeToy: null,
            negotiation: null,
            endGameProposal: null,
            activeEndGame: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            awaitingBondageBuyback: null,
            waitingForWardrobe: null,
            mercyRequest: null,
            mercyCooldowns: new Map(),
            disconnectTimer: null,
            endGameBlockedFor: null,
            endGameBlockRollDone: false,
            paused: false,
        };
    }

    // The round number, 1-indexed, used as the points multiplier for that round.
    private get currentRound(): number {
        return this.state.currentRound;
    }

    private playerName(memberNumber: number): string {
        return this.state.players?.find(p => p.memberNumber === memberNumber)?.name ?? `Player #${memberNumber}`;
    }

    private isMatchParticipant(memberNumber: number): boolean {
        return !!(this.state.players?.some(p => p.memberNumber === memberNumber));
    }

    private handlePause(sender: number): void {
        if (!this.state.players?.some(p => p.memberNumber === sender)) return;
        if (this.state.paused) {
            this.bot.whisper(sender, "Already paused — type !resume when you're ready.");
            return;
        }
        this.state.paused = true;
        const name = this.playerName(sender);
        this.bot.whisper(this.state.players!.find(p => p.memberNumber !== sender)!.memberNumber,
            `⏸️ ${name} paused the bot — type !resume when you're done.`);
        this.bot.whisper(sender, "⏸️ Paused — I'll stay out of your way. Type !resume when you're ready to continue.");
    }

    private handleResume(sender: number): void {
        if (!this.state.players?.some(p => p.memberNumber === sender)) return;
        if (!this.state.paused) {
            this.bot.whisper(sender, "Not paused.");
            return;
        }
        this.state.paused = false;
        const name = this.playerName(sender);
        this.bot.whisper(this.state.players!.find(p => p.memberNumber !== sender)!.memberNumber,
            `▶️ ${name} resumed the bot.`);
        this.bot.whisper(sender, "▶️ Resumed — pick up where you left off.");
    }

    public handleChatMessage(sender: number, content: string, isWhisper: boolean): void {
        let msg = content.trim();
        if (!msg) return;

        // Strip one layer of enclosing parens so BC's out-of-character
        // convention — e.g. "(help)" or "(H)" — is parsed the same as the
        // bare word. This only affects what the bot reads internally; the
        // player's own message still displays with the parens intact to
        // everyone else in the room, so their OOC bracket stays visible.
        const parenMatch = msg.match(/^\(([\s\S]*)\)$/);
        if (parenMatch) {
            msg = parenMatch[1].trim();
        }
        if (!msg) return;

        // "quit" / "(quit)" / "!quit" is only meaningful while a disconnect
        // countdown is running (see onMemberLeave) — it's the remaining
        // player's way to end the game early instead of waiting out the
        // countdown or using the real BC safeword. Not a globally-
        // recognized command otherwise, so this check is scoped to
        // state.disconnectTimer being active and only listens to whoever
        // isn't the disconnected player.
        if (this.state.disconnectTimer && sender !== this.state.disconnectTimer.memberNumber) {
            const normalizedQuit = msg.replace(/^!/, "").trim();
            if (/^\(?quit\)?$/i.test(normalizedQuit)) {
                this.endGameDueToDisconnect(this.state.disconnectTimer.memberNumber);
                return;
            }
        }

        if (!msg.startsWith("!")) {
            // While paused, ignore all conversational input from match participants
            // so players can RP freely. !pause / !resume are bang-commands so they
            // bypass this check. Non-participants are never routed here.
            if (this.state.paused && this.isMatchParticipant(sender)) return;
            this.handleConversational(sender, msg);
            return;
        }

        const [cmdRaw, ...rest] = msg.split(/\s+/);
        const cmd = cmdRaw.toLowerCase();
        const args = rest.join(" ");

        const helpArg = args.trim().toLowerCase();

        // While paused, only !pause and !resume are processed. Everything else
        // (including game commands like !bank and !press) is silently ignored so
        // players can RP without the bot interrupting.
        if (this.state.paused && cmd !== "!pause" && cmd !== "!resume") return;

        switch (cmd) {
            case "!help":
                if (helpArg === "setup") {
                    this.handleHelpSetup(sender);
                } else if (helpArg === "game") {
                    this.handleHelpGame(sender);
                } else if (helpArg === "shop") {
                    this.handleHelpShop(sender);
                } else if (helpArg === "admin") {
                    this.handleHelpAdmin(sender);
                } else {
                    this.handleContextHelp(sender);
                }
                break;
            case "!readme":
                this.handleReadme(sender);
                break;
            case "!changelog":
                this.handleChangelog(sender);
                break;
            case "!leaderboard":
            case "!lb":
                this.handleLeaderboard(sender);
                break;
            case "!friend":
                this.handleFriendRequest(sender, this.roomMembers.get(sender)?.name ?? `Player #${sender}`);
                break;
            case "!wd":
                this.handleWdCommand(sender, args);
                break;
            case "!looking":
                this.handleLooking(sender);
                break;
            case "!unfriend":
                this.handleUnfriend(sender);
                break;
            case "!challenge":
                this.handleChallenge(sender, args);
                break;
            case "!propose":
                this.handlePropose(sender, args);
                break;
            case "!accept":
                this.handleAccept(sender);
                break;
            case "!counter":
                this.handleCounter(sender, args);
                break;
            case "!decline":
                this.handleDecline(sender);
                break;
            case "!yes":
                if (this.isAwaitingChallengeAcceptance()) {
                    this.handleChallengeAcceptAnswer(sender, true);
                } else if (this.isAwaitingCarryoverChoice()) {
                    this.handleCarryoverChoiceAnswer(sender, true);
                } else if (this.isAwaitingPairSettingsShortcut()) {
                    this.handlePairSettingsShortcutAnswer(sender, true);
                } else if (this.isAwaitingConsentAll()) {
                    this.handleConsentAllAnswer(sender, true);
                } else if (this.isAwaitingLobbyFallback()) {
                    this.handleLobbyFallbackAnswer(sender, true);
                } else if (this.isAwaitingHighSecConsent()) {
                    this.handleHighSecConsent(sender, true);
                } else {
                    this.handleYesNoAnswer(sender, true);
                }
                break;
            case "!no":
                if (this.isAwaitingChallengeAcceptance()) {
                    this.handleChallengeAcceptAnswer(sender, false);
                } else if (this.isAwaitingCarryoverChoice()) {
                    this.handleCarryoverChoiceAnswer(sender, false);
                } else if (this.isAwaitingPairSettingsShortcut()) {
                    this.handlePairSettingsShortcutAnswer(sender, false);
                } else if (this.isAwaitingConsentAll()) {
                    this.handleConsentAllAnswer(sender, false);
                } else if (this.isAwaitingLobbyFallback()) {
                    this.handleLobbyFallbackAnswer(sender, false);
                } else if (this.isAwaitingHighSecConsent()) {
                    this.handleHighSecConsent(sender, false);
                } else {
                    this.handleYesNoAnswer(sender, false);
                }
                break;
            case "!cancel":
                this.handleCancel(sender);
                break;
            case "!lockready":
                this.handleLockBlockChoice(sender, "unblock");
                break;
            case "!bondage":
                this.handleBondageShortcut(sender);
                break;
            case "!removebondage":
                this.handleRemoveBondage(sender, args);
                break;
            case "!buybondage":
                this.handleBuyBondage(sender, args);
                break;
            case "!reapplybondage":
                this.handleReapplyBondage(sender, args);
                break;
            case "!bank":
                this.handleBank(sender);
                break;
            case "!press":
                this.handlePress(sender);
                break;
            case "!endgame":
                this.handleEndgame(sender);
                break;
            case "!mercy":
                this.handleMercyCommand(sender);
                break;
            case "!reset":
                this.handleReset(sender);
                break;
            case "!setstreak":
                this.handleSetStreak(sender, args);
                break;
            case "!feedback":
                this.handleFeedback(sender, args, isWhisper);
                break;
            case "!setstatus":
                this.handleSetStatus(sender, args, isWhisper);
                break;
            case "!testlock":
                this.handleTestLock(sender, args);
                break;
            case "!teststrip":
                this.handleTestStrip(sender, args);
                break;
            case "!testredress":
                this.handleTestRedress(sender, args);
                break;
            case "!testonline":
                this.handleTestOnline(sender, args);
                break;
            case "!testbeep":
                this.handleTestBeep(sender, args);
                break;
            case "!stuck":
                this.handleStuck(sender, args);
                break;
            case "!redress":
                this.handleRedress(sender, args);
                break;
            case "!removed":
                this.handleRemovedConfirmation(sender);
                break;
            case "!done":
                this.handleDone(sender);
                break;
            case "!time":
                this.handleTime(sender);
                break;
            case "!pause":
                this.handlePause(sender);
                break;
            case "!resume":
                this.handleResume(sender);
                break;
        }
    }

    // Handles plain-language equivalents of negotiation commands (no leading "!"),
    // so players can respond conversationally during setup and self-rolls.
    private handleConversational(sender: number, msg: string): void {
        const negotiation = this.state.negotiation;
        const lower = msg.toLowerCase();

        // Bare "help"/"H" (including the now-unwrapped "(help)"/"(H)" OOC
        // forms — see handleChatMessage's paren-stripping) is recognized
        // everywhere, ahead of every other conversational check, so it's
        // never swallowed as invalid input by whatever's currently active.
        if (lower === "help" || lower === "h") {
            this.handleContextHelp(sender);
            return;
        }

        // Room bot, post-session: the winner confirming they're done so the
        // room can reset (see beginRoomResetConfirm). Checked as a class field
        // since the match state is already idle by now.
        if (this.pendingRoomReset && sender === this.pendingRoomReset.winnerMemberNumber
            && (lower === "ready" || lower === "done")) {
            this.finalizeRoomReset();
            return;
        }

        // Pre-roll: both players confirming the settings before the first roll
        // (see beginMatchStartConfirm). Checked before the normal playing-phase
        // handlers so a "ready"/"start" isn't swallowed as anything else.
        if (this.pendingMatchStart) {
            if (lower === "ready" || lower === "start" || lower === "yes" || lower === "y") {
                this.handleMatchStartConfirm(sender);
                return;
            }
            if (lower === "cancel") {
                this.cancelMatchStart();
                return;
            }
        }

        // A !challenge matched more than one room member by name — the
        // challenger's next reply picks which one, before any negotiation exists.
        if (this.pendingChallengeDisambiguation?.challengerNumber === sender) {
            this.handleChallengeDisambiguationAnswer(sender, msg);
            return;
        }

        // A numbered reply to a pending !stuck / !redress pick. Checked ahead of
        // the playing-phase menus so the number resolves the wardrobe choice the
        // player just opened rather than being read as a menu selection.
        if (this.pendingWardrobeAction?.memberNumber === sender && this.resolveWardrobeSelection(sender, msg)) {
            return;
        }

        // Admin numbered reply to a pending !testredress list.
        if (this.pendingTestRedress?.adminNumber === sender && this.resolveTestRedressSelection(sender, msg)) {
            return;
        }

        // The challenged player hasn't said whether they accept the challenge
        // yet — nothing else (negotiation, proposals, etc.) proceeds until
        // they answer yes/no, and only their answer counts.
        if (negotiation && this.state.phase === "negotiating" && negotiation.acceptanceStage === "awaiting") {
            if (sender === negotiation.opponent.memberNumber) {
                if (lower === "yes" || lower === "y") {
                    this.handleChallengeAcceptAnswer(sender, true);
                } else if (lower === "no" || lower === "n") {
                    this.handleChallengeAcceptAnswer(sender, false);
                }
            }
            return;
        }

        // An in-progress end game proposal/negotiation pauses everything else —
        // route both players' messages through it first.
        if (this.state.endGameProposal && this.handleEndGameMessage(sender, msg, lower)) {
            return;
        }

        // An in-progress !mercy request pauses everything else — route both
        // players' messages through it first, same as the end game proposal.
        if (this.state.mercyRequest && this.handleMercyMessage(sender, msg, lower)) {
            return;
        }

        // "mercy" spoken conversationally is equivalent to !mercy.
        if (lower === "mercy" && this.state.phase === "playing" && !this.state.mercyRequest) {
            this.handleMercyCommand(sender);
            return;
        }

        // An in-progress clothing deal can involve messages from either the
        // buyer or the opponent, regardless of who's awaitingPostBank.
        if (this.state.clothingDeal && this.handleClothingDealMessage(sender, msg, lower)) {
            return;
        }

        // Same for an in-progress bondage deal (apply or paid removal).
        if (this.state.bondageDeal && this.handleBondageDealMessage(sender, msg, lower)) {
            return;
        }

        // Same for an in-progress lock deal (placer proposes, wearer responds).
        if (this.state.lockDeal && this.handleLockDealMessage(sender, msg, lower)) {
            return;
        }

        // Same for an in-progress toy rental (winner picks & proposes, loser responds).
        if (this.state.toyDeal && this.handleToyDealMessage(sender, msg, lower)) {
            return;
        }

        // Same for an in-progress service deal (buyer describes & proposes, seller responds).
        if (this.state.serviceDeal && this.handleServiceDealMessage(sender, msg, lower)) {
            return;
        }

        // Plain-language equivalents of !bank / !press for whoever just won
        // a roll and is deciding what to do next.
        if (this.state.phase === "playing" && this.state.awaitingDecision === sender) {
            if (lower === "bank") {
                this.handleBank(sender);
                return;
            }
            if (lower === "press" || lower === "roll" || lower === "roll again" || lower === "keep rolling") {
                this.handlePress(sender);
                return;
            }
            if (lower === "endgame" || lower === "end game" || lower === "end") {
                this.handleEndgame(sender);
                return;
            }
        }

        if (this.state.phase === "playing" && this.state.awaitingPostBank === sender) {
            this.handlePostBankAnswer(sender, lower, msg);
            return;
        }

        // A player previously typed "counter"/"!counter" with no value — this
        // message is their counter-proposal value.
        if (negotiation && negotiation.awaitingCounterFrom === sender) {
            negotiation.awaitingCounterFrom = null;
            this.handleCounter(sender, msg);
            return;
        }

        // Final negotiation question — both players answer independently
        // (see handleRoomTypeAnswer). Sender must be one of the two match
        // participants — without this check, BC echoes the bot's own
        // whispers back as incoming messages from the bot's own member
        // number, which would fail to parse and re-trigger this same
        // reprompt whisper, looping forever until BC's flood protection
        // kicks the connection (found live 2026-07-16).
        if (negotiation && this.state.phase === "negotiating" && negotiation.roomTypeStage === "awaiting"
            && (sender === negotiation.challenger.memberNumber || sender === negotiation.opponent.memberNumber)) {
            const parsed = parseRoomTypeAnswer(lower);
            if (parsed === null) {
                this.bot.whisper(sender, `I didn't catch that — reply 1 (Spectator), 2 (Private), or 3 (Locked).`);
                return;
            }
            this.handleRoomTypeAnswer(sender, parsed);
            return;
        }

        // The challenger is being asked for a numeric setting (e.g. minimum
        // rounds) and hasn't proposed a value yet — treat any extractable
        // number in their reply as that proposal. Guarded against every
        // pre-negotiation sub-stage still being "awaiting" — without this,
        // any non-numeric reply from the challenger (e.g. "no" to the
        // carryover question) got wrongly swallowed here as an invalid
        // minRounds answer instead of ever reaching the real handler below
        // (found live 2026-07-17 — only broke for the challenger, since this
        // block is challenger-only; the opponent's replies were never at risk).
        const preNegotiationStageActive = negotiation !== null && (
            negotiation.carryoverStage === "awaiting" ||
            negotiation.pairSettingsStage === "awaiting" ||
            negotiation.settingsCompareStage === "awaiting" ||
            negotiation.consentAllStage === "awaiting" ||
            negotiation.lockBlockStage === "awaiting_choice" ||
            negotiation.lockBlockStage === "awaiting_highsec_consent"
        );
        if (negotiation && this.state.phase === "negotiating" && !negotiation.pending && !preNegotiationStageActive) {
            const key = nextNegotiationKey(negotiation.config);
            if (key !== null && !isYesNoKey(key) && sender === negotiation.challenger.memberNumber) {
                const num = extractNumber(msg);
                if (num === null) {
                    this.bot.whisper(sender, numericReprompt(key));
                    return;
                }

                const parsed = parseProposalValue(key, String(num));
                if (typeof parsed === "string") {
                    this.bot.whisper(sender, parsed);
                    return;
                }

                negotiation.pending = { key, value: parsed.value, proposedBy: sender };
                this.bot.sendChat(
                    `${negotiation.challenger.name} proposes: ${settingLabel(key)} = ${formatValue(key, parsed.value)}. ` +
                    `${negotiation.opponent.name}, you can "accept" or "counter <value>".`
                );
                return;
            }
        }

        if (lower === "accept") {
            if (negotiation && this.state.phase === "negotiating" && negotiation.pending) {
                this.handleAccept(sender);
            }
            return;
        }

        if (lower === "accept" && negotiation && this.state.phase === "negotiating" && negotiation.settingsCompareStage === "awaiting"
            && (sender === negotiation.challenger.memberNumber || sender === negotiation.opponent.memberNumber)) {
            this.handleSettingsCompareAnswer(sender, "accept");
            return;
        }

        if (lower === "saved" && negotiation && this.state.phase === "negotiating" && negotiation.settingsCompareStage === "awaiting"
            && (sender === negotiation.challenger.memberNumber || sender === negotiation.opponent.memberNumber)) {
            this.handleSettingsCompareAnswer(sender, "saved");
            return;
        }

        if (lower === "yes" || lower === "y") {
            if (negotiation && this.state.phase === "negotiating") {
                if (negotiation.pending) {
                    this.handleAccept(sender);
                    return;
                }
                if (negotiation.carryoverStage === "awaiting") {
                    this.handleCarryoverChoiceAnswer(sender, true);
                    return;
                }
                if (negotiation.pairSettingsStage === "awaiting") {
                    this.handlePairSettingsShortcutAnswer(sender, true);
                    return;
                }
                if (negotiation.consentAllStage === "awaiting") {
                    this.handleConsentAllAnswer(sender, true);
                    return;
                }
                if (negotiation.lobbyFallbackStage === "awaiting") {
                    this.handleLobbyFallbackAnswer(sender, true);
                    return;
                }
                if (negotiation.lockBlockStage === "awaiting_highsec_consent") {
                    this.handleHighSecConsent(sender, true);
                    return;
                }
                const key = nextNegotiationKey(negotiation.config);
                if (key !== null && isYesNoKey(key)) {
                    this.handleYesNoAnswer(sender, true);
                }
            }
            return;
        }

        if (lower === "no" || lower === "n") {
            if (negotiation && this.state.phase === "negotiating" && !negotiation.pending) {
                if (negotiation.carryoverStage === "awaiting") {
                    this.handleCarryoverChoiceAnswer(sender, false);
                    return;
                }
                if (negotiation.pairSettingsStage === "awaiting") {
                    this.handlePairSettingsShortcutAnswer(sender, false);
                    return;
                }
                if (negotiation.consentAllStage === "awaiting") {
                    this.handleConsentAllAnswer(sender, false);
                    return;
                }
                if (negotiation.lobbyFallbackStage === "awaiting") {
                    this.handleLobbyFallbackAnswer(sender, false);
                    return;
                }
                if (negotiation.lockBlockStage === "awaiting_highsec_consent") {
                    this.handleHighSecConsent(sender, false);
                    return;
                }
                const key = nextNegotiationKey(negotiation.config);
                if (key !== null && isYesNoKey(key)) {
                    this.handleYesNoAnswer(sender, false);
                }
            }
            return;
        }

        // Blocked-padlock resolution words (see beginLockBlockCheck): a blocked
        // player replies "unblock" (they've re-enabled it) or "highsec" (request
        // the alternative lock).
        if (negotiation && this.state.phase === "negotiating" && negotiation.lockBlockStage === "awaiting_choice"
            && negotiation.lockBlockPending.includes(sender)) {
            if (lower === "unblock" || lower === "unblocked" || lower === "ready" || lower === "done") {
                this.handleLockBlockChoice(sender, "unblock");
                return;
            }
            if (lower === "highsec" || lower === "high sec" || lower === "high-sec" || lower === "high security" || lower === "high-security") {
                this.handleLockBlockChoice(sender, "highsec");
                return;
            }
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            this.handleCounter(sender, (counterMatch[1] ?? "").trim());
            return;
        }
    }

    private handleHelp(sender: number): void {
        let text =
            `=== WinnersDice Commands ===\n` +
            `!readme - Read about this game\n` +
            `!challenge - Challenge a player to a match\n` +
            `!help setup - Challenge and match setup\n` +
            `!help game - During the match\n` +
            `!help shop - The shop and spending\n`;

        if (this.isAdmin(sender)) {
            text += `!help admin - Admin commands\n`;
        }

        text +=
            `!feedback <text> - Send feedback (whisper only)\n` +
            `!friend - Add me to your friend list so you can see when I'm online (!unfriend to undo)\n` +
            `!changelog - See what's changed recently\n` +
            `Tip: all commands work in chat or as a whisper to me.`;

        this.sendLongWhisper(sender, text);
    }

    // Reciprocate a friending so the player can see the bot on their friend
    // list. BC has no friend-request event: picking "Add friend with
    // notification" makes their client send a Hidden ChatRoomFriendRequestAdd
    // chat message, which index.ts routes here. The silent option sends
    // nothing at all, so !friend exists as the manual path to the same place.
    // The lobby room is publicly listed, so a friend sees the bot online plus
    // the room name and player count and can jump straight in.
    public handleFriendRequest(memberNumber: number, name: string): void {
        if (this.bot.isFriend(memberNumber)) {
            this.bot.whisper(memberNumber,
                `You're already on my friend list! If you can't see me, add me from your own ` +
                `friend list too — BC only shows us to each other when we've both added.`
            );
            return;
        }

        this.bot.addFriend(memberNumber);
        log(`Friend request from ${name} (#${memberNumber}) — added back.`);
        this.bot.whisper(memberNumber,
            `Added you back! 🎲 I'll now show up on your friend list whenever I'm online, ` +
            `so you can tell at a glance when the table is open. This room stays unlisted, ` +
            `so you'll see that I'm on rather than the room name itself. If you haven't ` +
            `added me on your side yet, do that and I'll appear. Whisper !unfriend to undo.`
        );
    }

    private handleUnfriend(memberNumber: number): void {
        if (!this.bot.removeFriend(memberNumber)) {
            this.bot.whisper(memberNumber, "You weren't on my friend list to begin with.");
            return;
        }
        this.bot.whisper(memberNumber,
            `Removed you from my friend list — I won't show up there any more. ` +
            `Whisper !friend if you ever want me back.`
        );
    }

    private handleReadme(memberNumber: number): void {
        const text =
            `=== WinnersDice ===\n` +
            `WinnersDice is a high-stakes, two-player dice duel with adult consequences. Challenge someone, negotiate what's on the line — rounds, stripping, bondage, toys, maybe a little service — then roll. The winner of each roll builds a pot, takes control, and decides what happens next. Roll on, bank it, or spend those coins making your opponent's evening... interesting.\n\n` +
            `Roll well and your streak grows. Roll a natural 20 and you're on fire. Roll a 1 and you'll feel it. Press your luck or play it safe — but once the rounds are done, someone's walking away in more restraints than they arrived in.\n\n` +
            `Shop smart. Roll lucky. And maybe... negotiate a little mercy.\n\n` +
            `Say !help for commands.`;

        this.sendLongWhisper(memberNumber, text);
    }

    private handleHelpSetup(sender: number): void {
        const text =
            `=== Match Setup ===\n` +
            `!challenge [name] - Start a challenge (no name = shows who's in the room)\n` +
            `yes / no - Answer yes/no questions\n` +
            `[number] - Enter a value when prompted\n` +
            `accept - Accept the current proposal\n` +
            `counter <value> - Counter with a different value (or just "counter" to be prompted)\n` +
            `decline - End the negotiation\n` +
            `cancel - Abort entirely`;

        this.sendLongWhisper(sender, text);
    }

    private handleHelpGame(sender: number): void {
        const text =
            `=== During the Match ===\n` +
            `Winner of each roll chooses what's next — loser waits.\n` +
            `!bank - Lock in your pot (spend / continue / endgame)\n` +
            `!press - Roll again, risking your current pot\n` +
            `!endgame - End the match early (after minimum rounds)\n` +
            `!mercy - Concede early: forfeit half your points and owe a service\n` +
            `!pause / !resume - Pause or resume the bot (either player — useful for RP)\n` +
            `!stuck [item] - Bound and can't reach your clothes? I'll take a garment off for you\n` +
            `!redress [item] - Put a garment I took off back on\n\n` +
            `=== Streaks, Boosts & Curses ===\n` +
            `Each win: dice + streak + boost → pot × round multiplier\n` +
            `Natural 20 always wins the roll outright (+2 streak). Natural 1 always loses it outright, plus -1 to your rolls until you win.\n` +
            `Streak resets on a loss or when banker picks "continue". Boost persists across rounds, drains -1 per loss.`;

        this.sendLongWhisper(sender, text);
    }

    private handleHelpShop(sender: number): void {
        const text =
            `=== Post-Bank Menu ===\n` +
            `Reply with the number shown:\n` +
            `1. continue - Next round (multiplier up, streaks reset)\n` +
            `2. spend - Open the shop\n` +
            `3. endgame - End the match (after minimum rounds)\n` +
            `4. remove locks - Shown if you have Exclusive locks; pays to remove them instantly\n\n` +
            `=== Shop ===\n` +
            `boost - Buy a streak boost (+1–5, max +${MAX_BOOST})\n` +
            `clothing - Buy a clothing item from your opponent\n` +
            `bondage - Apply bondage to your opponent (you pay full price; they receive half — bot takes the rest)\n` +
            `locks - Lock your opponent's bondage; they can buy out anytime from their post-bank menu\n` +
            `buy back bondage - Pay to have your own bondage removed (opponent sets the price)\n` +
            `buyback - Buy back something you sold, at double the price\n` +
            `toys - Purchase a timed toy session\n` +
            `actions & services - Request a service from your opponent\n` +
            `back - Return to the post-bank menu\n` +
            `cancel - Back out\n\n` +
            `=== Bondage Removal ===\n` +
            `!removebondage <slot> - (placer) Remove bondage you applied, free\n` +
            `!buybondage <slot> - (wearer) Request a buyout directly — same as "buy back bondage" in the shop, just skips the slot menu`;

        this.sendLongWhisper(sender, text);
    }

    private handleHelpAdmin(sender: number): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const text =
            `=== Admin Commands ===\n` +
            `!reset - End the current match and reset\n` +
            `!setstreak <n> - Set streak bonus cap (default ${DEFAULT_MAX_STREAK})\n` +
            `!setstatus <memberNumber> <status> - Update a player's feedback status\n` +
            `!feedback list - View all feedback\n` +
            `!testlock [@name] - Instantly apply a test timer/password lock (self by default) - no match needed\n` +
            `!teststrip [@name] [group] - Report clothing act/advise verdict + worn items; if a group is named, try to remove it (wardrobe-helper live test)\n` +
            `!testredress @name [number|group] - List what you took off that player, numbered; reply a number (or pass one, e.g. "bra") to put it back on\n` +
            `!testonline [@name|memberNumber] - Friend the target, then ask BC who's online and report if they show up (matchmaking presence probe)\n` +
            `!testbeep <@name|memberNumber> [message] - Send a beep (with text) to the target; have them reply to test the incoming-beep path\n` +
            `!wd pool - List everyone in the matchmaking pool (online/offline, paused, strikes)\n` +
            `!wd clearstrikes <@name|#> - Reset a player's early-leave strikes\n` +
            `!wd unblock <@name|#> - Un-block a player and reset their strikes`;

        this.sendLongWhisper(sender, text);
    }

    // ============================================================
    // CONTEXTUAL HELP
    // ============================================================
    //
    // Dispatches bare "help"/"H" (see handleConversational — also covers
    // the OOC "(help)"/"(H)" forms, unwrapped by handleChatMessage's
    // paren-stripping) and bare "!help" with no topic argument (see
    // handleChatMessage's switch) to a short, phase-appropriate hint
    // instead of the generic top-level command index. Falls back to that
    // generic index (handleHelp) for idle/pre-game/negotiation phases,
    // where "!help setup" already covers things. The explicit "!help
    // setup/game/shop/admin" topic commands are untouched by any of this —
    // they always show their full page regardless of phase.
    // ============================================================

    private isStandardCounterStage(stage: string): boolean {
        return stage === "awaiting_opponent_response" || stage === "awaiting_opponent_counter_value"
            || stage === "awaiting_buyer_counter_response" || stage === "awaiting_buyer_counter_value";
    }

    private isServiceCounterStage(stage: string): boolean {
        return stage === "awaiting_seller_response" || stage === "awaiting_seller_counter_value"
            || stage === "awaiting_buyer_counter_response" || stage === "awaiting_buyer_counter_value";
    }

    // Post-Bank ("What next?") and Shop context help — scoped to usage
    // mechanics not already stated by the menu's own option lines
    // (postBankPromptText/openSpendMenu), rather than restating them.
    private postBankHintText(): string {
        return `💰 Your banked points are safe no matter what you pick here — nothing costs anything by itself. ` +
            `You can go into the shop (2) and back out as many times as you like before choosing continue or endgame — spending doesn't use up your turn.`;
    }

    private shopHintText(): string {
        return `🛍️ Reply with just the number shown — words like "boost" won't work, only the digit. ` +
            `Everything here except boost negotiates a price with your opponent first — nothing's charged until they accept; boost is the one fixed-price, self-serve option. ` +
            `0 (Back) doesn't cancel anything — it just returns you to continue/spend/endgame, and you can come back into the shop as many times as you want.`;
    }

    private dealCounterHintText(canCancel: boolean): string {
        return canCancel
            ? `💬 accept to close the deal, counter <number> to push back, or cancel to walk away.`
            : `💬 accept to close the deal, or counter <number> to push back — no backing out of this one once it's rolling!`;
    }

    private endGameQuestionHintText(proposal: EndGameProposal): string {
        switch (proposal.proposalStage) {
            case "q1_time": return `⏱️ Type a number — how many minutes you're claiming. Costs that many points.`;
            case "q2_location": return `🚪 1 to stay in this room, 2 to move somewhere else.`;
            case "q3_privacy": return `👀 1 for public, 2 for private.`;
            case "q4_locks":
                return this.endGameAwaitingLockSlotsInput
                    ? `🔒 List the slots separated by commas, or say all.`
                    : `🔒 yes if you want to lock down any of their slots, no if not.`;
            case "q5_description": return `✍️ Just type freely — describe what you've got planned, then send it when you're happy.`;
            default: return "";
        }
    }

    // Re-generates the current question's prompt so the help hint can be
    // followed by a repeat of what's actually being asked, mirroring the
    // shop menu's "hint, then re-show the menu" pattern (see
    // handleContextHelp). Kept as its own function rather than refactored
    // to share strings with the Q1-Q5 handlers (startEndGameProposal/
    // advanceToEndGameQ4/etc.), since those fire on state transitions with
    // extra one-time context (e.g. Q1's "noted" confirmation) that a bare
    // re-ask shouldn't repeat.
    private endGameQuestionPromptText(proposal: EndGameProposal): string {
        switch (proposal.proposalStage) {
            case "q1_time":
                return `Q1 of 5 — How many minutes do you want to claim? Each point = 1 minute and will be spent from your balance ` +
                    `(you have ${this.state.spendingBalance} pts available). Type a number.`;
            case "q2_location":
                return `Q2 of 5 — Where do you want to take this?\n1. Stay in this room\n2. Move to a different room (recommended for longer sessions)`;
            case "q3_privacy":
                return `Q3 of 5 — How do you want to set the room?\n1. Public — open for others to watch or join\n2. Private — just the two of you`;
            case "q4_locks":
                return this.endGameAwaitingLockSlotsInput
                    ? `Which slots? Valid: ${END_GAME_LOCK_SLOTS.join(", ")}\nReply with a comma-separated list, or "all" for all of them.`
                    : `Q4 of 5 — Do you want to place locks on ${this.playerName(proposal.loserMemberNumber)}? (yes / no)`;
            case "q5_description":
                return `Q5 of 5 — Describe what you have in mind for ${this.playerName(proposal.loserMemberNumber)}. They will see this. (Type freely — when done, send it)`;
            default:
                return "";
        }
    }

    private handleContextHelp(sender: number): void {
        const state = this.state;

        // Active service deal — help only applies to the two players involved.
        if (state.serviceDeal && state.serviceDeal.stage === "active" &&
            (sender === state.serviceDeal.buyer || sender === state.serviceDeal.seller)) {
            this.bot.whisper(sender,
                `Service in progress 🎭 Available commands: \`!done\` (winner only — declare complete), ` +
                `\`!time\` (check time remaining), safeword (emergency stop).`
            );
            return;
        }

        // Active end game — help only applies to the two players involved.
        if (state.activeEndGame &&
            (sender === state.activeEndGame.winnerMemberNumber || sender === state.activeEndGame.loserMemberNumber)) {
            this.bot.whisper(sender,
                `End game in progress 🔒 Available commands: \`!done\` (winner, in-room only — end early), ` +
                `\`!time\` (check time remaining), safeword (emergency stop).`
            );
            return;
        }

        if (state.bondageDeal && this.isStandardCounterStage(state.bondageDeal.stage) &&
            (sender === state.bondageDeal.placer || sender === state.bondageDeal.wearer)) {
            this.bot.whisper(sender, this.dealCounterHintText(true));
            return;
        }
        if (state.lockDeal && this.isStandardCounterStage(state.lockDeal.stage) &&
            (sender === state.lockDeal.placer || sender === state.lockDeal.wearer)) {
            this.bot.whisper(sender, this.dealCounterHintText(true));
            return;
        }
        if (state.serviceDeal && this.isServiceCounterStage(state.serviceDeal.stage) &&
            (sender === state.serviceDeal.buyer || sender === state.serviceDeal.seller)) {
            this.bot.whisper(sender, this.dealCounterHintText(true));
            return;
        }
        if (state.toyDeal && this.isStandardCounterStage(state.toyDeal.stage) &&
            (sender === state.toyDeal.winner || sender === state.toyDeal.loser)) {
            this.bot.whisper(sender, this.dealCounterHintText(sender === state.toyDeal.winner));
            return;
        }

        if (state.endGameProposal) {
            const proposal = state.endGameProposal;
            if (this.isEndGameProposalQuestionStage(proposal.proposalStage) && sender === proposal.winnerMemberNumber) {
                this.bot.whisper(sender, this.endGameQuestionHintText(proposal));
                this.bot.whisper(sender, this.endGameQuestionPromptText(proposal));
                return;
            }
            if (proposal.proposalStage === "negotiating" && sender === proposal.winnerMemberNumber) {
                this.bot.whisper(sender,
                    `⚔️ yes to accept, "counter <amount>" to spend points raising it back (capped at 90% of your original ask), or "decline" to block the whole deal. ` +
                    `(Step 4 is the final say — no more back-and-forth after that.)`
                );
                return;
            }
            if (proposal.proposalStage === "negotiating" && sender === proposal.loserMemberNumber) {
                this.bot.whisper(sender,
                    `⚔️ yes to accept, or "counter <amount>" to cut it further — no flat decline on this one, only accept or cut more. ` +
                    `(Step 4 is the final say — no more back-and-forth after that.)`
                );
                return;
            }
        }

        if (state.phase === "playing" && state.awaitingPostBank === sender) {
            if (state.spendMenuOpen) {
                this.bot.whisper(sender, this.shopHintText());
                this.openSpendMenu(sender);
            } else {
                this.bot.whisper(sender, this.postBankHintText());
                this.bot.whisper(sender, this.postBankPromptText(sender));
            }
            return;
        }

        if (state.phase === "playing" && state.awaitingDecision === sender && state.config) {
            this.bot.whisper(sender,
                `🎲 It's your call — !bank to lock in your pot, !press to keep rolling. Once you've hit round ${state.config.minRounds}, !endgame and !mercy open up too.`
            );
            return;
        }

        this.handleHelp(sender);
    }

    // Case-insensitive name lookup with fuzzy fallback: exact → startsWith →
    // includes. Returns exact matches if any; otherwise falls through to the
    // next tier, so "sara" finds "Sahra" and "!challenge 3" from the list
    // still resolves correctly.
    private findPlayersByName(name: string, excludeMemberNumber: number): Player[] {
        const lower = name.toLowerCase();
        const botNumber = this.bot.getMemberNumber();
        const candidates = [...this.roomMembers.values()].filter(p => p.memberNumber !== excludeMemberNumber && p.memberNumber !== botNumber);

        const exact = candidates.filter(p => p.name.toLowerCase() === lower);
        if (exact.length > 0) return exact;

        const starts = candidates.filter(p => p.name.toLowerCase().startsWith(lower));
        if (starts.length > 0) return starts;

        return candidates.filter(p => p.name.toLowerCase().includes(lower));
    }

    private handleChallenge(sender: number, args: string): void {
        if (this.checkPendingUpdate()) return;

        if (this.state.phase !== "idle") {
            if (botRole === "main") {
                const reason = this.state.phase === "negotiating"
                    ? "Another match is currently being set up here"
                    : "A match is currently being played here in the lobby";
                this.bot.whisper(sender, `${reason} — try again in a few minutes.`);
            }
            return;
        }

        // Multi-room mode: room bots never negotiate (see design_multi_room.md)
        // — they only run matches handed to them via the handoff queue.
        if (botRole !== "main") {
            this.bot.whisper(sender,
                `This is a private game room — challenges start in the main WinnersDice room ("${mainRoomName}"). ` +
                `Head there and type !challenge @PlayerName to set up a match.`
            );
            return;
        }

        const targetName = args.replace(/^@/, "").trim();
        const challenger = this.roomMembers.get(sender);
        if (!challenger) return;

        // No name given — whisper a numbered list of who's in the room.
        if (!targetName) {
            const botNumber = this.bot.getMemberNumber();
            const others = [...this.roomMembers.values()].filter(p => p.memberNumber !== sender && p.memberNumber !== botNumber);
            if (others.length === 0) {
                this.bot.whisper(sender, "There's no one else in the room to challenge right now.");
                return;
            }
            this.pendingChallengeDisambiguation = { challengerNumber: sender, candidates: others };
            this.bot.whisper(sender,
                `Who would you like to challenge?\n` +
                others.map((p, i) => `${i + 1}. ${p.name}`).join("\n") +
                `\nReply with a number or type their name.`
            );
            return;
        }

        if (this.pendingChallengeDisambiguation?.challengerNumber === sender) {
            this.pendingChallengeDisambiguation = null;
        }

        const matches = this.findPlayersByName(targetName, sender);
        if (matches.length === 0) {
            this.bot.whisper(sender, `Couldn't find "${targetName}" in the room.`);
            return;
        }

        if (matches.length > 1) {
            this.pendingChallengeDisambiguation = { challengerNumber: sender, candidates: matches };
            this.bot.whisper(sender,
                `Multiple players match that name:\n` +
                matches.map((p, i) => `${i + 1}. ${p.name} (member #${p.memberNumber})`).join("\n") +
                `\nReply with the number to choose.`
            );
            return;
        }

        this.beginNegotiation(challenger, matches[0]);
    }

    // Resolves the challenger's numbered reply to a prior name-collision
    // whisper. Only called while pendingChallengeDisambiguation is set for
    // this sender (checked in handleConversational).
    private handleChallengeDisambiguationAnswer(sender: number, raw: string): void {
        const pending = this.pendingChallengeDisambiguation;
        if (!pending) return;

        if (this.state.phase !== "idle") {
            this.pendingChallengeDisambiguation = null;
            this.bot.whisper(sender, "That challenge is no longer available — a match is already in progress.");
            return;
        }

        const trimmed = raw.trim();
        const idx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
        const match = (idx !== null && idx >= 1 && idx <= pending.candidates.length) ? pending.candidates[idx - 1] : null;
        if (!match) {
            this.bot.whisper(sender,
                `Please reply with a number: ` +
                pending.candidates.map((p, i) => `${i + 1}. ${p.name} (member #${p.memberNumber})`).join(", ")
            );
            return;
        }

        this.pendingChallengeDisambiguation = null;
        const challenger = this.roomMembers.get(sender);
        if (!challenger) return;
        this.beginNegotiation(challenger, match);
    }

    private beginNegotiation(challenger: Player, opponent: Player): void {
        const negotiation: NegotiationState = {
            challenger,
            opponent,
            acceptanceStage: "awaiting",
            acceptanceTimer: null,
            config: {},
            pending: null,
            answers: {},
            awaitingCounterFrom: null,
            consentAllStage: "not_asked",
            consentAllAnswers: {},
            carryoverStage: "not_asked",
            carryoverAnswers: {},
            useCarryover: false,
            lobbyFallbackStage: "not_asked",
            lobbyFallbackAnswers: {},
            playInLobby: false,
            roomTypeStage: "not_asked",
            roomTypeAnswers: {},
            roomType: null,
            pairSettingsStage: "not_asked",
            pairSettingsAnswers: {},
            pairSettingsTimer: null,
            savedPairConfig: null,
            usedPairSettingsShortcut: false,
            challengerPlayerConfig: this.playerSettings[challenger.memberNumber]?.config ?? null,
            opponentPlayerConfig: this.playerSettings[opponent.memberNumber]?.config ?? null,
            settingsCompareStage: "not_asked",
            settingsCompareAnswers: {},
            settingsCompareTimer: null,
            lockBlockStage: "not_asked",
            lockBlockPending: [],
            highSecConsentAnswers: {},
            useHighSecurityLock: false,
        };

        this.state = {
            phase: "negotiating",
            config: null,
            players: null,
            pot: 0,
            currentRound: 1,
            rollNumber: 1,
            awaitingDecision: null,
            awaitingPostBank: null,
            spendMenuOpen: false,
            clothingDeal: null,
            serviceDeal: null,
            bondageDeal: null,
            activeBondage: [],
            removableBondage: [],
            activeLocks: [],
            lockDeal: null,
            toyDeal: null,
            activeToy: null,
            negotiation,
            endGameProposal: null,
            activeEndGame: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            awaitingBondageBuyback: null,
            waitingForWardrobe: null,
            mercyRequest: null,
            mercyCooldowns: new Map(),
            disconnectTimer: null,
            endGameBlockedFor: null,
            endGameBlockRollDone: false,
            paused: false,
        };

        this.bot.sendChat(`${challenger.name} has challenged ${opponent.name} to WinnersDice!`);
        this.bot.whisper(
            opponent.memberNumber,
            `⚔️ ${challenger.name} has challenged you to a game of WinnersDice! Do you accept? (yes/no)`
        );

        negotiation.acceptanceTimer = setTimeout(() => {
            this.expireChallengeAcceptance(negotiation);
        }, CHALLENGE_ACCEPTANCE_TIMEOUT_MS);
    }

    // True while the challenged player is being asked whether they accept
    // the challenge at all, before any negotiation (or the "let's negotiate"
    // announcement) has begun.
    private isAwaitingChallengeAcceptance(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.acceptanceStage === "awaiting";
    }

    private clearChallengeAcceptanceTimer(negotiation: NegotiationState): void {
        if (negotiation.acceptanceTimer) {
            clearTimeout(negotiation.acceptanceTimer);
            negotiation.acceptanceTimer = null;
        }
    }

    // Fires if the challenged player hasn't answered within
    // CHALLENGE_ACCEPTANCE_TIMEOUT_MS. Guards against acting on a stale timer
    // in case the challenge was already resolved some other way (accepted,
    // declined, cancelled, safeworded, admin-reset) right around the deadline.
    private expireChallengeAcceptance(negotiation: NegotiationState): void {
        if (this.state.negotiation !== negotiation || negotiation.acceptanceStage !== "awaiting") {
            return;
        }

        const { challenger, opponent } = negotiation;
        this.bot.whisper(challenger.memberNumber, "⏱️ No response — challenge cancelled.");
        this.bot.whisper(opponent.memberNumber, "⏱️ No response — challenge cancelled.");
        this.state = this.createIdleState();
    }

    // Only the challenged player's answer counts here — the challenger has
    // nothing to accept or decline at this stage.
    private handleChallengeAcceptAnswer(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.acceptanceStage !== "awaiting") {
            return;
        }

        if (sender !== negotiation.opponent.memberNumber) {
            return;
        }

        this.clearChallengeAcceptanceTimer(negotiation);

        const { challenger, opponent } = negotiation;

        if (!value) {
            this.bot.whisper(challenger.memberNumber, `${opponent.name} declined your WinnersDice challenge.`);
            this.bot.whisper(opponent.memberNumber, `You declined ${challenger.name}'s WinnersDice challenge.`);
            this.state = this.createIdleState();
            return;
        }

        negotiation.acceptanceStage = "accepted";
        this.bot.sendChat(`${opponent.name} accepted!`);
        this.beginLockBlockCheck(negotiation);
    }

    // ---- Lock-block preflight (blocked TimerPasswordPadlock) ----------------
    // The end game locks the loser with a TimerPasswordPadlock. If a player has
    // that item in their BlockItems the lock silently fails, so we resolve it
    // up front — right after the challenge is accepted, before wasting time on
    // the settings questions. BC only sends BlockItems at room-join, so this
    // reflects the last sync; a mid-room unblock still works when the lock is
    // actually applied (verified live 2026-07-20), we just can't re-detect it.

    private hasPadlockBlocked(memberNumber: number): boolean {
        const char = this.roomCharacters.get(memberNumber);
        return !!char?.BlockItems?.ItemMisc?.TimerPasswordPadlock;
    }

    private beginLockBlockCheck(negotiation: NegotiationState): void {
        const blocked = [negotiation.challenger, negotiation.opponent]
            .filter(p => this.hasPadlockBlocked(p.memberNumber));
        if (blocked.length === 0) {
            negotiation.lockBlockStage = "done";
            this.promptCarryoverOrBeginSettings(negotiation);
            return;
        }
        negotiation.lockBlockStage = "awaiting_choice";
        negotiation.lockBlockPending = blocked.map(p => p.memberNumber);
        for (const p of blocked) {
            this.bot.whisper(p.memberNumber,
                `⚠️ You've blocked the Timer Password Padlock, which WinnersDice uses to lock the loser at the end of a match — with it blocked, the end game can't lock you in.\n` +
                `Reply "unblock" once you've re-enabled it (Online Settings → Items — no need to leave the room), or "highsec" to use a High-Security lock instead: the winner gets a key to release you and I auto-release at time's up. Your opponent has to agree to the High-Security option.`
            );
        }
        for (const p of [negotiation.challenger, negotiation.opponent]) {
            if (!negotiation.lockBlockPending.includes(p.memberNumber)) {
                this.bot.whisper(p.memberNumber,
                    `Hang on — ${blocked.map(b => b.name).join(" and ")} ${blocked.length > 1 ? "have" : "has"} blocked the lock WinnersDice uses at match end. Sorting that out before we set up the game.`
                );
            }
        }
    }

    private handleLockBlockChoice(sender: number, choice: "unblock" | "highsec"): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.lockBlockStage !== "awaiting_choice") return;
        if (!negotiation.lockBlockPending.includes(sender)) return;

        if (choice === "unblock") {
            negotiation.lockBlockPending = negotiation.lockBlockPending.filter(n => n !== sender);
            this.bot.whisper(sender, `Got it, thanks — I'll use the normal lock for you.`);
            if (negotiation.lockBlockPending.length === 0) {
                negotiation.lockBlockStage = "done";
                this.promptCarryoverOrBeginSettings(negotiation);
            }
            return;
        }

        // highsec — needs both players to agree, since it changes how the loser
        // gets released (winner holds a key, no self-release, no visible timer).
        negotiation.lockBlockStage = "awaiting_highsec_consent";
        negotiation.highSecConsentAnswers = {};
        const requester = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
        this.bot.sendChat(
            `${requester.name} has the end-game padlock blocked and would rather use a High-Security lock. ` +
            `${negotiation.challenger.name} and ${negotiation.opponent.name}: use a High-Security lock for the loser this match? ` +
            `The loser can't remove it themselves; the winner gets a key and I auto-release at time's up. (yes/no)`
        );
    }

    private isAwaitingHighSecConsent(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.lockBlockStage === "awaiting_highsec_consent";
    }

    private handleHighSecConsent(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.lockBlockStage !== "awaiting_highsec_consent") return;
        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) return;

        negotiation.highSecConsentAnswers[sender] = value;
        const cA = negotiation.highSecConsentAnswers[negotiation.challenger.memberNumber];
        const oA = negotiation.highSecConsentAnswers[negotiation.opponent.memberNumber];

        if (cA === undefined || oA === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(`${responder.name} says ${value ? "yes" : "no"}. Waiting on ${other.name}...`);
            return;
        }

        if (cA && oA) {
            negotiation.useHighSecurityLock = true;
            negotiation.lockBlockStage = "done";
            this.bot.sendChat(`Both agreed — this match will use a High-Security lock at the end. Setting up the game.`);
            this.promptCarryoverOrBeginSettings(negotiation);
            return;
        }

        // Declined — the blocked player(s) must unblock instead.
        negotiation.lockBlockStage = "awaiting_choice";
        negotiation.highSecConsentAnswers = {};
        this.bot.sendChat(`High-Security lock declined — the blocked player will need to unblock the padlock instead.`);
        for (const n of negotiation.lockBlockPending) {
            this.bot.whisper(n,
                `High-Security was declined. Please unblock the Timer Password Padlock in your item settings, then whisper "unblock" — or !cancel to call off the match.`
            );
        }
    }

    // After the challenge is accepted, checks whether this pair has a saved
    // carryover balance from a previous match (see pairKey/pairBalances) and,
    // if so, asks both players whether to use it before settings negotiation
    // starts (see handleCarryoverChoiceAnswer). Skips straight to settings
    // negotiation if there's nothing to ask about.
    private promptCarryoverOrBeginSettings(negotiation: NegotiationState): void {
        const { challenger, opponent } = negotiation;
        const key = this.pairKey(challenger.memberNumber, opponent.memberNumber);
        const entry = this.pairBalances[key];
        const challengerCarry = entry?.balances[String(challenger.memberNumber)] ?? 0;
        const opponentCarry = entry?.balances[String(opponent.memberNumber)] ?? 0;

        if (!entry || (challengerCarry <= 0 && opponentCarry <= 0)) {
            negotiation.carryoverStage = "done";
            negotiation.useCarryover = false;
            this.promptSettingsShortcutOrBeginNegotiation(negotiation);
            return;
        }

        negotiation.carryoverStage = "awaiting";
        negotiation.carryoverAnswers = {};
        this.bot.sendChat(
            `${challenger.name} and ${opponent.name}: you have points carried over from your last match together — ` +
            `${challenger.name}: ${challengerCarry} pts, ${opponent.name}: ${opponentCarry} pts. ` +
            `Use them? Both must reply "yes" to carry them over — either replying "no" starts both of you fresh and clears the saved points for good.`
        );
    }

    private isAwaitingCarryoverChoice(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.carryoverStage === "awaiting";
    }

    // Dispatches one player's yes/no answer to the carryover opt-in prompt.
    // Both challenger and opponent must answer "yes" for the saved balance
    // to be applied at match start; either answering "no" clears the saved
    // entry outright (see savePairCarryover for how it's re-created).
    private handleCarryoverChoiceAnswer(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.carryoverStage !== "awaiting") {
            return;
        }
        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        negotiation.carryoverAnswers[sender] = value;

        const challengerAnswer = negotiation.carryoverAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.carryoverAnswers[negotiation.opponent.memberNumber];

        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(`${responder.name} says ${value ? "yes" : "no"}. Waiting on ${other.name}...`);
            return;
        }

        const agreed = challengerAnswer && opponentAnswer;
        negotiation.carryoverStage = "done";
        negotiation.carryoverAnswers = {};
        negotiation.useCarryover = agreed;

        if (agreed) {
            this.bot.sendChat("Both players agreed — carried-over points will be applied when the match starts.");
        } else {
            const key = this.pairKey(negotiation.challenger.memberNumber, negotiation.opponent.memberNumber);
            delete this.pairBalances[key];
            this.savePairBalances();
            this.bot.sendChat("Starting fresh — the saved carryover for this pair has been cleared.");
        }

        this.promptSettingsShortcutOrBeginNegotiation(negotiation);
    }

    // Dispatches one player's independent answer to ROOM_TYPE_QUESTION. Once
    // both have answered: matching answers win outright; a mismatch falls
    // back to "private" (see design_multi_room.md's TBD note, resolved by DW
    // on 2026-07-16 — default-to-private on disagreement).
    private handleRoomTypeAnswer(sender: number, value: RoomType): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.roomTypeStage !== "awaiting") {
            return;
        }
        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        negotiation.roomTypeAnswers[sender] = value;

        const challengerAnswer = negotiation.roomTypeAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.roomTypeAnswers[negotiation.opponent.memberNumber];

        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(`${responder.name} picks ${value}. Waiting on ${other.name}...`);
            return;
        }

        const resolved: RoomType = challengerAnswer === opponentAnswer ? challengerAnswer : "private";
        negotiation.roomTypeStage = "done";
        negotiation.roomTypeAnswers = {};
        negotiation.roomType = resolved;

        if (challengerAnswer === opponentAnswer) {
            this.bot.sendChat(`Both players agreed — room type: ${resolved}.`);
        } else {
            this.bot.sendChat(`${negotiation.challenger.name} and ${negotiation.opponent.name} picked different room types — defaulting to private.`);
        }

        this.promptSettingsCompareOrFinish(negotiation);
    }

    private beginSettingsNegotiation(): void {
        this.bot.sendChat(
            `Let's negotiate the match settings. Either player can type !cancel at any time to abort.`
        );
        this.promptNextSetting();
    }

    private promptNextSetting(): void {
        const negotiation = this.state.negotiation;
        if (!negotiation) return;

        negotiation.pending = null;
        negotiation.awaitingCounterFrom = null;

        const key = nextNegotiationKey(negotiation.config);
        if (key === null) {
            if (negotiation.lobbyFallbackStage === "not_asked") {
                if (botRole === "main" && listClaimedHandoffs().length > 0) {
                    negotiation.lobbyFallbackStage = "awaiting";
                    negotiation.lobbyFallbackAnswers = {};
                    this.bot.sendChat(`${negotiation.challenger.name} and ${negotiation.opponent.name}: ${LOBBY_FALLBACK_QUESTION}`);
                    return;
                }
                negotiation.lobbyFallbackStage = "done";
            }
            if (negotiation.lobbyFallbackStage === "awaiting") return;

            if (negotiation.roomTypeStage === "not_asked") {
                negotiation.roomTypeStage = "awaiting";
                negotiation.roomTypeAnswers = {};
                this.bot.sendChat(`${negotiation.challenger.name} and ${negotiation.opponent.name}: ${ROOM_TYPE_QUESTION}`);
                return;
            }
            if (negotiation.roomTypeStage === "awaiting") return;
            this.finishNegotiation();
            return;
        }

        if (isYesNoKey(key)) {
            if (negotiation.consentAllStage === "not_asked") {
                negotiation.consentAllStage = "awaiting";
                negotiation.consentAllAnswers = {};
                this.bot.sendChat(`${negotiation.challenger.name} and ${negotiation.opponent.name}: ${CONSENT_ALL_QUESTION}`);
                return;
            }

            negotiation.answers = {};
            this.bot.sendChat(
                `${negotiation.challenger.name} and ${negotiation.opponent.name}: ${yesNoQuestion(key)} (reply "yes" or "no")`
            );
            return;
        }

        this.bot.sendChat(`${negotiation.challenger.name}, ${numericQuestion(key)}`);
    }

    private handlePropose(sender: number, args: string): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation) return;
        if (negotiation.acceptanceStage === "awaiting") return;

        if (sender !== negotiation.challenger.memberNumber) {
            this.bot.sendChat(`Only ${negotiation.challenger.name} can open the proposal for this setting.`);
            return;
        }

        if (negotiation.pending) {
            this.bot.sendChat(`There's already a pending proposal awaiting a response.`);
            return;
        }

        const key = nextNegotiationKey(negotiation.config);
        if (key === null) return;

        if (isYesNoKey(key)) {
            this.bot.sendChat(`${settingLabel(key)} is a yes/no setting — both players reply "yes" or "no".`);
            return;
        }

        const parsed = parseProposalValue(key, args);
        if (typeof parsed === "string") {
            this.bot.sendChat(parsed);
            return;
        }

        negotiation.pending = { key, value: parsed.value, proposedBy: sender };
        this.bot.sendChat(
            `${negotiation.challenger.name} proposes: ${settingLabel(key)} = ${formatValue(key, parsed.value)}. ` +
            `${negotiation.opponent.name}, you can "accept" or "counter <value>".`
        );
    }

    private handleAccept(sender: number): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || !negotiation.pending) {
            return;
        }

        if (sender === negotiation.pending.proposedBy) {
            this.bot.sendChat("You can't accept your own proposal — waiting on the other player.");
            return;
        }

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        const { key, value } = negotiation.pending;
        (negotiation.config as any)[key] = value;
        negotiation.pending = null;

        this.bot.sendChat(`${settingLabel(key)} agreed: ${formatValue(key, value)}.`);
        this.promptNextSetting();
    }

    private handleCounter(sender: number, args: string): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || !negotiation.pending) {
            return;
        }

        if (sender === negotiation.pending.proposedBy) {
            this.bot.sendChat("You can't counter your own proposal.");
            return;
        }

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        if (!args.trim()) {
            negotiation.awaitingCounterFrom = sender;
            this.bot.whisper(sender, "What value would you like to counter with?");
            return;
        }

        const counterKey = negotiation.pending.key;
        const parsed = parseProposalValue(counterKey, args);
        if (typeof parsed === "string") {
            if (counterKey === "minRounds" && extractNumber(args) === null) {
                negotiation.awaitingCounterFrom = sender;
                this.bot.whisper(sender, numericReprompt(counterKey));
                return;
            }
            this.bot.sendChat(parsed);
            return;
        }

        const counterer = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
        const other = counterer === negotiation.challenger ? negotiation.opponent : negotiation.challenger;

        negotiation.pending = { key: negotiation.pending.key, value: parsed.value, proposedBy: sender };

        this.bot.sendChat(
            `${counterer.name} counters: ${settingLabel(negotiation.pending.key)} = ${formatValue(negotiation.pending.key, parsed.value)}. ` +
            `${other.name}, you can "accept" or "counter <value>".`
        );
    }

    private handleDecline(sender: number): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || !negotiation.pending) {
            return;
        }

        if (sender === negotiation.pending.proposedBy) {
            this.bot.sendChat("You can't decline your own proposal.");
            return;
        }

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        const decliner = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
        const key = negotiation.pending.key;
        negotiation.pending = null;

        this.bot.sendChat(`${decliner.name} declines the proposal for ${settingLabel(key)}.`);
        this.promptNextSetting();
    }

    private handleYesNoAnswer(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation) return;

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        const key = nextNegotiationKey(negotiation.config);
        if (key === null || !isYesNoKey(key)) return;

        negotiation.answers[sender] = value;

        const challengerAnswer = negotiation.answers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.answers[negotiation.opponent.memberNumber];

        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(`${responder.name} says ${value ? "yes" : "no"}. Waiting on ${other.name}...`);
            return;
        }

        const agreed = challengerAnswer && opponentAnswer;
        (negotiation.config as any)[key] = agreed;
        negotiation.answers = {};

        if (agreed) {
            this.bot.sendChat(`Both players said yes — ${settingLabel(key)}: enabled.`);
        } else {
            this.bot.sendChat(`${settingLabel(key)}: disabled (at least one player said no).`);
        }
        this.promptNextSetting();
    }

    // True while both players are being asked the single up-front "agree to
    // all" consent question, before any individual stripping/bondage/toys/
    // services question has been sent.
    private isAwaitingConsentAll(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.consentAllStage === "awaiting";
    }

    private handleConsentAllAnswer(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.consentAllStage !== "awaiting") {
            return;
        }

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        negotiation.consentAllAnswers[sender] = value;

        const challengerAnswer = negotiation.consentAllAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.consentAllAnswers[negotiation.opponent.memberNumber];

        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(`${responder.name} says ${value ? "yes" : "no"}. Waiting on ${other.name}...`);
            return;
        }

        const agreed = challengerAnswer && opponentAnswer;
        negotiation.consentAllStage = "done";
        negotiation.consentAllAnswers = {};

        if (agreed) {
            negotiation.config.stripping = true;
            negotiation.config.bondage = true;
            negotiation.config.toys = true;
            negotiation.config.services = true;
            this.bot.sendChat("Both players agreed — stripping, bondage, toys, and actions & services are all enabled.");
        } else {
            this.bot.sendChat("At least one player said no — let's go through each setting individually.");
        }

        this.promptNextSetting();
    }

    private isAwaitingLobbyFallback(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.lobbyFallbackStage === "awaiting";
    }

    // Dispatches one player's yes/no answer to LOBBY_FALLBACK_QUESTION. Both
    // must agree to play in the public lobby room — unlike roomTypeStage, a
    // mismatch (or either "no") cancels the match rather than defaulting to
    // anything, since there's no private fallback available right now.
    private handleLobbyFallbackAnswer(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.lobbyFallbackStage !== "awaiting") {
            return;
        }

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        negotiation.lobbyFallbackAnswers[sender] = value;

        const challengerAnswer = negotiation.lobbyFallbackAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.lobbyFallbackAnswers[negotiation.opponent.memberNumber];

        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(`${responder.name} says ${value ? "yes" : "no"}. Waiting on ${other.name}...`);
            return;
        }

        const agreed = challengerAnswer && opponentAnswer;
        negotiation.lobbyFallbackStage = "done";
        negotiation.lobbyFallbackAnswers = {};

        if (!agreed) {
            this.bot.sendChat(`No match will be played right now — the private room is still in use. Feel free to !challenge again once it frees up.`);
            this.clearChallengeAcceptanceTimer(negotiation);
            this.state = this.createIdleState();
            return;
        }

        negotiation.playInLobby = true;
        negotiation.roomTypeStage = "done";
        this.bot.sendChat(`Both players agreed — you'll play right here in the lobby.`);
        this.promptSettingsCompareOrFinish(negotiation);
    }

    private handleCancel(sender: number): void {
        const state = this.state;

        // Pre-roll settings confirmation — either player can call it off.
        if (this.pendingMatchStart) {
            this.cancelMatchStart();
            return;
        }

        if (state.phase === "negotiating" && state.negotiation) {
            const negotiation = state.negotiation;
            if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
                return;
            }

            const player = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            this.bot.sendChat(`${player.name} cancelled the negotiation. No match will be played.`);
            this.clearChallengeAcceptanceTimer(negotiation);
            this.state = this.createIdleState();
            return;
        }

        // The winner can back out of the end game proposal unilaterally only
        // while they're still filling in Q1-Q5 — once it's been delivered to
        // the loser (stage "negotiating"), only the negotiation flow itself
        // resolves it (accept/counter/block), no unilateral cancel.
        if (state.endGameProposal && this.isEndGameProposalQuestionStage(state.endGameProposal.proposalStage)
            && sender === state.endGameProposal.winnerMemberNumber) {
            this.handleEndGameProposalCancel(sender);
            return;
        }

        if (state.clothingDeal && (sender === state.clothingDeal.buyer || sender === state.clothingDeal.opponent)) {
            this.handleClothingDealCancel(sender);
            return;
        }

        if (state.bondageDeal && (sender === state.bondageDeal.placer || sender === state.bondageDeal.wearer)) {
            this.handleBondageDealCancel(sender);
            return;
        }

        if (state.lockDeal && (sender === state.lockDeal.placer || sender === state.lockDeal.wearer)) {
            this.handleLockDealCancel(sender);
            return;
        }

        if (state.toyDeal && (sender === state.toyDeal.winner || sender === state.toyDeal.loser)) {
            this.handleToyDealCancel(sender);
            return;
        }

        if (state.serviceDeal && (sender === state.serviceDeal.buyer || sender === state.serviceDeal.seller)) {
            this.handleServiceDealCancel(sender);
            return;
        }

        this.handleShopCancel(sender);
    }

    // Either party in an in-progress clothing deal can back out — mirrors
    // handleLockDealCancel/handleBondageDealCancel.
    private handleClothingDealCancel(sender: number): void {
        const deal = this.state.clothingDeal;
        if (!deal) return;

        const otherParty = sender === deal.buyer ? deal.opponent : deal.buyer;
        const alreadyVisibleToBoth = deal.stage !== "awaiting_item_price" && deal.stage !== "awaiting_item" && deal.stage !== "awaiting_price";

        this.bot.whisper(sender, "Clothing deal cancelled.");
        if (alreadyVisibleToBoth) {
            this.bot.whisper(otherParty, `${this.playerName(sender)} cancelled the clothing deal.`);
        }

        this.state.clothingDeal = null;
        this.returnToSpendMenu(deal.buyer);
    }

    // Either party in an in-progress bondage deal can back out — always
    // notified if the deal was already visible to both sides (i.e. anything
    // past the placer's private slot/item/price entry for an apply deal, or
    // any stage of a removal deal, since the wearer's initial ask is already
    // visible to the placer).
    private handleBondageDealCancel(sender: number): void {
        const deal = this.state.bondageDeal;
        if (!deal) return;

        const otherParty = sender === deal.placer ? deal.wearer : deal.placer;
        const alreadyVisibleToBoth = deal.kind === "removal" ||
            (deal.stage !== "awaiting_slot" && deal.stage !== "awaiting_item" && deal.stage !== "awaiting_price");

        this.bot.whisper(sender, "Bondage deal cancelled.");
        if (alreadyVisibleToBoth) {
            this.bot.whisper(otherParty, `${this.playerName(sender)} cancelled the bondage deal.`);
        }

        this.state.bondageDeal = null;
        this.returnToSpendMenu(deal.placer);
    }

    // Either party in an in-progress lock deal can back out — mirrors
    // handleBondageDealCancel.
    private handleLockDealCancel(sender: number): void {
        const deal = this.state.lockDeal;
        if (!deal) return;

        const otherParty = sender === deal.placer ? deal.wearer : deal.placer;
        const alreadyVisibleToBoth = deal.stage !== "awaiting_slot" && deal.stage !== "awaiting_price";

        this.bot.whisper(sender, "Lock deal cancelled.");
        if (alreadyVisibleToBoth) {
            this.bot.whisper(otherParty, `${this.playerName(sender)} cancelled the lock deal.`);
        }

        this.state.lockDeal = null;
        this.returnToSpendMenu(deal.placer);
    }

    // Only the winner (initiator) can back out of an in-progress toy rental —
    // the loser is a captive participant and can't simply decline, mirroring
    // the "You can't decline a toy offer" messaging in handleToyLoserResponse.
    private handleToyDealCancel(sender: number): void {
        const deal = this.state.toyDeal;
        if (!deal) return;

        if (sender === deal.loser) {
            this.bot.whisper(sender, "You can't cancel this deal — reply with 'yes' to accept or 'counter <number>' to negotiate the price.");
            return;
        }

        const otherParty = sender === deal.winner ? deal.loser : deal.winner;
        const alreadyVisibleToBoth = deal.stage !== "awaiting_toy" && deal.stage !== "awaiting_toy_confirm" && deal.stage !== "awaiting_price";

        this.bot.whisper(sender, "Toy deal cancelled.");
        if (alreadyVisibleToBoth) {
            this.bot.whisper(otherParty, `${this.playerName(sender)} cancelled the toy deal.`);
        }

        this.state.toyDeal = null;
        this.returnToSpendMenu(deal.winner);
    }

    // Lets a player back out of whatever they're doing in the spend menu —
    // a boost purchase, a buyback, or a clothing offer they're making — so
    // an unaffordable price never leaves them stuck with no way out.
    private handleShopCancel(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || state.awaitingPostBank !== sender) return;

        if (state.awaitingBoostLevel === sender) {
            state.awaitingBoostLevel = null;
            this.bot.whisper(sender, "Boost purchase cancelled.");
            this.returnToSpendMenu(sender);
            return;
        }

        if (state.awaitingBuyback === sender) {
            state.awaitingBuyback = null;
            this.bot.whisper(sender, "Buyback cancelled.");
            this.returnToSpendMenu(sender);
            return;
        }

        if (state.awaitingBondageBuyback === sender) {
            state.awaitingBondageBuyback = null;
            this.bot.whisper(sender, "Bondage buyback cancelled.");
            this.returnToSpendMenu(sender);
            return;
        }

        if (state.spendMenuOpen) {
            state.spendMenuOpen = false;
            this.bot.whisper(sender, this.postBankPromptText(sender));
        }
    }

    private finishNegotiation(): void {
        const negotiation = this.state.negotiation;
        if (!negotiation) return;

        // Permission pre-flight — runs before committing to a match.
        const challengerOk = this.checkPlayerPermissions(negotiation.challenger.memberNumber, negotiation.challenger.name);
        const opponentOk = this.checkPlayerPermissions(negotiation.opponent.memberNumber, negotiation.opponent.name);

        if (!challengerOk || !opponentOk) {
            // checkPlayerPermissions already whispered the blocked player; inform the other.
            if (!challengerOk) {
                this.bot.whisper(negotiation.opponent.memberNumber,
                    `The match has been cancelled — ${negotiation.challenger.name} needs to enable item interactions first.`
                );
            }
            if (!opponentOk) {
                this.bot.whisper(negotiation.challenger.memberNumber,
                    `The match has been cancelled — ${negotiation.opponent.name} needs to enable item interactions first.`
                );
            }
            this.bot.sendChat(
                `The WinnersDice match between ${negotiation.challenger.name} and ${negotiation.opponent.name} ` +
                `was cancelled due to a permissions issue. Fix the setting and !challenge again.`
            );
            this.state = this.createIdleState();
            return;
        }

        const config: GameConfig = {
            minRounds: negotiation.config.minRounds ?? 3,
            stripping: negotiation.config.stripping ?? false,
            bondage: negotiation.config.bondage ?? false,
            // Bondage application is no longer negotiated — the other player always applies it.
            bondageAppliedBy: negotiation.config.bondage ? "player" : null,
            // TODO: lock duration will be set per-purchase from the spend menu
            // once bondage purchases are implemented, rather than up front.
            lockDuration: 0,
            toys: negotiation.config.toys ?? false,
            services: negotiation.config.services ?? false,
            maxStreak: this.defaultMaxStreak,
        };

        // Apply this pair's carried-over balance, if both players opted in
        // at accept time (see promptCarryoverOrBeginSettings/
        // handleCarryoverChoiceAnswer). If they opted out, the saved entry
        // was already deleted at that point, so there's nothing to read here.
        const carryoverEntry = negotiation.useCarryover
            ? this.pairBalances[this.pairKey(negotiation.challenger.memberNumber, negotiation.opponent.memberNumber)]
            : undefined;
        const challengerStart = carryoverEntry?.balances[String(negotiation.challenger.memberNumber)] ?? 0;
        const opponentStart = carryoverEntry?.balances[String(negotiation.opponent.memberNumber)] ?? 0;

        // Save negotiation settings for future "use same settings?" shortcut.
        this.saveNegotiationSettings(negotiation, {
            minRounds: config.minRounds,
            stripping: config.stripping,
            bondage: config.bondage,
            toys: config.toys,
            services: config.services,
        });

        // Multi-room mode: the lobby bot never runs matches itself. Hand off
        // to a room bot instead of building match state — see design_multi_room.md.
        // Exception: playInLobby (see handleLobbyFallbackAnswer) — both players
        // agreed to play right here rather than wait for the busy room bot, so
        // fall through to launchMatch() same as the non-main path below.
        if (botRole === "main" && !negotiation.playInLobby) {
            this.handOffMatch(negotiation, config, challengerStart, opponentStart);
            return;
        }

        this.launchMatch(
            config,
            negotiation.challenger,
            negotiation.opponent,
            challengerStart,
            opponentStart,
            negotiation.useHighSecurityLock
        );
    }

    // Builds match state and starts play. Shared by the legacy direct-play
    // fallback above (botRole !== "main" during negotiation) and the room
    // bot's claimed-match start (see startClaimedMatch) — those two are the
    // only paths that ever reach "playing" phase.
    private launchMatch(
        config: GameConfig,
        challenger: { memberNumber: number; name: string },
        opponent: { memberNumber: number; name: string },
        challengerStart: number,
        opponentStart: number,
        useHighSecurityLock: boolean = false
    ): void {
        this.matchUsesHighSecurityLock = useHighSecurityLock;
        const players: [PlayerState, PlayerState] = [
            { memberNumber: challenger.memberNumber, name: challenger.name, balance: challengerStart, streak: 0, boost: 0, cursedPenalty: 0, pendingBalance: 0, soldItems: [] },
            { memberNumber: opponent.memberNumber, name: opponent.name, balance: opponentStart, streak: 0, boost: 0, cursedPenalty: 0, pendingBalance: 0, soldItems: [] },
        ];

        this.state = {
            phase: "playing",
            config,
            players,
            pot: 0,
            currentRound: 1,
            rollNumber: 1,
            awaitingDecision: null,
            awaitingPostBank: null,
            spendMenuOpen: false,
            clothingDeal: null,
            serviceDeal: null,
            bondageDeal: null,
            activeBondage: [],
            removableBondage: [],
            activeLocks: [],
            lockDeal: null,
            toyDeal: null,
            activeToy: null,
            negotiation: null,
            endGameProposal: null,
            activeEndGame: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            awaitingBondageBuyback: null,
            waitingForWardrobe: null,
            mercyRequest: null,
            mercyCooldowns: new Map(),
            disconnectTimer: null,
            endGameBlockedFor: null,
            endGameBlockRollDone: false,
            paused: false,
        };

        const summary = [
            `Minimum rounds: ${config.minRounds}`,
            `Stripping: ${formatValue("stripping", config.stripping)}`,
            `Bondage: ${formatValue("bondage", config.bondage)}` + (config.bondage ? ` (applied by the other player; lock time set via purchases)` : ""),
            `Toys: ${formatValue("toys", config.toys)}`,
            `Services: ${formatValue("services", config.services)}`,
        ].join(", ");

        this.bot.sendChat(
            `Here are the agreed settings for ${players[0].name} vs ${players[1].name} — ${summary}.`
        );
        if (challengerStart > 0 || opponentStart > 0) {
            this.bot.sendChat(
                `Carried-over points applied — ${players[0].name} starts with ${challengerStart} pts, ${players[1].name} starts with ${opponentStart} pts.`
            );
        }

        this.beginMatchStartConfirm();
    }

    // Both players must confirm the settings shown above before the first roll.
    // Whichever bot runs the match (room bot after arrival, or the lobby bot
    // for a fallback match), the match doesn't begin until both reply — and is
    // cancelled if they don't within MATCH_START_CONFIRM_TIMEOUT_MS.
    private beginMatchStartConfirm(): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players) return;

        const timer = setTimeout(() => this.cancelMatchStart(), MATCH_START_CONFIRM_TIMEOUT_MS);
        this.pendingMatchStart = { confirms: new Set(), timer };

        const minutes = Math.round(MATCH_START_CONFIRM_TIMEOUT_MS / 60000);
        this.bot.sendChat(
            `${state.players[0].name} and ${state.players[1].name}: both reply "ready" (or "start") to confirm and begin rolling. ` +
            `Type !cancel if something's wrong. (Auto-cancels in ${minutes} min if you don't both confirm.)`
        );
    }

    private handleMatchStartConfirm(sender: number): void {
        const pending = this.pendingMatchStart;
        const state = this.state;
        if (!pending || state.phase !== "playing" || !state.players) return;
        if (!state.players.some(p => p.memberNumber === sender)) return;
        if (pending.confirms.has(sender)) {
            this.bot.whisper(sender, `You're confirmed — waiting on the other player.`);
            return;
        }

        pending.confirms.add(sender);
        const other = state.players.find(p => p.memberNumber !== sender);
        if (pending.confirms.size >= 2) {
            this.finalizeMatchStart();
        } else {
            this.bot.sendChat(`${this.playerName(sender)} is ready — waiting on ${other ? other.name : "the other player"}.`);
        }
    }

    private clearMatchStartConfirm(): void {
        if (this.pendingMatchStart) {
            clearTimeout(this.pendingMatchStart.timer);
            this.pendingMatchStart = null;
        }
    }

    private finalizeMatchStart(): void {
        this.clearMatchStartConfirm();
        this.startMatch();
    }

    // Both players didn't confirm the settings in time (or one typed !cancel) —
    // call the match off. Mirrors the abort teardown used by safeword/reset.
    private cancelMatchStart(): void {
        if (!this.pendingMatchStart) return;
        this.clearMatchStartConfirm();

        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();

        const names = this.state.players ? this.state.players.map(p => p.name).join(" and ") : "the players";
        this.bot.sendChat(`Match cancelled — settings weren't confirmed by both players. ${names} can !challenge again.`);

        if (this.activeHandoff) {
            this.writeRoomBotResult(this.activeHandoff, "reset", null, null, 0, 0);
            this.resetRoomBotForNextMatch();
        }
        this.state = this.createIdleState();
    }

    // Multi-room mode (BOT_ROLE=main): writes the agreed match to
    // handoffs/pending/ for a room bot to claim, instead of running it here.
    // See design_multi_room.md's full flow.
    private handOffMatch(negotiation: NegotiationState, config: GameConfig, challengerStart: number, opponentStart: number): void {
        writeHandoff({
            players: {
                challenger: { memberNumber: negotiation.challenger.memberNumber, name: negotiation.challenger.name },
                opponent: { memberNumber: negotiation.opponent.memberNumber, name: negotiation.opponent.name },
            },
            config,
            roomType: negotiation.roomType ?? "private",
            startingBalances: { challenger: challengerStart, opponent: opponentStart },
            useHighSecurityLock: negotiation.useHighSecurityLock,
        });

        this.bot.sendChat(
            `All settings agreed! A game room is being prepared for ${negotiation.challenger.name} and ${negotiation.opponent.name} — you'll receive an invite shortly.`
        );
        this.bot.whisper(negotiation.challenger.memberNumber, "Your game room is being prepared — hang tight, you'll get an invite shortly.");
        this.bot.whisper(negotiation.opponent.memberNumber, "Your game room is being prepared — hang tight, you'll get an invite shortly.");

        this.state = this.createIdleState();
    }

    // ============================================================
    // MULTI-ROOM MODE — ROOM BOT (BOT_ROLE !== "main")
    // ============================================================
    // See design_multi_room.md. A room bot never negotiates — it polls
    // handoffs/pending/ for work, configures its one static room per the
    // claimed match's roomType, waits for both named players to arrive,
    // then runs the match via launchMatch() same as any direct-play game.

    // Static base name for Spectator/Locked, or base + a fresh random
    // 3-digit suffix for Private (so a Private room's name can't be
    // reused/guessed from a previous match — see design_multi_room.md's
    // Room Types section).
    private resolveRoomName(roomType: RoomType): string {
        if (roomType !== "private") return secrets.roomName;
        // No separator — "WD Room 1" + "42" = "WD Room 142". 2 digits
        // (00-99) is plenty of randomness at this scale and keeps the name
        // short.
        const suffix = String(Math.floor(Math.random() * 100)).padStart(2, "0");
        const name = `${secrets.roomName}${suffix}`;
        // BC's room name cap is confirmed live 2026-07-16: 20 chars works
        // ("WinnersDice Room 1 3"), 22 chars fails with "InvalidRoomData"
        // ("WinnersDice Room 1 265"). secrets.ts's gamebot1 roomName was
        // shortened to leave margin, but warn loudly if it (or the format
        // here) ever creeps back over the limit rather than failing
        // silently at claim time.
        if (name.length > 20) {
            logError(`[Handoff] Private room name "${name}" (${name.length} chars) may exceed BC's room name limit — shorten secrets.roomName.`);
        }
        return name;
    }

    private pollForHandoff(): void {
        if (!this.bot.isConnected() || this.state.phase !== "idle" || this.activeHandoff) return;

        if (!this.hasReapedOrphanedClaims) {
            this.hasReapedOrphanedClaims = true;
            this.reapOwnOrphanedClaims();
        }

        for (const entry of listPendingHandoffs()) {
            const roomName = this.resolveRoomName(entry.roomType);
            const claimed = claimHandoff(entry, botRole, roomName);
            if (claimed) {
                this.setupClaimedRoom(claimed);
                return;
            }
            // Rename lost the race to another room bot — try the next pending entry.
        }
    }

    // Runs once, the first time this room bot is idle and connected. If a
    // previous run of this same botRole crashed or was killed mid-match, its
    // claim never got a result written and just sits in handoffs/claimed/
    // forever — found live 2026-07-17 (a stale claim caused the lobby bot to
    // whisper a leftover room invite from an old test on its next restart).
    // Closes each one out as an aborted match and puts the room back to its
    // default state, since a fresh process has no memory of what state a
    // stale claim's room might have been left in.
    private reapOwnOrphanedClaims(): void {
        let reaped = false;
        for (const claimed of listClaimedHandoffs()) {
            if (claimed.claimedBy !== botRole) continue;
            log(`[Handoff] Reaping orphaned claim ${claimed.id} left over from a previous run.`);
            this.writeRoomBotResult(claimed, "reset", null, null, 0, 0);
            reaped = true;
        }
        if (reaped) {
            this.bot.configureRoomForMatch({ name: secrets.roomName, visibility: "hidden", locked: false });
        }
    }

    private setupClaimedRoom(handoff: HandoffEntry): void {
        this.activeHandoff = handoff;
        const roomName = handoff.roomName!;

        log(`[Handoff] Claimed ${handoff.id} — configuring room "${roomName}" as ${handoff.roomType}.`);
        if (handoff.roomType === "private") {
            // Private's randomized name requires an actual rename — found
            // live 2026-07-16 that ChatRoomAdmin/Update does NOT change an
            // existing room's Name, so this leaves and recreates fresh
            // instead. createRoom()'s defaults (Visibility: Admin = Hidden,
            // unlocked) already match what Private needs, so no follow-up
            // configureRoomForMatch call is needed.
            this.bot.leaveRoom();
            this.bot.createRoom(roomName);
        } else {
            // Spectator/Locked keep the static base name — Visibility/Locked
            // toggle via Update in place (confirmed working live 2026-07-16).
            this.bot.configureRoomForMatch({
                name: roomName,
                visibility: handoff.roomType === "spectator" ? "public" : "hidden",
                // Unlocked during the entry window even for Locked matches —
                // re-locked once both players are confirmed present (checkHandoffArrival).
                locked: false,
            });
        }

        this.handoffEntryTimer = setTimeout(() => this.expireHandoffEntry(handoff.id), 5 * 60 * 1000);
        this.checkHandoffArrival();
    }

    // Called from onMemberJoin/onRoomSync — checks whether both of the
    // active handoff's named players are now in this bot's room, and starts
    // the match the moment they both are.
    private checkHandoffArrival(): void {
        const handoff = this.activeHandoff;
        if (!handoff || this.state.phase !== "idle") return;

        const { challenger, opponent } = handoff.players;
        if (!this.roomMembers.has(challenger.memberNumber) || !this.roomMembers.has(opponent.memberNumber)) {
            return;
        }

        if (this.handoffEntryTimer) {
            clearTimeout(this.handoffEntryTimer);
            this.handoffEntryTimer = null;
        }

        if (handoff.roomType === "locked") {
            this.bot.configureRoomForMatch({ name: handoff.roomName!, visibility: "hidden", locked: true });
        }

        this.bot.sendChat(`Both players are here — let's begin!`);
        this.launchMatch(handoff.config, challenger, opponent, handoff.startingBalances.challenger, handoff.startingBalances.opponent, handoff.useHighSecurityLock ?? false);
    }

    // One or both named players never showed up within the entry window.
    private expireHandoffEntry(handoffId: string): void {
        const handoff = this.activeHandoff;
        if (!handoff || handoff.id !== handoffId) return;

        log(`[Handoff] ${handoffId} expired waiting for players to arrive.`);
        this.bot.sendChat(`This game room's invite expired — nobody arrived in time. Resetting for the next match.`);
        this.writeRoomBotResult(handoff, "disconnect", null, null, 0, 0);
        this.resetRoomBotForNextMatch();
    }

    // Shared teardown for every way a room-bot-run match can end (see
    // writeRoomBotResult's call sites). Unlocks/renames the room back to
    // its static default and clears activeHandoff so pollForHandoff can
    // pick up the next pending entry.
    // Room bot: after the end-game session ends, ask the winner to confirm
    // before resetting the room (see pendingRoomReset). Whispers them and arms
    // an auto-reset timeout so the room can't hang forever if they wander off.
    private beginRoomResetConfirm(winnerMemberNumber: number): void {
        // Clear any prior pending confirm (shouldn't normally happen).
        if (this.pendingRoomReset) clearTimeout(this.pendingRoomReset.timer);
        const timer = setTimeout(() => {
            log("[Handoff] Room-reset confirmation timed out — resetting the room anyway.");
            this.resetRoomBotForNextMatch();
        }, ROOM_RESET_CONFIRM_TIMEOUT_MS);
        this.pendingRoomReset = { winnerMemberNumber, timer };
        const minutes = Math.round(ROOM_RESET_CONFIRM_TIMEOUT_MS / 60000);
        this.bot.whisper(winnerMemberNumber,
            `That's a wrap on the match! Whisper "ready" when you're both done and I'll reset the room for the next game. ` +
            `(If I don't hear back, I'll reset automatically in about ${minutes} minutes.)`
        );
    }

    // The winner confirmed they're done (or the timeout fired) — do the actual
    // room reset. Safe to call whether or not a confirm is pending.
    private finalizeRoomReset(): void {
        this.resetRoomBotForNextMatch();
    }

    private resetRoomBotForNextMatch(): void {
        if (this.pendingRoomReset) {
            clearTimeout(this.pendingRoomReset.timer);
            this.pendingRoomReset = null;
        }
        this.clearMatchStartConfirm();
        if (this.handoffEntryTimer) {
            clearTimeout(this.handoffEntryTimer);
            this.handoffEntryTimer = null;
        }
        const wasPrivate = this.activeHandoff?.roomType === "private";
        this.activeHandoff = null;

        if (wasPrivate) {
            // Leave the randomly-named room and recreate the static base
            // one — same reasoning as setupClaimedRoom (Update can't rename).
            this.bot.leaveRoom();
            this.bot.createRoom(secrets.roomName);
        } else {
            this.bot.configureRoomForMatch({ name: secrets.roomName, visibility: "hidden", locked: false });
        }
    }

    // Writes the match's outcome to handoffs/results/ for the lobby bot to
    // apply to players.json/pair_balances.json. pairBalances only carries
    // real leftover balances for a "normal"/"mercy" ending — safeword/reset/
    // disconnect endings never save carryover (mirrors the existing
    // single-bot convention documented on PairBalanceEntry in types.ts).
    private writeRoomBotResult(
        handoff: HandoffEntry,
        endReason: MatchResultEntry["endReason"],
        winner: number | null,
        loser: number | null,
        winnerPointsEarned: number,
        loserPointsLost: number
    ): void {
        const pairBalances: Record<string, number> = {};
        if ((endReason === "normal" || endReason === "mercy") && this.state.players) {
            for (const p of this.state.players) pairBalances[String(p.memberNumber)] = p.balance;
        }

        writeResult({
            handoffId: handoff.id,
            completedAt: centralTimestamp(),
            winner,
            loser,
            winnerPointsEarned,
            loserPointsLost,
            endReason,
            pairBalances,
        });
    }

    private startMatch(): void {
        this.bot.sendChat(`🎯 Round 1 begins! (×1 multiplier)`);
        this.playRound();
    }

    private playRound(): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;

        while (true) {
            if (this.resolveRoll(rollD20(), rollD20())) break;
        }
    }

    // Resolves one roll from the two raw d20 rolls. Returns false if the
    // roll needs to be rerolled (a tie on effective totals).
    private resolveRoll(dice1: number, dice2: number): boolean {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return true;

        const [p1, p2] = state.players;
        const maxStreak = state.config.maxStreak;

        // Capture each player's streak/boost/cursed penalty as they stood
        // for THIS roll, before any natural-roll effects are applied below.
        const streak1 = p1.streak;
        const streak2 = p2.streak;
        const boost1 = p1.boost;
        const boost2 = p2.boost;
        const curse1 = p1.cursedPenalty;
        const curse2 = p2.cursedPenalty;
        const total1 = dice1 + streak1 + boost1 + curse1;
        const total2 = dice2 + streak2 + boost2 + curse2;

        // A Natural 20 always wins the roll outright, and a Natural 1 always
        // loses it outright — regardless of streak/boost/curse totals.
        // Natural 20 takes priority (a 20-vs-1 exchange is just a normal
        // 20-wins case, not a conflict). If both players hit the same
        // extreme in the same exchange (both Natural 20, or both Natural 1),
        // the effects cancel out and — same as an ordinary tied total —
        // the round rerolls.
        const p1Nat20 = dice1 === 20, p2Nat20 = dice2 === 20;
        const p1Nat1 = dice1 === 1, p2Nat1 = dice2 === 1;

        let forcedWinner: PlayerState | null = null;
        let forcedReason: "nat20" | "opponentNat1" | null = null;
        if (p1Nat20 !== p2Nat20) {
            forcedWinner = p1Nat20 ? p1 : p2;
            forcedReason = "nat20";
        } else if (p1Nat1 !== p2Nat1) {
            forcedWinner = p1Nat1 ? p2 : p1;
            forcedReason = "opponentNat1";
        }

        if (forcedWinner === null && ((p1Nat20 && p2Nat20) || (p1Nat1 && p2Nat1) || total1 === total2)) {
            return false;
        }

        const winner = forcedWinner ?? (total1 > total2 ? p1 : p2);
        const loser = winner === p1 ? p2 : p1;
        const winnerTotal = winner === p1 ? total1 : total2;

        // A Natural 1 stacks a -1 cursed penalty on the roller's future
        // rolls until they win one (cleared below when a cursed player wins) —
        // applies regardless of whether this roll was forced by a Natural 1/20.
        if (dice1 === 1) {
            p1.cursedPenalty -= 1;
            this.bot.whisper(p1.memberNumber, `💀 Snake eyes! -1 to your rolls until your next win.`);
        }
        if (dice2 === 1) {
            p2.cursedPenalty -= 1;
            this.bot.whisper(p2.memberNumber, `💀 Snake eyes! -1 to your rolls until your next win.`);
        }

        if (forcedReason === "nat20") {
            this.bot.sendChat(`🎯 Natural 20! ${winner.name} wins the roll outright — streak jumps by 2!`);
        } else if (forcedReason === "opponentNat1") {
            this.bot.sendChat(`💀 ${loser.name} rolled a Natural 1 — automatic loss! ${winner.name} takes the roll.`);
        }
        winner.streak = Math.min(winner.streak + (forcedReason === "nat20" ? 2 : 1), maxStreak);
        if (winner.cursedPenalty !== 0) {
            winner.cursedPenalty = 0;
            this.bot.sendChat(`✨ ${winner.name} wins the roll and shakes off the curse!`);
        }

        // Losing resets the streak and drains one charge of boost.
        loser.streak = 0;
        loser.boost = Math.max(0, loser.boost - 1);

        const points = winnerTotal * this.currentRound;
        state.pot += points;

        state.awaitingDecision = winner.memberNumber;

        // Once a roll completes while an end game block is pending, the
        // blocked winner has met the "play at least one roll" requirement.
        if (state.endGameBlockedFor !== null) {
            state.endGameBlockRollDone = true;
        }

        const result: RoundResult = {
            round: state.currentRound,
            rollNumber: state.rollNumber,
            rolls: [
                { memberNumber: p1.memberNumber, dice: dice1, streak: streak1, boost: boost1, cursedPenalty: curse1, total: total1 },
                { memberNumber: p2.memberNumber, dice: dice2, streak: streak2, boost: boost2, cursedPenalty: curse2, total: total2 },
            ],
            winner: winner.memberNumber,
            points,
            potTotal: state.pot,
        };

        this.announceRollResult(result);
        return true;
    }

    private announceRollResult(result: RoundResult): void {
        const [p1, p2] = this.state.players!;
        const winner = result.winner === p1.memberNumber ? p1 : p2;
        const loser = winner === p1 ? p2 : p1;
        const [r1, r2] = result.rolls;
        const winnerRoll = winner === p1 ? r1 : r2;
        const loserRoll = winner === p1 ? r2 : r1;

        const fmtBreakdown = (roll: DiceRoll): string => {
            let breakdown = `${roll.dice}`;
            if (roll.streak > 0) breakdown += ` + ${roll.streak} (streak)`;
            if (roll.boost > 0) breakdown += ` + ${roll.boost} (boost)`;
            if (roll.cursedPenalty < 0) breakdown += ` - ${Math.abs(roll.cursedPenalty)} (cursed)`;
            return breakdown;
        };

        const winnerPoints = winnerRoll.total * result.round;

        // Only the winner's points go into the pot, so we don't spell out the
        // loser's point math — just show their raw roll so the result is still
        // clear at a glance, and fold the outcome + next-step into fewer lines.
        this.bot.sendChat(
            `🎲 Roll ${result.rollNumber} — ${winner.name} wins with ${fmtBreakdown(winnerRoll)} = ${winnerRoll.total} × ${result.round} = ${winnerPoints} points (beat ${loser.name}'s ${loserRoll.total}) → Pot: ${result.potTotal} points`
        );
        this.bot.sendChat(`${winner.name} can bank ${result.potTotal} points or keep rolling to build the pot.`);

        // Whisper every active player in the match — not just the winner —
        // so nobody is left without word of the roll outcome.
        for (const player of this.state.players!) {
            if (player.memberNumber === winner.memberNumber) {
                this.bot.whisper(
                    player.memberNumber,
                    `You won this roll! Use !bank to take it, !press to keep rolling, or !endgame to call the match (after round ${this.state.config!.minRounds}).`
                );
            } else {
                this.bot.whisper(
                    player.memberNumber,
                    `${winner.name} won that roll — waiting for them to decide bank/press/endgame... (Pot: ${result.potTotal} points)`
                );
            }
        }
    }

    private handleBank(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config || state.awaitingDecision !== sender) return;
        if (this.blockedByWardrobe(sender)) return;
        if (this.blockedByShopDeal(sender)) return;
        if (this.blockedByMercy(sender)) return;

        const winner = state.players.find(p => p.memberNumber === sender)!;
        winner.balance += state.pot;
        const banked = state.pot;
        state.pot = 0;
        state.spendingBalance = winner.balance;

        // If this player was blocked from calling end game, clear the block
        // now that they've played a roll and banked.
        if (state.endGameBlockedFor === sender && state.endGameBlockRollDone) {
            state.endGameBlockedFor = null;
            state.endGameBlockRollDone = false;
            this.bot.whisper(sender, "⚔️ End game is available to you again.");
        }

        this.bot.sendChat(`${winner.name} banks the pot of ${banked} points! Balance: ${winner.balance}.`);

        state.awaitingDecision = null;
        state.awaitingPostBank = sender;
        state.spendMenuOpen = false;
        this.bot.whisper(
            sender,
            `You've banked ${banked} points (balance: ${winner.balance})! Streak was ${winner.streak}, Boost was ${winner.boost}.\n` +
            this.postBankPromptText(sender)
        );
    }

    // The continue/spend/endgame prompt shown after banking, and re-shown
    // once a paused clothing deal's wardrobe change comes through. Includes a
    // 4th "remove locks" option whenever the given player has any active locks.
    private postBankPromptText(memberNumber: number): string {
        const state = this.state;
        const nextRound = this.currentRound + 1;
        const lines = [
            `What next?`,
            `1. continue — start Round ${nextRound} (×${nextRound} next round, streak resets)`,
            `2. spend — use your points`,
            `3. endgame — call the match (available after round ${state.config!.minRounds})`,
        ];

        const locks = this.activeLocksFor(memberNumber);
        if (locks.length > 0) {
            const total = locks.reduce((sum, l) => sum + this.lockRemovalCost(l), 0);
            lines.push(`4. remove locks — pay ${total} points to have your locked ${locks.map(l => l.slot).join(", ")} unlocked`);
        }

        lines.push(`H. help — what does all this mean?`);

        return lines.join("\n");
    }

    // Handles a banked player's reply to the spend/continue/endgame prompt
    // (or, if the spend menu is open, their spend-menu choice).
    private handlePostBankAnswer(sender: number, lower: string, raw: string): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;

        if (this.blockedByWardrobe(sender)) return;
        if (this.blockedByServiceDeal(sender)) return;
        if (this.blockedByMercy(sender)) return;

        // If a shop deal is active (bondage/lock/toy/clothing), the other player
        // hasn't responded yet. Don't show the bank menu or "I didn't catch that"
        // — just remind the winner they're waiting. Also prevents a second offer
        // from being placed before the first is answered.
        if (state.bondageDeal || state.lockDeal || state.toyDeal || state.clothingDeal) {
            this.bot.whisper(sender, "⏳ Waiting for the other player to respond to your offer.");
            return;
        }

        if (state.spendMenuOpen) {
            this.handleSpendMenuChoice(sender, lower, raw);
            return;
        }

        if (lower === "0") {
            this.bot.whisper(sender, "You're at the main menu — there's nothing to go back to. Choose an option or wait for the other player.");
            return;
        }

        if (lower === "1") {
            state.awaitingPostBank = null;
            this.startNewRound(sender);
            return;
        }

        if (lower === "2") {
            this.bot.sendChat(`🛍️ ${this.playerName(sender)} enters the shop...`);
            this.openSpendMenu(sender);
            return;
        }

        if (lower === "3" || lower === "endgame" || lower === "end game" || lower === "end") {
            this.handleEndgame(sender);
            return;
        }

        if (lower === "4" && this.activeLocksFor(sender).length > 0) {
            this.handleRemoveLocksPayment(sender);
            return;
        }

        const hasLocks = this.activeLocksFor(sender).length > 0;
        this.bot.whisper(sender,
            `I didn't catch that — reply 1 (continue), 2 (spend), or 3 (endgame)${hasLocks ? ", or 4 (remove locks)" : ""}.`);
    }

    private handlePress(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || state.awaitingDecision !== sender) return;
        if (this.blockedByWardrobe(sender)) return;
        if (this.blockedByShopDeal(sender)) return;
        if (this.blockedByMercy(sender)) return;

        if (state.rollNumber >= MAX_ROLLS_PER_ROUND) {
            this.bot.whisper(sender, `You've reached the maximum of ${MAX_ROLLS_PER_ROUND} rolls this round. You must bank or pass.`);
            return;
        }

        const winner = state.players.find(p => p.memberNumber === sender)!;

        let bonusText = `+${winner.streak} streak`;
        if (winner.boost > 0) bonusText += ` and +${winner.boost} boost`;
        this.bot.sendChat(
            `${winner.name} presses on, keeping ${state.pot} points at risk with ${bonusText} on the next roll.`
        );

        state.awaitingDecision = null;
        state.rollNumber += 1;
        this.playRound();
    }

    // Called when the banked winner chooses 'continue': starts a new round,
    // resetting the roll counter and both players' streaks (boosts persist),
    // and releasing the other player's pending trade earnings.
    private startNewRound(bankedSender: number): void {
        const state = this.state;
        if (!state.players || !state.config) return;

        const banker = state.players.find(p => p.memberNumber === bankedSender)!;
        banker.balance = state.spendingBalance;

        state.currentRound += 1;
        state.rollNumber = 1;

        for (const player of state.players) {
            player.streak = 0;
        }

        const other = state.players.find(p => p.memberNumber !== bankedSender)!;
        if (other.pendingBalance > 0) {
            other.balance += other.pendingBalance;
            this.bot.whisper(other.memberNumber, `Your pending balance of ${other.pendingBalance} points is now available — your balance is ${other.balance} points.`);
            other.pendingBalance = 0;
        }

        this.bot.sendChat(`🏦 ${banker.name} banks and continues! Starting Round ${state.currentRound} (×${state.currentRound} multiplier) — streaks reset!`);

        this.playRound();
    }

    // Instead of ending the match outright, this now kicks off the
    // structured end game proposal/negotiation (see startEndGameProposal) —
    // the match only actually ends once that concludes (executeEndGame ->
    // expireEndGame -> finishMatch) or is blocked by the loser.
    private handleEndgame(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;
        if (state.awaitingDecision !== sender && state.awaitingPostBank !== sender) return;
        if (this.blockedByWardrobe(sender)) return;
        if (this.blockedByShopDeal(sender)) return;
        if (this.blockedByMercy(sender)) return;
        if (state.endGameProposal || state.activeEndGame) return;

        // End game blocked after a block/decline — must play a roll then bank first.
        if (state.endGameBlockedFor === sender) {
            const hint = state.endGameBlockRollDone
                ? "You've played a roll — bank to unlock end game."
                : "Play at least one roll and then bank to unlock end game again.";
            this.bot.whisper(sender, `⚔️ End game is locked for you right now. ${hint}`);
            return;
        }

        if (state.currentRound < state.config.minRounds) {
            if (state.awaitingPostBank === sender) {
                this.bot.whisper(sender, `Not yet — minimum rounds not reached. Reply 1 (continue) or 2 (spend).`);
            } else {
                this.bot.whisper(sender, `The minimum of ${state.config.minRounds} rounds hasn't been reached yet — !bank or !press to continue.`);
            }
            return;
        }

        const winner = state.players.find(p => p.memberNumber === sender)!;
        if (state.awaitingPostBank === sender) {
            winner.balance = state.spendingBalance;
        } else {
            // Called right after winning a roll, before banking — bank the
            // pot first (same as finishMatch used to do) so the proposal's
            // balance whispers and affordability checks are accurate.
            if (state.pot > 0) {
                winner.balance += state.pot;
                state.pot = 0;
            }
            state.spendingBalance = winner.balance;
        }

        state.awaitingDecision = null;
        this.startEndGameProposal(sender);
    }

    // Ends the match, crediting the calling player's unbanked pot, announcing
    // the final scores, and resetting to idle.
    private finishMatch(sender: number): void {
        const state = this.state;
        if (!state.players) return;

        const winner = state.players.find(p => p.memberNumber === sender)!;
        if (state.pot > 0) {
            winner.balance += state.pot;
            state.pot = 0;
        }

        const [p1, p2] = state.players;
        let resultMsg: string;
        let finalWinnerMemberNumber: number | null = null;
        if (p1.balance === p2.balance) {
            resultMsg = "It's a tie!";
        } else {
            const finalWinner = p1.balance > p2.balance ? p1 : p2;
            finalWinnerMemberNumber = finalWinner.memberNumber;
            resultMsg = `${finalWinner.name} wins WinnersDice!`;
        }

        this.bot.sendChat(
            `${winner.name} ends the match! Final scores — ${p1.name}: ${p1.balance}, ${p2.name}: ${p2.balance}. ${resultMsg}`
        );

        if (this.activeHandoff) {
            // Room bot: report via the handoff queue instead of touching
            // players.json/pair_balances.json directly (lobby-bot-owned).
            const loser = finalWinnerMemberNumber === null ? null : (finalWinnerMemberNumber === p1.memberNumber ? p2.memberNumber : p1.memberNumber);
            this.writeRoomBotResult(this.activeHandoff, "normal", finalWinnerMemberNumber, loser, 0, 0);
            // Don't reset the room yet — hold it until the winner confirms
            // they're done, so it isn't yanked out from under players still in
            // it. activeHandoff stays set here, which keeps pollForHandoff from
            // claiming a new match during the wait. Auto-resets on timeout.
            this.beginRoomResetConfirm(winner.memberNumber);
        } else {
            this.recordGameCompletion(finalWinnerMemberNumber, [p1, p2]);
            this.savePairCarryover(p1, p2);
        }

        this.clearPendingWardrobeChecks();
        this.clearWardrobeHelperState();
        this.releaseAllActiveLocks();
        this.releaseBondageFor(winner.memberNumber);
        // Session's over — fully free the loser too: everything's just been
        // unlocked above, so remove all their remaining bondage. Only when
        // they're still in the room for the bot to act on; a "move" session's
        // players have already left (the winner frees them out there).
        const loserPlayer = state.players.find(p => p.memberNumber !== winner.memberNumber);
        if (loserPlayer && this.roomMembers.has(loserPlayer.memberNumber)) {
            this.releaseBondageFor(loserPlayer.memberNumber);
        }
        this.releaseActiveToy();
        this.state = this.createIdleState();

        this.checkPendingUpdate();
    }

    // ============================================================
    // MERCY / CONCESSION
    // ============================================================
    //
    // Either player can whisper !mercy (or just "mercy") once minRounds is
    // reached to offer to end the game early: they forfeit 50% of their
    // points and owe the other player a service of their choosing. The
    // other player ("winner" below, i.e. whoever mercy is being requested
    // from) can reject (the requester gets a one-round cooldown) or accept
    // and negotiate the service's duration through a single counter-offer.
    // ============================================================

    private handleMercyCommand(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;
        if (!state.players.some(p => p.memberNumber === sender)) return;
        if (this.blockedByWardrobe(sender)) return;

        if (state.mercyRequest) {
            this.bot.whisper(sender, "A mercy request is already in progress.");
            return;
        }

        if (state.endGameProposal || state.activeEndGame ||
            state.clothingDeal || state.bondageDeal || state.lockDeal || state.toyDeal) {
            this.bot.whisper(sender, "Can't request mercy while another negotiation is in progress.");
            return;
        }

        const cooldownRound = state.mercyCooldowns.get(sender);
        if (cooldownRound !== undefined && state.currentRound < cooldownRound) {
            this.bot.whisper(sender, "Your last mercy request was rejected — you can't ask again until next round.");
            return;
        }

        if (state.currentRound < state.config.minRounds) {
            this.bot.whisper(sender, `Mercy isn't available until the minimum of ${state.config.minRounds} rounds is complete.`);
            return;
        }

        state.mercyRequest = {
            requesterId: sender,
            stage: "awaiting_details",
            serviceText: null,
            winnerDuration: null,
            concederCounter: null,
        };

        this.bot.whisper(sender,
            "⚠️ **Mercy request** — You're asking to end the game early. If accepted, you'll forfeit **50% of your current points** " +
            "and owe your opponent a service or punishment of their choosing. This is the fastest way to exit a game if you have a " +
            "reason to stop without calling safeword. To proceed, whisper me your reason for ending and what you're offering as a " +
            "service. If you've changed your mind, whisper **cancel** to withdraw the request."
        );
    }

    // Dispatches a message to the in-progress mercy request. Returns true if
    // the message was consumed — only intercepts messages from whichever
    // player is relevant to the current stage; anything else falls through
    // to the normal conversational handling.
    private handleMercyMessage(sender: number, raw: string, lower: string): boolean {
        const req = this.state.mercyRequest;
        if (!req || !this.state.players) return false;

        const conceder = this.state.players.find(p => p.memberNumber === req.requesterId)!;
        const winner = this.state.players.find(p => p.memberNumber !== req.requesterId)!;

        if (sender === conceder.memberNumber && lower.trim() === "cancel"
            && (req.stage === "awaiting_details" || req.stage === "awaiting_winner_response")) {
            this.state.mercyRequest = null;
            this.bot.whisper(conceder.memberNumber, "Mercy request withdrawn.");
            if (req.stage === "awaiting_winner_response") {
                this.bot.whisper(winner.memberNumber, `${conceder.name} withdrew their mercy request.`);
            }
            return true;
        }

        switch (req.stage) {
            case "awaiting_details": {
                if (sender !== conceder.memberNumber) return false;
                const text = raw.trim();
                if (!text) return true;

                req.serviceText = text;
                req.stage = "awaiting_winner_response";
                this.bot.whisper(winner.memberNumber,
                    `🏳️ **${conceder.name} is requesting mercy** and wants to end the game early. They've offered: "${text}" ` +
                    `If you accept, they lose 50% of their points and you bank everything. You'll then name a duration for the ` +
                    `service. Please keep it reasonable — this is someone choosing accountability over safeword. Reply **accept** ` +
                    `or **reject**.`
                );
                return true;
            }

            case "awaiting_winner_response": {
                if (sender !== winner.memberNumber) return false;
                const trimmed = lower.trim();

                if (trimmed === "accept" || trimmed === "yes" || trimmed === "y") {
                    req.stage = "awaiting_duration";
                    this.bot.whisper(winner.memberNumber, `Name a duration for the service (e.g. '30 minutes', '1 hour').`);
                    return true;
                }
                if (trimmed === "reject" || trimmed === "no" || trimmed === "n" || trimmed === "decline") {
                    this.state.mercyCooldowns.set(conceder.memberNumber, this.state.currentRound + 1);
                    this.state.mercyRequest = null;
                    this.bot.whisper(conceder.memberNumber,
                        `${winner.name} rejected your mercy request. The game continues — you can ask again next round.`);
                    this.bot.whisper(winner.memberNumber, `You rejected ${conceder.name}'s mercy request. The game continues.`);
                    return true;
                }
                this.bot.whisper(winner.memberNumber, `Please reply **accept** or **reject**.`);
                return true;
            }

            case "awaiting_duration": {
                if (sender !== winner.memberNumber) return false;
                const text = raw.trim();
                if (!text) return true;

                req.winnerDuration = text;
                req.stage = "awaiting_conceder_response";
                this.bot.whisper(conceder.memberNumber,
                    `${winner.name} proposes a duration of **${text}** for your service. You may **accept** or make a ` +
                    `**counter** offer once. If your counter is rejected, the original time stands.`
                );
                return true;
            }

            case "awaiting_conceder_response": {
                if (sender !== conceder.memberNumber) return false;
                const trimmed = lower.trim();

                if (trimmed === "accept" || trimmed === "yes" || trimmed === "y") {
                    this.resolveMercy(req, req.winnerDuration!);
                    return true;
                }

                const counterMatch = trimmed.match(/^counter(?:\s+(.+))?$/);
                if (counterMatch) {
                    const valueText = raw.trim().replace(/^counter\s*/i, "").trim();
                    if (!valueText) {
                        this.bot.whisper(conceder.memberNumber, `What duration would you like to counter with?`);
                        return true;
                    }
                    req.concederCounter = valueText;
                    req.stage = "awaiting_winner_counter_response";
                    this.bot.whisper(winner.memberNumber,
                        `${conceder.name} counters with a duration of **${valueText}**. Reply **accept** or **reject** — ` +
                        `if rejected, the original time of ${req.winnerDuration} stands.`
                    );
                    return true;
                }

                this.bot.whisper(conceder.memberNumber, `Please reply **accept** or **counter <duration>**.`);
                return true;
            }

            case "awaiting_winner_counter_response": {
                if (sender !== winner.memberNumber) return false;
                const trimmed = lower.trim();

                if (trimmed === "accept" || trimmed === "yes" || trimmed === "y") {
                    this.resolveMercy(req, req.concederCounter!);
                    return true;
                }
                if (trimmed === "reject" || trimmed === "no" || trimmed === "n" || trimmed === "decline") {
                    this.resolveMercy(req, req.winnerDuration!);
                    return true;
                }
                this.bot.whisper(winner.memberNumber, `Please reply **accept** or **reject**.`);
                return true;
            }
        }

        return false;
    }

    // Settles an accepted mercy request: the conceder forfeits 50% of their
    // current points (rounded down) to the winner, who also banks any
    // unclaimed pot as part of the concession, then the match ends — same
    // teardown as a normal bank/end (finishMatch).
    private resolveMercy(req: MercyRequest, finalDuration: string): void {
        const state = this.state;
        if (!state.players) return;

        const conceder = state.players.find(p => p.memberNumber === req.requesterId)!;
        const winner = state.players.find(p => p.memberNumber !== req.requesterId)!;

        // Commit any balance still sitting in an active spend session before
        // computing the forfeiture, so nothing already spent is double-counted.
        if (state.awaitingPostBank === conceder.memberNumber) conceder.balance = state.spendingBalance;
        if (state.awaitingPostBank === winner.memberNumber) winner.balance = state.spendingBalance;

        let banked = 0;
        if (state.pot > 0) {
            banked += state.pot;
            state.pot = 0;
        }

        const forfeited = Math.floor(conceder.balance * 0.5);
        conceder.balance -= forfeited;
        winner.balance += forfeited + banked;
        const totalBanked = forfeited + banked;

        this.bot.sendChat(
            `🏳️ ${conceder.name} conceded the game. ${winner.name} banks ${totalBanked} points. ` +
            `${conceder.name} owes: "${req.serviceText}" for ${finalDuration}.`
        );

        this.state.mercyRequest = null;

        if (this.activeHandoff) {
            this.writeRoomBotResult(this.activeHandoff, "mercy", winner.memberNumber, conceder.memberNumber, 0, 0);
            this.resetRoomBotForNextMatch();
        } else {
            this.recordGameCompletion(winner.memberNumber, state.players);
            this.savePairCarryover(conceder, winner);
        }

        this.clearPendingWardrobeChecks();
        this.clearWardrobeHelperState();
        this.clearEndGameState();
        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();
        this.clearServiceDeal();
        this.state = this.createIdleState();

        this.checkPendingUpdate();
    }

    // ============================================================
    // END GAME — WINNER PROPOSAL, NEGOTIATION & EXECUTION
    // ============================================================
    //
    // Triggered by handleEndgame() once minRounds is reached: the winner
    // answers 5 questions (Q1-Q5), the full proposal is delivered to the
    // loser, and then up to 5 negotiation steps play out (mirroring the
    // turn order of the shared bondage/lock/toy price negotiation, but with
    // bespoke cost math: the loser's cost is originalMinutes - agreedMinutes,
    // deducted from their raw balance since they're not in a bank session).
    // Reworked 2026-07-17 — DW's design: Q1 is the winner's real target
    // (originalMinutes); the loser spends to cut currentMinutes down
    // (unlimited first move, down to 0 if they want; every round after that,
    // both the loser's cuts and the winner's raises must move by at least
    // 10% of originalMinutes each time — no tiny nibbles). The winner can
    // spend to raise it back but never past 90% of originalMinutes. Ends
    // either in EXECUTION (timer + password lock, plus any requested extra
    // lock slots) or a BLOCK (winner explicitly declines — both sides lose
    // whatever the current numbers implied, game continues). Cutting to 0 is
    // no longer an automatic block — it's just a normal value that goes back
    // to the winner to respond to.
    // ============================================================

    private isEndGameProposalQuestionStage(stage: EndGameProposal["proposalStage"]): boolean {
        return stage === "q1_time" || stage === "q2_location" || stage === "q3_privacy"
            || stage === "q4_locks" || stage === "q5_description";
    }

    private endGameBalanceLine(forMemberNumber: number): string {
        const state = this.state;
        const me = state.players!.find(p => p.memberNumber === forMemberNumber)!;
        const other = state.players!.find(p => p.memberNumber !== forMemberNumber)!;
        return `Your balance: ${me.balance} pts | ${other.name}'s balance: ${other.balance} pts`;
    }

    // The winner's absolute ceiling once the loser has cut the time — they
    // can spend to raise it back, but never past 90% of their original ask,
    // no matter how many rounds happen.
    private endGameWinnerCeiling(originalMinutes: number): number {
        return Math.floor(originalMinutes * 0.9);
    }

    // Minimum move size for every round EXCEPT the loser's first move (which
    // stays fully free — any amount, including straight to 0). Both the
    // loser's second cut and every winner raise must close by at least this
    // much — a flat 10% of the original ask, not of wherever the number
    // currently sits — so nobody can trickle by 1 minute a round. Corrected
    // 2026-07-17: this was originally built as a MAXIMUM on the loser's
    // second move, which was backwards — DW wants a minimum, mirroring the
    // pre-rework gap-close rule, on both sides' later rounds.
    private endGameMinimumMove(originalMinutes: number): number {
        return Math.round(originalMinutes * 0.10);
    }

    // Points cost multiplier for each negotiation step. Step 1 (loser's
    // first counter) is 1×; step 2 (winner's raise) is 3×; steps 3 and 4
    // (loser's second counter, winner's final raise) are 5×. Points are
    // deducted immediately when each move is made, not at settlement.
    private endGameMultiplier(negotiationStep: number): number {
        if (negotiationStep === 1) return 1;
        if (negotiationStep === 2) return 3;
        return 5;
    }

    private startEndGameProposal(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        const winner = state.players.find(p => p.memberNumber === sender)!;
        const loser = state.players.find(p => p.memberNumber !== sender)!;

        state.awaitingPostBank = null;
        state.spendMenuOpen = false;
        this.endGameAwaitingLockSlotsInput = false;

        state.endGameProposal = {
            winnerMemberNumber: winner.memberNumber,
            loserMemberNumber: loser.memberNumber,
            proposalStage: "q1_time",
            proposedMinutes: 0,
            location: null,
            privacy: null,
            inRoom: false,
            requestedLockSlots: [],
            description: "",
            negotiationStep: 0,
            originalMinutes: 0,
            currentMinutes: 0,
            winnerPointsCommitted: 0,
            loserPointsCommitted: 0,
        };

        // Announce to the room that the end-game menu is open. Previously the
        // only sign the other player had was the balance whisper below, which
        // was easy to miss — DW wants an explicit heads-up that a reward is
        // being set up.
        this.bot.sendChat(`⚔️ ${winner.name} is setting up an end-game offer for ${loser.name}...`);

        this.bot.whisper(winner.memberNumber, this.endGameBalanceLine(winner.memberNumber));
        this.bot.whisper(loser.memberNumber, this.endGameBalanceLine(loser.memberNumber));

        this.bot.whisper(winner.memberNumber,
            `⚔️ End game initiated.\n` +
            `Q1 of 5 — How many minutes do you want with ${loser.name}?\n` +
            `Your balance: ${state.spendingBalance} pts. The bid is spent immediately (1 pt = 1 min). ` +
            `They can counter to cut it (escalating cost each round). Type a number.`
        );
    }

    private handleEndGameProposalCancel(sender: number): void {
        const proposal = this.state.endGameProposal;
        if (!proposal) return;

        const preDelivery = proposal.proposalStage !== "negotiating" && proposal.proposalStage !== "executing";
        let cancelMsg = "End game proposal cancelled.";

        if (preDelivery && proposal.winnerPointsCommitted > 0) {
            // Refund the Q1 bid — proposal was never delivered to the loser.
            this.state.spendingBalance += proposal.winnerPointsCommitted;
            cancelMsg = `End game proposal cancelled. ${proposal.winnerPointsCommitted} pts refunded (balance: ${this.state.spendingBalance} pts).`;
        }

        this.state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;
        this.bot.whisper(sender, cancelMsg);
        this.state.awaitingPostBank = sender;
        this.bot.whisper(sender, this.postBankPromptText(sender));
    }

    // Dispatches a message to the in-progress end game proposal/negotiation.
    // Returns true if the message was consumed.
    private handleEndGameMessage(sender: number, raw: string, lower: string): boolean {
        const proposal = this.state.endGameProposal;
        if (!proposal) return false;

        if (proposal.proposalStage === "negotiating") {
            return this.handleEndGameNegotiation(proposal, sender, raw, lower);
        }
        if (proposal.proposalStage === "awaiting_loser_move_consent") {
            if (sender !== proposal.loserMemberNumber) return false;
            if (lower === "yes" || lower === "y") { this.handleLoserMoveConsent(sender, true); return true; }
            if (lower === "no" || lower === "n") { this.handleLoserMoveConsent(sender, false); return true; }
            this.bot.whisper(sender, `Reply "yes" to go with them, or "no" to keep the session in this room.`);
            return true;
        }
        if (proposal.proposalStage === "executing") return false;

        // Q1-Q5 only ever take input from the winner.
        if (sender !== proposal.winnerMemberNumber) return false;

        switch (proposal.proposalStage) {
            case "q1_time": return this.handleEndGameQ1(proposal, raw);
            case "q2_location": return this.handleEndGameQ2(proposal, lower);
            case "q3_privacy": return this.handleEndGameQ3(proposal, lower);
            case "q4_locks": return this.handleEndGameQ4(proposal, raw, lower);
            case "q5_description": return this.handleEndGameQ5(proposal, raw);
        }
        return false;
    }

    private handleEndGameQ1(proposal: EndGameProposal, raw: string): boolean {
        const state = this.state;
        const n = extractNumber(raw);
        if (n === null || n <= 0 || n > state.spendingBalance) {
            this.bot.whisper(proposal.winnerMemberNumber,
                `That's not a valid number, or you don't have enough points. You have ${state.spendingBalance} pts — type a number between 1 and ${state.spendingBalance}.`);
            return true;
        }

        proposal.proposedMinutes = n;
        proposal.originalMinutes = n;
        proposal.currentMinutes = n;
        proposal.negotiationStep = 1;
        proposal.proposalStage = "q2_location";

        // Deduct the Q1 bid immediately (1× rate).
        state.spendingBalance -= n;
        proposal.winnerPointsCommitted = n;

        this.bot.whisper(proposal.winnerMemberNumber,
            `✅ ${n} min — ${n} pts spent now. Balance: ${state.spendingBalance} pts.\n\n` +
            `Q2 of 5 — Where do you want to take this?\n1. Stay in this room\n2. Move to a different room`
        );
        return true;
    }

    private handleEndGameQ2(proposal: EndGameProposal, lower: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "1" || trimmed === "stay") {
            proposal.location = "stay";
            proposal.inRoom = true;
            proposal.proposalStage = "q3_privacy";
            this.bot.whisper(proposal.winnerMemberNumber,
                `Q3 of 5 — How do you want to set the room?\n1. Public — open for others to watch or join\n2. Private — just the two of you`);
            return true;
        }
        if (trimmed === "2" || trimmed === "move") {
            proposal.location = "move";
            proposal.inRoom = false;
            this.advanceToEndGameQ4(proposal);
            return true;
        }
        this.bot.whisper(proposal.winnerMemberNumber, `Please reply 1 (stay) or 2 (move).`);
        return true;
    }

    private handleEndGameQ3(proposal: EndGameProposal, lower: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "1" || trimmed === "public") {
            proposal.privacy = "public";
        } else if (trimmed === "2" || trimmed === "private") {
            proposal.privacy = "private";
        } else {
            this.bot.whisper(proposal.winnerMemberNumber, `Please reply 1 (public) or 2 (private).`);
            return true;
        }
        this.advanceToEndGameQ4(proposal);
        return true;
    }

    private advanceToEndGameQ4(proposal: EndGameProposal): void {
        proposal.proposalStage = "q4_locks";
        this.bot.whisper(proposal.winnerMemberNumber,
            `Q4 of 5 — Do you want to place locks on ${this.playerName(proposal.loserMemberNumber)}? (yes / no)`);
    }

    private handleEndGameQ4(proposal: EndGameProposal, raw: string, lower: string): boolean {
        if (this.endGameAwaitingLockSlotsInput) {
            return this.handleEndGameLockSlotsInput(proposal, raw);
        }

        const trimmed = lower.trim();
        if (trimmed === "no" || trimmed === "none") {
            proposal.requestedLockSlots = [];
            this.advanceToEndGameQ5(proposal);
            return true;
        }
        if (trimmed === "yes") {
            this.endGameAwaitingLockSlotsInput = true;
            this.bot.whisper(proposal.winnerMemberNumber,
                `Which slots? Valid: ${END_GAME_LOCK_SLOTS.join(", ")}\n` +
                `Reply with a comma-separated list, or "all" for all of them.`);
            return true;
        }
        this.bot.whisper(proposal.winnerMemberNumber,
            `Do you want to place locks on ${this.playerName(proposal.loserMemberNumber)}? (yes / no)`);
        return true;
    }

    private handleEndGameLockSlotsInput(proposal: EndGameProposal, raw: string): boolean {
        const trimmed = raw.trim().toLowerCase();

        if (trimmed === "all") {
            proposal.requestedLockSlots = [...END_GAME_LOCK_SLOTS];
        } else {
            const tokens = trimmed.split(",").map(t => t.trim()).filter(Boolean);
            const matched: string[] = [];
            const unmatched: string[] = [];
            for (const token of tokens) {
                const norm = token.replace(/[^a-z0-9]/g, "");
                const slot = END_GAME_LOCK_SLOTS.find(s => s.toLowerCase() === norm || s.toLowerCase() === `item${norm}`);
                if (slot) matched.push(slot); else unmatched.push(token);
            }
            if (matched.length === 0) {
                this.bot.whisper(proposal.winnerMemberNumber,
                    `I didn't recognize any of those slots. Valid: ${END_GAME_LOCK_SLOTS.join(", ")} (or "all").`);
                return true;
            }
            proposal.requestedLockSlots = [...new Set(matched)];
            if (unmatched.length > 0) {
                this.bot.whisper(proposal.winnerMemberNumber, `(Ignored unrecognized: ${unmatched.join(", ")})`);
            }
        }

        this.endGameAwaitingLockSlotsInput = false;
        this.advanceToEndGameQ5(proposal);
        return true;
    }

    private advanceToEndGameQ5(proposal: EndGameProposal): void {
        proposal.proposalStage = "q5_description";
        this.bot.whisper(proposal.winnerMemberNumber,
            `Q5 of 5 — Describe what you have in mind for ${this.playerName(proposal.loserMemberNumber)}. They will see this. (Type freely — when done, send it)`);
    }

    private handleEndGameQ5(proposal: EndGameProposal, raw: string): boolean {
        const trimmed = raw.trim();
        if (!trimmed) {
            this.bot.whisper(proposal.winnerMemberNumber, `Please describe what you have in mind.`);
            return true;
        }

        proposal.description = trimmed;
        proposal.proposalStage = "negotiating";
        this.deliverEndGameProposalToLoser(proposal);
        return true;
    }

    private deliverEndGameProposalToLoser(proposal: EndGameProposal): void {
        const state = this.state;
        const winner = state.players!.find(p => p.memberNumber === proposal.winnerMemberNumber)!;
        const loser = state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        const locationText = proposal.location === "move"
            ? "Moving to a different room"
            : `Staying in this room (${proposal.privacy})`;
        const locksText = proposal.requestedLockSlots.length > 0 ? proposal.requestedLockSlots.join(", ") : "none";

        this.sendLongWhisper(loser.memberNumber,
            `⚔️ ${winner.name} claims end game:\n` +
            `${proposal.proposedMinutes} min | ${locationText} | Locks: ${locksText}\n` +
            `"${proposal.description}"\n` +
            `──────────────────────\n` +
            `Your balance: ${loser.balance} pts | ${winner.name} spent ${proposal.winnerPointsCommitted} pts to make this ask.\n\n` +
            `Countering costs points at an escalating rate — 1× now, 3× if it comes back to you, 5× after that. All spent points are burned regardless of outcome.\n\n` +
            `"yes" — accept as-is\n` +
            `"counter 15" — cut it by 15 min (1 pt per min this round)\n` +
            `"block" — hard reject (costs ${proposal.originalMinutes * 2} pts — both sides lose everything spent)`
        );

        // Parallel whisper to the winner: remind them of their ask and remaining balance.
        this.bot.whisper(winner.memberNumber,
            `⚔️ Proposal sent to ${loser.name}. Waiting for their response.\n` +
            `Your ask: ${proposal.originalMinutes} min (${proposal.winnerPointsCommitted} pts spent). Balance: ${state.spendingBalance} pts.\n` +
            `If they counter, you can raise it back at 3× cost (max ${this.endGameWinnerCeiling(proposal.originalMinutes)} min — 90% of your ask). They can also block outright.`
        );

        if (proposal.location === "stay" && proposal.privacy === "public") {
            this.bot.sendChat(`⚔️ ${winner.name} has proposed an end game with ${loser.name}. Terms are being negotiated...`);
        }
    }

    // Dispatches a negotiation-stage message to whichever side's turn it is.
    // Turn order mirrors the shared price negotiation: negotiationStep 1/3
    // are the loser's turn to respond, 2/4 are the winner's turn.
    private handleEndGameNegotiation(proposal: EndGameProposal, sender: number, raw: string, lower: string): boolean {
        const winner = this.playerName(proposal.winnerMemberNumber);
        const loser = this.playerName(proposal.loserMemberNumber);
        const isLoserTurn = proposal.negotiationStep === 1 || proposal.negotiationStep === 3;
        const isWinnerTurn = proposal.negotiationStep === 2 || proposal.negotiationStep === 4;

        if (sender === proposal.loserMemberNumber) {
            if (!isLoserTurn) {
                this.bot.whisper(sender, `Waiting on ${winner} — it's their turn.`);
                return true;
            }
            return this.handleEndGameLoserResponse(proposal, lower, raw);
        }

        if (sender === proposal.winnerMemberNumber) {
            if (!isWinnerTurn) {
                this.bot.whisper(sender, `Waiting on ${loser} — it's their turn.`);
                return true;
            }
            return this.handleEndGameWinnerResponse(proposal, lower, raw);
        }

        return false;
    }

    private handleEndGameLoserResponse(proposal: EndGameProposal, lower: string, raw: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "yes" || trimmed === "accept") {
            this.closeEndGameDeal(proposal, proposal.currentMinutes);
            return true;
        }

        // Full block — only available on the loser's first counter (step 1).
        // Costs 2× the winner's original ask flat (no round multiplier).
        if (trimmed === "block" && proposal.negotiationStep === 1) {
            const blockCost = proposal.originalMinutes * 2;
            const loser = this.state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;
            if (loser.balance < blockCost) {
                this.bot.whisper(proposal.loserMemberNumber,
                    `Full block costs ${blockCost} pts (2× the ${proposal.originalMinutes} min ask) — you only have ${loser.balance} pts. Counter or accept instead.`);
                return true;
            }
            this.loserBlockEndGame(proposal, blockCost);
            return true;
        }

        if (trimmed.startsWith("counter")) {
            const n = extractNumber(raw);
            if (n === null) {
                this.bot.whisper(proposal.loserMemberNumber, `How much do you want to lower it by? e.g. "counter 15" cuts 15 min off — not a new total.`);
                return true;
            }
            return this.applyEndGameLoserCounter(proposal, n);
        }

        const blockHint = proposal.negotiationStep === 1 ? `, "block" to reject outright (costs ${proposal.originalMinutes * 2} pts)` : "";
        this.bot.whisper(proposal.loserMemberNumber, `Reply "yes" to accept, "counter <amount>" to cut it further${blockHint}.`);
        return true;
    }

    // n here is the amount to cut OFF the current value, not a new target.
    // Points are deducted immediately at the current round's multiplier.
    // First move (step 1) is 1× and unlimited down to 0; second move
    // (step 3) is 5× and must cut at least 10% of originalMinutes.
    private applyEndGameLoserCounter(proposal: EndGameProposal, n: number): boolean {
        const loser = this.state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;
        const isFirstMove = proposal.negotiationStep === 1;
        const multiplier = this.endGameMultiplier(proposal.negotiationStep);

        if (n <= 0) {
            this.bot.whisper(loser.memberNumber, `Give a positive number — how many minutes do you want to cut it by?`);
            return true;
        }

        if (n > proposal.currentMinutes) {
            this.bot.whisper(loser.memberNumber, `You can cut it down to 0 at most — that's ${proposal.currentMinutes} min right now.`);
            return true;
        }

        if (!isFirstMove) {
            // Must close by at least 10% of the original ask — unless
            // there's less than that much room left before 0.
            const minimumMove = Math.min(this.endGameMinimumMove(proposal.originalMinutes), proposal.currentMinutes);
            if (n < minimumMove) {
                const winnerName = this.playerName(proposal.winnerMemberNumber);
                this.bot.whisper(loser.memberNumber,
                    `You need to cut at least ${minimumMove} min this round (10% of ${winnerName}'s original ${proposal.originalMinutes} min ask). At ${multiplier}× that's ${minimumMove * multiplier} pts.`);
                return true;
            }
        }

        const cost = n * multiplier;
        if (loser.balance < cost) {
            const maxAffordable = Math.floor(loser.balance / multiplier);
            if (maxAffordable <= 0 || (!isFirstMove && maxAffordable < this.endGameMinimumMove(proposal.originalMinutes))) {
                this.bot.whisper(loser.memberNumber,
                    `You can't afford to cut any minutes at ${multiplier}× rate — you only have ${loser.balance} pts.`);
                return true;
            }
            this.bot.whisper(loser.memberNumber,
                `Can't afford ${n} min at ${multiplier}× rate (costs ${cost} pts, you have ${loser.balance}). ` +
                `Max you can cut is ${maxAffordable} min (${maxAffordable * multiplier} pts). Reply "counter ${maxAffordable}" or give a smaller number.`);
            return true;
        }

        // Deduct immediately.
        loser.balance -= cost;
        proposal.loserPointsCommitted += cost;
        proposal.currentMinutes -= n;
        proposal.negotiationStep = isFirstMove ? 2 : 4;

        this.sendEndGameStateWhisper(proposal);
        return true;
    }

    private handleEndGameWinnerResponse(proposal: EndGameProposal, lower: string, raw: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "yes" || trimmed === "accept") {
            // Can't settle a 0-minute claim (the loser cut it all the way down).
            // Force a rebid: the winner must raise it back with "counter", or
            // "decline" to end the deal — accepting nothing isn't allowed.
            if (proposal.currentMinutes <= 0) {
                this.bot.whisper(proposal.winnerMemberNumber,
                    `You can't claim 0 minutes — put time back on with "counter <minutes>" to rebid, or "decline" to end the deal.`);
                return true;
            }
            this.closeEndGameDeal(proposal, proposal.currentMinutes);
            return true;
        }

        if (trimmed === "decline") {
            this.blockEndGame(proposal);
            return true;
        }

        if (trimmed.startsWith("counter")) {
            const n = extractNumber(raw);
            if (n === null) {
                this.bot.whisper(proposal.winnerMemberNumber, `How much do you want to raise it back by? e.g. "counter 10" adds 10 minutes back — not a new total.`);
                return true;
            }
            return this.applyEndGameWinnerCounter(proposal, n);
        }

        this.bot.whisper(proposal.winnerMemberNumber,
            `Reply "yes" to accept, "counter <amount to raise it by>" to spend points raising it back, or "decline" to block the deal outright.`);
        return true;
    }

    // n here is the amount to add BACK onto the current value, not a new
    // target. Points are deducted immediately at this round's multiplier
    // (3× for step 2, 5× for step 4). Capped at 90% of the original ask
    // and must close by at least endGameMinimumMove each round.
    private applyEndGameWinnerCounter(proposal: EndGameProposal, n: number): boolean {
        const state = this.state;
        const isFinal = proposal.negotiationStep === 4;
        const multiplier = this.endGameMultiplier(proposal.negotiationStep);

        if (n <= 0) {
            this.bot.whisper(proposal.winnerMemberNumber, `Give a positive number — how many minutes do you want to add back?`);
            return true;
        }

        const ceiling = this.endGameWinnerCeiling(proposal.originalMinutes);
        const roomToCeiling = Math.max(ceiling - proposal.currentMinutes, 0);
        if (roomToCeiling <= 0) {
            this.bot.whisper(proposal.winnerMemberNumber,
                `You're already at your ceiling — ${ceiling} min (90% of your original ${proposal.originalMinutes}) is the most you can ever recover.`);
            return true;
        }

        const minimumMove = Math.min(this.endGameMinimumMove(proposal.originalMinutes), roomToCeiling);
        if (n < minimumMove) {
            this.bot.whisper(proposal.winnerMemberNumber,
                `You need to raise it by at least ${minimumMove} min this round. At ${multiplier}× that's ${minimumMove * multiplier} pts.`);
            return true;
        }

        const newCurrent = proposal.currentMinutes + n;
        if (newCurrent > ceiling) {
            this.bot.whisper(proposal.winnerMemberNumber,
                `You can raise it by at most ${roomToCeiling} more min — ${ceiling} min (90% of your original ${proposal.originalMinutes}) is the most you can ever recover.`);
            return true;
        }

        const cost = n * multiplier;
        if (state.spendingBalance < cost) {
            const maxAffordable = Math.min(Math.floor(state.spendingBalance / multiplier), roomToCeiling);
            if (maxAffordable < minimumMove) {
                this.bot.whisper(proposal.winnerMemberNumber,
                    `You can't afford the minimum raise at ${multiplier}× rate — you only have ${state.spendingBalance} pts (min raise is ${minimumMove} min = ${minimumMove * multiplier} pts).`);
                return true;
            }
            this.bot.whisper(proposal.winnerMemberNumber,
                `Can't afford ${n} min at ${multiplier}× rate (costs ${cost} pts, you have ${state.spendingBalance}). ` +
                `Max you can raise is ${maxAffordable} min (${maxAffordable * multiplier} pts). Reply "counter ${maxAffordable}" or give a smaller number.`);
            return true;
        }

        // Deduct immediately.
        state.spendingBalance -= cost;
        proposal.winnerPointsCommitted += cost;
        proposal.currentMinutes = newCurrent;

        if (isFinal) {
            this.closeEndGameDeal(proposal, newCurrent);
            return true;
        }

        proposal.negotiationStep = 3;
        this.sendEndGameStateWhisper(proposal);
        return true;
    }

    private sendEndGameStateWhisper(proposal: EndGameProposal): void {
        const winner = this.playerName(proposal.winnerMemberNumber);
        const loser = this.playerName(proposal.loserMemberNumber);
        const isWinnerTurn = proposal.negotiationStep === 2 || proposal.negotiationStep === 4;
        const isFinal = proposal.negotiationStep === 4;
        const nextMultiplier = this.endGameMultiplier(proposal.negotiationStep);

        const acceptNote = proposal.currentMinutes <= 0
            ? `It's been cut to 0 — the winner can't claim 0, so it has to be rebid.`
            : `Accepting now costs nothing more.`;
        const text =
            `📊 ${proposal.currentMinutes} min on the table — ${winner} spent ${proposal.winnerPointsCommitted} pts, ${loser} spent ${proposal.loserPointsCommitted} pts. ${acceptNote}\n` +
            `${isWinnerTurn ? winner : loser}'s turn — step ${proposal.negotiationStep} of 5${isFinal ? " (final — binding)" : ` | next move costs ${nextMultiplier}× per minute`}.`;

        this.bot.whisper(proposal.winnerMemberNumber, text);
        this.bot.whisper(proposal.loserMemberNumber, text);

        // Role-specific instructions to whoever's turn it actually is.
        if (isWinnerTurn) {
            const ceiling = this.endGameWinnerCeiling(proposal.originalMinutes);
            const roomToCeiling = Math.max(ceiling - proposal.currentMinutes, 0);
            const minimumMove = Math.min(this.endGameMinimumMove(proposal.originalMinutes), roomToCeiling);
            if (proposal.currentMinutes <= 0) {
                // At 0, "accept" is disallowed (see handleEndGameWinnerResponse)
                // — the winner must rebid a time or drop the deal.
                this.bot.whisper(proposal.winnerMemberNumber,
                    `It's been cut to 0 — you can't claim 0 minutes. "counter <amount>" to put time back on (${nextMultiplier}× rate, max ${roomToCeiling} min), or "decline" to end the deal (you lose what you've spent).`
                );
            } else {
                this.bot.whisper(proposal.winnerMemberNumber,
                    `"yes" to accept, "counter <amount>" to raise it (${nextMultiplier}× rate, min ${minimumMove} min = ${minimumMove * nextMultiplier} pts, max ${roomToCeiling} min), or "decline" to end the deal (you lose what you've spent).`
                );
            }
        } else {
            const minimumMove = Math.min(this.endGameMinimumMove(proposal.originalMinutes), proposal.currentMinutes);
            this.bot.whisper(proposal.loserMemberNumber,
                `"yes" to accept, or "counter <amount>" to cut it further (${nextMultiplier}× rate, min ${minimumMove} min = ${minimumMove * nextMultiplier} pts).`
            );
        }
    }

    // Loser typed "block" on their first counter — spends 2× the original
    // ask to hard-reject the end game. All committed points are burned.
    // Winner is locked out of !endgame until they play a roll and bank.
    private loserBlockEndGame(proposal: EndGameProposal, blockCost: number): void {
        const state = this.state;
        const winner = state.players!.find(p => p.memberNumber === proposal.winnerMemberNumber)!;
        const loser = state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        loser.balance -= blockCost;
        proposal.loserPointsCommitted += blockCost;

        // Sync winner's balance from spendingBalance (Q1 already deducted).
        winner.balance = state.spendingBalance;

        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;
        state.endGameBlockedFor = proposal.winnerMemberNumber;
        state.endGameBlockRollDone = false;

        this.bot.sendChat(`⛔ ${loser.name} blocked the end game! All committed points are burned.`);
        this.bot.whisper(proposal.winnerMemberNumber,
            `End game blocked by ${loser.name} — you lost ${proposal.winnerPointsCommitted} pts. ` +
            `You can still use the spend menu, but end game is locked until you play at least one roll and bank.`);
        this.bot.whisper(proposal.loserMemberNumber,
            `You blocked the end game — cost you ${blockCost} pts. ${winner.name} lost ${proposal.winnerPointsCommitted} pts.`);

        state.awaitingPostBank = proposal.winnerMemberNumber;
        this.bot.whisper(proposal.winnerMemberNumber, this.postBankPromptText(proposal.winnerMemberNumber));
    }

    // The winner declined the deal outright. All committed points are burned
    // on both sides — no refunds. Winner is locked out of !endgame until
    // they play a roll and bank. Match resumes.
    private blockEndGame(proposal: EndGameProposal): void {
        const state = this.state;
        const winner = state.players!.find(p => p.memberNumber === proposal.winnerMemberNumber)!;
        const loser = state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        // Points already deducted live — sync winner's balance and set block.
        winner.balance = state.spendingBalance;
        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;
        state.endGameBlockedFor = proposal.winnerMemberNumber;
        state.endGameBlockRollDone = false;

        this.bot.sendChat("The end game was declined. The game continues.");
        this.bot.whisper(winner.memberNumber,
            `You declined — you lost ${proposal.winnerPointsCommitted} pts. ` +
            `You can still shop, but end game is locked until you play at least one more roll and bank.`);
        this.bot.whisper(loser.memberNumber,
            `${winner.name} declined — you lost ${proposal.loserPointsCommitted} pts. The match continues.`);

        state.awaitingPostBank = winner.memberNumber;
        this.bot.whisper(winner.memberNumber, this.postBankPromptText(winner.memberNumber));
    }

    private closeEndGameDeal(proposal: EndGameProposal, finalMinutes: number): void {
        // High-consent safeguard: a High-Security lock has no visible timer and
        // the bot can't reach the loser to auto-release once they leave the
        // room, so before letting the winner take them out we confirm the loser
        // is OK with it (or would rather keep the session in this room). Only
        // when both conditions hold; otherwise the deal closes as normal.
        if (this.matchUsesHighSecurityLock && proposal.location === "move") {
            proposal.currentMinutes = finalMinutes; // stash the agreed value
            proposal.proposalStage = "awaiting_loser_move_consent";
            this.bot.whisper(proposal.loserMemberNumber,
                `⚠️ This match uses a High-Security lock — there's no visible countdown, and once you leave this room I can't auto-release you, so you'd be trusting ${this.playerName(proposal.winnerMemberNumber)} to unlock you. ` +
                `Reply "yes" if you're OK going with them, or "no" to keep the session in this room so I release you when the ${finalMinutes}-minute timer is up.`
            );
            return;
        }
        proposal.proposalStage = "executing";
        this.executeEndGame(proposal, finalMinutes);
    }

    // The loser's answer to the High-Security move-out consent (see
    // closeEndGameDeal). "yes" proceeds with the move; "no" keeps the session
    // in this room (location→stay, inRoom→true) so the bot auto-releases.
    private handleLoserMoveConsent(sender: number, value: boolean): void {
        const proposal = this.state.endGameProposal;
        if (!proposal || proposal.proposalStage !== "awaiting_loser_move_consent") return;
        if (sender !== proposal.loserMemberNumber) return;

        if (!value) {
            proposal.location = "stay";
            proposal.inRoom = true;
            this.bot.sendChat(`${this.playerName(sender)} would rather stay put — the session will run here in this room.`);
        }
        proposal.proposalStage = "executing";
        this.executeEndGame(proposal, proposal.currentMinutes);
    }

    // Property for the timer/password lock applied to the loser's leash slot
    // on execution — combines BC's TimerPasswordPadlock behavior (a password
    // the winner controls, plus an automatic unlock at RemoveTimer) with the
    // bot's own setTimeout-driven expireEndGame() as the authoritative timer.
    private buildTimerPasswordLockProperty(password: string, minutes: number): any {
        return {
            Effect: ["Lock"],
            Difficulty: 20,
            LockedBy: "TimerPasswordPadlock",
            LockMemberNumber: this.bot.getMemberNumber(),
            LockMemberName: secrets.username,
            LockSet: true,
            Password: password,
            RemoveItem: false,
            RemoveTimer: Date.now() + minutes * 60 * 1000,
            ShowTimer: true,
            EnableRandomInput: false,
            MemberNumberList: [],
        };
    }

    // Alternative end-game lock for a match flagged useHighSecurityLock (a
    // player had TimerPasswordPadlock blocked — see the lock-block resolve
    // gate). A HighSecurityPadlock can't be self-removed and has no built-in
    // timer, so the winner is added to MemberNumberListKeys (they can release
    // the loser any time) and the bot's own setTimeout still auto-removes it at
    // the agreed time — matching how the winner's password works in the normal
    // case. The bot (locker) is included in the key list too.
    private buildHighSecurityLockProperty(winnerMemberNumber: number): any {
        const bot = this.bot.getMemberNumber();
        return {
            Effect: ["Lock"],
            Difficulty: 20,
            LockedBy: "HighSecurityPadlock",
            LockMemberNumber: bot,
            LockMemberName: secrets.username,
            LockSet: true,
            RemoveItem: false,
            MemberNumberListKeys: `${bot},${winnerMemberNumber}`,
        };
    }

    // Settles the agreed end game: deducts both sides' committed points and
    // burns them — by design, points spent settling an end-game deal are
    // gone for good, credited to neither player (unlike the match's leftover
    // balance at teardown, which carries over per pair — see
    // savePairCarryover). Strips the winner's own accumulated bondage (see
    // releaseWinnerBondage), announces the terms per location/privacy, and
    // applies the loser's locks (leash + any requested extra slots) for
    // exactly the negotiated finalMinutes — the same number that set the
    // points cost is also the real lock duration (see applyEndGameLocks).
    private executeEndGame(proposal: EndGameProposal, finalMinutes: number): void {
        const state = this.state;
        if (!state.players) return;

        const winner = state.players.find(p => p.memberNumber === proposal.winnerMemberNumber)!;
        const loser = state.players.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        // Points were deducted live during negotiation — use committed totals.
        const winnerCost = proposal.winnerPointsCommitted;
        const loserCost = proposal.loserPointsCommitted;

        // Sync winner's balance from spendingBalance (already deducted).
        winner.balance = state.spendingBalance;
        // loser.balance already updated during negotiation.

        log(`End game settled: ${winner.name} spent ${winnerCost} pts, ${loser.name} spent ${loserCost} pts — burned by design, credited to neither player.`);

        // Terms are agreed — the winner shouldn't still be wearing whatever
        // bondage they picked up earlier in the match. Unlock any of the
        // winner's locked items first (the loser may have paid to lock them),
        // otherwise removeItem can't take a locked item off.
        this.releaseLocksFor(winner.memberNumber);
        this.releaseBondageFor(winner.memberNumber);

        // Release any exclusive locks on the loser's items too. applyEndGameLocks
        // will re-apply them with a timer password lock, but BC silently rejects
        // applyItem on a locked item — so we have to clear the locks first.
        // We delay applyEndGameLocks by 3 seconds to give BC time to process
        // the unlock events and update the loser's appearance before we try to
        // re-lock. Without the delay, roomCharacters still shows the old locked
        // state and the timer password lock application silently fails.
        this.releaseLocksFor(loser.memberNumber);

        const pointsSpentNote = `(${winner.name} spent ${proposal.winnerPointsCommitted} pts [${winner.balance} left], ${loser.name} spent ${proposal.loserPointsCommitted} pts [${loser.balance} left] settling the deal)`;
        if (proposal.location === "move") {
            this.bot.sendChat(`⚔️ End game terms agreed! ${winner.name} and ${loser.name} — consider moving to a private room for this session. ${pointsSpentNote}`);
        } else if (proposal.privacy === "public") {
            this.bot.sendChat(`⚔️ End game underway! ${winner.name} has claimed ${finalMinutes} minutes with ${loser.name}. The room is open for observers. ${pointsSpentNote}`);
        } else {
            this.bot.sendChat(`⚔️ End game underway between ${winner.name} and ${loser.name}. ${pointsSpentNote}`);
        }

        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;

        const winnerMemberNumber = winner.memberNumber;
        const loserMemberNumber = loser.memberNumber;
        const requestedLockSlots = proposal.requestedLockSlots;
        const inRoom = proposal.inRoom;
        setTimeout(() => {
            this.applyEndGameLocks(winnerMemberNumber, loserMemberNumber, winnerCost, loserCost, requestedLockSlots, finalMinutes, inRoom);
        }, 3000);
    }

    // Applies the timer/password lock to the loser's leash slot AND every
    // requested extra lock slot (that has something worn on it), all for
    // lockMinutes — the same negotiated time that set the points cost in
    // executeEndGame — and sharing the same password. Hands the winner that
    // password, and schedules expireEndGame() for when it's up.
    private applyEndGameLocks(
        winnerMemberNumber: number,
        loserMemberNumber: number,
        winnerPointsSpent: number,
        loserPointsSpent: number,
        requestedLockSlots: string[],
        lockMinutes: number,
        inRoom: boolean,
    ): void {
        const state = this.state;

        const useHighSec = this.matchUsesHighSecurityLock;
        const password = useHighSec ? null : END_GAME_LOCK_PASSWORD_WORDS[Math.floor(Math.random() * END_GAME_LOCK_PASSWORD_WORDS.length)];
        const lockProperty = useHighSec
            ? this.buildHighSecurityLockProperty(winnerMemberNumber)
            : this.buildTimerPasswordLockProperty(password!, lockMinutes);

        // A leash needs a locked collar to attach to (locked the same way as
        // everything else so it all releases together) — add one, or lock the
        // loser's existing collar so the leash can't be slipped off.
        const collar = this.ensureCollarForLeash(loserMemberNumber, lockProperty);

        this.bot.applyItem(loserMemberNumber, END_GAME_LEASH_GROUP, END_GAME_LEASH_ITEM, "Default", lockProperty);

        const appliedLockSlots: string[] = [];
        for (const group of requestedLockSlots) {
            const slotDisplay = PICK_SLOTS.find(s => s.group === group)?.display;
            const entry = slotDisplay
                ? state.activeBondage.find(b => b.wearerMemberNumber === loserMemberNumber && b.slot === slotDisplay)
                : undefined;
            if (!entry) continue; // nothing worn there — nothing to lock
            this.bot.applyItem(loserMemberNumber, group, entry.itemName, "Default", lockProperty);
            appliedLockSlots.push(group);
        }
        if (appliedLockSlots.length < requestedLockSlots.length) {
            const skipped = requestedLockSlots.filter(s => !appliedLockSlots.includes(s));
            this.bot.whisper(winnerMemberNumber, `Note: couldn't lock ${skipped.join(", ")} — nothing is worn there.`);
        }

        if (useHighSec) {
            this.bot.whisper(winnerMemberNumber,
                `🔑 High-Security lock on ${this.playerName(loserMemberNumber)}'s leash${appliedLockSlots.length > 0 ? " and locks" : ""} — you hold a key, so you can release them any time. If you don't, I'll auto-release when the ${lockMinutes}-minute timer runs out.`);
        } else {
            this.bot.whisper(winnerMemberNumber,
                `🔑 Lock password for ${this.playerName(loserMemberNumber)}'s leash${appliedLockSlots.length > 0 ? " and locks" : ""}: ${password} — this is only shown once.`);
        }

        const timer = setTimeout(() => this.expireEndGame(), lockMinutes * 60 * 1000);
        state.activeEndGame = {
            winnerMemberNumber,
            loserMemberNumber,
            agreedMinutes: lockMinutes,
            winnerPointsSpent,
            loserPointsSpent,
            timer,
            appliedLockSlots,
            inRoom,
            activeStartTime: Date.now(),
            collarAdded: collar.added,
            collarLockedExisting: collar.lockedExisting,
        };

        // If the session is happening in this room, let the winner know the bot
        // is standing by for lock removal at time's up — and that they can end
        // early at any time with !done.
        if (inRoom) {
            this.bot.whisper(winnerMemberNumber,
                `⏳ Standing by — I'll remove ${this.playerName(loserMemberNumber)}'s locks when the ${lockMinutes}-minute timer runs out.\n` +
                `If you're done early, type !done to end the session now.`
            );
        }
    }

    // Admin-only debug tool: applies the exact same timer/password lock as
    // the real end-game flow (buildTimerPasswordLockProperty), but directly
    // and instantly — no match, proposal, or negotiation needed. Targets the
    // sender by default, or "!testlock @name" for anyone else currently in
    // the room. Lets you watch wrapper.output's ChatRoomSyncItem echo to
    // confirm the password/duration actually saved, without playing a whole
    // match first. Doesn't touch state.activeEndGame — this is a throwaway
    // test lock, not a tracked one, so it won't auto-strip via expireEndGame;
    // remove it by hand (or wait out BC's own RemoveTimer) when you're done.
    private handleTestLock(sender: number, args: string): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        let targetMemberNumber = sender;
        const targetName = args.replace(/^@/, "").trim();
        if (targetName) {
            const matches = this.findPlayersByName(targetName, -1);
            if (matches.length === 0) {
                this.bot.whisper(sender, `No one named "${targetName}" found in the room.`);
                return;
            }
            if (matches.length > 1) {
                this.bot.whisper(sender, `Multiple people named "${targetName}" are in the room — be more specific.`);
                return;
            }
            targetMemberNumber = matches[0].memberNumber;
        }

        const targetDisplayName = this.roomMembers.get(targetMemberNumber)?.name ?? `Player #${targetMemberNumber}`;
        const password = END_GAME_LOCK_PASSWORD_WORDS[Math.floor(Math.random() * END_GAME_LOCK_PASSWORD_WORDS.length)];
        const testMinutes = 1;
        const lockProperty = this.buildTimerPasswordLockProperty(password, testMinutes);
        this.bot.applyItem(targetMemberNumber, END_GAME_LEASH_GROUP, END_GAME_LEASH_ITEM, "Default", lockProperty);

        this.bot.whisper(sender,
            `🔧 Test lock applied to ${targetDisplayName}: password "${password}", ${testMinutes} min. ` +
            `Check wrapper.output for the ChatRoomSyncItem confirming it actually saved.`
        );
    }

    // Allows the winner to end an active service deal or an in-room end game
    // early. For services, the winner is the buyer; for end games, the winner
    // is the match winner. If the loser types !done during a service, they get
    // a whisper explaining who can end it.
    private handleDone(sender: number): void {
        // Post-session: winner using !done to release the room for reset.
        if (this.pendingRoomReset && sender === this.pendingRoomReset.winnerMemberNumber) {
            this.finalizeRoomReset();
            return;
        }

        // Active service deal takes priority.
        const deal = this.state.serviceDeal;
        if (deal && deal.stage === "active") {
            this.handleServiceDone(sender);
            return;
        }

        const active = this.state.activeEndGame;
        if (!active) {
            this.bot.whisper(sender, `No active session right now.`);
            return;
        }
        if (sender !== active.winnerMemberNumber) {
            this.bot.whisper(sender, `Only ${this.playerName(active.winnerMemberNumber)} can end the session early.`);
            return;
        }
        if (!active.inRoom) {
            this.bot.whisper(sender, `!done is only available for in-room sessions.`);
            return;
        }
        clearTimeout(active.timer);
        this.bot.sendChat(`⚔️ ${this.playerName(active.winnerMemberNumber)} has declared the session complete early.`);
        this.expireEndGame();
    }

    // Shared logic for the winner (!done) declaring an active service complete.
    // Called from handleDone and from the "done" conversational path in
    // handleServiceDealMessage's "active" case.
    private handleServiceDone(sender: number): void {
        const deal = this.state.serviceDeal;
        if (!deal || deal.stage !== "active") return;
        if (sender !== deal.buyer) {
            this.bot.whisper(sender, `Only ${this.playerName(deal.buyer)} can end the service early.`);
            return;
        }
        if (deal.timerHandle) clearTimeout(deal.timerHandle);
        if (deal.warningHandle) clearTimeout(deal.warningHandle);
        this.bot.sendChat(`✅ ${this.playerName(deal.buyer)} has declared the service complete.`);
        this.state.serviceDeal = null;
        this.sendPostServiceMenu(deal.buyer);
    }

    // Handles !time (and conversational "time") for both the active service
    // deal and the active end game. Whispers the requesting player how many
    // minutes and seconds remain. Only fires if the sender is one of the two
    // players involved.
    private handleTime(sender: number): void {
        const deal = this.state.serviceDeal;
        if (deal && deal.stage === "active") {
            if (sender === deal.buyer || sender === deal.seller) {
                this.whisperServiceTimeRemaining(sender);
            }
            return;
        }

        const endGame = this.state.activeEndGame;
        if (endGame) {
            if (sender === endGame.winnerMemberNumber || sender === endGame.loserMemberNumber) {
                const elapsed = Date.now() - endGame.activeStartTime;
                const remaining = Math.max(0, endGame.agreedMinutes * 60 * 1000 - elapsed);
                const mins = Math.floor(remaining / 60000);
                const secs = Math.floor((remaining % 60000) / 1000);
                this.bot.whisper(sender, `⏳ ${mins}m ${secs}s remaining on the end game lock.`);
            }
            return;
        }

        this.bot.whisper(sender, "No active timer right now.");
    }

    // Whispers the service time remaining to the given player.
    private whisperServiceTimeRemaining(sender: number): void {
        const deal = this.state.serviceDeal;
        if (!deal || deal.stage !== "active" || deal.serviceStartTime === null) return;
        const elapsed = Date.now() - deal.serviceStartTime;
        const remaining = Math.max(0, deal.serviceDurationMs - elapsed);
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        this.bot.whisper(sender, `⏳ ${mins}m ${secs}s remaining on the service.`);
    }

    // Fires when the agreed end game time is up: strips the timer/password
    // leash lock and any extra requested locks, announces it, and finishes
    // the match. Guards against a stale timer in case activeEndGame was
    // already cleared some other way (safeword, reset) in the meantime.
    private expireEndGame(): void {
        const active = this.state.activeEndGame;
        if (!active) return;

        this.bot.removeItem(active.loserMemberNumber, END_GAME_LEASH_GROUP);
        // A bot-added collar is removed; a pre-existing collar the bot locked is
        // just unlocked (it's the player's own).
        if (active.collarAdded) {
            this.bot.removeItem(active.loserMemberNumber, "ItemNeck");
        } else if (active.collarLockedExisting) {
            this.unlockExistingCollar(active.loserMemberNumber);
        }
        for (const group of active.appliedLockSlots) {
            const slotDisplay = PICK_SLOTS.find(s => s.group === group)?.display;
            const entry = slotDisplay
                ? this.state.activeBondage.find(b => b.wearerMemberNumber === active.loserMemberNumber && b.slot === slotDisplay)
                : undefined;
            if (entry) {
                this.bot.applyItem(active.loserMemberNumber, group, entry.itemName, "Default", {});
            }
        }

        this.bot.sendChat(
            `⏱️ ${this.playerName(active.winnerMemberNumber)}'s claimed time with ${this.playerName(active.loserMemberNumber)} has ended. ` +
            `(${this.playerName(active.winnerMemberNumber)} spent ${active.winnerPointsSpent} pts, ${this.playerName(active.loserMemberNumber)} spent ${active.loserPointsSpent} pts settling this.)`
        );

        this.state.activeEndGame = null;
        this.finishMatch(active.winnerMemberNumber);
    }

    // ============================================================
    // SPEND MENU & CLOTHING TRADES
    // ============================================================

    // The spend menu's options, in display order, for the given player's
    // current state. Recomputed identically when showing the menu and when
    // parsing a numeric reply, so the two always stay in sync.
    private spendMenuOptions(sender: number): { key: string; label: string }[] {
        const state = this.state;
        const player = state.players!.find(p => p.memberNumber === sender)!;
        const opponent = state.players!.find(p => p.memberNumber !== sender)!;
        const options: { key: string; label: string }[] = [];
        options.push({ key: "boost", label: `boost — buy a streak boost that persists across rounds (max +${MAX_BOOST})` });
        if (state.config!.stripping) options.push({ key: "clothing", label: `clothing — buy an item of clothing from your opponent` });
        if (state.config!.bondage) options.push({ key: "bondage", label: `bondage — buy bondage for your opponent` });
        if (state.config!.bondage && this.lockableBondageSlotsFor(opponent.memberNumber).length > 0) {
            options.push({ key: "locks", label: `locks — pay to lock ${opponent.name}'s bondage; they can remove it later for 2× your price` });
        }
        if (state.config!.bondage && this.state.activeBondage.some(b => b.wearerMemberNumber === player.memberNumber)) {
            options.push({ key: "bondagebuyback", label: `buy back bondage — pay 2× the original price to have your bondage removed` });
        }
        if (state.config!.toys && this.toyCatalog.length > 0) {
            options.push({ key: "toys", label: `toys — pick a toy, agree a price with ${opponent.name}, then use it for a set time` });
        }
        if (state.config!.services) options.push({ key: "services", label: `actions & services — request an action or service from ${opponent.name} for a price` });
        if (player.soldItems.length > 0) options.push({ key: "buyback", label: `buyback — buy back an item you've sold` });
        return options;
    }

    // Whispers the banked player their spend options, based on what was
    // negotiated for this match.
    private openSpendMenu(sender: number): void {
        const state = this.state;
        if (!state.players || !state.config) return;

        const options = this.spendMenuOptions(sender);
        state.spendMenuOpen = true;
        this.bot.whisper(sender,
            `The shop (${state.spendingBalance} points balance) — what would you like to do?\n` +
            options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") +
            `\n0. Back — return to continue/endgame` +
            `\nH. help — what does all this mean?`
        );
    }

    // Handles the banked player's reply while the spend menu is open.
    private handleSpendMenuChoice(sender: number, lower: string, raw: string): void {
        const state = this.state;
        if (!state.players || !state.config) return;
        const player = state.players.find(p => p.memberNumber === sender)!;

        if (state.awaitingBoostLevel === sender) {
            this.handleBoostLevelResponse(sender, raw);
            return;
        }

        if (state.awaitingBuyback === sender) {
            this.handleBuybackResponse(sender, lower, raw);
            return;
        }

        if (state.awaitingBondageBuyback === sender) {
            this.handleBondageBuybackResponse(sender, lower, raw);
            return;
        }

        if (lower === "0") {
            state.spendMenuOpen = false;
            this.bot.whisper(sender, this.postBankPromptText(sender));
            return;
        }

        const options = this.spendMenuOptions(sender);
        const idx = /^\d+$/.test(lower) ? parseInt(lower, 10) : null;
        const key = (idx !== null && idx >= 1 && idx <= options.length) ? options[idx - 1].key : null;

        if (key === null) {
            this.bot.whisper(sender,
                `I didn't catch that — reply with a number (${options.map((o, i) => `${i + 1}. ${o.label}`).join(", ")}, 0. Back)`);
            return;
        }

        if (key === "boost") {
            this.startBoostPurchase(sender);
            return;
        }

        if (key === "clothing") {
            if (!state.config.stripping) {
                this.bot.whisper(sender, "Clothing trades aren't available in this match.");
                return;
            }
            this.startClothingDeal(sender);
            return;
        }

        if (key === "bondage") {
            if (!state.config.bondage) {
                this.bot.whisper(sender, "Bondage wasn't enabled for this match.");
                return;
            }
            this.startBondageDeal(sender);
            return;
        }

        if (key === "locks") {
            if (!state.config.bondage) {
                this.bot.whisper(sender, "Bondage wasn't enabled for this match.");
                return;
            }
            this.startLockDeal(sender);
            return;
        }

        if (key === "services") {
            if (!state.config.services) {
                this.bot.whisper(sender, `${settingLabel("services")} wasn't enabled for this match.`);
                return;
            }
            this.startServiceDeal(sender);
            return;
        }

        if (key === "toys") {
            if (!state.config.toys) {
                this.bot.whisper(sender, `${settingLabel("toys")} wasn't enabled for this match.`);
                return;
            }
            this.startToyDeal(sender);
            return;
        }

        if (key === "buyback") {
            if (player.soldItems.length === 0) {
                this.bot.whisper(sender, "You don't have any sold items to buy back.");
                return;
            }
            this.startBuyback(sender);
            return;
        }

        if (key === "bondagebuyback") {
            if (!state.config.bondage) {
                this.bot.whisper(sender, "Bondage wasn't enabled for this match.");
                return;
            }
            this.startBondageBuyback(sender);
            return;
        }
    }

    // ============================================================
    // STREAK BOOST PURCHASE
    // ============================================================

    // Cumulative point cost to hold a total boost of `boost` (0 = free). Prices
    // are per total level (see BOOST_PRICES), so a top-up charges the gap
    // between levels — stacking cheap +1s can't dodge the higher tiers.
    private boostPriceFor(boost: number): number {
        if (boost <= 0) return 0;
        return BOOST_PRICES[Math.min(boost, MAX_BOOST) - 1];
    }

    private startBoostPurchase(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(sender)) return;
        const player = state.players.find(p => p.memberNumber === sender)!;
        state.awaitingBoostLevel = sender;

        this.bot.sendChat(`⚡ ${this.playerName(sender)} is picking up a power-up...`);
        const room = MAX_BOOST - player.boost;
        this.bot.whisper(sender,
            `A boost adds straight to your roll total and persists across rounds — it only drains by 1 each time you lose, so a +3 boost survives 3 losses.\n\n` +
            `Prices are for your TOTAL boost level (topping up only charges the difference):\n` +
            `+1 total — 40 points\n` +
            `+2 total — 100 points\n` +
            `+3 total — 225 points\n` +
            `+4 total — 500 points\n` +
            `+5 total — 1,000 points\n` +
            `(your current boost: +${player.boost}, max total: +${MAX_BOOST})\n` +
            (room > 0
                ? `How many more levels? (say 1-${room}, or 0 to go back)`
                : `You're already at the max boost. (say 0 to go back)`)
        );
    }

    private handleBoostLevelResponse(sender: number, raw: string): void {
        const state = this.state;
        if (!state.players) return;
        const player = state.players.find(p => p.memberNumber === sender)!;

        const n = extractNumber(raw);
        if (n === 0) {
            this.handleShopCancel(sender);
            return;
        }
        if (n === null || n < 1 || n > 5) {
            this.bot.whisper(sender, "Please say a number from 1 to 5.");
            return;
        }

        let level = n;
        const room = MAX_BOOST - player.boost;
        if (room <= 0) {
            this.bot.whisper(sender, `Your boost is already at the max (+${MAX_BOOST}).`);
            state.awaitingBoostLevel = null;
            this.returnToSpendMenu(sender);
            return;
        }
        if (level > room) {
            this.bot.whisper(sender, `Max total boost is +${MAX_BOOST} — you have +${player.boost}, so I'll cap this at +${room}.`);
            level = room;
        }

        // Prices are for the TOTAL boost level, not per-purchase, so topping up
        // charges the difference between the new total's price and what the
        // current level would have cost. Without this, buying +1 five times
        // (5×40) would reach +5 for 200 instead of its real 1000 price.
        const targetBoost = player.boost + level;
        const cost = this.boostPriceFor(targetBoost) - this.boostPriceFor(player.boost);
        if (state.spendingBalance < cost) {
            this.bot.whisper(sender, `You can't afford that — going from +${player.boost} to +${targetBoost} costs ${cost} points and you have ${state.spendingBalance}. Type !cancel to exit the shop or choose a smaller boost.`);
            state.awaitingBoostLevel = null;
            this.returnToSpendMenu(sender);
            return;
        }

        state.spendingBalance -= cost;
        player.boost += level;
        state.awaitingBoostLevel = null;

        this.bot.whisper(sender, `Boost purchased for ${cost} points! Your boost is now +${player.boost}. Each loss reduces it by 1.`);
        this.returnToSpendMenu(sender);
    }

    // ============================================================
    // BUYBACK
    // ============================================================

    private startBuyback(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(sender)) return;
        const player = state.players.find(p => p.memberNumber === sender)!;

        state.awaitingBuyback = sender;

        this.bot.sendChat(`💸 ${this.playerName(sender)} is trying to buy something back...`);

        if (player.soldItems.length === 1) {
            const sold = player.soldItems[0];
            this.bot.whisper(sender, `Want to buy back your ${sold.item}? Cost: ${sold.salePrice * 2} points. (say yes or no)`);
            return;
        }

        const lines = player.soldItems.map((s, i) => `${i + 1}. ${s.item} — ${s.salePrice * 2} points`);
        this.bot.whisper(sender,
            `Which item would you like to buy back?\n` +
            lines.join("\n") +
            `\n0. Back` +
            `\n(say the item name or number)`
        );
    }

    private handleBuybackResponse(sender: number, lower: string, raw: string): void {
        const state = this.state;
        if (!state.players) return;
        const player = state.players.find(p => p.memberNumber === sender)!;

        let chosen: SoldItem | null = null;

        if (player.soldItems.length === 1) {
            if (lower === "yes" || lower === "y") {
                chosen = player.soldItems[0];
            } else if (lower === "no" || lower === "n") {
                state.awaitingBuyback = null;
                this.bot.whisper(sender, "Okay, maybe next time.");
                this.returnToSpendMenu(sender);
                return;
            } else {
                this.bot.whisper(sender, "Please say 'yes' or 'no'.");
                return;
            }
        } else {
            if (raw.trim() === "0") {
                this.handleShopCancel(sender);
                return;
            }
            const num = extractNumber(raw);
            if (num !== null && num >= 1 && num <= player.soldItems.length) {
                chosen = player.soldItems[num - 1];
            } else {
                const trimmed = raw.toLowerCase().trim();
                chosen = player.soldItems.find(s => s.item.toLowerCase() === trimmed) ?? null;
            }
            if (!chosen) {
                this.bot.whisper(sender, "Please say the item name or its number from the list.");
                return;
            }
        }

        const cost = chosen.salePrice * 2;
        if (state.spendingBalance < cost) {
            this.bot.whisper(sender, `You can't afford that — buying back ${chosen.item} costs ${cost} points and you have ${state.spendingBalance}. Type !cancel to exit the shop or choose something cheaper.`);
            state.awaitingBuyback = null;
            this.returnToSpendMenu(sender);
            return;
        }

        const holder = state.players.find(p => p.memberNumber === chosen!.soldBy)!;

        state.spendingBalance -= cost;
        holder.pendingBalance += Math.floor(chosen.salePrice);
        player.soldItems = player.soldItems.filter(s => s !== chosen);
        state.awaitingBuyback = null;

        const item = chosen.item;
        const message = `${player.name} is buying back their ${item} for ${cost} points. ${holder.name} receives ${chosen.salePrice} points (pending).`;
        this.bot.whisper(sender, message);
        this.bot.whisper(holder.memberNumber, message);

        // Unlike a clothing sale, BC has no way to detect a player putting
        // an item back ON (ChatRoomSyncSingle can't distinguish add vs
        // remove), so buyback doesn't block on a wardrobe check.
        this.bot.sendChat(`✅ Buyback complete! ${player.name} bought back their ${item}.`);
        this.bot.whisper(sender, `Go ahead and put your ${item} back on when ready.`);

        this.returnToSpendMenu(sender);
    }

    // Re-shows the spend menu to a player still in the post-bank flow.
    private returnToSpendMenu(buyer: number): void {
        if (this.state.awaitingPostBank === buyer) {
            this.openSpendMenu(buyer);
        }
    }

    private startClothingDeal(buyer: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(buyer)) return;
        const opponent = state.players.find(p => p.memberNumber !== buyer)!;

        state.clothingDeal = {
            buyer,
            opponent: opponent.memberNumber,
            item: null,
            price: null,
            counterPrice: null,
            stage: "awaiting_item_price",
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
        };

        this.bot.sendChat(`👗 ${this.playerName(buyer)} is eyeing ${this.playerName(opponent.memberNumber)}'s wardrobe...`);
        this.bot.whisper(buyer, "What would you like to buy and for how much? (e.g. 'I'd like their red dress for 50 points')");
    }

    // Dispatches a message to the in-progress clothing deal, if any.
    // Returns true if the message was consumed by the deal flow.
    private handleClothingDealMessage(sender: number, raw: string, lower: string): boolean {
        const deal = this.state.clothingDeal;
        if (!deal) return false;

        switch (deal.stage) {
            case "awaiting_item_price":
            case "awaiting_item":
            case "awaiting_price":
                if (sender !== deal.buyer) return false;
                return this.handleClothingItemPriceInput(deal, raw);

            case "awaiting_opponent_response":
                if (sender !== deal.opponent) return false;
                return this.handleClothingOpponentResponse(deal, lower);

            case "awaiting_opponent_counter_value":
                if (sender !== deal.opponent) return false;
                return this.handleClothingOpponentCounterValue(deal, raw);

            case "awaiting_buyer_counter_response":
                if (sender !== deal.buyer) return false;
                return this.handleClothingBuyerCounterResponse(deal, lower);

            case "awaiting_buyer_counter_value":
                if (sender !== deal.buyer) return false;
                return this.handleClothingBuyerCounterValue(deal, raw);
        }
    }

    // Parses the buyer's item/price input for stages awaiting_item_price,
    // awaiting_item, and awaiting_price. Always consumes the message.
    private handleClothingItemPriceInput(deal: ClothingDeal, raw: string): boolean {
        const trimmedLower = raw.trim().toLowerCase();
        if (trimmedLower === "cancel" || trimmedLower === "!cancel") {
            this.handleClothingDealCancel(deal.buyer);
            return true;
        }

        if (deal.stage === "awaiting_item_price") {
            const { item, price } = extractItemAndPrice(raw);
            if (item && price !== null) {
                deal.item = item;
                deal.price = price;
                this.proposeClothingDealToOpponent(deal);
            } else if (item) {
                deal.item = item;
                deal.stage = "awaiting_price";
                this.bot.whisper(deal.buyer, `Got '${item}' — how many points are you offering?`);
            } else if (price !== null) {
                deal.price = price;
                deal.stage = "awaiting_item";
                this.bot.whisper(deal.buyer, `Got ${price} points — what item do you want?`);
            } else {
                this.bot.whisper(deal.buyer, "What would you like to buy and for how much? (e.g. 'I'd like their red dress for 50 points')");
            }
            return true;
        }

        if (deal.stage === "awaiting_item") {
            const { item } = extractItemAndPrice(raw);
            if (!item) {
                this.bot.whisper(deal.buyer, "What item would you like to buy?");
                return true;
            }
            deal.item = item;
            this.proposeClothingDealToOpponent(deal);
            return true;
        }

        // awaiting_price
        const price = extractNumber(raw);
        if (price === 0) {
            this.handleClothingDealCancel(deal.buyer);
            return true;
        }
        if (price === null) {
            this.bot.whisper(deal.buyer, "How many points are you offering?");
            return true;
        }
        deal.price = price;
        this.proposeClothingDealToOpponent(deal);
        return true;
    }

    private proposeClothingDealToOpponent(deal: ClothingDeal): void {
        const state = this.state;
        if (state.spendingBalance < deal.price!) {
            this.bot.whisper(deal.buyer, `You can't afford that — ${deal.price} points is more than your ${state.spendingBalance} balance. Type !cancel to exit the shop, or tell me what you'd like to buy and for how much.`);
            deal.item = null;
            deal.price = null;
            deal.stage = "awaiting_item_price";
            return;
        }

        // Opening offer — always succeeds at negotiationStep 0, sets initiatorFloor.
        applyInitiatorOffer(deal, deal.price!);

        deal.stage = "awaiting_opponent_response";
        this.bot.sendChat(`👗 ${this.playerName(deal.buyer)} is looking to buy some clothing from ${this.playerName(deal.opponent)}...`);
        this.bot.whisper(deal.opponent,
            `${this.playerName(deal.buyer)} wants to buy your ${deal.item} for ${deal.price} points. ` +
            `Accept, decline, or counter with a different price? (say 'accept', 'decline', or 'counter <number>')`
        );
        this.bot.whisper(deal.buyer,
            `⏳ Offer sent to ${this.playerName(deal.opponent)}. Waiting for their response...`
        );
    }

    private handleClothingOpponentResponse(deal: ClothingDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeClothingDeal(deal, deal.price!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.buyer, "Offer declined.");
            this.state.clothingDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_opponent_counter_value";
                this.bot.whisper(deal.opponent, "What price would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleClothingOpponentCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.opponent, "Please say 'accept', 'decline', or 'counter <number>'.");
        return true;
    }

    private handleClothingOpponentCounterValue(deal: ClothingDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.opponent, "What price would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyResponderCounter(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.opponent, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.opponent, result.notice);

        if (result.matched) {
            this.finalizeClothingDeal(deal, result.price!);
            return true;
        }

        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.buyer, `${this.playerName(deal.opponent)} counters: ${deal.item} for ${deal.counterPrice} points. Accept, decline, or counter?`);
        return true;
    }

    // The buyer can accept, decline, or counter the opponent's counter,
    // continuing the structured negotiation (see applyInitiatorOffer).
    private handleClothingBuyerCounterResponse(deal: ClothingDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeClothingDeal(deal, deal.counterPrice!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.opponent, "Offer declined.");
            this.state.clothingDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_buyer_counter_value";
                this.bot.whisper(deal.buyer, "How many points would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleClothingBuyerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.buyer, "Please say 'accept', 'decline', or 'counter <amount>'.");
        return true;
    }

    private handleClothingBuyerCounterValue(deal: ClothingDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.buyer, "How many points would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.buyer, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.buyer, result.notice);

        if (result.final || result.matched) {
            this.finalizeClothingDeal(deal, result.matched ? result.price! : deal.price!);
            return true;
        }

        deal.stage = "awaiting_opponent_response";
        this.bot.whisper(deal.opponent, `${this.playerName(deal.buyer)} counters: ${deal.item} for ${deal.price} points. Accept, decline, or counter?`);
        return true;
    }

    // Settles an agreed clothing deal at the final price: checks the buyer
    // can afford it, deducts the full price from their spending balance,
    // credits half to the opponent's pending balance (the other half is
    // the bot's fee), and pauses the game until the opponent's wardrobe
    // change comes through.
    private finalizeClothingDeal(deal: ClothingDeal, price: number): void {
        const state = this.state;
        if (!state.players) return;

        const buyer = state.players.find(p => p.memberNumber === deal.buyer)!;
        const opponent = state.players.find(p => p.memberNumber === deal.opponent)!;
        const item = deal.item!;

        if (state.spendingBalance < price) {
            this.bot.whisper(deal.buyer, `You can't afford that — ${price} points is more than your ${state.spendingBalance} balance. The deal is off.`);
            this.bot.whisper(deal.opponent, `${this.playerName(deal.buyer)} can't cover ${price} points — the deal is off.`);
            state.clothingDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return;
        }

        const half = Math.floor(price / 2);

        state.spendingBalance -= price;
        opponent.pendingBalance += half;
        opponent.soldItems.push({ item, salePrice: price, soldBy: buyer.memberNumber });

        const breakdown = `👗 Deal! ${item} sold for ${price} points. ${opponent.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points.`;
        this.bot.whisper(deal.buyer, breakdown);
        this.bot.whisper(deal.opponent, breakdown);

        const waitMsg = `⏳ Waiting for ${opponent.name} to remove ${item} from their wardrobe. The game is paused until then. (${opponent.name} can whisper !removed to confirm manually if it doesn't clear on its own.)`;
        this.bot.whisper(deal.buyer, waitMsg);
        this.bot.whisper(deal.opponent, waitMsg);

        this.startWardrobeCheck(deal.buyer, deal.opponent, item);

        state.clothingDeal = null;
    }

    // Watches for a ChatRoomSyncSingle wardrobe change from `opponent`
    // within WARDROBE_CHECK_TIMEOUT_MS, blocking all game commands until it
    // arrives (verified via item-count drop, or a manual !removed from
    // opponent — see onSyncSingle/handleRemovedConfirmation). If none
    // arrives in time, nudges the buyer to follow up directly, but keeps
    // the game paused.
    private startWardrobeCheck(buyer: number, opponent: number, item: string): void {
        const existing = this.pendingWardrobeChecks.get(opponent);
        if (existing) clearTimeout(existing.timer);

        const timeoutAt = Date.now() + WARDROBE_CHECK_TIMEOUT_MS;
        this.state.waitingForWardrobe = { memberNumber: opponent, item, timeoutAt };

        const baselineCount = this.roomCharacters.get(opponent)?.Appearance?.length ?? null;

        const timer = setTimeout(() => {
            this.bot.whisper(buyer, `⚠️ ${this.playerName(opponent)} hasn't made a wardrobe change yet. You may need to follow up.`);
        }, WARDROBE_CHECK_TIMEOUT_MS);

        this.pendingWardrobeChecks.set(opponent, { buyer, item, timer, baselineCount });
    }

    // Confirms the opponent's wardrobe check either (a) automatically, once
    // onSyncSingle sees their Appearance count drop below the baseline
    // captured when the deal closed, or (b) manually, via !removed —
    // mirrors StripDiceBot's handleRemoved(). Clears the pending check and
    // resumes the buyer's menu either way.
    private completeWardrobeCheck(memberNumber: number): void {
        const pending = this.pendingWardrobeChecks.get(memberNumber);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingWardrobeChecks.delete(memberNumber);

        if (this.state.waitingForWardrobe?.memberNumber === memberNumber) {
            this.state.waitingForWardrobe = null;
        }

        this.bot.sendChat(`👗 ${this.playerName(memberNumber)} has handed over their ${pending.item}! The game continues.`);

        // Capture which groups were removed in this deal (ingestAppearance has
        // already run against the same sync that triggered this). Any clothing
        // entry added within the last 10 seconds is considered part of this deal.
        const SHOP_REMOVAL_WINDOW_MS = 10_000;
        const now = Date.now();
        const shopGroups = (this.removedClothingHistory.get(memberNumber) ?? [])
            .filter(e => now - e.removedAt < SHOP_REMOVAL_WINDOW_MS)
            .map(e => e.group);
        if (shopGroups.length > 0) {
            this.lastShopRemovedGroups.set(memberNumber, shopGroups);
        }

        // If the player is already restrained, let them know !stuck is available.
        if (this.state.activeBondage.some(b => b.wearerMemberNumber === memberNumber)) {
            this.bot.whisper(memberNumber,
                `You're restrained — if you need help undressing, whisper !stuck and I'll give you a hand, or ask your opponent directly.`);
        }

        this.sendPostWardrobeMenu(pending.buyer);
    }

    // Manual fallback for a pending wardrobe check — lets the opponent
    // confirm the handoff themselves instead of waiting solely on BC's sync
    // event to land. Mirrors StripDiceBot's !removed command.
    private handleRemovedConfirmation(sender: number): void {
        const waiting = this.state.waitingForWardrobe;
        if (!waiting || waiting.memberNumber !== sender) {
            this.bot.whisper(sender, "There's nothing pending for you to confirm right now.");
            return;
        }
        this.completeWardrobeCheck(sender);
    }

    // Whispers `sender` that the game is paused if a wardrobe change is
    // still pending. Returns true if the command should be blocked.
    private blockedByWardrobe(sender: number): boolean {
        const waiting = this.state.waitingForWardrobe;
        if (!waiting) return false;
        this.bot.whisper(sender, `⏳ The game is paused until ${this.playerName(waiting.memberNumber)} updates their wardrobe.`);
        return true;
    }

    // A pending mercy request pauses bank/press/endgame for both players
    // until it's resolved (accepted/rejected/cancelled) — see handleMercyMessage.
    private blockedByMercy(sender: number): boolean {
        if (!this.state.mercyRequest) return false;
        this.bot.whisper(sender, `⏳ The game is paused while a mercy request is being decided.`);
        return true;
    }

    private clearPendingWardrobeChecks(): void {
        for (const pending of this.pendingWardrobeChecks.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingWardrobeChecks.clear();
        this.state.waitingForWardrobe = null;
    }

    // ============================================================
    // ACTIONS & SERVICES
    // ============================================================
    //
    // Mirrors the clothing deal flow: the winner (buyer) describes a request
    // and names a price, the loser (seller) can accept, decline, or counter
    // once, and the buyer can only accept/decline that counter (no further
    // counters). Unlike clothing, settlement doesn't wait on a wardrobe
    // change — instead the deal stays non-null through a 5-minute "active"
    // period (with a 3-minute warning) so the game stays paused until the
    // timer fires.
    // ============================================================

    private startServiceDeal(buyer: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(buyer)) return;
        const seller = state.players.find(p => p.memberNumber !== buyer)!;

        state.serviceDeal = {
            buyer,
            seller: seller.memberNumber,
            description: null,
            price: null,
            counterPrice: null,
            stage: "awaiting_description",
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
            timerHandle: null,
            warningHandle: null,
            serviceStartTime: null,
            serviceDurationMs: 0,
        };

        this.bot.sendChat(`🎭 ${this.playerName(buyer)} is browsing the services menu...`);
        this.bot.whisper(buyer, "What action or service would you like to request? Describe it and name your price in points. (0 to go back)");
    }

    // Dispatches a message to the in-progress service deal, if any. Returns
    // true if the message was consumed by the deal flow.
    private handleServiceDealMessage(sender: number, raw: string, lower: string): boolean {
        const deal = this.state.serviceDeal;
        if (!deal) return false;

        switch (deal.stage) {
            case "awaiting_description":
                if (sender !== deal.buyer) return false;
                return this.handleServiceDescriptionInput(deal, raw);

            case "awaiting_seller_response":
                if (sender !== deal.seller) return false;
                return this.handleServiceSellerResponse(deal, lower);

            case "awaiting_seller_counter_value":
                if (sender !== deal.seller) return false;
                return this.handleServiceSellerCounterValue(deal, raw);

            case "awaiting_buyer_counter_response":
                if (sender !== deal.buyer) return false;
                return this.handleServiceBuyerCounterResponse(deal, lower);

            case "awaiting_buyer_counter_value":
                if (sender !== deal.buyer) return false;
                return this.handleServiceBuyerCounterValue(deal, raw);

            case "active":
                // During the active timer, only the players involved are
                // allowed to send recognized commands; everything else is
                // silently consumed so the bot doesn't react to chatter.
                if (sender !== deal.buyer && sender !== deal.seller) return false;
                if (lower === "time") {
                    this.whisperServiceTimeRemaining(sender);
                    return true;
                }
                if (lower === "done") {
                    this.handleServiceDone(sender);
                    return true;
                }
                // Silently consume all other messages from either party.
                return true;
        }
    }

    // Parses the buyer's description/price input, same free-form extraction
    // as clothing (extractItemAndPrice). Since ServiceDeal has a single
    // "awaiting_description" stage (no separate item/price sub-stages), the
    // still-missing field is tracked by which of deal.description/deal.price
    // is still null. Always consumes the message.
    private handleServiceDescriptionInput(deal: ServiceDeal, raw: string): boolean {
        const trimmedLower = raw.trim().toLowerCase();
        if (trimmedLower === "cancel" || trimmedLower === "!cancel" || trimmedLower === "0") {
            this.handleServiceDealCancel(deal.buyer);
            return true;
        }

        if (deal.description === null && deal.price === null) {
            const { item: description, price } = extractItemAndPrice(raw);
            if (description && price !== null) {
                deal.description = description;
                deal.price = price;
                this.proposeServiceDealToSeller(deal);
            } else if (description) {
                deal.description = description;
                this.bot.whisper(deal.buyer, `Got it — how many points are you offering?`);
            } else if (price !== null) {
                deal.price = price;
                this.bot.whisper(deal.buyer, `Got ${price} points — what action or service would you like to request?`);
            } else {
                this.bot.whisper(deal.buyer, "What action or service would you like to request? Describe it and name your price in points.");
            }
            return true;
        }

        if (deal.description === null) {
            const { item: description } = extractItemAndPrice(raw);
            if (!description) {
                this.bot.whisper(deal.buyer, "What action or service would you like to request?");
                return true;
            }
            deal.description = description;
            this.proposeServiceDealToSeller(deal);
            return true;
        }

        // price is null
        const price = extractNumber(raw);
        if (price === null) {
            this.bot.whisper(deal.buyer, "How many points are you offering?");
            return true;
        }
        deal.price = price;
        this.proposeServiceDealToSeller(deal);
        return true;
    }

    private proposeServiceDealToSeller(deal: ServiceDeal): void {
        const state = this.state;
        if (state.spendingBalance < deal.price!) {
            this.bot.whisper(deal.buyer, `You can't afford that — ${deal.price} points is more than your ${state.spendingBalance} balance. Type !cancel to exit the shop, or describe what you'd like to request and your price.`);
            deal.description = null;
            deal.price = null;
            return;
        }

        // Opening offer — always succeeds at negotiationStep 0, sets initiatorFloor.
        applyInitiatorOffer(deal, deal.price!);

        deal.stage = "awaiting_seller_response";
        this.bot.whisper(deal.seller,
            `${this.playerName(deal.buyer)} wants to buy a service: "${deal.description}" for ${deal.price} pts ` +
            `(you'd receive ${Math.floor(deal.price! / 2)} pts — half the agreed price). ` +
            `Reply accept, decline, or counter <amount>.`
        );
        this.bot.whisper(deal.buyer,
            `⏳ Offer sent to ${this.playerName(deal.seller)}. Waiting for their response...`
        );
    }

    private handleServiceSellerResponse(deal: ServiceDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeServiceDeal(deal, deal.price!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.buyer, "Service declined.");
            this.state.serviceDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_seller_counter_value";
                this.bot.whisper(deal.seller, "How many points would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleServiceSellerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.seller, "Please say 'accept', 'decline', or 'counter <amount>'.");
        return true;
    }

    private handleServiceSellerCounterValue(deal: ServiceDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.seller, "How many points would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyResponderCounter(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.seller, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.seller, result.notice);

        if (result.matched) {
            this.finalizeServiceDeal(deal, result.price!);
            return true;
        }

        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.buyer, `${this.playerName(deal.seller)} counters: "${deal.description}" for ${deal.counterPrice} points. Accept, decline, or counter?`);
        return true;
    }

    // The buyer can accept, decline, or counter the seller's counter,
    // continuing the structured negotiation (see applyInitiatorOffer).
    private handleServiceBuyerCounterResponse(deal: ServiceDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeServiceDeal(deal, deal.counterPrice!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.seller, "Service declined.");
            this.state.serviceDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_buyer_counter_value";
                this.bot.whisper(deal.buyer, "How many points would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleServiceBuyerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.buyer, "Please say 'accept', 'decline', or 'counter <amount>'.");
        return true;
    }

    private handleServiceBuyerCounterValue(deal: ServiceDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.buyer, "How many points would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.buyer, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.buyer, result.notice);

        if (result.final || result.matched) {
            this.finalizeServiceDeal(deal, result.matched ? result.price! : deal.price!);
            return true;
        }

        deal.stage = "awaiting_seller_response";
        this.bot.whisper(deal.seller, `${this.playerName(deal.buyer)} counters: "${deal.description}" for ${deal.price} points (you'd receive ${Math.floor(deal.price! / 2)} pts). Accept, decline, or counter?`);
        return true;
    }

    // Settles an agreed service deal at the final price: checks the buyer
    // can afford it, deducts the full price from their spending balance,
    // credits half to the seller's pending balance (the other half is the
    // bot's fee), announces it, and starts the 5-minute active timer. The
    // deal stays non-null (stage "active") until the timer fires, keeping
    // the game paused.
    private finalizeServiceDeal(deal: ServiceDeal, price: number): void {
        const state = this.state;
        if (!state.players) return;

        const buyer = state.players.find(p => p.memberNumber === deal.buyer)!;
        const seller = state.players.find(p => p.memberNumber === deal.seller)!;
        const description = deal.description!;

        if (state.spendingBalance < price) {
            this.bot.whisper(deal.buyer, `You can't afford that — ${price} points is more than your ${state.spendingBalance} balance. The deal is off.`);
            this.bot.whisper(deal.seller, `${this.playerName(deal.buyer)} can't cover ${price} points — the deal is off.`);
            state.serviceDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return;
        }

        const half = Math.floor(price / 2);
        state.spendingBalance -= price;
        seller.pendingBalance += half;

        this.bot.whisper(seller.memberNumber, `✅ Service agreed at ${price} pts — you'll receive ${half} pts (pending, available next Bank).`);

        const SERVICE_MINUTES = 5;
        this.bot.sendChat(
            `⏳ ${seller.name} is performing "${description}" for ${buyer.name} — ` +
            `${SERVICE_MINUTES} minutes on the clock. ` +
            `Use !done when complete, !time to check remaining time, or safeword to stop. ` +
            `(${price} pts settled; ${buyer.name} has ${state.spendingBalance} pts left.)`
        );

        deal.price = price;
        deal.stage = "active";
        this.startServiceTimer(deal);
    }

    // Schedules the 3-minute warning whisper and the 5-minute expiry for an
    // active service deal.
    private startServiceTimer(deal: ServiceDeal): void {
        deal.serviceStartTime = Date.now();
        deal.serviceDurationMs = 5 * 60 * 1000;

        deal.warningHandle = setTimeout(() => {
            this.bot.whisper(deal.buyer, "⏳ 3 minutes remaining on the service.");
            this.bot.whisper(deal.seller, "⏳ 3 minutes remaining on the service.");
        }, 2 * 60 * 1000);

        deal.timerHandle = setTimeout(() => this.expireServiceDeal(deal), deal.serviceDurationMs);
    }

    // Fires when an active service deal's 5-minute timer runs out — announces
    // it, clears the deal, and resumes whichever menu the buyer was in.
    // Guards against a stale timer in case the deal was already cleared some
    // other way (match end, safeword, reset) in the meantime.
    private expireServiceDeal(deal: ServiceDeal): void {
        if (this.state.serviceDeal !== deal) return;

        this.bot.sendChat("⏰ Time's up! The service period has ended. Game resumes.");
        this.state.serviceDeal = null;
        this.sendPostServiceMenu(deal.buyer);
    }

    // Whispers the buyer what to do next once an active service deal's timer
    // clears — re-showing whichever menu they were in before the pause.
    private sendPostServiceMenu(buyer: number): void {
        const state = this.state;
        if (state.phase !== "playing" || state.awaitingPostBank !== buyer) return;

        if (state.spendMenuOpen) {
            this.openSpendMenu(buyer);
        } else {
            this.bot.whisper(buyer, `Game resumes — here's what you can do next:\n` + this.postBankPromptText(buyer));
        }
    }

    // Either party in an in-progress (or active) service deal can back out —
    // mirrors handleToyDealCancel. Not visible to the other party until the
    // buyer's opening offer has been sent (stage past "awaiting_description").
    private handleServiceDealCancel(sender: number): void {
        const deal = this.state.serviceDeal;
        if (!deal) return;

        // !cancel is not available once the service is underway — only !done
        // (winner) or safeword can stop it at that point.
        if (deal.stage === "active") return;

        const otherParty = sender === deal.buyer ? deal.seller : deal.buyer;
        const alreadyVisibleToBoth = deal.stage !== "awaiting_description";

        if (deal.timerHandle) clearTimeout(deal.timerHandle);
        if (deal.warningHandle) clearTimeout(deal.warningHandle);

        this.bot.whisper(sender, "Service deal cancelled.");
        if (alreadyVisibleToBoth) {
            this.bot.whisper(otherParty, `${this.playerName(sender)} cancelled the service deal.`);
        }

        this.state.serviceDeal = null;
        this.returnToSpendMenu(deal.buyer);
    }

    // Cancels an in-progress or active service deal's timers and clears it —
    // called alongside clearPendingWardrobeChecks()/releaseActiveToy() when a
    // match ends, is force-reset, or halted by a safeword.
    private clearServiceDeal(): void {
        const deal = this.state.serviceDeal;
        if (!deal) return;
        if (deal.timerHandle) clearTimeout(deal.timerHandle);
        if (deal.warningHandle) clearTimeout(deal.warningHandle);
        this.state.serviceDeal = null;
    }

    // Whispers `sender` that the game is paused if a service deal is being
    // negotiated or its active timer is running. Returns true if the command
    // should be blocked.
    private blockedByServiceDeal(sender: number): boolean {
        if (!this.state.serviceDeal) return false;
        this.bot.whisper(sender, "⏳ A service is in progress — game is paused.");
        return true;
    }

    // True if any shop deal (clothing, bondage, lock, toy, or service) is
    // currently being negotiated or is otherwise still active.
    private hasActiveDeal(): boolean {
        const state = this.state;
        return !!(state.bondageDeal || state.clothingDeal || state.lockDeal || state.toyDeal || state.serviceDeal);
    }

    // Whispers `sender` that the game is paused if any shop deal is active.
    // Returns true if the command should be blocked. Used to keep !bank,
    // !press, and !endgame from orphaning a deal that's mid-negotiation.
    private blockedByShopDeal(sender: number): boolean {
        if (!this.hasActiveDeal()) return false;
        this.bot.whisper(sender, "⏳ A shop deal is in progress — finish or cancel it first.");
        return true;
    }

    // ============================================================
    // BONDAGE PURCHASES
    // ============================================================
    //
    // Mirrors the clothing deal flow above, including the money direction:
    // the banked winner spends from their spendingBalance, the opponent
    // receives half as pending earnings, and the other half is the bot fee.
    // The one mechanical difference: items are applied/removed directly via
    // the BC socket (ChatRoomCharacterItemUpdate — see BCConnection.
    // applyItem/removeItem), so there's no wardrobe-check pause; the change
    // is instant and doesn't depend on the other player's client.
    //
    // "placer" and "wearer" are stable roles across both deal kinds:
    //   - apply:   placer picks slot+item and offers a price; wearer accepts
    //     (or counters) and receives half. The placer pays, like clothing.
    //   - removal: wearer names the slot to buy back; placer names the
    //     price; wearer accepts and pays for their freedom.
    // ============================================================

    private groupForSlotDisplay(display: string): string {
        return PICK_SLOTS.find(s => s.display === display)!.group;
    }

    // Slots not already occupied by active bondage on this wearer, and
    // present in the BC item catalog (empty catalog groups are skipped).
    private availableBondageSlotsFor(wearerMemberNumber: number): PickSlot[] {
        const worn = new Set(
            this.state.activeBondage.filter(b => b.wearerMemberNumber === wearerMemberNumber).map(b => b.slot)
        );
        return PICK_SLOTS.filter(s => !worn.has(s.display) && (this.itemCatalog.get(s.group) ?? []).length > 0);
    }

    // Active bondage entry a given member is involved in on the named slot,
    // filtered to their role ("placer" for !removebondage, "wearer" for
    // !buybondage). Slot matching is case/punctuation-insensitive.
    private findActiveBondage(memberNumber: number, slotArg: string, role: "placer" | "wearer"): ActiveBondage | null {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const q = norm(slotArg);
        return this.state.activeBondage.find(b => {
            const roleMatch = role === "placer" ? b.placerMemberNumber === memberNumber : b.wearerMemberNumber === memberNumber;
            return roleMatch && norm(b.slot) === q;
        }) ?? null;
    }

    private listPlacedBondage(placerMemberNumber: number): string {
        const placed = this.state.activeBondage.filter(b => b.placerMemberNumber === placerMemberNumber);
        if (placed.length === 0) return "(none)";
        return placed.map(b => `${b.slot} (${b.itemName}) on ${this.playerName(b.wearerMemberNumber)}`).join(", ");
    }

    private listWornBondage(wearerMemberNumber: number): string {
        const worn = this.state.activeBondage.filter(b => b.wearerMemberNumber === wearerMemberNumber);
        if (worn.length === 0) return "(none)";
        return worn.map(b => `${b.slot} (${b.itemName})`).join(", ");
    }

    // A leash (ItemNeckRestraints/CollarLeash) needs a collar in the ItemNeck
    // slot to attach to — and that collar MUST be locked, or the loser could
    // just slip it off and the leash with it. Call this right before applying a
    // leash, with the same lockProperty the leash gets so everything releases
    // together:
    //   - no collar worn   → add the most popular one, locked (added=true)
    //   - collar worn, unlocked → lock it in place, preserving the item
    //     (lockedExisting=true) — teardown UNLOCKS rather than removes it
    //   - collar worn, already locked → leave it (already secure; never
    //     replace someone else's lock)
    private ensureCollarForLeash(memberNumber: number, lockProperty: any): { added: boolean; lockedExisting: boolean } {
        const collar = this.roomCharacters.get(memberNumber)?.Appearance
            ?.find((item: any) => item?.Group === "ItemNeck" && item?.Name);

        if (!collar) {
            // Pin to a plain un-typed collar so the lock-only Property is
            // complete and actually sticks (see END_GAME_FRESH_COLLAR_ITEM).
            this.bot.applyItem(memberNumber, "ItemNeck", END_GAME_FRESH_COLLAR_ITEM, "Default", lockProperty);
            return { added: true, lockedExisting: false };
        }

        // Collar already locked (e.g. a player-placed lock) — leave it. It's
        // already secure, and it isn't ours to replace or unlock at teardown.
        if (collar.Property?.LockedBy) {
            return { added: false, lockedExisting: false };
        }

        // Lock the existing collar in place. CRITICAL: merge the lock fields
        // ON TOP OF the collar's current Property rather than replacing it.
        // The lockProperty alone carries no asset/type fields (TypeRecord,
        // ShockLevel, etc.), so applying it by itself makes BC re-validate the
        // item, rebuild it to its unlocked defaults, and DROP the lock — which
        // is exactly why typed collars (e.g. PetSuitShockCollar) were coming
        // out unlocked while the leash locked fine (confirmed in the 2026-07-22
        // room log). Merging preserves the item's type and adds the lock, the
        // same way a normal BC client locks a worn item.
        this.bot.applyItem(memberNumber, "ItemNeck", collar.Name, collar.Color ?? "Default",
            { ...(collar.Property ?? {}), ...lockProperty });
        return { added: false, lockedExisting: true };
    }

    // Re-applies the loser's worn collar with no lock (preserving name/color),
    // undoing a lock the bot added over a pre-existing collar at end game.
    private unlockExistingCollar(memberNumber: number): void {
        const collar = this.roomCharacters.get(memberNumber)?.Appearance
            ?.find((item: any) => item?.Group === "ItemNeck" && item?.Name);
        if (collar) {
            this.bot.applyItem(memberNumber, "ItemNeck", collar.Name, collar.Color ?? "Default", {});
        }
    }

    // Top-N most popular items for this slot (from this bot's own usage
    // data), filled out with random catalog items so the list is never
    // sparse on a cold start (StripDiceBot's shared picker instead falls
    // back to bootstrap preset outfits, which WD has none of).
    // Returns `all` — the full sorted catalog list for this slot (pinned new
    // items → popular by usage → shuffled remainder) — and `options`, which is
    // the first PICK_LIST_TOP_N entries of `all`. The full list is stored in
    // the deal so "M for more" can page through it without re-randomising.
    private buildBondagePickList(group: string, excluded: string[]): { options: string[]; all: string[] } {
        const catalogItems = this.itemCatalog.get(group) ?? [];
        const usage = this.bondageUsage[group] ?? {};

        // Pin any new items for this slot to the front (see NEW_ITEMS) so
        // players always see the latest gear regardless of usage history.
        const pinned: string[] = [...NEW_ITEMS].filter(
            n => catalogItems.includes(n) && !excluded.includes(n)
        );

        // All items with recorded usage, sorted by popularity (descending).
        const popularSorted: string[] = Object.entries(usage)
            .filter(([name, count]) => count > 0 && !excluded.includes(name) && catalogItems.includes(name) && !pinned.includes(name))
            .sort((a, b) => b[1] - a[1])
            .map(([name]) => name);

        // Remaining catalog items not already above — shuffled once so the
        // order is stable for the lifetime of this deal (M for more pages
        // through the same shuffled list).
        const rest = catalogItems.filter(n => !pinned.includes(n) && !popularSorted.includes(n) && !excluded.includes(n));
        const shuffled = [...rest].sort(() => Math.random() - 0.5);

        const all = [...pinned, ...popularSorted, ...shuffled];
        const options = all.slice(0, PICK_LIST_TOP_N);

        return { options, all };
    }

    private formatBondagePickList(slotDisplay: string, wearerName: string, options: string[], page: number, totalPages: number): string {
        const pageNote = totalPages > 1 ? ` (page ${page + 1} of ${totalPages})` : "";
        const lines = [`Slot: ${slotDisplay} — pick an item to apply to ${wearerName}:${pageNote}`];
        options.forEach((name, i) => {
            const newMarker = NEW_ITEMS.has(name) ? " 🆕 new!" : "";
            lines.push(`${i + 1}. ${name}${newMarker}`);
        });
        if (page + 1 < totalPages) lines.push("M. More");
        lines.push("0. Back");
        lines.push("Or type any item name from this slot.");
        return lines.join("\n");
    }

    // Case-insensitive fuzzy match against the slot's catalog: exact (spaces
    // stripped), then startsWith, then includes. Multiple hits ask the
    // placer to clarify. Mirrors bondagePicker.ts's fuzzyMatchItem.
    // `exact: true` is only set for the exact tier — callers use this to
    // decide whether the match needs a yes/no confirmation before it's used.
    private fuzzyMatchBondageItem(group: string, input: string): { match?: string; exact?: boolean; candidates?: string[] } {
        const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
        const q = norm(input);
        if (!q) return {};
        const items = this.itemCatalog.get(group) ?? [];

        const exact = items.filter(n => norm(n) === q);
        if (exact.length >= 1) return { match: exact[0], exact: true };
        const starts = items.filter(n => norm(n).startsWith(q));
        if (starts.length === 1) return { match: starts[0] };
        if (starts.length > 1) return { candidates: starts };
        const includes = items.filter(n => norm(n).includes(q));
        if (includes.length === 1) return { match: includes[0] };
        if (includes.length > 1) return { candidates: includes };
        return {};
    }

    // Entry point from the spend menu ('bondage') and the !bondage shortcut.
    // The winner (placer) always drives this: slot, then item, then price.
    private startBondageDeal(buyer: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(buyer)) return;
        const wearer = state.players.find(p => p.memberNumber !== buyer)!;

        if (this.itemCatalog.size === 0) {
            this.bot.whisper(buyer, "The bondage item catalog isn't available right now — try again later.");
            return;
        }

        const available = this.availableBondageSlotsFor(wearer.memberNumber);
        if (available.length === 0) {
            this.bot.whisper(buyer, `${wearer.name} has no open bondage slots left — every slot already has something applied.`);
            return;
        }

        state.bondageDeal = {
            kind: "apply",
            placer: buyer,
            wearer: wearer.memberNumber,
            slot: null,
            itemName: null,
            itemOptions: [],
            itemOptionsAll: [],
            itemOptionsPage: 0,
            price: null,
            counterPrice: null,
            stage: "awaiting_slot",
            pendingFuzzyItem: null,
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
        };

        this.bot.sendChat(`⛓️ ${this.playerName(buyer)} is looking to apply some bondage to ${wearer.name}...`);
        this.bot.whisper(buyer, `Which slot?\n` + available.map((s, i) => `${i + 1}. ${s.display}`).join("\n") + `\n0. Back`);
    }

    // Entry point for !buybondage <slot>: the wearer initiates, but the
    // placer names the price — same shape as the clothing "buyer" stage,
    // just with the roles who provides input vs. who accepts swapped.
    private handleBuyBondage(sender: number, args: string): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players) return;
        if (this.blockedByWardrobe(sender)) return;

        if (state.clothingDeal || state.bondageDeal) {
            this.bot.whisper(sender, "There's already a deal in progress.");
            return;
        }

        const slotArg = args.trim();
        if (!slotArg) {
            this.bot.whisper(sender, "Usage: !buybondage <slot>");
            return;
        }

        const match = this.findActiveBondage(sender, slotArg, "wearer");
        if (!match) {
            this.bot.whisper(sender, `You don't have any bondage on that slot. Currently worn: ${this.listWornBondage(sender)}`);
            return;
        }

        const slotLock = this.state.activeLocks.find(l => l.wearerMemberNumber === sender && l.slot === match.slot);
        const lockFeeNote = slotLock
            ? ` Note: this slot has a lock — a removal fee of ${this.lockRemovalCost(slotLock)} pts will be added to the final buyout price.`
            : "";

        state.bondageDeal = {
            kind: "removal",
            placer: match.placerMemberNumber,
            wearer: sender,
            slot: match.slot,
            itemName: match.itemName,
            itemOptions: [],
            itemOptionsAll: [],
            itemOptionsPage: 0,
            price: null,
            counterPrice: null,
            stage: "awaiting_price",
            pendingFuzzyItem: null,
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
        };

        const lockNote = slotLock ? ` (slot has a lock — wearer will also pay the ${this.lockRemovalCost(slotLock)} pt lock removal fee)` : "";
        this.bot.whisper(match.placerMemberNumber,
            `${this.playerName(sender)} wants to buy back the ${match.itemName} on their ${match.slot}. How many points do you want to charge for removal?${lockNote}`);
        this.bot.whisper(sender, `⏳ Offer sent to ${this.playerName(match.placerMemberNumber)}. Waiting for their response...${lockFeeNote}`);
    }

    // Shop-menu entry point for a bondage buyout — same deal as !buybondage,
    // just prompting for the slot instead of requiring it as a command
    // argument. Only reachable when the wearer actually has bondage on.
    private startBondageBuyback(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(sender)) return;
        if (this.blockedByWardrobe(sender)) return;

        const worn = state.activeBondage.filter(b => b.wearerMemberNumber === sender);
        if (worn.length === 0) {
            this.bot.whisper(sender, "You don't have any bondage on right now.");
            return;
        }

        state.awaitingBondageBuyback = sender;

        this.bot.sendChat(`💸 ${this.playerName(sender)} is trying to buy their way out of some bondage...`);

        if (worn.length === 1) {
            const b = worn[0];
            const lock = state.activeLocks.find(l => l.wearerMemberNumber === sender && l.slot === b.slot);
            const lockFee = lock ? this.lockRemovalCost(lock) : 0;
            const cost = b.applyPrice * 2 + lockFee;
            const lockNote = lockFee > 0 ? ` (includes ${lockFee} pt lock removal fee)` : "";
            this.bot.whisper(sender,
                `Buy back the ${b.itemName} on your ${b.slot}? Cost: ${cost} points${lockNote}. (yes / no)`);
            return;
        }

        const lines = worn.map((b, i) => {
            const lock = state.activeLocks.find(l => l.wearerMemberNumber === sender && l.slot === b.slot);
            const lockFee = lock ? this.lockRemovalCost(lock) : 0;
            const cost = b.applyPrice * 2 + lockFee;
            const lockNote = lockFee > 0 ? ` (+${lockFee} lock fee)` : "";
            return `${i + 1}. ${b.slot} — ${b.itemName} — ${cost} pts${lockNote}`;
        });
        this.bot.whisper(sender,
            `Which bondage would you like to buy back?\n` +
            lines.join("\n") +
            `\n0. Back`
        );
    }

    // Handles the wearer's numbered (or yes/no) reply to the bondage buyback
    // menu. Deducts 2× applyPrice (+ lock fee if any) from spendingBalance,
    // credits the placer, and removes the item immediately — no negotiation.
    private handleBondageBuybackResponse(sender: number, lower: string, raw: string): void {
        const state = this.state;
        if (!state.players) return;

        const worn = state.activeBondage.filter(b => b.wearerMemberNumber === sender);

        let chosen: typeof worn[0] | null = null;

        if (worn.length === 1) {
            if (lower === "yes" || lower === "y") {
                chosen = worn[0];
            } else if (lower === "no" || lower === "n") {
                state.awaitingBondageBuyback = null;
                this.bot.whisper(sender, "Okay, maybe next time.");
                this.returnToSpendMenu(sender);
                return;
            } else {
                this.bot.whisper(sender, "Please say 'yes' or 'no'.");
                return;
            }
        } else {
            if (raw.trim() === "0") {
                this.handleShopCancel(sender);
                return;
            }
            const num = extractNumber(raw);
            if (num !== null && num >= 1 && num <= worn.length) {
                chosen = worn[num - 1];
            }
            if (!chosen) {
                this.bot.whisper(sender, "Please reply with the number of the item to buy back, or 0 to go back.");
                return;
            }
        }

        const lock = state.activeLocks.find(l => l.wearerMemberNumber === sender && l.slot === chosen!.slot);
        const lockFee = lock ? this.lockRemovalCost(lock) : 0;
        const cost = chosen.applyPrice * 2 + lockFee;

        if (state.spendingBalance < cost) {
            this.bot.whisper(sender,
                `You can't afford that — buying back the ${chosen.itemName} costs ${cost} points and you have ${state.spendingBalance}. Type !cancel to exit the shop.`);
            state.awaitingBondageBuyback = null;
            this.returnToSpendMenu(sender);
            return;
        }

        const placer = state.players.find(p => p.memberNumber === chosen!.placerMemberNumber);
        const half = Math.floor(chosen.applyPrice);

        state.spendingBalance -= cost;
        if (placer) placer.pendingBalance += half;

        if (lock) {
            const lockHalf = Math.floor(lockFee / 2);
            const lockPlacer = state.players.find(p => p.memberNumber === lock.placerMemberNumber);
            if (lockPlacer) lockPlacer.pendingBalance += lockHalf;
            state.activeLocks = state.activeLocks.filter(l => l !== lock);
        }

        const group = this.groupForSlotDisplay(chosen.slot);
        this.bot.removeItem(sender, group);
        state.activeBondage = state.activeBondage.filter(b => b !== chosen);
        if (ALLOW_FREE_REAPPLY && placer) {
            state.removableBondage.push({ ...chosen });
        }
        state.awaitingBondageBuyback = null;

        let msg = `🔓 ${this.playerName(sender)} bought back the ${chosen.itemName} from their ${chosen.slot} for ${cost} points.`;
        if (placer) msg += ` ${placer.name} receives ${half} points (pending — available next Bank).`;
        if (lock) msg += ` Lock removed.`;
        msg += ` (${this.playerName(sender)} has ${state.spendingBalance} points left.)`;
        this.bot.sendChat(msg);

        this.returnToSpendMenu(sender);
    }

    // !removebondage <slot> — free, instant, placer-only.
    private handleRemoveBondage(sender: number, args: string): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players) return;
        if (this.blockedByWardrobe(sender)) return;

        const slotArg = args.trim();
        if (!slotArg) {
            this.bot.whisper(sender, "Usage: !removebondage <slot>");
            return;
        }

        const match = this.findActiveBondage(sender, slotArg, "placer");
        if (!match) {
            this.bot.whisper(sender, `You haven't placed any bondage on that slot. Your placed items: ${this.listPlacedBondage(sender)}`);
            return;
        }

        this.bot.removeItem(match.wearerMemberNumber, this.groupForSlotDisplay(match.slot));
        state.activeBondage = state.activeBondage.filter(b => b !== match);
        state.activeLocks = state.activeLocks.filter(
            l => !(l.wearerMemberNumber === match.wearerMemberNumber && l.slot === match.slot)
        );
        if (ALLOW_FREE_REAPPLY) {
            state.removableBondage.push({ ...match });
        }

        this.bot.sendChat(`🔓 ${this.playerName(sender)} removed the ${match.itemName} from ${this.playerName(match.wearerMemberNumber)}'s ${match.slot} — free of charge.`);
    }

    // !reapplybondage <slot> — free, instant, placer-only, and only for the
    // exact item they just removed from that slot (ALLOW_FREE_REAPPLY).
    private handleReapplyBondage(sender: number, args: string): void {
        if (!ALLOW_FREE_REAPPLY) {
            this.bot.whisper(sender, "Re-applying isn't available right now.");
            return;
        }

        const state = this.state;
        if (state.phase !== "playing" || !state.players) return;
        if (this.blockedByWardrobe(sender)) return;

        const slotArg = args.trim();
        if (!slotArg) {
            this.bot.whisper(sender, "Usage: !reapplybondage <slot>");
            return;
        }

        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const q = norm(slotArg);
        const idx = state.removableBondage.findIndex(b => b.placerMemberNumber === sender && norm(b.slot) === q);
        if (idx === -1) {
            this.bot.whisper(sender, "There's nothing of yours available to re-apply for free on that slot.");
            return;
        }

        const entry = state.removableBondage[idx];
        if (state.activeBondage.some(b => b.wearerMemberNumber === entry.wearerMemberNumber && b.slot === entry.slot)) {
            this.bot.whisper(sender, "That slot already has something applied — can't re-apply there.");
            state.removableBondage.splice(idx, 1);
            return;
        }

        this.bot.applyItem(entry.wearerMemberNumber, this.groupForSlotDisplay(entry.slot), entry.itemName, "Default", { Difficulty: 20 });
        state.activeBondage.push({ ...entry });
        state.removableBondage.splice(idx, 1);

        this.bot.sendChat(`⛓️ ${this.playerName(sender)} re-applied ${entry.itemName} to ${this.playerName(entry.wearerMemberNumber)}'s ${entry.slot} — free of charge.`);
    }

    // Shortcut for the spend menu's 'bondage' option, reachable directly as
    // !bondage without navigating the menu first.
    private handleBondageShortcut(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.config) return;
        if (state.awaitingPostBank !== sender) {
            this.bot.whisper(sender, "You can only buy bondage right after banking — !bank first, then use the shop or !bondage.");
            return;
        }
        if (!state.config.bondage) {
            this.bot.whisper(sender, "Bondage wasn't enabled for this match.");
            return;
        }
        if (this.blockedByWardrobe(sender)) return;
        if (state.clothingDeal || state.bondageDeal) {
            this.bot.whisper(sender, "There's already a deal in progress.");
            return;
        }

        state.spendMenuOpen = true;
        this.startBondageDeal(sender);
    }

    // Dispatches a message to the in-progress bondage deal, if any. Returns
    // true if the message was consumed by the deal flow.
    private handleBondageDealMessage(sender: number, raw: string, lower: string): boolean {
        const deal = this.state.bondageDeal;
        if (!deal) return false;

        switch (deal.stage) {
            case "awaiting_slot":
                if (sender !== deal.placer) return false;
                return this.handleBondageSlotChoice(deal, raw);

            case "awaiting_removal_slot":
                if (sender !== deal.wearer) return false;
                return this.handleBondageRemovalSlotChoice(deal, raw);

            case "awaiting_item":
                if (sender !== deal.placer) return false;
                return this.handleBondageItemChoice(deal, raw);

            case "awaiting_item_confirm":
                if (sender !== deal.placer) return false;
                return this.handleBondageItemConfirm(deal, lower);

            case "awaiting_price":
                if (sender !== deal.placer) return false;
                return this.handleBondagePriceChoice(deal, raw);

            case "awaiting_opponent_response":
                if (sender !== deal.wearer) return false;
                return this.handleBondageWearerResponse(deal, lower);

            case "awaiting_opponent_counter_value":
                if (sender !== deal.wearer) return false;
                return this.handleBondageWearerCounterValue(deal, raw);

            case "awaiting_buyer_counter_response":
                if (sender !== deal.placer) return false;
                return this.handleBondagePlacerCounterResponse(deal, lower);

            case "awaiting_buyer_counter_value":
                if (sender !== deal.placer) return false;
                return this.handleBondagePlacerCounterValue(deal, raw);
        }
    }

    private handleBondageSlotChoice(deal: BondageDeal, raw: string): boolean {
        const wearerName = this.playerName(deal.wearer);
        const available = this.availableBondageSlotsFor(deal.wearer);

        const trimmed = raw.trim();
        if (trimmed === "0") {
            this.handleBondageDealCancel(deal.placer);
            return true;
        }

        const idx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
        const match = (idx !== null && idx >= 1 && idx <= available.length) ? available[idx - 1] : null;
        if (!match) {
            this.bot.whisper(deal.placer,
                `That's not a valid slot number for ${wearerName}. Choose a number:\n` +
                available.map((s, i) => `${i + 1}. ${s.display}`).join("\n") + `\n0. Back`);
            return true;
        }

        const { options, all } = this.buildBondagePickList(match.group, []);
        if (options.length === 0) {
            this.bot.whisper(deal.placer, "No items are available for that slot right now — pick a different one.");
            return true;
        }

        deal.slot = match.display;
        deal.itemOptions = options;
        deal.itemOptionsAll = all;
        deal.itemOptionsPage = 0;
        deal.stage = "awaiting_item";
        const totalPages = Math.ceil(all.length / PICK_LIST_TOP_N);
        this.sendLongWhisper(deal.placer, this.formatBondagePickList(match.display, wearerName, options, 0, totalPages));
        return true;
    }

    // Wearer's slot pick for a shop-menu-initiated buyout (see
    // startBondageBuyback) — mirrors handleBuyBondage's tail once the slot
    // is known: straight to asking the placer for a price, no item pick.
    private handleBondageRemovalSlotChoice(deal: BondageDeal, raw: string): boolean {
        const worn = this.state.activeBondage.filter(b => b.wearerMemberNumber === deal.wearer);

        const trimmed = raw.trim();
        if (trimmed === "0") {
            this.handleBondageDealCancel(deal.wearer);
            return true;
        }

        const idx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
        const match = (idx !== null && idx >= 1 && idx <= worn.length) ? worn[idx - 1] : null;
        if (!match) {
            this.bot.whisper(deal.wearer,
                `That's not a valid number. Choose one:\n` +
                worn.map((b, i) => `${i + 1}. ${b.slot} — ${b.itemName}`).join("\n") + `\n0. Back`);
            return true;
        }

        deal.slot = match.slot;
        deal.itemName = match.itemName;
        deal.stage = "awaiting_price";

        const slotLock = this.state.activeLocks.find(l => l.wearerMemberNumber === deal.wearer && l.slot === match.slot);
        const lockFeeNote = slotLock
            ? ` Note: this slot has a lock — a removal fee of ${this.lockRemovalCost(slotLock)} pts will be added to the final buyout price.`
            : "";
        const lockNote = slotLock ? ` (slot has a lock — wearer will also pay the ${this.lockRemovalCost(slotLock)} pt lock removal fee)` : "";

        this.bot.whisper(deal.placer,
            `${this.playerName(deal.wearer)} wants to buy back the ${match.itemName} on their ${match.slot}. How many points do you want to charge for removal?${lockNote}`);
        this.bot.whisper(deal.wearer, `⏳ Offer sent to ${this.playerName(deal.placer)}. Waiting for their response...${lockFeeNote}`);
        return true;
    }

    private handleBondageItemChoice(deal: BondageDeal, raw: string): boolean {
        const group = this.groupForSlotDisplay(deal.slot!);
        let chosen: string | null = null;

        const trimmed = raw.trim();
        if (trimmed === "0") {
            this.handleBondageDealCancel(deal.placer);
            return true;
        }

        // "M" or "m" — advance to the next page of the item list.
        if (trimmed.toLowerCase() === "m") {
            const allOpts = deal.itemOptionsAll;
            const totalPages = Math.ceil(allOpts.length / PICK_LIST_TOP_N);
            if (totalPages <= 1) {
                this.bot.whisper(deal.placer, "There are no more options for this slot.");
                return true;
            }
            deal.itemOptionsPage = (deal.itemOptionsPage + 1) % totalPages;
            const start = deal.itemOptionsPage * PICK_LIST_TOP_N;
            deal.itemOptions = allOpts.slice(start, start + PICK_LIST_TOP_N);
            const wearerName = this.playerName(deal.wearer);
            this.sendLongWhisper(deal.placer, this.formatBondagePickList(deal.slot!, wearerName, deal.itemOptions, deal.itemOptionsPage, totalPages));
            return true;
        }

        if (/^\d+$/.test(trimmed)) {
            const idx = parseInt(trimmed, 10);
            if (idx >= 1 && idx <= deal.itemOptions.length) {
                chosen = deal.itemOptions[idx - 1];
            } else {
                this.bot.whisper(deal.placer, `Pick a number 1-${deal.itemOptions.length} or type an item name. (0. Back)`);
                return true;
            }
        } else {
            const result = this.fuzzyMatchBondageItem(group, trimmed);
            if (result.match && result.exact) {
                chosen = result.match;
            } else if (result.match) {
                // Only startsWith/includes matched, not exact — confirm
                // with the placer before locking it in.
                deal.pendingFuzzyItem = result.match;
                deal.stage = "awaiting_item_confirm";
                this.bot.whisper(deal.placer, `Did you mean ${result.match}? (yes/no)`);
                return true;
            } else if (result.candidates) {
                this.bot.whisper(deal.placer, `Multiple matches: ${result.candidates.slice(0, 8).join(", ")} — be more specific.`);
                return true;
            } else {
                const totalPages = Math.ceil(deal.itemOptionsAll.length / PICK_LIST_TOP_N);
                const moreHint = totalPages > 1 ? " Type M to browse more options, or" : "";
                this.bot.whisper(deal.placer, `No item matching "${trimmed}" for this slot.${moreHint} type more of the name to search.`);
                return true;
            }
        }

        deal.itemName = chosen;
        deal.stage = "awaiting_price";
        this.bot.whisper(deal.placer, `Got it — ${chosen} for ${this.playerName(deal.wearer)}'s ${deal.slot}. How many points are you offering them?`);
        return true;
    }

    // Placer's yes/no reply to a "Did you mean X?" fuzzy-match confirmation.
    private handleBondageItemConfirm(deal: BondageDeal, lower: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "yes" || trimmed === "y") {
            const chosen = deal.pendingFuzzyItem!;
            deal.itemName = chosen;
            deal.pendingFuzzyItem = null;
            deal.stage = "awaiting_price";
            this.bot.whisper(deal.placer, `Got it — ${chosen} for ${this.playerName(deal.wearer)}'s ${deal.slot}. How many points are you offering them?`);
            return true;
        }
        if (trimmed === "no" || trimmed === "n") {
            deal.pendingFuzzyItem = null;
            deal.stage = "awaiting_item";
            this.bot.whisper(deal.placer, `No problem — type the item name again (or reply with a number from the list).`);
            return true;
        }
        this.bot.whisper(deal.placer, `Did you mean ${deal.pendingFuzzyItem}? Please reply yes or no.`);
        return true;
    }

    private handleBondagePriceChoice(deal: BondageDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === 0) {
            this.handleBondageDealCancel(deal.placer);
            return true;
        }
        if (n === null || n < 0) {
            this.bot.whisper(deal.placer, deal.kind === "apply"
                ? "How many points are you offering?"
                : "How many points do you want to charge?");
            return true;
        }

        // Apply deals spend the placer's banked session balance — same
        // up-front affordability check as proposeClothingDealToOpponent.
        if (deal.kind === "apply" && this.state.spendingBalance < n) {
            this.bot.whisper(deal.placer,
                `You can't afford that — ${n} points is more than your ${this.state.spendingBalance} balance. ` +
                `Offer a lower price, or type !cancel to back out.`);
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.placer, result.error!);
            return true;
        }

        this.proposeBondageDealToOpponent(deal);
        return true;
    }

    private proposeBondageDealToOpponent(deal: BondageDeal): void {
        deal.stage = "awaiting_opponent_response";
        const placerName = this.playerName(deal.placer);
        const wearerName = this.playerName(deal.wearer);

        if (deal.kind === "apply") {
            this.bot.whisper(deal.wearer,
                `${placerName} offers ${deal.price} points to apply ${deal.itemName} to your ${deal.slot} — you'd receive ${Math.floor(deal.price! / 2)} points (pending). ` +
                `Accept? (yes/no, or 'counter <number>')`);
            this.bot.whisper(deal.placer,
                `⏳ Offer sent to ${wearerName}. Waiting for their response...`);
        } else {
            this.bot.whisper(deal.wearer,
                `${placerName} will remove the ${deal.itemName} from your ${deal.slot} for ${deal.price} points. Accept? (yes/no, or 'counter <number>')`);
            this.bot.whisper(deal.placer,
                `⏳ Offer sent to ${wearerName}. Waiting for their response...`);
        }
    }

    private handleBondageWearerResponse(deal: BondageDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeBondageDeal(deal, deal.price!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.placer, "Offer declined.");
            this.state.bondageDeal = null;
            this.returnToSpendMenu(deal.placer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_opponent_counter_value";
                this.bot.whisper(deal.wearer, "What price would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleBondageWearerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.wearer, "Please say 'yes', 'no', or 'counter <number>'.");
        return true;
    }

    private handleBondageWearerCounterValue(deal: BondageDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.wearer, "What price would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyResponderCounter(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.wearer, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.wearer, result.notice);

        if (result.matched) {
            this.finalizeBondageDeal(deal, result.price!);
            return true;
        }

        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.placer, `${this.playerName(deal.wearer)} counters: ${deal.counterPrice} points. Accept, decline, or counter?`);
        return true;
    }

    // The placer can accept, decline, or counter the wearer's counter,
    // continuing the structured negotiation (see applyInitiatorOffer).
    private handleBondagePlacerCounterResponse(deal: BondageDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeBondageDeal(deal, deal.counterPrice!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.wearer, "Offer declined.");
            this.state.bondageDeal = null;
            this.returnToSpendMenu(deal.placer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_buyer_counter_value";
                this.bot.whisper(deal.placer, "What price would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleBondagePlacerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.placer, "Please say 'accept', 'decline', or 'counter <number>'.");
        return true;
    }

    private handleBondagePlacerCounterValue(deal: BondageDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.placer, "What price would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.placer, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.placer, result.notice);

        if (result.final || result.matched) {
            this.finalizeBondageDeal(deal, result.matched ? result.price! : deal.price!);
            return true;
        }

        deal.stage = "awaiting_opponent_response";
        this.bot.whisper(deal.wearer,
            `${this.playerName(deal.placer)} counters: ${deal.price} points. Accept, decline, or counter?`);
        return true;
    }

    // Settles an agreed bondage deal at the final price, with the same money
    // flow as clothing: the payer covers the full price, the other party
    // receives half as pending earnings, and the other half is the bot fee.
    //   - apply:   the placer pays from their banked spendingBalance (they
    //     are the awaitingPostBank player, mid-spend-session); the wearer
    //     receives half.
    //   - removal: the wearer pays from their balance to be freed; the
    //     placer receives half.
    // The item is applied/removed instantly via the BC socket — no
    // wardrobe-check pause, since the bot changes Item* groups directly.
    private finalizeBondageDeal(deal: BondageDeal, price: number): void {
        const state = this.state;
        if (!state.players) return;

        const wearer = state.players.find(p => p.memberNumber === deal.wearer)!;
        const placer = state.players.find(p => p.memberNumber === deal.placer)!;

        if (deal.kind === "apply") {
            if (state.spendingBalance < price) {
                this.bot.whisper(deal.placer, `You can't afford that — ${price} points is more than your ${state.spendingBalance} balance. The deal is off.`);
                this.bot.whisper(deal.wearer, `${placer.name} can't cover ${price} points — the deal is off.`);
                state.bondageDeal = null;
                this.returnToSpendMenu(deal.placer);
                return;
            }
        } else {
            const lock = state.activeLocks.find(l => l.wearerMemberNumber === deal.wearer && l.slot === deal.slot);
            const lockFee = lock ? this.lockRemovalCost(lock) : 0;
            const totalPrice = price + lockFee;

            if (wearer.balance < totalPrice) {
                const breakdown = lockFee > 0 ? ` (bondage: ${price} + lock: ${lockFee})` : "";
                this.bot.whisper(deal.wearer, `You can't afford that — total cost is ${totalPrice} points${breakdown} and you have ${wearer.balance}. The deal is off.`);
                this.bot.whisper(deal.placer, `${wearer.name} can't cover ${totalPrice} points — the deal is off.`);
                state.bondageDeal = null;
                this.returnToSpendMenu(deal.wearer);
                return;
            }
        }

        const half = Math.floor(price / 2);
        const group = this.groupForSlotDisplay(deal.slot!);
        const itemName = deal.itemName!;

        if (deal.kind === "apply") {
            state.spendingBalance -= price;
            wearer.pendingBalance += half;

            this.bot.applyItem(deal.wearer, group, itemName, "Default", { Difficulty: 20 });
            state.activeBondage.push({
                slot: deal.slot!,
                itemName,
                assetName: itemName,
                placerMemberNumber: deal.placer,
                wearerMemberNumber: deal.wearer,
                applyPrice: price,
            });
            this.incrementBondageUsage(group, itemName);
            state.removableBondage = state.removableBondage.filter(
                r => !(r.wearerMemberNumber === deal.wearer && r.slot === deal.slot)
            );

            this.bot.sendChat(`⛓️ Deal! ${placer.name} paid ${price} points to apply ${itemName} to ${wearer.name}'s ${deal.slot}. ${wearer.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points. (${placer.name} has ${state.spendingBalance} points left.)`);
        } else {
            // Check for a lock on this slot — fold its removal fee into the total
            const lock = state.activeLocks.find(l => l.wearerMemberNumber === deal.wearer && l.slot === deal.slot);
            const lockFee = lock ? this.lockRemovalCost(lock) : 0;
            const totalPrice = price + lockFee;

            wearer.balance -= totalPrice;
            placer.pendingBalance += half;

            if (lock) {
                const lockHalf = Math.floor(lockFee / 2);
                const lockPlacer = state.players.find(p => p.memberNumber === lock.placerMemberNumber);
                if (lockPlacer) lockPlacer.pendingBalance += lockHalf;
                state.activeLocks = state.activeLocks.filter(l => l !== lock);
            }

            // Preserve the original apply price before the entry is filtered
            // out, so a free re-apply keeps the same buyback cost basis.
            const removedEntry = state.activeBondage.find(b => b.wearerMemberNumber === deal.wearer && b.slot === deal.slot);
            this.bot.removeItem(deal.wearer, group);
            state.activeBondage = state.activeBondage.filter(b => !(b.wearerMemberNumber === deal.wearer && b.slot === deal.slot));
            if (ALLOW_FREE_REAPPLY) {
                state.removableBondage.push({
                    slot: deal.slot!,
                    itemName,
                    assetName: itemName,
                    placerMemberNumber: deal.placer,
                    wearerMemberNumber: deal.wearer,
                    applyPrice: removedEntry?.applyPrice ?? price,
                });
            }

            let msg = `🔓 Deal! ${wearer.name} paid ${totalPrice} points to have ${itemName} removed from their ${deal.slot}. ${placer.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points.`;
            if (lock) {
                const lockHalf = Math.floor(lockFee / 2);
                msg += ` Lock removed — ${this.playerName(lock.placerMemberNumber)} receives ${lockHalf} points (pending).`;
            }
            msg += ` (${wearer.name} has ${wearer.balance} points left.)`;
            this.bot.sendChat(msg);
        }

        state.bondageDeal = null;
        // For apply deals the placer is the buyer (they spent from spendingBalance).
        // For removal deals the wearer is the buyer (they paid from their own balance
        // to get bondage removed). Return the menu to whoever was in the shop.
        this.returnToSpendMenu(deal.kind === "removal" ? deal.wearer : deal.placer);
    }

    // Physically releases every active bondage item via the BC socket and
    // clears the tracking arrays — used for a force-reset (!reset) or a
    // safeword halt, where both players need to be freed immediately. A normal
    // match end goes through releaseBondageFor() per player instead (winner at
    // deal settlement, both at session end — see finishMatch).
    private releaseAllActiveBondage(): void {
        for (const entry of this.state.activeBondage) {
            this.bot.removeItem(entry.wearerMemberNumber, this.groupForSlotDisplay(entry.slot));
        }
        this.state.activeBondage = [];
        this.state.removableBondage = [];
    }

    // Strips one member's active bondage. Used for the winner the moment an
    // end-game deal settles, and for BOTH players at the end of the session
    // (see finishMatch). Removal is staggered one item at a time
    // (END_GAME_STRIP_STAGGER_MS apart) rather than fired all at once, and each
    // removal is verified against the member's synced appearance, retrying up
    // to END_GAME_STRIP_MAX_ATTEMPTS times before giving up and asking them to
    // remove the item manually. Callers should unlock the member's locks first
    // (releaseLocksFor / releaseAllActiveLocks) — a locked item won't remove.
    private releaseBondageFor(memberNumber: number): void {
        const toRemove = this.state.activeBondage.filter(b => b.wearerMemberNumber === memberNumber);

        toRemove.forEach((entry, i) => {
            setTimeout(() => {
                this.stripWinnerItem(memberNumber, entry.slot, this.groupForSlotDisplay(entry.slot), 1);
            }, i * END_GAME_STRIP_STAGGER_MS);
        });

        this.state.activeBondage = this.state.activeBondage.filter(b => b.wearerMemberNumber !== memberNumber);
        this.state.removableBondage = this.state.removableBondage.filter(b => b.wearerMemberNumber !== memberNumber);
    }

    // Removes one item from the winner and, after a short delay, checks
    // their re-synced appearance to confirm it actually came off. If it's
    // still there, retries (re-sending the removal) up to
    // END_GAME_STRIP_MAX_ATTEMPTS total attempts before whispering the
    // winner to remove it by hand.
    private stripWinnerItem(memberNumber: number, slotDisplay: string, group: string, attempt: number): void {
        this.bot.removeItem(memberNumber, group);

        setTimeout(() => {
            const char = this.roomCharacters.get(memberNumber);
            const stillPresent = char?.Appearance?.some((item: any) => item.Group === group) ?? false;
            if (!stillPresent) return;

            if (attempt >= END_GAME_STRIP_MAX_ATTEMPTS) {
                this.bot.whisper(memberNumber, `I tried to remove your bondage but couldn't free your ${slotDisplay} — you may need to remove it manually.`);
                return;
            }

            this.stripWinnerItem(memberNumber, slotDisplay, group, attempt + 1);
        }, END_GAME_STRIP_VERIFY_DELAY_MS);
    }

    // ============================================================
    // WARDROBE HELPER (see design_wardrobe_helper.md)
    // ============================================================
    //
    // Players often apply bondage BEFORE stripping, ending up bound (can't use
    // their own hands in BC) while still dressed. This lets the bot act as
    // their hands: !stuck takes a garment off, !redress puts a remembered one
    // back. Both are whisper-only and self-target in v1, usable during a match.
    // The bot acts directly when the target's item permissions allow it, and
    // otherwise advises the other player (who may have permission the bot
    // lacks). All of it is driven by passive appearance memory populated from
    // the normal room syncs — see ingestAppearance.

    // A group is "clothing-relevant" iff it isn't a bondage/restraint group
    // (those start with "Item", handled by activeBondage/activeLocks) and isn't
    // a body/cosmetic group in the denylist. See NON_CLOTHING_GROUPS.
    private isClothingGroup(group: string): boolean {
        if (!group) return false;
        if (group.startsWith("Item")) return false;
        return !NON_CLOTHING_GROUPS.has(group);
    }

    // Called for every character sync (before roomCharacters is overwritten, so
    // it can diff the previous appearance against the fresh one). Only tracks
    // the two match participants — that's the only time !stuck/!redress apply,
    // and it bounds the memory to two players. Detects clothing coming off
    // (records it for !redress) and going back on (drops it from the history),
    // and keeps wardrobeItemCache as never-cleared last-known state for exact
    // restoration later.
    private ingestAppearance(memberNumber: number, char: BCCharacter): void {
        if (!this.isMatchParticipant(memberNumber)) return;

        const newAppearance = Array.isArray(char.Appearance) ? char.Appearance : [];
        const prev = this.roomCharacters.get(memberNumber);
        const prevAppearance = Array.isArray(prev?.Appearance) ? prev!.Appearance! : [];

        const wornBefore = new Map<string, BCAppearanceItem>();
        for (const it of prevAppearance) {
            if (it?.Group && it?.Name) wornBefore.set(it.Group, it);
        }
        const wornNow = new Set<string>();
        for (const it of newAppearance) {
            if (it?.Group && it?.Name) wornNow.add(it.Group);
        }

        // Removed: clothing-relevant group worn before, gone now.
        for (const [group, item] of wornBefore) {
            if (!this.isClothingGroup(group)) continue;
            if (!wornNow.has(group)) {
                const record = this.wardrobeItemCache.get(`${memberNumber}:${group}`) ?? item;
                this.recordClothingRemoval(memberNumber, group, record);
            }
        }
        // Restored: clothing-relevant group worn now but not before — drop it
        // from the removal history so a re-equipped item doesn't linger.
        for (const group of wornNow) {
            if (!wornBefore.has(group) && this.isClothingGroup(group)) {
                this.dropFromRemovalHistory(memberNumber, group);
            }
        }

        // Update never-cleared last-known cache from the fresh appearance.
        for (const it of newAppearance) {
            if (it?.Group && it?.Name) {
                this.wardrobeItemCache.set(`${memberNumber}:${it.Group}`, it);
            }
        }
    }

    // Records a detected clothing removal, one entry per group (most-recent
    // wins), most-recent-last.
    private recordClothingRemoval(memberNumber: number, group: string, item: BCAppearanceItem): void {
        const list = (this.removedClothingHistory.get(memberNumber) ?? []).filter(e => e.group !== group);
        list.push({ group, item, removedAt: Date.now() });
        this.removedClothingHistory.set(memberNumber, list);
    }

    private dropFromRemovalHistory(memberNumber: number, group: string): void {
        const list = this.removedClothingHistory.get(memberNumber);
        if (!list) return;
        const filtered = list.filter(e => e.group !== group);
        if (filtered.length) this.removedClothingHistory.set(memberNumber, filtered);
        else this.removedClothingHistory.delete(memberNumber);
    }

    // Cleared on reset / safeword / match end (NOT on reconnect). Leaves
    // wardrobeItemCache in place — it's harmless last-known memory that just
    // re-populates from the next match's syncs.
    private clearWardrobeHelperState(): void {
        if (this.pendingWardrobeAction) {
            clearTimeout(this.pendingWardrobeAction.timer);
            this.pendingWardrobeAction = null;
        }
        this.clearPendingTestRedress();
        this.removedClothingHistory.clear();
        this.lastShopRemovedGroups.clear();
    }

    private clearPendingWardrobeActionFor(memberNumber: number): void {
        if (this.pendingWardrobeAction?.memberNumber === memberNumber) {
            clearTimeout(this.pendingWardrobeAction.timer);
            this.pendingWardrobeAction = null;
        }
    }

    // Whether the bot can directly applyItem/removeItem on this target right
    // now. Mirrors the bondage-club-bot-hub posture: gate on ItemPermission
    // rather than trying to force through a closed one. Level 0 = everyone;
    // 1 = whitelist only (bot must be on it); 2+ = owner/lover/nobody tiers the
    // bot can't satisfy. AllowItem === false is a hard global block.
    private canActOnAppearance(targetMemberNumber: number): boolean {
        const char = this.roomCharacters.get(targetMemberNumber);
        if (!char) return false;
        if (char.OnlineSharedSettings?.AllowItem === false) return false;
        const level = char.ItemPermission ?? 0;
        if (level === 0) return true;
        if (level === 1) return (char.WhiteList ?? []).includes(this.bot.getMemberNumber());
        return false;
    }

    // Clothing-relevant items currently worn (has a Name), from live appearance.
    private wornClothingItems(memberNumber: number): Array<{ group: string; item: BCAppearanceItem }> {
        const char = this.roomCharacters.get(memberNumber);
        const appearance = Array.isArray(char?.Appearance) ? char!.Appearance! : [];
        const out: Array<{ group: string; item: BCAppearanceItem }> = [];
        for (const it of appearance) {
            if (it?.Group && it?.Name && this.isClothingGroup(it.Group)) {
                out.push({ group: it.Group, item: it });
            }
        }
        return out;
    }

    // "Group: Pretty Name" — CamelCase split for ASCII names, non-ASCII (e.g.
    // Chinese item names) passed through unchanged.
    private formatItemLabel(group: string, item: BCAppearanceItem): string {
        const name = item?.Name ?? "(unknown)";
        const pretty = /[^\x00-\x7F]/.test(name) ? name : name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        return `${group}: ${pretty}`;
    }

    // Strips lock-related fields from a stored Property before re-applying an
    // item (a garment that was ever locked shouldn't come back locked). Same
    // lesson as the end-game collar bug — Property is load-bearing.
    private stripPropertyLocks(property: any): any {
        if (!property || typeof property !== "object") return {};
        const {
            LockedBy, LockMemberNumber, LockMemberName, LockSet, Password,
            RemoveItem, RemoveTimer, ShowTimer, EnableRandomInput, MemberNumberList,
            MemberNumberListKeys, CombinationNumber, LockPickSeed, ...rest
        } = property;
        if (Array.isArray(rest.Effect)) {
            rest.Effect = rest.Effect.filter((e: string) => e !== "Lock");
        }
        return rest;
    }

    // Removes one clothing group, then verifies against the next sync and
    // retries (same pattern as stripWinnerItem). Confirms or advises the
    // invoker on the outcome.
    // BC does NOT echo a character's appearance change back to the client that
    // initiated it — a normal client updates its own local copy on send, but
    // this headless bot has none, so our roomCharacters model would otherwise
    // never see a change WE made (confirmed live 2026-07-23: after the bot's
    // applyItem, zero sync events came back). We patch our own model here so
    // the wardrobe cache/history and any read-back stay accurate. Player- and
    // partner-initiated changes are still echoed to us normally and update
    // roomCharacters through the usual sync handlers.
    private patchLocalAppearance(target: number, group: string, item: BCAppearanceItem | null): void {
        const char = this.roomCharacters.get(target);
        if (!char) return;
        const appearance = Array.isArray(char.Appearance) ? char.Appearance.slice() : [];
        const idx = appearance.findIndex((it: any) => it?.Group === group);
        if (item === null) {
            if (idx >= 0) appearance.splice(idx, 1);
        } else if (idx >= 0) {
            appearance[idx] = item;
        } else {
            appearance.push(item);
        }
        this.roomCharacters.set(target, { ...char, Appearance: appearance });
    }

    // `subject` is the possessive used in the confirm whisper — "your" for a
    // player helping themselves, "<name>'s" for an admin acting on someone else.
    private actRemoveClothing(target: number, group: string, invoker: number, subject: string, label: string): void {
        this.bot.removeItem(target, group);
        this.patchLocalAppearance(target, group, null);
        this.bot.whisper(invoker, `✅ Took ${subject} ${label} off.`);
    }

    // Re-applies a remembered clothing item (locks stripped from its property).
    private actRestoreClothing(target: number, entry: RemovedClothingEntry, invoker: number, subject: string, label: string): void {
        const property = this.stripPropertyLocks(entry.item.Property);
        this.bot.applyItem(target, entry.group, entry.item.Name!, entry.item.Color ?? "Default", property);
        this.patchLocalAppearance(target, entry.group, { ...entry.item, Property: property });
        this.dropFromRemovalHistory(target, entry.group);
        this.bot.whisper(invoker, `✅ Put ${subject} ${label} back on.`);
    }

    // Permission closed — ask the other player to do it by hand (they may have
    // Owner/Lover-tier access the bot doesn't).
    private adviseOtherPlayer(stuckPlayer: number, verb: string, group: string, item: BCAppearanceItem): void {
        const other = this.getOtherPlayerMemberNumber(stuckPlayer);
        const stuckName = this.playerName(stuckPlayer);
        const label = this.formatItemLabel(group, item);
        this.bot.whisper(stuckPlayer,
            `Your item permissions won't let me change your clothes directly. ` +
            (other !== null ? `I've asked ${this.playerName(other)} to help with your ${label}.` : `You'll need a hand from your partner.`));
        if (other !== null) {
            this.bot.whisper(other,
                `🧥 ${stuckName} asked me to ${verb} their ${label}, but their item permissions block me. ` +
                `If you can, please ${verb} their ${group} (${item.Name}) by hand.`);
        }
    }

    private promptWardrobeChoice(sender: number, kind: "stuck" | "redress", options: Array<{ group: string; item: BCAppearanceItem }>): void {
        const lines = options.map((o, i) => `${i + 1}. ${this.formatItemLabel(o.group, o.item)}`);
        const verb = kind === "stuck" ? "take off" : "put back on";
        const timer = setTimeout(() => {
            if (this.pendingWardrobeAction?.memberNumber === sender) {
                this.pendingWardrobeAction = null;
                this.bot.whisper(sender, `(Wardrobe pick timed out — whisper !${kind} again if you still need it.)`);
            }
        }, WARDROBE_PICK_TIMEOUT_MS);
        this.pendingWardrobeAction = { memberNumber: sender, kind, options, timer };
        this.bot.whisper(sender,
            `⚠️ Heads up: !${kind} is new and not well tested yet — if anything looks off, whisper !feedback to me or let Missy know if she's around.\n` +
            `Which should I ${verb}? Reply with one or more numbers (e.g. 1 or 1 3):\n${lines.join("\n")}`);
    }

    // Numeric reply to a pending !stuck/!redress pick. Accepts one or more
    // space-separated numbers (e.g. "1" or "1 3"). Routed from
    // handleConversational. Returns true if it consumed the message.
    private resolveWardrobeSelection(sender: number, msg: string): boolean {
        const pending = this.pendingWardrobeAction;
        if (!pending || pending.memberNumber !== sender) return false;
        const trimmed = msg.trim();
        // Must be one or more digit tokens (no other words).
        const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
        if (!tokens.length || !tokens.every(t => /^\d+$/.test(t))) return false;

        const indices = tokens.map(t => parseInt(t, 10));
        const invalid = indices.filter(i => i < 1 || i > pending.options.length);
        if (invalid.length > 0) {
            this.bot.whisper(sender, `Reply with numbers between 1 and ${pending.options.length}.`);
            return true;
        }

        clearTimeout(pending.timer);
        this.pendingWardrobeAction = null;

        // Deduplicate by group so "1 1" doesn't double-remove the same slot.
        const seen = new Set<string>();
        const choices = indices
            .map(i => pending.options[i - 1])
            .filter(c => { if (seen.has(c.group)) return false; seen.add(c.group); return true; });

        for (const choice of choices) {
            if (pending.kind === "stuck") this.resolveStuck(sender, choice);
            else this.resolveRedress(sender, choice);
        }
        return true;
    }

    private resolveStuck(sender: number, choice: { group: string; item: BCAppearanceItem }): void {
        const label = this.formatItemLabel(choice.group, choice.item);
        if (this.canActOnAppearance(sender)) {
            this.bot.whisper(sender, `Getting your ${label} off…`);
            this.actRemoveClothing(sender, choice.group, sender, "your", label);
        } else {
            this.adviseOtherPlayer(sender, "take off", choice.group, choice.item);
        }
    }

    private resolveRedress(sender: number, choice: { group: string; item: BCAppearanceItem }): void {
        const label = this.formatItemLabel(choice.group, choice.item);
        if (this.canActOnAppearance(sender)) {
            this.bot.whisper(sender, `Putting your ${label} back on…`);
            this.actRestoreClothing(sender, { group: choice.group, item: choice.item, removedAt: Date.now() }, sender, "your", label);
        } else {
            this.adviseOtherPlayer(sender, "put back on", choice.group, choice.item);
        }
    }

    // !stuck [description] — take a garment off a bound/stuck player (self, v1).
    private handleStuck(sender: number, args: string): void {
        if (this.state.phase !== "playing" || !this.isMatchParticipant(sender)) {
            this.bot.whisper(sender, "!stuck only works while you're in a match.");
            return;
        }
        this.clearPendingWardrobeActionFor(sender);

        let candidates = this.wornClothingItems(sender);
        if (candidates.length === 0) {
            this.bot.whisper(sender, "You're not wearing anything I can help you out of right now.");
            return;
        }

        const arg = args.trim().toLowerCase();
        if (arg) {
            const needle = arg.replace(/\s+/g, "");
            const filtered = candidates.filter(c =>
                c.group.toLowerCase().includes(arg) ||
                (c.item.Name ?? "").toLowerCase().includes(needle));
            if (filtered.length) candidates = filtered;
        }

        // Float shop-deal groups to the top so the most likely picks are option 1/2.
        const shopGroups = this.lastShopRemovedGroups.get(sender);
        if (shopGroups && shopGroups.length > 0) {
            candidates.sort((a, b) => {
                const aShop = shopGroups.includes(a.group) ? 0 : 1;
                const bShop = shopGroups.includes(b.group) ? 0 : 1;
                return aShop - bShop;
            });
        }

        this.promptWardrobeChoice(sender, "stuck", candidates);
    }

    // !redress [description] — put a remembered garment back on (self, v1).
    private handleRedress(sender: number, args: string): void {
        if (this.state.phase !== "playing" || !this.isMatchParticipant(sender)) {
            this.bot.whisper(sender, "!redress only works while you're in a match.");
            return;
        }
        this.clearPendingWardrobeActionFor(sender);

        // Most-recent-first.
        let history = (this.removedClothingHistory.get(sender) ?? []).slice().reverse();
        if (history.length === 0) {
            this.bot.whisper(sender, "I don't have anything on record to put back on you.");
            return;
        }

        const arg = args.trim().toLowerCase();
        if (arg) {
            const needle = arg.replace(/\s+/g, "");
            const filtered = history.filter(e =>
                e.group.toLowerCase().includes(arg) ||
                (e.item.Name ?? "").toLowerCase().includes(needle));
            if (filtered.length) history = filtered;
        }

        const shopGroups = this.lastShopRemovedGroups.get(sender);

        // Admin shortcut: if we have shop-deal context, auto-apply those items
        // without a menu (this is the "put back what the shop took" fast path).
        if (this.isAdmin(sender) && shopGroups && shopGroups.length > 0) {
            const shopMatches = history.filter(e => shopGroups.includes(e.group));
            if (shopMatches.length > 0) {
                for (const entry of shopMatches) {
                    const label = this.formatItemLabel(entry.group, entry.item);
                    if (this.canActOnAppearance(sender)) {
                        this.actRestoreClothing(sender, entry, sender, "your", label);
                    } else {
                        this.adviseOtherPlayer(sender, "put back on", entry.group, entry.item);
                    }
                }
                return;
            }
        }

        // Float shop-deal groups to the top so the most likely picks are option 1/2.
        if (shopGroups && shopGroups.length > 0) {
            history.sort((a, b) => {
                const aShop = shopGroups.includes(a.group) ? 0 : 1;
                const bShop = shopGroups.includes(b.group) ? 0 : 1;
                return aShop - bShop;
            });
        }

        const options = history.map(e => ({ group: e.group, item: e.item }));
        this.promptWardrobeChoice(sender, "redress", options);
    }

    // !teststrip [@name] [group] — admin-only. Reports the act-or-advise
    // verdict and worn clothing for a target, and (if a group is named) tries
    // to remove it, so DW can confirm live whether the bot can strip clothing
    // off a BOUND player before the rest of the feature is trusted. See
    // design_wardrobe_helper.md §7.
    private handleTestStrip(sender: number, args: string): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const nameTok = tokens.find(t => t.startsWith("@"));
        let target = sender;
        if (nameTok) {
            const matches = this.findPlayersByName(nameTok.replace(/^@/, ""), -1);
            if (matches.length === 0) {
                this.bot.whisper(sender, `No one named "${nameTok.replace(/^@/, "")}" found in the room.`);
                return;
            }
            if (matches.length > 1) {
                this.bot.whisper(sender, `Multiple people match "${nameTok.replace(/^@/, "")}" — be more specific.`);
                return;
            }
            target = matches[0].memberNumber;
        }
        const groupTok = tokens.find(t => t !== nameTok);

        const targetName = this.roomMembers.get(target)?.name ?? `Player #${target}`;
        const char = this.roomCharacters.get(target);
        const perm = char?.ItemPermission ?? 0;
        const allowItem = char?.OnlineSharedSettings?.AllowItem;
        const verdict = this.canActOnAppearance(target);
        const candidates = this.wornClothingItems(target);

        this.bot.whisper(sender,
            `🔧 teststrip ${targetName}: canAct=${verdict} (ItemPermission=${perm}, AllowItem=${allowItem === false ? "false" : "true/unset"}).`);
        this.bot.whisper(sender,
            candidates.length > 0
                ? `Worn clothing (${candidates.length}): ${candidates.map((c, i) => `${i + 1}. ${this.formatItemLabel(c.group, c.item)}`).join("  |  ")}`
                : `No clothing-relevant groups currently worn.`);

        if (groupTok) {
            const match = candidates.find(c => c.group.toLowerCase() === groupTok.toLowerCase());
            if (!match) {
                this.bot.whisper(sender, `No worn clothing group "${groupTok}" on ${targetName}. Use an exact Group name from the list above.`);
                return;
            }
            this.bot.whisper(sender, `Removing ${match.group} from ${targetName} — check their character to confirm.`);
            // Remember what we took off so !testredress can put it back, even
            // outside a match (ingestAppearance only records for participants).
            this.recordClothingRemoval(target, match.group, match.item);
            this.actRemoveClothing(target, match.group, sender, `${targetName}'s`, this.formatItemLabel(match.group, match.item));
        }
    }

    // !testredress @name [number|group] — admin-only mirror of !teststrip for
    // the restore path. With no selector it whispers the target's removed-
    // clothing history as a numbered list and waits for the admin to reply with
    // a number. A selector (a number, or a group/name fragment like "bra")
    // restores that item straight away. Attempts the apply regardless of the
    // target's permission — the point is to test whether restore works.
    private handleTestRedress(sender: number, args: string): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const nameTok = tokens.find(t => t.startsWith("@"));
        let target = sender;
        if (nameTok) {
            const matches = this.findPlayersByName(nameTok.replace(/^@/, ""), -1);
            if (matches.length === 0) {
                this.bot.whisper(sender, `No one named "${nameTok.replace(/^@/, "")}" found in the room.`);
                return;
            }
            if (matches.length > 1) {
                this.bot.whisper(sender, `Multiple people match "${nameTok.replace(/^@/, "")}" — be more specific.`);
                return;
            }
            target = matches[0].memberNumber;
        }
        const selector = tokens.filter(t => t !== nameTok).join(" ").trim();

        const targetName = this.roomMembers.get(target)?.name ?? `Player #${target}`;
        // Most-recent-first, matching !redress.
        const options = (this.removedClothingHistory.get(target) ?? [])
            .slice().reverse()
            .map(e => ({ group: e.group, item: e.item }));
        if (options.length === 0) {
            this.bot.whisper(sender, `No removed-clothing history for ${targetName}. Take something off first (e.g. !teststrip @${targetName} <group>).`);
            return;
        }

        if (selector) {
            let choice: { group: string; item: BCAppearanceItem } | undefined;
            if (/^\d+$/.test(selector)) {
                const idx = parseInt(selector, 10);
                if (idx < 1 || idx > options.length) {
                    this.bot.whisper(sender, `Pick a number between 1 and ${options.length}.`);
                    return;
                }
                choice = options[idx - 1];
            } else {
                const needle = selector.toLowerCase().replace(/\s+/g, "");
                choice = options.find(o =>
                    o.group.toLowerCase().includes(selector.toLowerCase()) ||
                    (o.item.Name ?? "").toLowerCase().includes(needle));
                if (!choice) {
                    this.bot.whisper(sender, `Nothing in ${targetName}'s removed history matches "${selector}".`);
                    return;
                }
            }
            this.restoreTestRedressChoice(sender, target, targetName, choice);
            return;
        }

        // No selector — show the numbered list and wait for a reply.
        this.clearPendingTestRedress();
        const lines = options.map((o, i) => `${i + 1}. ${this.formatItemLabel(o.group, o.item)}`);
        const timer = setTimeout(() => {
            if (this.pendingTestRedress?.adminNumber === sender) {
                this.pendingTestRedress = null;
                this.bot.whisper(sender, "(testredress pick timed out.)");
            }
        }, WARDROBE_PICK_TIMEOUT_MS);
        this.pendingTestRedress = { adminNumber: sender, target, options, timer };
        this.bot.whisper(sender,
            `🔧 ${targetName}'s removed clothing — reply with a number (or re-run with the number/name):\n${lines.join("\n")}`);
    }

    // Resolves an admin's numeric reply to a pending !testredress list. Returns
    // true if it consumed the message.
    private resolveTestRedressSelection(sender: number, msg: string): boolean {
        const pending = this.pendingTestRedress;
        if (!pending || pending.adminNumber !== sender) return false;
        const trimmed = msg.trim();
        if (!/^\d+$/.test(trimmed)) return false;
        const idx = parseInt(trimmed, 10);
        if (idx < 1 || idx > pending.options.length) {
            this.bot.whisper(sender, `Reply with a number between 1 and ${pending.options.length}.`);
            return true;
        }
        const choice = pending.options[idx - 1];
        const targetName = this.roomMembers.get(pending.target)?.name ?? `Player #${pending.target}`;
        clearTimeout(pending.timer);
        const target = pending.target;
        this.pendingTestRedress = null;
        this.restoreTestRedressChoice(sender, target, targetName, choice);
        return true;
    }

    private restoreTestRedressChoice(admin: number, target: number, targetName: string, choice: { group: string; item: BCAppearanceItem }): void {
        const label = this.formatItemLabel(choice.group, choice.item);
        this.bot.whisper(admin, `Restoring ${choice.group} on ${targetName} — check their character to confirm.`);
        this.actRestoreClothing(target, { group: choice.group, item: choice.item, removedAt: Date.now() }, admin, `${targetName}'s`, label);
    }

    private clearPendingTestRedress(): void {
        if (this.pendingTestRedress) {
            clearTimeout(this.pendingTestRedress.timer);
            this.pendingTestRedress = null;
        }
    }

    // !testonline [@name|memberNumber] — admin-only matchmaking probe (see
    // design_matchmaking.md). Friends the target, then asks BC which friends
    // are online (AccountQuery/OnlineFriends) and reports whether the target
    // shows up. Answers two unknowns: does the query work at all, and is a
    // one-directional friend (bot → player) enough for BC to report presence,
    // or does the player have to friend the bot back?
    private async handleTestOnline(sender: number, args: string): Promise<void> {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        // Resolve target: a raw member number, an @name, or default to sender.
        let target = sender;
        const tok = args.trim();
        if (tok) {
            if (/^\d{3,}$/.test(tok)) {
                target = Number(tok);
            } else {
                const matches = this.findPlayersByName(tok.replace(/^@/, ""), -1);
                if (matches.length === 0) {
                    this.bot.whisper(sender, `No one named "${tok.replace(/^@/, "")}" found in the room (or pass a member number).`);
                    return;
                }
                if (matches.length > 1) {
                    this.bot.whisper(sender, `Multiple people match "${tok.replace(/^@/, "")}" — be more specific or pass a member number.`);
                    return;
                }
                target = matches[0].memberNumber;
            }
        }

        const alreadyFriend = this.bot.isFriend(target);
        const added = this.bot.addFriend(target);
        this.bot.whisper(sender,
            `🔧 Friend step: ${added ? `friended #${target}` : (alreadyFriend ? `#${target} already a friend` : `couldn't friend #${target}`)}. Querying BC for online friends…`);

        const online = await this.bot.queryOnlineFriends();
        const isOnline = online.some((f: any) => f?.MemberNumber === target);
        const list = online.map((f: any) =>
            `${f?.MemberName ?? "?"} #${f?.MemberNumber}${f?.ChatRoomName ? ` in "${f.ChatRoomName}"` : ""}`);

        this.bot.whisper(sender, `AccountQuery returned ${online.length} online friend(s): ${list.join(" | ") || "(none)"}.`);
        this.bot.whisper(sender,
            isOnline
                ? `✅ #${target} IS shown online — one-directional friending is enough for presence.`
                : `❌ #${target} is NOT in the online list. Either they're offline, or BC needs them to friend the bot back (mutual). Full raw result is in the log (AccountQueryResult).`);
    }

    // Incoming beep handler (wired in index.ts). For now this is a probe: it
    // logs the exact shape of every incoming beep — especially a reply to a
    // bot-sent beep — so the matchmaking relay can rely on the right fields
    // (sender, message, room). See design_matchmaking.md "Reply relay".
    public onAccountBeep(data: any): void {
        const from = data?.MemberNumber;
        const name = data?.MemberName ?? "?";
        const msg = data?.Message;
        const room = data?.ChatRoomName ?? "";
        const msgStr = typeof msg === "string" ? msg : `[${typeof msg}]`;
        log(`INCOMING BEEP from ${name} (#${from})${room ? ` [room: ${room}]` : ""}: "${msgStr}"`);

        // Matchmaking reply relay: only human text beeps (string Message) from
        // someone we beeped for an active !looking call. Addon beeps (object
        // Message, e.g. GGC_BEEP) are ignored.
        if (typeof from === "number" && typeof msg === "string") {
            this.relayLookingReply(from, name, msg);
        }
    }

    // !testbeep <@name|memberNumber> [message] — admin-only. Sends a beep to
    // the target (with a message) so we can confirm (a) beeps arrive and (b)
    // the Message text rides along. Have the target REPLY to see the incoming
    // shape via onAccountBeep. See design_matchmaking.md build notes.
    private handleTestBeep(sender: number, args: string): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const tokens = args.trim().split(/\s+/).filter(Boolean);
        if (tokens.length === 0) {
            this.bot.whisper(sender, "Usage: !testbeep <@name|memberNumber> [message]");
            return;
        }

        const first = tokens[0];
        let target: number;
        if (/^@?\d{3,}$/.test(first)) {
            target = Number(first.replace(/^@/, ""));
        } else {
            const matches = this.findPlayersByName(first.replace(/^@/, ""), -1);
            if (matches.length === 0) {
                this.bot.whisper(sender, `No one named "${first.replace(/^@/, "")}" found in the room (or pass a member number).`);
                return;
            }
            if (matches.length > 1) {
                this.bot.whisper(sender, `Multiple people match "${first.replace(/^@/, "")}" — be more specific or pass a member number.`);
                return;
            }
            target = matches[0].memberNumber;
        }

        const message = tokens.slice(1).join(" ") || "WinnersDice test beep — reply to this so we can check the reply path.";
        this.bot.beep(target, message);
        const targetName = this.roomMembers.get(target)?.name ?? `#${target}`;
        this.bot.whisper(sender,
            `🔧 Beeped ${targetName} (#${target}) with: "${message}". Check that it arrived WITH the text, then have them reply — I'll echo the incoming beep here and log its shape.`);
    }

    // ============================================================
    // LOCKS (spend menu)
    // ============================================================

    // Property for an Exclusive lock, applied by re-sending the same item
    // with this Property added — mirrors how bondage items are otherwise
    // applied here (Name/Color unchanged, Property is the only thing that
    // changes). "ExclusivePadlock" is the LockedBy value BC uses for its own
    // Exclusive Padlock asset (see bc_items.json's ItemMisc list); the bot
    // sets it directly rather than requiring a real Exclusive Padlock item,
    // and bypasses BC's own removal permissions entirely on both ends.
    private buildLockProperty(): any {
        return {
            Effect: ["Lock"],
            Difficulty: 20,
            LockedBy: "ExclusivePadlock",
            LockMemberNumber: this.bot.getMemberNumber(),
            LockMemberName: secrets.username,
            LockSet: true,
            EnableRandomInput: false,
            MemberNumberList: [],
        };
    }

    // This wearer's active bondage slots that aren't already locked —
    // what a placer can choose from when starting a lock purchase.
    private lockableBondageSlotsFor(wearerMemberNumber: number): ActiveBondage[] {
        const locked = new Set(
            this.state.activeLocks.filter(l => l.wearerMemberNumber === wearerMemberNumber).map(l => l.slot)
        );
        return this.state.activeBondage.filter(b => b.wearerMemberNumber === wearerMemberNumber && !locked.has(b.slot));
    }

    private activeLocksFor(wearerMemberNumber: number): ActiveLock[] {
        return this.state.activeLocks.filter(l => l.wearerMemberNumber === wearerMemberNumber);
    }

    // Removal costs a fixed multiple of the price agreed when the lock deal
    // was struck — same multiplier as clothing buyback (LOCK_REMOVAL_MULTIPLIER).
    private lockRemovalCost(lock: ActiveLock): number {
        return lock.agreedPrice * LOCK_REMOVAL_MULTIPLIER;
    }

    // Entry point from the spend menu's 'locks' option. The placer picks a
    // slot (or "all"), then proposes a removal price; the wearer can accept,
    // decline, or counter once — same negotiation shape as a bondage "apply"
    // deal. Only on acceptance are the lock(s) actually applied.
    private startLockDeal(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(sender)) return;
        const wearer = state.players.find(p => p.memberNumber !== sender)!;

        const lockable = this.lockableBondageSlotsFor(wearer.memberNumber);
        if (lockable.length === 0) {
            this.bot.whisper(sender, `${wearer.name} has no unlocked bondage to lock right now.`);
            return;
        }

        state.lockDeal = {
            placer: sender,
            wearer: wearer.memberNumber,
            slots: [],
            price: null,
            counterPrice: null,
            stage: "awaiting_slot",
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
        };
        this.bot.sendChat(`🔒 ${this.playerName(sender)} is eyeing a lock for ${this.playerName(wearer.memberNumber)}'s situation...`);
        this.bot.whisper(sender,
            `Which of ${wearer.name}'s items should get an Exclusive lock?\n` +
            lockable.map((b, i) => `${i + 1}. ${b.slot} — ${b.itemName}`).join("\n") +
            `\n${lockable.length + 1}. All of the above\n` +
            `0. Back\n` +
            `Reply with a number.`
        );
    }

    // Dispatches a message to the in-progress lock deal, if any. Returns true
    // if the message was consumed by the deal flow.
    private handleLockDealMessage(sender: number, raw: string, lower: string): boolean {
        const deal = this.state.lockDeal;
        if (!deal) return false;

        switch (deal.stage) {
            case "awaiting_slot":
                if (sender !== deal.placer) return false;
                return this.handleLockSlotChoice(deal, lower);

            case "awaiting_price":
                if (sender !== deal.placer) return false;
                return this.handleLockPriceChoice(deal, raw);

            case "awaiting_opponent_response":
                if (sender !== deal.wearer) return false;
                return this.handleLockWearerResponse(deal, lower);

            case "awaiting_opponent_counter_value":
                if (sender !== deal.wearer) return false;
                return this.handleLockWearerCounterValue(deal, raw);

            case "awaiting_buyer_counter_response":
                if (sender !== deal.placer) return false;
                return this.handleLockPlacerCounterResponse(deal, lower);

            case "awaiting_buyer_counter_value":
                if (sender !== deal.placer) return false;
                return this.handleLockPlacerCounterValue(deal, raw);
        }
    }

    private handleLockSlotChoice(deal: LockDeal, lower: string): boolean {
        if (lower.trim() === "0") {
            this.handleLockDealCancel(deal.placer);
            return true;
        }

        const lockable = this.lockableBondageSlotsFor(deal.wearer);
        if (lockable.length === 0) {
            this.state.lockDeal = null;
            this.bot.whisper(deal.placer, "There's nothing left to lock.");
            this.returnToSpendMenu(deal.placer);
            return true;
        }

        const idx = /^\d+$/.test(lower) ? parseInt(lower, 10) : null;
        if (idx !== null && idx >= 1 && idx <= lockable.length) {
            deal.slots = [lockable[idx - 1].slot];
        } else if ((idx !== null && idx === lockable.length + 1) || lower === "all") {
            deal.slots = lockable.map(b => b.slot);
        } else {
            this.bot.whisper(deal.placer, `Reply with a number 1-${lockable.length + 1} (or "all"), or 0 to go back.`);
            return true;
        }

        deal.stage = "awaiting_price";
        this.bot.whisper(deal.placer,
            `How much do you want to pay to lock ${this.playerName(deal.wearer)}'s ${deal.slots.join(", ")}? ${this.playerName(deal.wearer)} can accept, decline, or counter. (0 to back out)\nNote: the wearer can remove the lock later for 2× this price from their post-bank menu.`);
        return true;
    }

    private handleLockPriceChoice(deal: LockDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === 0) {
            this.handleLockDealCancel(deal.placer);
            return true;
        }
        if (n === null || n < 0) {
            this.bot.whisper(deal.placer, "How many points should removal cost?");
            return true;
        }

        if (this.state.spendingBalance < n) {
            this.bot.whisper(deal.placer,
                `You can't afford that — ${n} points is more than your ${this.state.spendingBalance} balance. ` +
                `Offer a lower price, or type !cancel to back out.`);
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.placer, result.error!);
            return true;
        }

        this.proposeLockDealToOpponent(deal);
        return true;
    }

    private proposeLockDealToOpponent(deal: LockDeal): void {
        deal.stage = "awaiting_opponent_response";
        const placerName = this.playerName(deal.placer);
        const wearerName = this.playerName(deal.wearer);
        const lockedList = deal.slots.join(", ");

        this.bot.whisper(deal.wearer,
            `${placerName} wants to pay ${deal.price} points to lock your ${lockedList}. You'll receive ${Math.floor(deal.price! / 2)} points (pending). You can remove the lock anytime from your post-bank menu for ${deal.price! * 2} points. Accept? (yes/no, or 'counter <number>')`);
        this.bot.whisper(deal.placer,
            `⏳ Your lock offer (pay ${deal.price} pts to lock ${lockedList}) has been sent to ${wearerName}. Waiting for their response...`);
    }

    private handleLockWearerResponse(deal: LockDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeLockDeal(deal, deal.price!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.placer, "Lock offer declined.");
            this.state.lockDeal = null;
            this.returnToSpendMenu(deal.placer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_opponent_counter_value";
                this.bot.whisper(deal.wearer, `What price would you like to counter with to lock ${deal.slots.join(", ")}? (removal will cost 2× that)` + counterOfferHint(deal));
                return true;
            }
            return this.handleLockWearerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.wearer, "Please say 'yes', 'no', or 'counter <number>'.");
        return true;
    }

    private handleLockWearerCounterValue(deal: LockDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.wearer, `What price would you like to counter with to lock ${deal.slots.join(", ")}? (removal will cost 2× that)` + counterOfferHint(deal));
            return true;
        }

        const result = applyResponderCounter(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.wearer, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.wearer, result.notice);

        if (result.matched) {
            this.finalizeLockDeal(deal, result.price!);
            return true;
        }

        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.placer, `${this.playerName(deal.wearer)} counters: ${deal.counterPrice} points to lock. Accept, decline, or counter?`);
        return true;
    }

    // The placer can accept, decline, or counter the wearer's counter,
    // continuing the structured negotiation (see applyInitiatorOffer).
    private handleLockPlacerCounterResponse(deal: LockDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeLockDeal(deal, deal.counterPrice!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.wearer, "Offer declined.");
            this.state.lockDeal = null;
            this.returnToSpendMenu(deal.placer);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_buyer_counter_value";
                this.bot.whisper(deal.placer, `What price would you like to counter with to lock ${deal.slots.join(", ")}? (removal will cost 2× that)` + counterOfferHint(deal));
                return true;
            }
            return this.handleLockPlacerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.placer, "Please say 'accept', 'decline', or 'counter <number>'.");
        return true;
    }

    private handleLockPlacerCounterValue(deal: LockDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.placer, `What price would you like to counter with to lock ${deal.slots.join(", ")}? (removal will cost 2× that)` + counterOfferHint(deal));
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.placer, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.placer, result.notice);

        if (result.final || result.matched) {
            this.finalizeLockDeal(deal, result.matched ? result.price! : deal.price!);
            return true;
        }

        deal.stage = "awaiting_opponent_response";
        this.bot.whisper(deal.wearer,
            `${this.playerName(deal.placer)} counters: ${deal.price} points to lock. Accept, decline, or counter?`);
        return true;
    }

    // Settles an agreed lock deal: the placer pays the negotiated price now
    // (same money flow as any other shop purchase — half to the wearer as
    // pending, half as bot fee), then applies the Exclusive lock(s) and
    // records the agreed price on each ActiveLock so the later removal cost
    // can be computed (see lockRemovalCost).
    private finalizeLockDeal(deal: LockDeal, price: number): void {
        const state = this.state;
        if (!state.players) return;

        if (state.spendingBalance < price) {
            this.bot.whisper(deal.placer, `You can't afford that — ${price} points is more than your ${state.spendingBalance} balance. The deal is off.`);
            this.bot.whisper(deal.wearer, `${this.playerName(deal.placer)} can't cover ${price} points — the deal is off.`);
            state.lockDeal = null;
            this.returnToSpendMenu(deal.placer);
            return;
        }

        state.lockDeal = null;

        const placerName = this.playerName(deal.placer);
        const wearerName = this.playerName(deal.wearer);
        const wearer = state.players.find(p => p.memberNumber === deal.wearer)!;
        const lockProperty = this.buildLockProperty();
        const half = Math.floor(price / 2);
        const removalCost = price * LOCK_REMOVAL_MULTIPLIER;

        state.spendingBalance -= price;
        wearer.pendingBalance += half;

        for (const slotDisplay of deal.slots) {
            const entry = state.activeBondage.find(b => b.wearerMemberNumber === deal.wearer && b.slot === slotDisplay);
            if (!entry) continue; // slot changed since it was picked — skip it

            this.bot.applyItem(deal.wearer, this.groupForSlotDisplay(slotDisplay), entry.itemName, "Default", lockProperty);
            state.activeLocks.push({
                slot: slotDisplay,
                placerMemberNumber: deal.placer,
                wearerMemberNumber: deal.wearer,
                agreedPrice: price,
            });
        }

        const lockedList = deal.slots.join(", ");
        this.bot.sendChat(`🔒 ${placerName} paid ${price} points to lock ${wearerName}'s ${lockedList}. ${wearerName} receives ${half} points (pending — available next Bank). Removal costs ${removalCost} points. (${placerName} has ${state.spendingBalance} points left.)`);
        this.bot.whisper(deal.wearer, `Pay ${removalCost} points from your post-bank menu ("remove locks") to have it removed anytime.`);

        this.returnToSpendMenu(deal.placer);
    }

    // Instant, no-negotiation lock removal from the wearer's top-level
    // post-bank prompt — pays the pre-set price(s) in one go, no need to wait
    // on the placer (unlike !buybondage, which is blocked on locked slots).
    private handleRemoveLocksPayment(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        const wearer = state.players.find(p => p.memberNumber === sender)!;

        const locks = this.activeLocksFor(sender);
        if (locks.length === 0) {
            this.bot.whisper(sender, "You don't have any locks to remove.");
            this.bot.whisper(sender, this.postBankPromptText(sender));
            return;
        }

        const total = locks.reduce((sum, l) => sum + this.lockRemovalCost(l), 0);
        if (state.spendingBalance < total) {
            this.bot.whisper(sender, `Insufficient balance — removing your lock(s) costs ${total} points and you have ${state.spendingBalance}.`);
            this.bot.whisper(sender, this.postBankPromptText(sender));
            return;
        }

        state.spendingBalance -= total;
        for (const lock of locks) {
            const placer = state.players.find(p => p.memberNumber === lock.placerMemberNumber);
            if (placer) placer.pendingBalance += Math.floor(this.lockRemovalCost(lock) / 2);

            const entry = state.activeBondage.find(b => b.wearerMemberNumber === sender && b.slot === lock.slot);
            if (entry) {
                this.bot.applyItem(sender, this.groupForSlotDisplay(lock.slot), entry.itemName, "Default", {});
            }
        }

        const removedSlots = locks.map(l => l.slot).join(", ");
        state.activeLocks = state.activeLocks.filter(l => l.wearerMemberNumber !== sender);

        this.bot.sendChat(`🔓 ${wearer.name} paid ${total} points to have their locked ${removedSlots} unlocked. (${wearer.name} has ${state.spendingBalance} points left.)`);
        this.bot.whisper(sender, this.postBankPromptText(sender));
    }

    // Physically unlocks every active lock (re-applies the same item with an
    // empty Property, same as a normal unlock) and clears the tracking array —
    // called alongside releaseAllActiveBondage() when a match ends, is
    // force-reset, or halted by a safeword. Runs before releaseAllActiveBondage()
    // strips the items outright, so the unlock call still has a real item to
    // re-apply to.
    private releaseAllActiveLocks(): void {
        for (const entry of this.state.activeLocks) {
            const item = this.state.activeBondage.find(
                b => b.wearerMemberNumber === entry.wearerMemberNumber && b.slot === entry.slot
            );
            if (item) {
                this.bot.applyItem(entry.wearerMemberNumber, this.groupForSlotDisplay(entry.slot), item.itemName, "Default", {});
            }
        }
        this.state.activeLocks = [];
    }

    // Unlocks only one member's active locks (re-applying each item with no
    // lock property, same mechanism as releaseAllActiveLocks), leaving everyone
    // else's in place. Used at end-game settlement so the winner's bondage can
    // actually be removed — BC won't removeItem a locked item, so the winner
    // would otherwise stay bound whenever the loser had paid to lock them
    // during the match. The loser's locks are untouched (the end-game leash
    // lock is meant to keep them bound for the agreed time).
    private releaseLocksFor(memberNumber: number): void {
        const remaining: typeof this.state.activeLocks = [];
        for (const entry of this.state.activeLocks) {
            if (entry.wearerMemberNumber !== memberNumber) {
                remaining.push(entry);
                continue;
            }
            const item = this.state.activeBondage.find(
                b => b.wearerMemberNumber === entry.wearerMemberNumber && b.slot === entry.slot
            );
            if (item) {
                this.bot.applyItem(entry.wearerMemberNumber, this.groupForSlotDisplay(entry.slot), item.itemName, "Default", {});
            }
        }
        this.state.activeLocks = remaining;
    }

    // ============================================================
    // TOYS (spend menu)
    // ============================================================
    //
    // The winner picks a toy and proposes a price for the loser's consent,
    // negotiated through the same structured 5-step price negotiation as
    // bondage/lock deals (applyInitiatorOffer/applyResponderCounter) —
    // except the loser can only accept or counter, never decline outright
    // (see handleToyLoserResponse). Once the price is agreed, the winner
    // picks a duration and the toy is placed on the WINNER's ItemHandheld
    // slot (not the loser's) for that long, then auto-removed via a
    // real-time setTimeout.
    // ============================================================

    // Case-insensitive fuzzy match against the full toy catalog: exact
    // (spaces stripped), then startsWith, then includes. Multiple hits ask
    // the winner to clarify. Mirrors fuzzyMatchBondageItem. `exact: true` is
    // only set for the exact tier — callers use this to decide whether the
    // match needs a yes/no confirmation before it's used.
    private fuzzyMatchToy(input: string): { match?: ToyCatalogEntry; exact?: boolean; candidates?: ToyCatalogEntry[] } {
        const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
        const q = norm(input);
        if (!q) return {};

        const exact = this.toyCatalog.filter(t => norm(t.label) === q);
        if (exact.length >= 1) return { match: exact[0], exact: true };
        const starts = this.toyCatalog.filter(t => norm(t.label).startsWith(q));
        if (starts.length === 1) return { match: starts[0] };
        if (starts.length > 1) return { candidates: starts };
        const includes = this.toyCatalog.filter(t => norm(t.label).includes(q));
        if (includes.length === 1) return { match: includes[0] };
        if (includes.length > 1) return { candidates: includes };
        return {};
    }

    // Curated popular toys followed by shuffled remainder — mirrors
    // buildBondagePickList's all/options pattern so "M for more" can page
    // through the full catalog without re-randomising.
    private buildToyPickList(): { options: ToyCatalogEntry[]; all: ToyCatalogEntry[] } {
        const popular = POPULAR_TOY_ASSET_NAMES
            .map(name => this.toyCatalog.find(t => t.assetName === name))
            .filter((t): t is ToyCatalogEntry => t !== undefined);

        const rest = this.toyCatalog.filter(t => !popular.includes(t));
        const shuffled = [...rest].sort(() => Math.random() - 0.5);

        const all = [...popular, ...shuffled];
        const options = all.slice(0, PICK_LIST_TOP_N);

        return { options, all };
    }

    private formatToyPickList(options: ToyCatalogEntry[], page: number, totalPages: number): string {
        const pageNote = totalPages > 1 ? ` (page ${page + 1} of ${totalPages})` : "";
        const lines = [`Pick a toy:${pageNote}`];
        options.forEach((t, i) => {
            lines.push(`${i + 1}. ${t.label}`);
        });
        if (page + 1 < totalPages) lines.push("M. More");
        lines.push("0. Back");
        lines.push(`Or type any toy name.`);
        return lines.join("\n");
    }

    private formatFullToyList(): string {
        return `Full toy catalog:\n` +
            this.toyCatalog.map((t, i) => `${i + 1}. ${t.label}`).join("\n") +
            `\n0. Back` +
            `\nOr type any toy name.`;
    }

    // Entry point from the spend menu's 'toys' option. The winner picks a
    // toy, then proposes a price; the loser can accept or counter (never
    // decline) — same negotiation shape as a bondage "apply" deal.
    private startToyDeal(winner: number): void {
        const state = this.state;
        if (!state.players) return;
        if (this.blockedByShopDeal(winner)) return;
        if (this.toyCatalog.length === 0) {
            this.bot.whisper(winner, "The toy catalog isn't available right now — try again later.");
            return;
        }
        if (state.activeToy) {
            this.bot.whisper(winner, "You're already holding something — your hand is full.");
            return;
        }
        if (state.activeBondage.some(b => b.wearerMemberNumber === winner && b.slot === "Hands")) {
            this.bot.whisper(winner, "Your hands are restrained — you can't hold a toy right now.");
            return;
        }

        const loser = state.players.find(p => p.memberNumber !== winner)!;
        const { options, all } = this.buildToyPickList();
        const totalPages = Math.ceil(all.length / PICK_LIST_TOP_N);
        state.toyDeal = {
            winner,
            loser: loser.memberNumber,
            toyAssetName: null,
            toyLabel: null,
            toyOptions: options.map(t => t.assetName),
            toyOptionsAll: all.map(t => t.assetName),
            toyOptionsPage: 0,
            price: null,
            counterPrice: null,
            stage: "awaiting_toy",
            pendingFuzzyToy: null,
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
            agreedPrice: null,
        };

        this.bot.sendChat(`🎲 ${this.playerName(winner)} has something devious in mind for ${this.playerName(loser.memberNumber)}...`);
        this.sendLongWhisper(winner, this.formatToyPickList(options, 0, totalPages));
    }

    // Dispatches a message to the in-progress toy deal, if any. Returns true
    // if the message was consumed by the deal flow.
    private handleToyDealMessage(sender: number, raw: string, lower: string): boolean {
        const deal = this.state.toyDeal;
        if (!deal) return false;

        switch (deal.stage) {
            case "awaiting_toy":
                if (sender !== deal.winner) return false;
                return this.handleToyChoice(deal, raw);

            case "awaiting_toy_confirm":
                if (sender !== deal.winner) return false;
                return this.handleToyItemConfirm(deal, lower);

            case "awaiting_price":
                if (sender !== deal.winner) return false;
                return this.handleToyPriceChoice(deal, raw);

            case "awaiting_opponent_response":
                if (sender !== deal.loser) return false;
                return this.handleToyLoserResponse(deal, lower);

            case "awaiting_opponent_counter_value":
                if (sender !== deal.loser) return false;
                return this.handleToyLoserCounterValue(deal, raw);

            case "awaiting_buyer_counter_response":
                if (sender !== deal.winner) return false;
                return this.handleToyWinnerCounterResponse(deal, lower);

            case "awaiting_buyer_counter_value":
                if (sender !== deal.winner) return false;
                return this.handleToyWinnerCounterValue(deal, raw);

            case "awaiting_duration":
                if (sender !== deal.winner) return false;
                return this.handleToyDurationChoice(deal, raw);
        }
    }

    private handleToyChoice(deal: ToyDeal, raw: string): boolean {
        let chosen: ToyCatalogEntry | null = null;

        const trimmed = raw.trim();
        if (trimmed === "0") {
            this.handleToyDealCancel(deal.winner);
            return true;
        }

        if (trimmed.toLowerCase() === "list" || trimmed.toLowerCase() === "show list") {
            deal.toyOptions = this.toyCatalog.map(t => t.assetName);
            this.sendLongWhisper(deal.winner, this.formatFullToyList());
            return true;
        }

        // "M" or "m" — advance to the next page of the toy list.
        if (trimmed.toLowerCase() === "m") {
            const allAssets = deal.toyOptionsAll;
            const totalPages = Math.ceil(allAssets.length / PICK_LIST_TOP_N);
            if (totalPages <= 1) {
                this.bot.whisper(deal.winner, "There are no more toys to browse.");
                return true;
            }
            deal.toyOptionsPage = (deal.toyOptionsPage + 1) % totalPages;
            const start = deal.toyOptionsPage * PICK_LIST_TOP_N;
            const pageAssets = allAssets.slice(start, start + PICK_LIST_TOP_N);
            deal.toyOptions = pageAssets;
            const pageOptions = pageAssets
                .map(a => this.toyCatalog.find(t => t.assetName === a))
                .filter((t): t is ToyCatalogEntry => t !== undefined);
            this.sendLongWhisper(deal.winner, this.formatToyPickList(pageOptions, deal.toyOptionsPage, totalPages));
            return true;
        }

        if (/^\d+$/.test(trimmed)) {
            const idx = parseInt(trimmed, 10);
            if (idx >= 1 && idx <= deal.toyOptions.length) {
                const assetName = deal.toyOptions[idx - 1];
                chosen = this.toyCatalog.find(t => t.assetName === assetName) ?? null;
            } else {
                this.bot.whisper(deal.winner, `Pick a number 1-${deal.toyOptions.length} or type a toy name. (0. Back)`);
                return true;
            }
        } else {
            const result = this.fuzzyMatchToy(trimmed);
            if (result.match && result.exact) {
                chosen = result.match;
            } else if (result.match) {
                // Only startsWith/includes matched, not exact — confirm
                // with the winner before locking it in.
                deal.pendingFuzzyToy = result.match.assetName;
                deal.stage = "awaiting_toy_confirm";
                this.bot.whisper(deal.winner, `Did you mean ${result.match.label}? (yes/no)`);
                return true;
            } else if (result.candidates) {
                this.bot.whisper(deal.winner, `Multiple matches: ${result.candidates.slice(0, 8).map(c => c.label).join(", ")} — be more specific.`);
                return true;
            } else {
                const totalPages = Math.ceil(deal.toyOptionsAll.length / PICK_LIST_TOP_N);
                const moreHint = totalPages > 1 ? " Type M to browse more options, or" : "";
                this.bot.whisper(deal.winner, `No toy matching "${trimmed}".${moreHint} type more of the name.`);
                return true;
            }
        }

        if (!chosen) {
            this.bot.whisper(deal.winner, `Pick a number 1-${deal.toyOptions.length} or type a toy name. (0. Back)`);
            return true;
        }

        deal.toyAssetName = chosen.assetName;
        deal.toyLabel = chosen.label;
        deal.stage = "awaiting_price";
        this.bot.whisper(deal.winner, `Got it — ${chosen.label}. How many points are you offering ${this.playerName(deal.loser)} for a turn with it?`);
        return true;
    }

    // Winner's yes/no reply to a "Did you mean X?" fuzzy-match confirmation.
    private handleToyItemConfirm(deal: ToyDeal, lower: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "yes" || trimmed === "y") {
            const chosen = this.toyCatalog.find(t => t.assetName === deal.pendingFuzzyToy)!;
            deal.toyAssetName = chosen.assetName;
            deal.toyLabel = chosen.label;
            deal.pendingFuzzyToy = null;
            deal.stage = "awaiting_price";
            this.bot.whisper(deal.winner, `Got it — ${chosen.label}. How many points are you offering ${this.playerName(deal.loser)} for a turn with it?`);
            return true;
        }
        if (trimmed === "no" || trimmed === "n") {
            deal.pendingFuzzyToy = null;
            deal.stage = "awaiting_toy";
            this.bot.whisper(deal.winner, `No problem — type the toy name again (or reply with a number from the list).`);
            return true;
        }
        const pending = this.toyCatalog.find(t => t.assetName === deal.pendingFuzzyToy);
        this.bot.whisper(deal.winner, `Did you mean ${pending?.label}? Please reply yes or no.`);
        return true;
    }

    private handleToyPriceChoice(deal: ToyDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === 0) {
            this.handleToyDealCancel(deal.winner);
            return true;
        }
        if (n === null || n < 0) {
            this.bot.whisper(deal.winner, "How many points are you offering?");
            return true;
        }

        if (this.state.spendingBalance < n) {
            this.bot.whisper(deal.winner,
                `You can't afford that — ${n} points is more than your ${this.state.spendingBalance} balance. ` +
                `Offer a lower price, or type !cancel to back out.`);
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.winner, result.error!);
            return true;
        }

        this.proposeToyDealToOpponent(deal);
        return true;
    }

    private proposeToyDealToOpponent(deal: ToyDeal): void {
        deal.stage = "awaiting_opponent_response";
        this.bot.whisper(deal.loser,
            `${this.playerName(deal.winner)} offers ${deal.price} points for a turn with your ${deal.toyLabel} — they'd use it on themselves; ` +
            `you'd receive ${Math.floor(deal.price! / 2)} points (pending). Accept, or 'counter <number>'?`);
        this.bot.whisper(deal.winner, `⏳ Offer sent to ${this.playerName(deal.loser)}. Waiting for their response...`);
    }

    // The loser can only accept or counter — never decline outright.
    private handleToyLoserResponse(deal: ToyDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeToyPriceNegotiation(deal, deal.price!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.loser, "You can't decline a toy offer — reply with 'yes' to accept or 'counter <number>' to negotiate the price.");
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_opponent_counter_value";
                this.bot.whisper(deal.loser, "What price would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleToyLoserCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.loser, "Reply 'yes' to accept or 'counter <number>' to negotiate the price.");
        return true;
    }

    private handleToyLoserCounterValue(deal: ToyDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.loser, "What price would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyResponderCounter(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.loser, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.loser, result.notice);

        if (result.matched) {
            this.finalizeToyPriceNegotiation(deal, result.price!);
            return true;
        }

        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.winner, `${this.playerName(deal.loser)} counters: ${deal.counterPrice} points. Accept, decline, or counter?`);
        return true;
    }

    // Unlike the loser, the winner can still accept, decline, or counter —
    // they're the one paying, so they can always walk away.
    private handleToyWinnerCounterResponse(deal: ToyDeal, lower: string): boolean {
        if (lower === "accept" || lower === "yes" || lower === "y") {
            this.finalizeToyPriceNegotiation(deal, deal.counterPrice!);
            return true;
        }

        if (lower === "decline" || lower === "no" || lower === "n") {
            this.bot.whisper(deal.loser, "Offer declined.");
            this.state.toyDeal = null;
            this.returnToSpendMenu(deal.winner);
            return true;
        }

        const counterMatch = lower.match(/^counter(?:\s+(.+))?$/);
        if (counterMatch) {
            const valueText = (counterMatch[1] ?? "").trim();
            if (!valueText) {
                deal.stage = "awaiting_buyer_counter_value";
                this.bot.whisper(deal.winner, "What price would you like to counter with?" + counterOfferHint(deal));
                return true;
            }
            return this.handleToyWinnerCounterValue(deal, valueText);
        }

        this.bot.whisper(deal.winner, "Please say 'accept', 'decline', or 'counter <number>'.");
        return true;
    }

    private handleToyWinnerCounterValue(deal: ToyDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null) {
            this.bot.whisper(deal.winner, "What price would you like to counter with?" + counterOfferHint(deal));
            return true;
        }

        const result = applyInitiatorOffer(deal, n);
        if (!result.ok) {
            this.bot.whisper(deal.winner, result.error!);
            return true;
        }
        if (result.notice) this.bot.whisper(deal.winner, result.notice);

        if (result.final || result.matched) {
            this.finalizeToyPriceNegotiation(deal, result.matched ? result.price! : deal.price!);
            return true;
        }

        deal.stage = "awaiting_opponent_response";
        this.bot.whisper(deal.loser, `${this.playerName(deal.winner)} counters: ${deal.price} points. Accept, or counter?`);
        return true;
    }

    // Price negotiation has concluded — record it and move on to duration
    // selection. The toy isn't applied yet; that happens once a duration is
    // chosen (see finalizeToyDeal).
    private finalizeToyPriceNegotiation(deal: ToyDeal, price: number): void {
        deal.agreedPrice = price;
        deal.stage = "awaiting_duration";
        const half = Math.floor(price / 2);

        this.bot.sendChat(`🧸 ${this.playerName(deal.winner)} and ${this.playerName(deal.loser)} agreed on ${price} points for the ${deal.toyLabel}.`);
        this.bot.whisper(deal.loser, `Price agreed — ${half} points coming your way (pending) once ${this.playerName(deal.winner)} picks a duration.`);
        this.bot.whisper(deal.winner,
            `Price agreed at ${price} points! How long do you want to use the ${deal.toyLabel}? ` +
            `Quick picks: ${TOY_DURATION_OPTIONS.join(" / ")} minutes — or type any number of minutes (1-120).`
        );
    }

    private handleToyDurationChoice(deal: ToyDeal, raw: string): boolean {
        const n = extractNumber(raw);
        if (n === null || n < 1 || n > 120) {
            this.bot.whisper(deal.winner, `How many minutes? Quick picks: ${TOY_DURATION_OPTIONS.join(" / ")} — or any number from 1-120.`);
            return true;
        }

        this.finalizeToyDeal(deal, n);
        return true;
    }

    // Settles the agreed toy rental: checks the winner can still afford it,
    // deducts the full price from their spending balance, credits half to
    // the loser's pending earnings (the other half is the bot fee), applies
    // the toy to the WINNER's ItemHandheld slot, and schedules its removal.
    private finalizeToyDeal(deal: ToyDeal, minutes: number): void {
        const state = this.state;
        if (!state.players) return;

        const price = deal.agreedPrice!;
        const winner = state.players.find(p => p.memberNumber === deal.winner)!;
        const loser = state.players.find(p => p.memberNumber === deal.loser)!;

        if (state.spendingBalance < price) {
            this.bot.whisper(deal.winner, `You can't afford that anymore — ${price} points is more than your ${state.spendingBalance} balance. The deal is off.`);
            this.bot.whisper(deal.loser, `${winner.name} can't cover ${price} points — the deal is off.`);
            state.toyDeal = null;
            this.returnToSpendMenu(deal.winner);
            return;
        }

        const half = Math.floor(price / 2);
        state.spendingBalance -= price;
        loser.pendingBalance += half;

        const assetName = deal.toyAssetName!;
        const itemLabel = deal.toyLabel!;

        this.bot.applyItem(deal.winner, "ItemHandheld", assetName, "Default", {});

        const timer = setTimeout(() => this.expireToy(deal.winner), minutes * 60 * 1000);
        state.activeToy = { slot: "ItemHandheld", assetName, itemLabel, holderMemberNumber: deal.winner, timer, agreedPrice: price };

        this.bot.sendChat(`🧸 Deal! ${winner.name} paid ${price} points for ${minutes} minute(s) with the ${itemLabel}. ${loser.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points. (${winner.name} has ${state.spendingBalance} points left.)`);

        state.toyDeal = null;
        this.returnToSpendMenu(deal.winner);
    }

    // Fires when an active toy's duration expires — removes it from the
    // holder's ItemHandheld slot and announces it. Guards against a stale
    // timer in case the toy was already cleared some other way (match end,
    // safeword, reset) in the meantime.
    private expireToy(holderMemberNumber: number): void {
        const active = this.state.activeToy;
        if (!active || active.holderMemberNumber !== holderMemberNumber) return;

        this.bot.removeItem(holderMemberNumber, "ItemHandheld");
        this.bot.sendChat(`⏱️ ${this.playerName(holderMemberNumber)}'s time with the ${active.itemLabel} is up.`);
        this.state.activeToy = null;
    }

    // Cancels the active toy's timer and physically removes it — called
    // alongside releaseAllActiveBondage()/releaseAllActiveLocks() when a
    // match ends, is force-reset, or halted by a safeword.
    private releaseActiveToy(): void {
        const active = this.state.activeToy;
        if (!active) return;
        clearTimeout(active.timer);
        this.bot.removeItem(active.holderMemberNumber, "ItemHandheld");
        this.state.activeToy = null;
    }

    private loadBondageUsage(): void {
        try {
            if (fs.existsSync(this.bondageUsagePath)) {
                this.bondageUsage = JSON.parse(fs.readFileSync(this.bondageUsagePath, "utf8"));
            }
        } catch (err) {
            logError(`[WD] Could not load bondage_usage.json — starting with empty usage data: ${err}`);
            this.bondageUsage = {};
        }
    }

    private saveBondageUsage(): void {
        try {
            fs.writeFileSync(this.bondageUsagePath, JSON.stringify(this.bondageUsage, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write bondage_usage.json: ${err}`);
        }
    }

    private incrementBondageUsage(group: string, itemName: string): void {
        if (!this.bondageUsage[group]) this.bondageUsage[group] = {};
        this.bondageUsage[group][itemName] = (this.bondageUsage[group][itemName] ?? 0) + 1;
        this.saveBondageUsage();
    }

    // BC sends ChatRoomSyncSingle as a full appearance snapshot for one
    // character whenever their appearance is resynced — including after a
    // wardrobe change. Used here to detect when a clothing deal's opponent
    // has handed over the traded item.
    public onSyncSingle(data: any): void {
        const memberNumber = data?.Character?.MemberNumber;
        if (typeof memberNumber !== "number") return;

        if (data.Character) {
            this.ingestAppearance(memberNumber, data.Character as BCCharacter);
            this.roomCharacters.set(memberNumber, data.Character as BCCharacter);
        }

        const pending = this.pendingWardrobeChecks.get(memberNumber);
        if (!pending) return;

        // Prefer verifying an actual item-count drop over trusting any sync
        // event — a resync can land for reasons unrelated to the traded
        // item. Null baseline (no cached appearance when the deal closed)
        // falls back to the old trust-any-sync behavior rather than never
        // resolving.
        const freshCount = Array.isArray(data.Character?.Appearance) ? data.Character.Appearance.length : null;
        if (pending.baselineCount !== null && freshCount !== null && freshCount >= pending.baselineCount) {
            return; // nothing actually changed yet — keep waiting
        }

        this.completeWardrobeCheck(memberNumber);
    }

    // Whispers the buyer what to do next once a clothing deal's wardrobe
    // pause clears — re-showing whichever menu they were in before the pause.
    private sendPostWardrobeMenu(buyer: number): void {
        const state = this.state;
        if (state.phase !== "playing" || state.awaitingPostBank !== buyer) return;

        if (state.spendMenuOpen) {
            this.openSpendMenu(buyer);
        } else {
            this.bot.whisper(buyer, `Game resumes — here's what you can do next:\n` + this.postBankPromptText(buyer));
        }
    }

    // BC delivers a safeword as an Action-type chat message (content
    // "ActionActivateSafewordRevert" / "ActionActivateSafewordReleaseAll"),
    // detected and dispatched here from index.ts. If the player activates
    // their safeword and is in a WD game or negotiation, halt
    // everything immediately — pending clothing deals and wardrobe waits
    // are cancelled, both players are whispered, and the room is notified.
    public handleSafewordUsed(memberNumber: number): void {
        const state = this.state;

        // Mid-countdown for an opponent who disconnected, and it's the
        // *other* player (the one still here) safewording — that's the
        // "end it now" option from the countdown whisper (see
        // onMemberLeave). Same teardown as expireDisconnectTimer, with the
        // disconnect getting the blame in the message rather than the
        // standard "used their safeword" framing.
        if (state.disconnectTimer && state.phase === "playing" && memberNumber !== state.disconnectTimer.memberNumber) {
            this.endGameDueToDisconnect(state.disconnectTimer.memberNumber);
            return;
        }

        const isInGame =
            (state.phase === "negotiating" &&
                (state.negotiation?.challenger.memberNumber === memberNumber ||
                    state.negotiation?.opponent.memberNumber === memberNumber)) ||
            (state.phase === "playing" &&
                state.players?.some(p => p.memberNumber === memberNumber));

        if (!isInGame) return;

        const playerName = this.roomMembers.get(memberNumber)?.name ?? `Player #${memberNumber}`;
        log(`SAFEWORD: ${playerName} (#${memberNumber}) used their safeword. Halting game.`);

        const otherMemberNumber = this.getOtherPlayerMemberNumber(memberNumber);

        if (state.negotiation) this.clearChallengeAcceptanceTimer(state.negotiation);
        this.pendingChallengeDisambiguation = null;
        this.clearMatchStartConfirm();
        this.clearDisconnectTimer();
        this.clearPendingWardrobeChecks();
        this.clearWardrobeHelperState();
        // TODO: Save/resume end game state across sessions — design TBD.
        this.clearEndGameState();
        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();
        this.clearServiceDeal();

        if (state.phase === "playing" && this.activeHandoff) {
            this.writeRoomBotResult(this.activeHandoff, "safeword", null, null, 0, 0);
            this.resetRoomBotForNextMatch();
        }
        this.state = this.createIdleState();

        this.bot.sendChat(`⛔ ${playerName} has used their safeword. The game has been stopped.`);
        this.bot.whisper(memberNumber, "Safeword acknowledged — the WinnersDice game has been stopped.");
        if (otherMemberNumber !== null) {
            this.bot.whisper(otherMemberNumber, `${playerName} used their safeword. The WinnersDice game has been stopped.`);
        }
    }

    // Returns the member number of the other game participant (i.e. not
    // `memberNumber`), or null if the game state doesn't have one.
    private getOtherPlayerMemberNumber(memberNumber: number): number | null {
        const state = this.state;
        if (state.phase === "negotiating" && state.negotiation) {
            const neg = state.negotiation;
            if (neg.challenger.memberNumber === memberNumber) return neg.opponent.memberNumber;
            if (neg.opponent.memberNumber === memberNumber) return neg.challenger.memberNumber;
        }
        if (state.phase === "playing" && state.players) {
            const other = state.players.find(p => p.memberNumber !== memberNumber);
            return other?.memberNumber ?? null;
        }
        return null;
    }

    // ============================================================
    // DISCONNECT HANDLING
    // ============================================================
    //
    // Fires when a room member leaves entirely (disconnect, closed client,
    // kicked) — detected via BC's ChatRoomSyncMemberLeave event and
    // dispatched here from index.ts alongside its own roomMembers cleanup.
    // ============================================================

    // Pre-game (negotiating): aborts immediately, same as !reset — there's
    // no in-progress scene to protect, so no grace period. Mid-match
    // (playing): starts a grace-period countdown (see
    // DISCONNECT_TIMEOUT_MS/expireDisconnectTimer) instead of ending things
    // outright, since disconnects are often just a dropped connection
    // rather than someone actually leaving; onMemberJoin cancels it if they
    // reconnect in time.
    public onMemberLeave(memberNumber: number): void {
        const state = this.state;

        // Matchmaking early-leave check runs regardless of game phase (the
        // phase branches below can return early).
        this.handleLookingLeave(memberNumber);

        if (state.phase === "negotiating" && state.negotiation &&
            (state.negotiation.challenger.memberNumber === memberNumber || state.negotiation.opponent.memberNumber === memberNumber)) {
            const playerName = this.roomMembers.get(memberNumber)?.name ?? `Player #${memberNumber}`;
            log(`DISCONNECT: ${playerName} (#${memberNumber}) left the room during negotiation. Cancelling.`);

            this.clearChallengeAcceptanceTimer(state.negotiation);
            this.state = this.createIdleState();
            this.bot.sendChat(`The WinnersDice challenge was cancelled — ${playerName} left the room.`);
            return;
        }

        if (state.phase === "playing" && state.players?.some(p => p.memberNumber === memberNumber)) {
            if (state.disconnectTimer) return; // already counting down

            const playerName = this.roomMembers.get(memberNumber)?.name ?? `Player #${memberNumber}`;
            const otherMemberNumber = this.getOtherPlayerMemberNumber(memberNumber);
            log(`DISCONNECT: ${playerName} (#${memberNumber}) left the room mid-match. Starting a ${DISCONNECT_TIMEOUT_MS / 60000}-minute countdown.`);

            const timer = setTimeout(() => this.expireDisconnectTimer(memberNumber), DISCONNECT_TIMEOUT_MS);
            state.disconnectTimer = { memberNumber, timer };

            if (otherMemberNumber !== null) {
                this.bot.whisper(otherMemberNumber,
                    `👋 ${playerName} has left the room. You have 3 minutes before the game is automatically ended — probably just a hiccup, ` +
                    `so feel free to wait it out. You can also say "quit" at any time to end it now instead.`
                );
            }
        }
    }

    // Fires DISCONNECT_TIMEOUT_MS after a mid-match disconnect if the
    // player hasn't rejoined (see onMemberJoin) and the remaining player
    // hasn't safeworded out early (see handleSafewordUsed). Guards against
    // a stale timer in case state.disconnectTimer was already cleared some
    // other way right around the deadline.
    private expireDisconnectTimer(memberNumber: number): void {
        if (this.state.disconnectTimer?.memberNumber !== memberNumber) return;
        this.endGameDueToDisconnect(memberNumber);
    }

    private clearDisconnectTimer(): void {
        if (this.state.disconnectTimer) {
            clearTimeout(this.state.disconnectTimer.timer);
            this.state.disconnectTimer = null;
        }
    }

    // Shared teardown for a mid-match disconnect that wasn't resolved by a
    // reconnect in time — either the countdown elapsed
    // (expireDisconnectTimer) or the remaining player chose to safeword out
    // early (see handleSafewordUsed). Same cleanup as a normal safeword,
    // but the announcement blames the disconnect. Does NOT call
    // finishMatch/recordGameCompletion/savePairCarryover — an aborted match
    // doesn't bank final balances, same as a normal safeword or !reset.
    private endGameDueToDisconnect(disconnectedMemberNumber: number): void {
        const playerName = this.roomMembers.get(disconnectedMemberNumber)?.name ?? `Player #${disconnectedMemberNumber}`;
        const otherMemberNumber = this.getOtherPlayerMemberNumber(disconnectedMemberNumber);
        const wasPlaying = this.state.phase === "playing";

        log(`DISCONNECT: Ending match — ${playerName} (#${disconnectedMemberNumber}) did not return in time.`);

        this.clearMatchStartConfirm();
        this.clearDisconnectTimer();
        this.clearPendingWardrobeChecks();
        this.clearWardrobeHelperState();
        this.clearEndGameState();
        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();
        this.clearServiceDeal();

        if (wasPlaying && this.activeHandoff) {
            this.writeRoomBotResult(this.activeHandoff, "disconnect", null, null, 0, 0);
            this.resetRoomBotForNextMatch();
        }
        this.state = this.createIdleState();

        this.bot.sendChat(`⛔ Game ended due to ${playerName} losing connection.`);
        if (otherMemberNumber !== null) {
            this.bot.whisper(otherMemberNumber, `Game ended due to ${playerName} losing connection. Hope they're okay — feel free to !challenge them again whenever.`);
        }
    }

    // ============================================================
    // PERMISSION PRE-FLIGHT
    // ============================================================

    // Checks whether `memberNumber` has the settings required for WinnersDice
    // to function. Returns false (and whispers the player) if a blocking issue
    // is found. Version mismatches warn but do not block, so they return true.
    private checkPlayerPermissions(memberNumber: number, name: string): boolean {
        const char = this.roomCharacters.get(memberNumber);
        if (!char) return true; // No character data available — can't check, assume OK

        // AllowItem: false means this player has globally blocked item interactions.
        // Clothing deals won't work without it.
        if (char.OnlineSharedSettings?.AllowItem === false) {
            this.bot.whisper(memberNumber,
                `For clothing deals to work in WinnersDice, you need to allow item interactions. ` +
                `Go to Online Settings → Items and enable 'Allow others to add items'.`
            );
            return false;
        }

        // Version mismatch warning — compare this player's major BC version to
        // their opponent's. If they differ the bot may not be able to make
        // wardrobe changes reliably, but we only warn rather than block.
        const negotiation = this.state.negotiation;
        if (negotiation && char.GameVersion) {
            const otherNumber = negotiation.challenger.memberNumber === memberNumber
                ? negotiation.opponent.memberNumber
                : negotiation.challenger.memberNumber;
            const otherChar = this.roomCharacters.get(otherNumber);
            if (otherChar?.GameVersion) {
                // Extract the major-version prefix, e.g. "R116" from "R116Beta1".
                const getMajor = (v: string) => v.match(/^R\d+/)?.[0] ?? v;
                const myMajor = getMajor(char.GameVersion);
                const otherMajor = getMajor(otherChar.GameVersion);
                if (myMajor !== otherMajor) {
                    this.bot.whisper(memberNumber,
                        `⚠️ Your BC version (${char.GameVersion}) differs from your opponent's (${otherChar.GameVersion}). ` +
                        `Clothing deals may not work correctly if your versions are far apart.`
                    );
                }
            }
        }

        return true;
    }

    // ============================================================
    // ADMIN COMMANDS
    // ============================================================

    private isAdmin(memberNumber: number): boolean {
        return secrets.adminMemberNumbers.includes(memberNumber) || memberNumber === this.bot.getMemberNumber();
    }

    private handleReset(sender: number): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }
        if (this.state.phase === "idle") {
            this.bot.whisper(sender, "No game is currently running.");
            return;
        }

        if (this.state.negotiation) this.clearChallengeAcceptanceTimer(this.state.negotiation);
        this.pendingChallengeDisambiguation = null;
        this.clearMatchStartConfirm();
        this.clearPendingWardrobeChecks();
        this.clearWardrobeHelperState();
        // TODO: Save/resume end game state across sessions — design TBD.
        this.clearEndGameState();
        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();
        this.clearServiceDeal();

        // Room bot: whether the match had actually started ("playing") or
        // it was still waiting for both players to arrive, an admin reset
        // ends this handoff — report it and free the room bot to poll again.
        if (this.activeHandoff) {
            this.writeRoomBotResult(this.activeHandoff, "reset", null, null, 0, 0);
            this.resetRoomBotForNextMatch();
        }
        this.state = this.createIdleState();
        this.bot.sendChat("Game has been reset by admin.");
    }

    // Cancels any in-progress end game proposal/negotiation and, if a timer
    // lock is actively running, cancels its timer and strips the leash lock.
    // Any additional requested lock slots are left for releaseAllActiveBondage()
    // to strip along with the item they're locked to (see applyEndGameLocks —
    // those locks are only ever applied over an already-tracked activeBondage
    // entry, so the normal teardown covers them).
    private clearEndGameState(): void {
        const state = this.state;
        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;

        if (state.activeEndGame) {
            clearTimeout(state.activeEndGame.timer);
            this.bot.removeItem(state.activeEndGame.loserMemberNumber, END_GAME_LEASH_GROUP);
            if (state.activeEndGame.collarAdded) {
                this.bot.removeItem(state.activeEndGame.loserMemberNumber, "ItemNeck");
            } else if (state.activeEndGame.collarLockedExisting) {
                this.unlockExistingCollar(state.activeEndGame.loserMemberNumber);
            }
            state.activeEndGame = null;
        }
    }

    // Sets the streak bonus cap, applying immediately to any in-progress
    // match and becoming the default for the next match.
    private handleSetStreak(sender: number, args: string): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const n = extractNumber(args);
        if (n === null || n < 1) {
            this.bot.whisper(sender, "Usage: !setstreak <n> (a positive whole number)");
            return;
        }

        this.defaultMaxStreak = n;
        if (this.state.config) {
            this.state.config.maxStreak = n;
        }

        this.bot.whisper(sender, `Streak cap set to ${n}.`);
        const adminName = this.roomMembers.get(sender)?.name ?? `Player #${sender}`;
        this.bot.sendChat(`⚙️ Streak cap updated to ${n} by ${adminName}.`);
    }

    // ============================================================
    // FEEDBACK
    // ============================================================

    private handleFeedback(sender: number, args: string, isWhisper: boolean): void {
        if (!isWhisper) return;

        const trimmed = args.trim();
        if (trimmed.toLowerCase() === "list") {
            this.handleFeedbackList(sender);
            return;
        }

        if (!trimmed) {
            this.bot.whisper(sender, "Please include your feedback! e.g. !feedback The game was great but...");
            return;
        }

        const name = this.roomMembers.get(sender)?.name ?? `Player #${sender}`;
        const timestamp = centralTimestamp();
        const line = `[${timestamp}] ${name} (#${sender}): ${trimmed}\n`;
        try {
            fs.appendFileSync(this.feedbackLogPath, line, "utf8");
        } catch (err) {
            logError(`[WD] Failed to write feedback.log: ${err}`);
        }
        log(`Feedback from ${name}: ${trimmed}`);

        const key = String(sender);
        const entry = this.feedbackStatus[key] ?? { name, items: [] };
        entry.name = name;
        entry.items.push({ timestamp, text: trimmed, status: "reviewing" });
        this.feedbackStatus[key] = entry;
        this.saveFeedbackStatus();

        const playerRecord = this.playerRecords[key];
        if (playerRecord && !playerRecord.feedbackGiven) {
            playerRecord.feedbackGiven = true;
            this.savePlayerRecords();
        }

        this.bot.whisper(sender, "Thank you for your feedback! 💬 We read everything and really appreciate it.");
    }

    private handleFeedbackList(sender: number): void {
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const entries = Object.entries(this.feedbackStatus);
        if (entries.length === 0) {
            this.bot.whisper(sender, "No feedback recorded yet.");
            return;
        }

        const lines: string[] = [];
        for (const [playerId, entry] of entries) {
            lines.push(`${entry.name} (#${playerId}):`);
            entry.items.forEach((item, i) => {
                lines.push(`  ${i + 1}. [${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}] ${item.text}`);
            });
        }

        this.sendLongWhisper(sender, `=== Feedback Status ===\n${lines.join("\n")}`);
    }

    private handleSetStatus(sender: number, args: string, isWhisper: boolean): void {
        if (!isWhisper) return;
        if (!this.isAdmin(sender)) {
            this.bot.whisper(sender, "Only the admin can use this command.");
            return;
        }

        const parts = args.trim().split(/\s+/);
        const playerId = parts[0];
        const status = (parts[1] ?? "").toLowerCase() as FeedbackItemStatus;
        const validStatuses: FeedbackItemStatus[] = ["reviewing", "testing", "implemented", "partly_implemented", "declined"];

        if (!playerId || !/^\d+$/.test(playerId)) {
            this.bot.whisper(sender, "Usage: !setstatus <memberNumber> <status>");
            return;
        }
        if (!validStatuses.includes(status)) {
            this.bot.whisper(sender, `Invalid status. Valid statuses: ${validStatuses.join(", ")}`);
            return;
        }

        const entry = this.feedbackStatus[playerId];
        if (!entry || entry.items.length === 0) {
            this.bot.whisper(sender, `No feedback found for player #${playerId}.`);
            return;
        }

        for (const item of entry.items) {
            item.status = status;
            item.statusShown = false;
        }
        this.saveFeedbackStatus();
        this.bot.whisper(sender, `Updated ${entry.items.length} feedback item(s) for ${entry.name} (#${playerId}) to "${status}".`);
    }

    private loadFeedbackStatus(): void {
        try {
            const raw = fs.readFileSync(this.feedbackStatusPath, "utf8");
            this.feedbackStatus = JSON.parse(raw);
        } catch {
            this.feedbackStatus = {};
        }
    }

    private saveFeedbackStatus(): void {
        try {
            fs.writeFileSync(this.feedbackStatusPath, JSON.stringify(this.feedbackStatus, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write feedback_status.json: ${err}`);
        }
    }

    private notifyFeedbackStatus(memberNumber: number, name: string): void {
        if (this.feedbackNotified.has(memberNumber)) return;
        const entry = this.feedbackStatus[String(memberNumber)];
        if (!entry || entry.items.length === 0) return;
        this.feedbackNotified.add(memberNumber);

        let changed = false;

        const resolvedToShow = entry.items.filter(item =>
            RESOLVED_FEEDBACK_STATUSES.has(item.status) && !item.statusShown
        );
        if (resolvedToShow.length > 0) {
            const lines = resolvedToShow.map((item, i) =>
                `${i + 1}. "${item.text}" — ${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}`
            );
            this.sendLongWhisper(memberNumber,
                `Hi ${name}! Here's an update on the feedback you've sent us:\n` +
                lines.join("\n") +
                `\n\nThanks for helping us improve the game! 💕`
            );
            for (const item of resolvedToShow) {
                item.statusShown = true;
            }
            changed = true;
        }

        const reviewingItems = entry.items.filter(item => REVIEWING_FEEDBACK_STATUSES.has(item.status));
        if (reviewingItems.length > 0) {
            const ackDate = entry.reviewingAckDate ? new Date(entry.reviewingAckDate) : null;
            const hasNewSinceAck = reviewingItems.some(item => !ackDate || new Date(item.timestamp) > ackDate);
            if (hasNewSinceAck) {
                this.sendLongWhisper(memberNumber,
                    `Hi ${name}! We've received your feedback and are reviewing it. We'll let you know when there's an update!`
                );
                entry.reviewingAckDate = new Date().toISOString();
                changed = true;
            }
        }

        if (changed) this.saveFeedbackStatus();
    }

    // Whispers tend to get silently dropped by the BC server if they exceed
    // its max chat message length, so split long messages on line boundaries.
    private sendLongWhisper(memberNumber: number, text: string, maxLen: number = 900): void {
        if (text.length <= maxLen) {
            this.bot.whisper(memberNumber, text);
            return;
        }

        const chunks: string[] = [];
        let chunk = "";
        for (const line of text.split("\n")) {
            if (chunk && chunk.length + 1 + line.length > maxLen) {
                chunks.push(chunk);
                chunk = "";
            }
            chunk = chunk ? `${chunk}\n${line}` : line;
        }
        if (chunk) chunks.push(chunk);

        // Every split chunk is prefixed with "- " so it can never start
        // with "!" — BCX (and similar BC extensions) intercept incoming
        // messages that begin with "!" as commands, so a chunk boundary
        // landing right before a "!command" line would otherwise get
        // swallowed client-side instead of displayed. Single-whisper
        // messages (the common case, above) never hit this branch and are
        // unaffected.
        chunks.forEach((c, i) => {
            setTimeout(() => this.bot.whisper(memberNumber, `- ${c}`), i * 300);
        });
    }

    // ============================================================
    // PLAYER TRACKING
    // ============================================================

    public onMemberJoin(memberNumber: number, name: string, char?: BCCharacter): void {
        if (memberNumber === this.bot.getMemberNumber()) return;
        if (char) {
            this.ingestAppearance(memberNumber, char);
            this.roomCharacters.set(memberNumber, char);
        }

        // Reconnect during their own disconnect countdown (see
        // onMemberLeave) — cancel it and resume as normal.
        if (this.state.disconnectTimer?.memberNumber === memberNumber) {
            this.clearDisconnectTimer();
            this.bot.sendChat(`🎲 ${name} is back! The game continues.`);
        }

        const isNewPlayer = !this.playerRecords[String(memberNumber)];
        this.recordPlayerSeen(memberNumber, name);

        // Multi-room mode (room bot): a join by one of the two players
        // named on the currently-claimed handoff gets a distinct greeting
        // and triggers the arrival check, instead of the generic welcome.
        const handoff = this.activeHandoff;
        const isHandoffPlayer = handoff !== null
            && (memberNumber === handoff.players.challenger.memberNumber || memberNumber === handoff.players.opponent.memberNumber);
        if (isHandoffPlayer) {
            this.bot.whisper(memberNumber, `Welcome — waiting on your opponent to join, then we'll begin.`);
            this.checkHandoffArrival();
        } else {
            this.sendWelcomeWhisper(memberNumber, name);
        }

        this.nudgeChangelogIfBehind(memberNumber, isNewPlayer);
        this.notifyFeedbackStatus(memberNumber, name);
    }

    public onRoomSync(characters: BCCharacter[]): void {
        for (const char of characters) {
            if (char.MemberNumber === undefined || char.MemberNumber === this.bot.getMemberNumber()) continue;
            const name = char.Nickname || char.Name || `Player #${char.MemberNumber}`;
            this.ingestAppearance(char.MemberNumber, char);
            this.roomCharacters.set(char.MemberNumber, char);
            this.recordPlayerSeen(char.MemberNumber, name);
        }
        // Multi-room mode (room bot): catches the case where both handoff
        // players were already present at the time of a full resync (e.g.
        // after a reconnect), which wouldn't otherwise fire onMemberJoin.
        if (this.activeHandoff) this.checkHandoffArrival();
    }

    // Room greeting whispered to a joining player (never to the room, and
    // never to the bot itself — see the guard in onMemberJoin below). The
    // closing line depends on whether a match is currently running: idle
    // points them at !challenge, anything else (negotiating/playing) tells
    // them to feel free to watch instead.
    private sendWelcomeWhisper(memberNumber: number, name: string): void {
        const intro =
            `🎲 Welcome to WinnersDice — a high-stakes dice duel where players strip, get restrained, and press their luck to see who comes out on top.\n\n` +
            `Say !readme for the full rundown.\n\n` +
            `This game is menu-driven with integrated help throughout — just type H or (H) at any menu or now for a hint.\n\n`;

        const closing = this.state.phase === "idle"
            ? `Ready to play? Type !challenge @[playername] to get started!`
            : `There's a game in progress right now — feel free to watch!`;

        this.sendLongWhisper(memberNumber, intro + closing);
    }

    // ---- changelog ---------------------------------------------------

    private loadChangelog(): ChangelogEntry[] {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.changelogPath, "utf8"));
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    // Records a shipped update so !changelog can report it later. Called from
    // index.ts on startup. A no-op if the version is already recorded, which
    // is what keeps the lobby and room bots from double-appending the same
    // entry to the changelog.json they share.
    public recordUpdate(entry: ChangelogEntry): void {
        const entries = this.loadChangelog();
        if (entries.some(e => e.version === entry.version)) return;
        entries.push(entry);
        try {
            const trimmed = entries.slice(-CHANGELOG_MAX_ENTRIES);
            fs.writeFileSync(this.changelogPath, JSON.stringify(trimmed, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write changelog.json: ${err}`);
        }
    }

    // The version a returning player is compared against — null when nothing
    // has shipped yet, which suppresses the nudge entirely.
    private latestChangelogVersion(): string | null {
        const entries = this.loadChangelog();
        return entries.length ? entries[entries.length - 1].version : null;
    }

    // One short line on join for players who were away when something shipped,
    // replacing the old habit of posting the whole update into room chat.
    // Skipped for first-time visitors, who have no absence to catch up on.
    private nudgeChangelogIfBehind(memberNumber: number, isNewPlayer: boolean): void {
        if (isNewPlayer) return;
        const latest = this.latestChangelogVersion();
        if (!latest) return;
        const record = this.playerRecords[String(memberNumber)];
        if (record?.lastChangelogVersion === latest) return;

        this.bot.whisper(memberNumber,
            `📋 I've been updated since your last visit — whisper !changelog to see what changed.`
        );
    }

    private handleChangelog(memberNumber: number): void {
        const entries = this.loadChangelog();
        if (!entries.length) {
            this.bot.whisper(memberNumber, "No changes recorded yet — you're up to date!");
            return;
        }

        const shown = entries.slice(-CHANGELOG_ENTRIES_SHOWN).reverse();
        const lines = shown.map(entry => {
            const date = entry.version.split("T")[0] || entry.version;
            const detail = entry.detail ? `\n${entry.detail}` : "";
            return `— ${date} —\n${entry.headline}${detail}`;
        });

        const older = entries.length - shown.length;
        const footer = older > 0 ? `\n\n(${older} older ${older === 1 ? "change" : "changes"} not shown.)` : "";

        this.sendLongWhisper(memberNumber,
            `=== What's New in WinnersDice ===\n\n${lines.join("\n\n")}${footer}`
        );

        // Mark caught up so the join nudge stops until the next update ships.
        const record = this.playerRecords[String(memberNumber)];
        if (record) {
            record.lastChangelogVersion = entries[entries.length - 1].version;
            this.savePlayerRecords();
        }
    }

    private loadPlayerRecords(): void {
        try {
            const raw = fs.readFileSync(this.playerRecordsPath, "utf8");
            this.playerRecords = JSON.parse(raw);
        } catch {
            this.playerRecords = {};
        }

        for (const memberNumber of this.loadFeedbackMemberNumbers()) {
            const record = this.playerRecords[String(memberNumber)];
            if (record) record.feedbackGiven = true;
        }

        // Backfill gamesLost for records saved before the field existed.
        for (const record of Object.values(this.playerRecords)) {
            record.gamesLost ??= 0;
        }
    }

    private handleLeaderboard(memberNumber: number): void {
        const records = Object.values(this.playerRecords);
        const me = this.playerRecords[String(memberNumber)];
        const myWins = me?.gamesWon ?? 0;
        const myLosses = me?.gamesLost ?? 0;

        const topWinners = records.filter(r => r.gamesWon > 0).sort((a, b) => b.gamesWon - a.gamesWon).slice(0, 5);
        const topLosers = records.filter(r => r.gamesLost > 0).sort((a, b) => b.gamesLost - a.gamesLost).slice(0, 5);

        const lines: string[] = [`Your record: ${myWins}W / ${myLosses}L`];

        lines.push("─ Top 5 Winners ─");
        if (topWinners.length === 0) {
            lines.push("No wins recorded yet.");
        } else {
            topWinners.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — ${r.gamesWon} wins`));
        }

        lines.push("─ Top 5 Losers ─");
        if (topLosers.length === 0) {
            lines.push("No losses recorded yet.");
        } else {
            topLosers.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — ${r.gamesLost} losses`));
        }

        this.sendLongWhisper(memberNumber, lines.join("\n"));
    }

    private savePlayerRecords(): void {
        try {
            fs.writeFileSync(this.playerRecordsPath, JSON.stringify(this.playerRecords, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write players.json: ${err}`);
        }
    }

    // ============================================================
    // MATCHMAKING POOL (main/lobby bot — see design_matchmaking.md)
    // ============================================================

    private loadRegisteredPlayers(): void {
        try {
            this.registeredPlayers = JSON.parse(fs.readFileSync(this.registeredPlayersPath, "utf8"));
        } catch {
            this.registeredPlayers = {};
        }
    }

    private saveRegisteredPlayers(): void {
        try {
            fs.writeFileSync(this.registeredPlayersPath, JSON.stringify(this.registeredPlayers, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write registered_players.json: ${err}`);
        }
    }

    // Router for all `!wd ...` subcommands. Matchmaking lives on the lobby bot;
    // a game-room bot just points the player back to the main room.
    private handleWdCommand(sender: number, args: string): void {
        if (botRole !== "main") {
            this.bot.whisper(sender, `Matchmaking is run from the main WinnersDice room ("${mainRoomName}") — head there and use !wd.`);
            return;
        }
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "").toLowerCase();
        const rest = parts.slice(1).join(" ");
        switch (sub) {
            case "register": this.handleWdRegister(sender); break;
            case "unregister": this.handleWdUnregister(sender); break;
            case "pause": this.handleWdPause(sender); break;
            case "resume": this.handleWdResume(sender); break;
            case "status": this.handleWdStatus(sender); break;
            case "pool": this.handleWdPool(sender); break;
            case "clearstrikes": this.handleWdClearStrikes(sender, rest); break;
            case "unblock": this.handleWdUnblock(sender, rest); break;
            default:
                this.bot.whisper(sender,
                    `WinnersDice matchmaking — whisper me:\n` +
                    `!wd register — join the pool so people can beep you for a game (you'll friend me too)\n` +
                    `!wd unregister — leave the pool\n` +
                    `!wd pause / !wd resume — stop / restart getting beeps (stays registered)\n` +
                    `!wd status — your current status\n` +
                    `!looking — beep online players that you're in the lobby for a game` +
                    (this.isAdmin(sender)
                        ? `\n(admin) !wd pool — list everyone registered\n(admin) !wd clearstrikes <@name|#> — reset strikes\n(admin) !wd unblock <@name|#> — un-block and reset`
                        : ""));
        }
    }

    // Resolves an admin target among registered players by member number or a
    // unique name substring (they may not be in the room, so this searches the
    // pool, not roomMembers).
    private resolveRegisteredTarget(token: string): RegisteredPlayer | null {
        const t = token.replace(/^@/, "").trim();
        if (!t) return null;
        if (/^\d{3,}$/.test(t)) return this.registeredPlayers[t] ?? null;
        const lower = t.toLowerCase();
        const matches = Object.values(this.registeredPlayers).filter(p => p.name.toLowerCase().includes(lower));
        return matches.length === 1 ? matches[0] : null;
    }

    private async handleWdPool(sender: number): Promise<void> {
        if (!this.isAdmin(sender)) { this.bot.whisper(sender, "Only the admin can use this command."); return; }
        const all = Object.values(this.registeredPlayers);
        if (all.length === 0) { this.bot.whisper(sender, "No one is registered."); return; }
        const online = await this.bot.queryOnlineFriends();
        const onlineNumbers = new Set<number>(online.map((f: any) => f?.MemberNumber).filter((n: any): n is number => typeof n === "number"));
        const lines = all
            .sort((a, b) => Number(onlineNumbers.has(b.memberNumber)) - Number(onlineNumbers.has(a.memberNumber)))
            .map(p => {
                const on = onlineNumbers.has(p.memberNumber) ? "🟢 online" : "⚪ offline";
                const flags = [p.blocked ? "BLOCKED" : null, p.paused ? "paused" : null].filter(Boolean).join(", ");
                return `${on} — ${p.name} #${p.memberNumber}${flags ? ` (${flags})` : ""}, strikes ${p.earlyLeaveCount}`;
            });
        this.sendLongWhisper(sender, `Matchmaking pool (${all.length}):\n` + lines.join("\n"));
    }

    private handleWdClearStrikes(sender: number, token: string): void {
        if (!this.isAdmin(sender)) { this.bot.whisper(sender, "Only the admin can use this command."); return; }
        const target = this.resolveRegisteredTarget(token);
        if (!target) { this.bot.whisper(sender, `No single registered player matches "${token}" — pass a member number or a unique name.`); return; }
        target.earlyLeaveCount = 0;
        this.saveRegisteredPlayers();
        this.bot.whisper(sender, `Cleared strikes for ${target.name} (#${target.memberNumber}).`);
    }

    private handleWdUnblock(sender: number, token: string): void {
        if (!this.isAdmin(sender)) { this.bot.whisper(sender, "Only the admin can use this command."); return; }
        const target = this.resolveRegisteredTarget(token);
        if (!target) { this.bot.whisper(sender, `No single registered player matches "${token}" — pass a member number or a unique name.`); return; }
        target.blocked = false;
        target.earlyLeaveCount = 0;
        this.saveRegisteredPlayers();
        this.bot.whisper(sender, `Unblocked ${target.name} (#${target.memberNumber}) — back in the pool with a clean slate.`);
    }

    private handleWdRegister(sender: number): void {
        const key = String(sender);
        const name = this.roomMembers.get(sender)?.name ?? this.playerName(sender);

        const existing = this.registeredPlayers[key];
        if (existing?.blocked) {
            this.bot.whisper(sender, "You've been removed from matchmaking. An admin has to !wd unblock you before you can rejoin.");
            return;
        }

        if (existing) {
            existing.name = name;
            existing.paused = false; // re-registering un-pauses
            this.saveRegisteredPlayers();
            this.bot.whisper(sender, "You're already registered — welcome back (and un-paused, if you were).");
        } else {
            this.registeredPlayers[key] = {
                memberNumber: sender,
                name,
                registeredAt: Date.now(),
                paused: false,
                earlyLeaveCount: 0,
                blocked: false,
                lastLookingAt: null,
                lookingCooldownUntil: null,
            };
            this.saveRegisteredPlayers();
            this.bot.whisper(sender, "✅ You're registered for WinnersDice matchmaking!");
        }

        // Friend them so presence queries can see them. Registration is only
        // fully live once they friend the bot back (BC is mutual-gated).
        this.bot.addFriend(sender);
        this.bot.whisper(sender,
            `One more step: please friend ${secrets.username} back (add me as a friend in BC). Friend status only works when it's mutual, so I need that to include you when someone whispers !looking. You can whisper !wd status anytime.`);
    }

    private handleWdUnregister(sender: number): void {
        const key = String(sender);
        if (!this.registeredPlayers[key]) {
            this.bot.whisper(sender, "You're not registered.");
            return;
        }
        delete this.registeredPlayers[key];
        this.saveRegisteredPlayers();
        // Deliberately NOT unfriending — friendship is decoupled from the pool
        // (a stale friend is harmless; only registered+online players get beeped).
        this.bot.whisper(sender, "You're out of WinnersDice matchmaking — no more game beeps. (I've kept the friend link; it's harmless.) Whisper !wd register to rejoin anytime.");
    }

    private handleWdPause(sender: number): void {
        const p = this.registeredPlayers[String(sender)];
        if (!p) { this.bot.whisper(sender, "You're not registered — whisper !wd register first."); return; }
        if (p.paused) { this.bot.whisper(sender, "You're already paused."); return; }
        p.paused = true;
        this.saveRegisteredPlayers();
        this.bot.whisper(sender, "⏸️ Paused — you stay registered but won't get game beeps. Whisper !wd resume when you're back.");
    }

    private handleWdResume(sender: number): void {
        const p = this.registeredPlayers[String(sender)];
        if (!p) { this.bot.whisper(sender, "You're not registered — whisper !wd register first."); return; }
        if (!p.paused) { this.bot.whisper(sender, "You're already active (not paused)."); return; }
        p.paused = false;
        this.saveRegisteredPlayers();
        this.bot.whisper(sender, "▶️ Back in the pool — you'll get game beeps again.");
    }

    private handleWdStatus(sender: number): void {
        const p = this.registeredPlayers[String(sender)];
        if (!p) {
            this.bot.whisper(sender, "You're not registered. Whisper !wd register to join matchmaking.");
            return;
        }
        const state = p.blocked ? "blocked" : (p.paused ? "paused" : "active");
        const friended = this.bot.isFriend(sender);
        this.bot.whisper(sender,
            `Your matchmaking status: ${state}. Strikes: ${p.earlyLeaveCount}/4.\n` +
            (friended
                ? `I have you friended. If you haven't friended ${secrets.username} back yet, please do — presence only works when it's mutual.`
                : `Heads up: I don't have you friended — whisper !wd register again.`));
    }

    // !looking — beep every online, registered, non-paused player that you'd
    // like to play. Requires being in the lobby; 30-min cooldown (admins exempt).
    private async handleLooking(sender: number): Promise<void> {
        if (botRole !== "main") {
            this.bot.whisper(sender, `!looking is used in the main WinnersDice room ("${mainRoomName}").`);
            return;
        }
        const p = this.registeredPlayers[String(sender)];
        if (!p || p.blocked) {
            this.bot.whisper(sender, p?.blocked
                ? "You've been removed from matchmaking — an admin needs to !wd unblock you."
                : "You need to register first — whisper !wd register.");
            return;
        }
        if (p.paused) {
            this.bot.whisper(sender, "You're paused. Whisper !wd resume first, then !looking.");
            return;
        }
        if (!this.roomMembers.has(sender)) {
            this.bot.whisper(sender, "Use !looking from inside the WinnersDice room.");
            return;
        }

        const now = Date.now();
        const admin = this.isAdmin(sender);
        if (!admin && p.lookingCooldownUntil && now < p.lookingCooldownUntil) {
            const mins = Math.max(1, Math.ceil((p.lookingCooldownUntil - now) / 60000));
            this.bot.whisper(sender, `You used !looking recently — try again in ~${mins} min.`);
            return;
        }

        // Pending early-leave warning (delivered here, not at leave time).
        if (p.earlyLeaveCount === 2) {
            this.bot.whisper(sender, "⚠️ Please stay at least 3 minutes after !looking — people need time to see the beep and reach the room.");
        } else if (p.earlyLeaveCount >= 3) {
            this.bot.whisper(sender, "⚠️ Last warning: stay at least 3 minutes after !looking. One more early leave removes you from matchmaking.");
        }

        const onlineList = await this.bot.queryOnlineFriends();
        const onlineNumbers = new Set<number>(
            onlineList.map((f: any) => f?.MemberNumber).filter((n: any): n is number => typeof n === "number"));

        const recipients = Object.values(this.registeredPlayers).filter(r =>
            r.memberNumber !== sender && !r.paused && !r.blocked && onlineNumbers.has(r.memberNumber));

        // Record the attempt + set cooldown regardless of who's online (anti-spam).
        p.lastLookingAt = now;
        if (!admin) p.lookingCooldownUntil = now + LOOKING_COOLDOWN_MS;
        this.saveRegisteredPlayers();

        if (recipients.length === 0) {
            this.bot.whisper(sender, "No registered players are online right now — nobody to beep. Hang out in the room and try again later.");
            return;
        }

        const seekerName = this.roomMembers.get(sender)?.name ?? this.playerName(sender);
        const beepMsg = `${seekerName} is in the WinnersDice lobby looking for a game! Reply to this beep if you're heading over.`;
        const beeped = new Set<number>();
        for (const r of recipients) {
            this.bot.beep(r.memberNumber, beepMsg);
            beeped.add(r.memberNumber);
        }
        this.activeLookingCalls.set(sender, { seeker: sender, beeped, expiresAt: now + LOOKING_RELAY_WINDOW_MS });

        if (!admin) this.startLookingStayTimer(sender);

        this.bot.whisper(sender,
            `📣 Beeped ${beeped.size} online player${beeped.size === 1 ? "" : "s"}. If anyone replies, I'll pass it along here. Please stick around a few minutes so they can join.`);
    }

    // 3-minute "stay" timer. Expiring without an early leave is good behavior
    // and decays one strike; leaving early (see onMemberLeave) adds one.
    private startLookingStayTimer(seeker: number): void {
        this.clearLookingStayTimer(seeker);
        const t = setTimeout(() => {
            this.lookingStayTimers.delete(seeker);
            const p = this.registeredPlayers[String(seeker)];
            if (p && p.earlyLeaveCount > 0) {
                p.earlyLeaveCount = Math.max(0, p.earlyLeaveCount - 1);
                this.saveRegisteredPlayers();
                log(`[WD] ${p.name} (#${seeker}) stayed after !looking — strike decayed to ${p.earlyLeaveCount}.`);
            }
        }, LOOKING_STAY_MS);
        this.lookingStayTimers.set(seeker, t);
    }

    private clearLookingStayTimer(seeker: number): void {
        const t = this.lookingStayTimers.get(seeker);
        if (t) { clearTimeout(t); this.lookingStayTimers.delete(seeker); }
    }

    // Called from onMemberLeave: if someone leaves while their post-!looking
    // stay timer is running, that's an early leave — add a strike (block at 4).
    private handleLookingLeave(memberNumber: number): void {
        if (!this.lookingStayTimers.has(memberNumber)) return;
        this.clearLookingStayTimer(memberNumber);
        this.activeLookingCalls.delete(memberNumber);
        const p = this.registeredPlayers[String(memberNumber)];
        if (!p) return;
        p.earlyLeaveCount += 1;
        if (p.earlyLeaveCount >= 4) p.blocked = true;
        this.saveRegisteredPlayers();
        log(`[WD] Early leave by ${p.name} (#${memberNumber}) after !looking — strikes now ${p.earlyLeaveCount}${p.blocked ? " (BLOCKED)" : ""}.`);
    }

    // Relays a registered player's beep-reply to the seeker who beeped them.
    // Only string (human) messages from an active, unexpired !looking call.
    private relayLookingReply(responder: number, responderName: string, message: string): void {
        const now = Date.now();
        for (const [seeker, call] of this.activeLookingCalls) {
            if (call.expiresAt < now) { this.activeLookingCalls.delete(seeker); continue; }
            if (!call.beeped.has(responder)) continue;
            const text = `💬 ${responderName} replied to your game call: "${message}"`;
            if (this.roomMembers.has(seeker)) this.bot.whisper(seeker, text);
            else this.bot.beep(seeker, text);
            return; // relay to the first matching call
        }
    }

    // Canonical, order-independent key for a two-player pair's carryover
    // balance (see pairBalances) — sorted so it doesn't matter who
    // challenges whom next time.
    private pairKey(a: number, b: number): string {
        return [a, b].sort((x, y) => x - y).join("-");
    }

    private loadPairBalances(): void {
        try {
            const raw = fs.readFileSync(this.pairBalancesPath, "utf8");
            this.pairBalances = JSON.parse(raw);
        } catch {
            this.pairBalances = {};
        }
    }

    private savePairBalances(): void {
        try {
            fs.writeFileSync(this.pairBalancesPath, JSON.stringify(this.pairBalances, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write pair_balances.json: ${err}`);
        }
    }

    // ============================================================
    // NEGOTIATION SETTINGS PERSISTENCE
    // ============================================================

    private loadPlayerSettings(): void {
        try {
            const raw = fs.readFileSync(this.playerSettingsPath, "utf8");
            this.playerSettings = JSON.parse(raw);
        } catch {
            this.playerSettings = {};
        }
    }

    private savePlayerSettings(): void {
        try {
            fs.writeFileSync(this.playerSettingsPath, JSON.stringify(this.playerSettings, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write player_settings.json: ${err}`);
        }
    }

    private loadPairSettings(): void {
        try {
            const raw = fs.readFileSync(this.pairSettingsPath, "utf8");
            this.pairSettings = JSON.parse(raw);
        } catch {
            this.pairSettings = {};
        }
    }

    private savePairSettings(): void {
        try {
            fs.writeFileSync(this.pairSettingsPath, JSON.stringify(this.pairSettings, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write pair_settings.json: ${err}`);
        }
    }

    // Called at finishNegotiation() before launching the match. Writes both
    // per-player and per-pair entries so returning players can skip re-negotiation.
    private saveNegotiationSettings(negotiation: NegotiationState, config: SavedGameConfig): void {
        const { challenger, opponent } = negotiation;
        const now = centralTimestamp();

        this.playerSettings[challenger.memberNumber] = { memberNumber: challenger.memberNumber, config, lastUpdated: now };
        this.playerSettings[opponent.memberNumber] = { memberNumber: opponent.memberNumber, config, lastUpdated: now };
        this.savePlayerSettings();

        const key = this.pairKey(challenger.memberNumber, opponent.memberNumber);
        this.pairSettings[key] = {
            memberNumbers: [challenger.memberNumber, opponent.memberNumber],
            config,
            lastUpdated: now,
        };
        this.savePairSettings();
    }

    // Returns a compact human-readable summary of saved settings for whispers.
    private formatSavedConfig(config: SavedGameConfig): string {
        return [
            `Rounds: ${config.minRounds} min`,
            `Stripping: ${config.stripping ? "yes" : "no"}`,
            `Bondage: ${config.bondage ? "yes" : "no"}`,
            `Toys: ${config.toys ? "yes" : "no"}`,
            `Services: ${config.services ? "yes" : "no"}`,
        ].join(" · ");
    }

    // After carryover resolves: if this pair has saved settings, whisper both
    // players and ask whether to skip negotiation. Otherwise begin normally.
    private promptSettingsShortcutOrBeginNegotiation(negotiation: NegotiationState): void {
        const key = this.pairKey(negotiation.challenger.memberNumber, negotiation.opponent.memberNumber);
        const entry = this.pairSettings[key];

        if (!entry) {
            this.beginSettingsNegotiation();
            return;
        }

        negotiation.pairSettingsStage = "awaiting";
        negotiation.pairSettingsAnswers = {};
        negotiation.savedPairConfig = entry.config;

        const summary = this.formatSavedConfig(entry.config);
        const msg = `You've played together before! Last time you agreed on: ${summary}. Use the same settings? (yes/no — 30 seconds or we'll negotiate fresh)`;
        this.bot.whisper(negotiation.challenger.memberNumber, msg);
        this.bot.whisper(negotiation.opponent.memberNumber, msg);

        negotiation.pairSettingsTimer = setTimeout(() => {
            if (this.state.negotiation?.pairSettingsStage !== "awaiting") return;
            log("[WD] Pair settings shortcut timed out — proceeding to normal negotiation.");
            negotiation.pairSettingsStage = "done";
            this.bot.whisper(negotiation.challenger.memberNumber, "No answer in time — negotiating fresh.");
            this.bot.whisper(negotiation.opponent.memberNumber, "No answer in time — negotiating fresh.");
            this.beginSettingsNegotiation();
        }, 30_000);
    }

    private isAwaitingPairSettingsShortcut(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.pairSettingsStage === "awaiting";
    }

    private handlePairSettingsShortcutAnswer(sender: number, value: boolean): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.pairSettingsStage !== "awaiting") return;
        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) return;

        negotiation.pairSettingsAnswers[sender] = value;

        const challengerAnswer = negotiation.pairSettingsAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.pairSettingsAnswers[negotiation.opponent.memberNumber];

        // One player answered — let the other know and wait.
        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.whisper(responder.memberNumber, `Got it — waiting on ${other.name}...`);
            return;
        }

        // Both answered — resolve.
        if (negotiation.pairSettingsTimer) {
            clearTimeout(negotiation.pairSettingsTimer);
            negotiation.pairSettingsTimer = null;
        }
        negotiation.pairSettingsStage = "done";

        if (challengerAnswer && opponentAnswer && negotiation.savedPairConfig) {
            // Both said yes — apply saved config and skip to room type.
            negotiation.usedPairSettingsShortcut = true;
            const cfg = negotiation.savedPairConfig;
            negotiation.config.minRounds = cfg.minRounds;
            negotiation.config.stripping = cfg.stripping;
            negotiation.config.bondage = cfg.bondage;
            negotiation.config.toys = cfg.toys;
            negotiation.config.services = cfg.services;
            negotiation.consentAllStage = "done"; // mark skipped so promptNextSetting doesn't re-ask
            this.bot.sendChat(`Both players agreed to reuse previous settings: ${this.formatSavedConfig(cfg)}. Skipping to room type.`);
            this.promptNextSetting();
        } else {
            // At least one said no — negotiate fresh.
            this.bot.whisper(negotiation.challenger.memberNumber, "Negotiating fresh.");
            this.bot.whisper(negotiation.opponent.memberNumber, "Negotiating fresh.");
            this.beginSettingsNegotiation();
        }
    }

    // After room type resolves: if at least one player has player-level settings
    // and the pair shortcut wasn't used, whisper them a comparison and let them
    // switch to their saved settings before the match starts.
    private promptSettingsCompareOrFinish(negotiation: NegotiationState): void {
        // Skip if we already used the pair shortcut — settings are already known.
        if (negotiation.usedPairSettingsShortcut) {
            this.finishNegotiation();
            return;
        }

        const { challenger, opponent } = negotiation;
        const experienced: { player: { memberNumber: number; name: string }; config: SavedGameConfig }[] = [];
        if (negotiation.challengerPlayerConfig) experienced.push({ player: challenger, config: negotiation.challengerPlayerConfig });
        if (negotiation.opponentPlayerConfig) experienced.push({ player: opponent, config: negotiation.opponentPlayerConfig });

        if (experienced.length === 0) {
            this.finishNegotiation();
            return;
        }

        // Build a summary of what was just negotiated for comparison.
        const negotiated: SavedGameConfig = {
            minRounds: negotiation.config.minRounds ?? 3,
            stripping: negotiation.config.stripping ?? false,
            bondage: negotiation.config.bondage ?? false,
            toys: negotiation.config.toys ?? false,
            services: negotiation.config.services ?? false,
        };

        negotiation.settingsCompareStage = "awaiting";
        negotiation.settingsCompareAnswers = {};

        for (const { player, config } of experienced) {
            const items: string[] = [];
            const keys: (keyof SavedGameConfig)[] = ["minRounds", "stripping", "bondage", "toys", "services"];
            for (const k of keys) {
                const match = (negotiated as any)[k] === (config as any)[k];
                const label = k === "minRounds" ? `Rounds: ${(negotiated as any)[k]} min` : `${k.charAt(0).toUpperCase() + k.slice(1)}: ${(negotiated as any)[k] ? "yes" : "no"}`;
                items.push(`${match ? "✅" : "❌"} ${label}${match ? "" : ` (your last: ${k === "minRounds" ? (config as any)[k] + " min" : ((config as any)[k] ? "yes" : "no")})`}`);
            }
            const msg = `Here's how the agreed settings compare to your last game:\n${items.join(" · ")}\nAccept these settings or switch to your saved ones? (accept/saved — 30 seconds or we'll continue)`;
            this.bot.whisper(player.memberNumber, msg);
        }

        // If only one player is experienced, the other isn't being asked — mark them as accepted.
        if (experienced.length === 1) {
            const otherNum = experienced[0].player.memberNumber === challenger.memberNumber
                ? opponent.memberNumber
                : challenger.memberNumber;
            negotiation.settingsCompareAnswers[otherNum] = "accept";
        }

        negotiation.settingsCompareTimer = setTimeout(() => {
            if (this.state.negotiation?.settingsCompareStage !== "awaiting") return;
            log("[WD] Settings compare timed out — finishing with negotiated settings.");
            negotiation.settingsCompareStage = "done";
            this.finishNegotiation();
        }, 30_000);
    }

    private isAwaitingSettingsCompare(): boolean {
        return this.state.phase === "negotiating" && this.state.negotiation?.settingsCompareStage === "awaiting";
    }

    private handleSettingsCompareAnswer(sender: number, value: "accept" | "saved"): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation || negotiation.settingsCompareStage !== "awaiting") return;
        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) return;

        negotiation.settingsCompareAnswers[sender] = value;

        const challengerAnswer = negotiation.settingsCompareAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.settingsCompareAnswers[negotiation.opponent.memberNumber];

        // Process immediately if someone said "saved" — first saved wins (challenger takes priority).
        const savedPlayer =
            challengerAnswer === "saved" ? { player: negotiation.challenger, config: negotiation.challengerPlayerConfig } :
            opponentAnswer === "saved"   ? { player: negotiation.opponent,   config: negotiation.opponentPlayerConfig } :
            null;

        if (savedPlayer && savedPlayer.config) {
            if (negotiation.settingsCompareTimer) {
                clearTimeout(negotiation.settingsCompareTimer);
                negotiation.settingsCompareTimer = null;
            }
            negotiation.settingsCompareStage = "done";
            const cfg = savedPlayer.config;
            negotiation.config.minRounds = cfg.minRounds;
            negotiation.config.stripping = cfg.stripping;
            negotiation.config.bondage = cfg.bondage;
            negotiation.config.toys = cfg.toys;
            negotiation.config.services = cfg.services;
            this.bot.whisper(negotiation.challenger.memberNumber, `Using ${savedPlayer.player.name}'s previous settings: ${this.formatSavedConfig(cfg)}.`);
            this.bot.whisper(negotiation.opponent.memberNumber, `Using ${savedPlayer.player.name}'s previous settings: ${this.formatSavedConfig(cfg)}.`);
            this.finishNegotiation();
            return;
        }

        // Both said accept — proceed with negotiated settings.
        if (challengerAnswer === "accept" && opponentAnswer === "accept") {
            if (negotiation.settingsCompareTimer) {
                clearTimeout(negotiation.settingsCompareTimer);
                negotiation.settingsCompareTimer = null;
            }
            negotiation.settingsCompareStage = "done";
            this.finishNegotiation();
            return;
        }

        // One answered, still waiting on the other.
        const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
        const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
        const otherAnswer = negotiation.settingsCompareAnswers[other.memberNumber];
        if (otherAnswer === undefined) {
            this.bot.whisper(responder.memberNumber, `Got it — waiting on ${other.name}...`);
        }
    }

    // Records each player's final balance as this pair's carryover for next
    // time they play each other. Called from finishMatch and resolveMercy
    // only — a safeword or admin !reset teardown intentionally does NOT
    // call this, so an aborted match never persists a balance.
    private savePairCarryover(p1: PlayerState, p2: PlayerState): void {
        const key = this.pairKey(p1.memberNumber, p2.memberNumber);
        this.pairBalances[key] = {
            memberNumbers: [p1.memberNumber, p2.memberNumber],
            balances: {
                [String(p1.memberNumber)]: p1.balance,
                [String(p2.memberNumber)]: p2.balance,
            },
            lastUpdated: centralTimestamp(),
        };
        this.savePairBalances();
    }

    // Multi-room mode (BOT_ROLE=main): applies match results a room bot
    // wrote to handoffs/results/. The lobby bot is the sole writer for
    // players.json and pair_balances.json (see design_multi_room.md), so
    // this mirrors recordGameCompletion/savePairCarryover rather than
    // calling them directly (those take live PlayerState, not a result file).
    private processHandoffResults(): void {
        for (const result of listPendingResults()) {
            // winner/loser are null for a tie or an aborted match (safeword/
            // reset/disconnect) — nobody's gamesWon/gamesPlayed gets credited then.
            const winnerRecord = result.winner !== null ? this.playerRecords[String(result.winner)] : undefined;
            const loserRecord = result.loser !== null ? this.playerRecords[String(result.loser)] : undefined;
            if (winnerRecord) {
                winnerRecord.gamesPlayed++;
                winnerRecord.gamesWon++;
            }
            if (loserRecord) {
                loserRecord.gamesPlayed++;
            }
            if (winnerRecord || loserRecord) this.savePlayerRecords();

            const pairMembers = Object.keys(result.pairBalances).map(Number);
            if (pairMembers.length === 2) {
                const [a, b] = pairMembers;
                this.pairBalances[this.pairKey(a, b)] = {
                    memberNumbers: [a, b],
                    balances: result.pairBalances,
                    lastUpdated: centralTimestamp(),
                };
                this.savePairBalances();
            }

            log(`[Handoff] Processed result ${result.handoffId} (winner #${result.winner}, ${result.endReason}).`);
            markResultProcessed(result.handoffId);
        }
    }

    // Multi-room mode (BOT_ROLE=main): a claimed handoff's roomName isn't
    // known up front (Private randomizes it fresh per match — see
    // design_multi_room.md), so the lobby bot polls handoffs/claimed/ for it
    // to appear and relays it to both players as soon as it does.
    private relayClaimedRoomInvites(): void {
        for (const handoff of listClaimedHandoffs()) {
            if (!handoff.roomName || this.relayedRoomInvites.has(handoff.id)) continue;

            this.relayedRoomInvites.add(handoff.id);
            const { challenger, opponent } = handoff.players;
            this.bot.whisper(challenger.memberNumber, `Your game room is ready — join "${handoff.roomName}" to begin!`);
            this.bot.whisper(opponent.memberNumber, `Your game room is ready — join "${handoff.roomName}" to begin!`);
            log(`[Handoff] Relayed room "${handoff.roomName}" to ${challenger.name} and ${opponent.name} for ${handoff.id}.`);
        }
    }

    // Reads feedback.log and returns the set of member numbers that have
    // submitted feedback, e.g. lines like "... Missy (#208543): ...".
    private loadFeedbackMemberNumbers(): Set<number> {
        const memberNumbers = new Set<number>();
        try {
            const raw = fs.readFileSync(this.feedbackLogPath, "utf8");
            for (const match of raw.matchAll(/\(#(\d+)\)/g)) {
                memberNumbers.add(Number(match[1]));
            }
        } catch {
            // No feedback log yet
        }
        return memberNumbers;
    }

    private recordPlayerSeen(memberNumber: number, name: string): void {
        const key = String(memberNumber);
        const now = centralTimestamp();
        const existing = this.playerRecords[key];
        if (existing) {
            existing.name = name;
            existing.lastSeen = now;
        } else {
            this.playerRecords[key] = {
                memberNumber,
                name,
                firstSeen: now,
                lastSeen: now,
                gamesPlayed: 0,
                gamesWon: 0,
                gamesLost: 0,
                feedbackGiven: this.loadFeedbackMemberNumbers().has(memberNumber),
            };
        }
        this.savePlayerRecords();
    }

    // Called once a match concludes, crediting both participants with a
    // completed game, the winner with a win, and the loser with a loss.
    private recordGameCompletion(winnerMemberNumber: number | null, participants: PlayerState[]): void {
        for (const participant of participants) {
            const record = this.playerRecords[String(participant.memberNumber)];
            if (!record) continue;
            record.gamesPlayed++;
            if (winnerMemberNumber !== null && participant.memberNumber === winnerMemberNumber) {
                record.gamesWon++;
            } else if (winnerMemberNumber !== null) {
                record.gamesLost++;
            }
        }
        this.savePlayerRecords();
    }

    // ============================================================
    // GRACEFUL UPDATE / REBOOT
    // ============================================================

    private checkPendingUpdate(): boolean {
        const current = readPendingUpdate();
        if (!current) return false;
        if (current.version === getSeenVersion(botRole)) return false;

        const note = current.note;
        const message = note
            ? `Heads up — I'll be restarting shortly for an update: ${note}. Be right back!`
            : `Heads up — I'll be restarting shortly for an update. Be right back!`;

        this.bot.sendChat(message);
        log(`Pending update detected (version ${current.version})${note ? ` (${note})` : ""}. Restarting...`);

        markVersionSeen(botRole, current.version);

        setTimeout(() => {
            process.exit(0);
        }, 2000);

        return true;
    }
}
