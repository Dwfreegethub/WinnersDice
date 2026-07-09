import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { log, logError, centralTimestamp } from "./logger";
import { secrets } from "./secrets";
import {
    ActiveBondage,
    ActiveEndGame,
    ActiveLock,
    ActiveToy,
    BCCharacter,
    Player,
    BondageDeal,
    ClothingDeal,
    DiceRoll,
    EndGameLockVote,
    EndGameProposal,
    FeedbackItemStatus,
    FeedbackStatusEntry,
    GameConfig,
    GameState,
    LockDeal,
    MercyRequest,
    NegotiationKey,
    NegotiationState,
    PlayerRecord,
    PlayerState,
    RoundResult,
    ServiceDeal,
    SoldItem,
    SpendOption,
    ToyDeal,
} from "./types";
import { PICK_SLOTS, PickSlot, PICK_LIST_TOP_N, loadBcItemCatalog } from "./bondagePicker";

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

function rollD20(): number {
    return Math.floor(Math.random() * 20) + 1;
}

// Default cap on each player's earned streak, used until an admin changes it
// with !setstreak between games.
const DEFAULT_MAX_STREAK = 10;

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

    private readonly pendingUpdatePath = path.join(__dirname, "..", "pending_update.txt");

    // Cap on streak for the *next* match, admin-settable via !setstreak.
    private defaultMaxStreak: number = DEFAULT_MAX_STREAK;

    // Wardrobe-change checks awaiting a ChatRoomSyncSingle for the opponent
    // in a clothing deal, keyed by the opponent's member number.
    private pendingWardrobeChecks: Map<number, {
        buyer: number;
        item: string;
        timer: NodeJS.Timeout;
    }> = new Map();

    // Full character data from the most recent room sync or join event, keyed
    // by member number. Used for permission pre-flight checks.
    private roomCharacters: Map<number, BCCharacter> = new Map();

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

    // Set while a !challenge's target name matches more than one room member;
    // holds the challenger's numbered reply until they pick one.
    private pendingChallengeDisambiguation: { challengerNumber: number; candidates: Player[] } | null = null;

    // True while the end game proposal's Q4 is waiting for the winner's
    // comma-separated slot list, after they answered "yes" to placing locks.
    // Only meaningful while state.endGameProposal.proposalStage === "q4_locks".
    private endGameAwaitingLockSlotsInput: boolean = false;

    constructor(bot: BCConnection, roomMembers: Map<number, Player>) {
        this.bot = bot;
        this.roomMembers = roomMembers;
        this.state = this.createIdleState();
        this.itemCatalog = loadBcItemCatalog(path.join(__dirname, "..", "..", "bc_items.json"), (msg) => log(msg));
        this.toyCatalog = loadToyCatalog(path.join(__dirname, "..", "ItemHandheld_toys_list.txt"), (msg) => log(msg));
        this.loadBondageUsage();
        this.loadFeedbackStatus();
        this.loadPlayerRecords();
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
            endGameLockVote: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            waitingForWardrobe: null,
            mercyRequest: null,
            mercyCooldowns: new Map(),
        };
    }

    // The round number, 1-indexed, used as the points multiplier for that round.
    private get currentRound(): number {
        return this.state.currentRound;
    }

    private playerName(memberNumber: number): string {
        return this.state.players?.find(p => p.memberNumber === memberNumber)?.name ?? `Player #${memberNumber}`;
    }

    public handleChatMessage(sender: number, content: string, isWhisper: boolean): void {
        const msg = content.trim();
        if (!msg) return;

        if (!msg.startsWith("!")) {
            this.handleConversational(sender, msg);
            return;
        }

        const [cmdRaw, ...rest] = msg.split(/\s+/);
        const cmd = cmdRaw.toLowerCase();
        const args = rest.join(" ");

        const helpArg = args.trim().toLowerCase();

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
                    this.handleHelp(sender);
                }
                break;
            case "!readme":
                this.handleReadme(sender);
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
                } else if (this.isAwaitingConsentAll()) {
                    this.handleConsentAllAnswer(sender, true);
                } else {
                    this.handleYesNoAnswer(sender, true);
                }
                break;
            case "!no":
                if (this.isAwaitingChallengeAcceptance()) {
                    this.handleChallengeAcceptAnswer(sender, false);
                } else if (this.isAwaitingConsentAll()) {
                    this.handleConsentAllAnswer(sender, false);
                } else {
                    this.handleYesNoAnswer(sender, false);
                }
                break;
            case "!cancel":
                this.handleCancel(sender);
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
        }
    }

    // Handles plain-language equivalents of negotiation commands (no leading "!"),
    // so players can respond conversationally during setup and self-rolls.
    private handleConversational(sender: number, msg: string): void {
        const negotiation = this.state.negotiation;
        const lower = msg.toLowerCase();

        // A !challenge matched more than one room member by name — the
        // challenger's next reply picks which one, before any negotiation exists.
        if (this.pendingChallengeDisambiguation?.challengerNumber === sender) {
            this.handleChallengeDisambiguationAnswer(sender, msg);
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

        // A pending lock-time vote (after end game bondage is applied, before
        // the timer/password lock goes on) only accepts 1/2/3 replies from
        // the losers being polled.
        if (this.state.endGameLockVote && this.handleEndGameLockVoteMessage(sender, msg)) {
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

        // The challenger is being asked for a numeric setting (e.g. minimum
        // rounds) and hasn't proposed a value yet — treat any extractable
        // number in their reply as that proposal.
        if (negotiation && this.state.phase === "negotiating" && !negotiation.pending) {
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

        if (lower === "yes" || lower === "y") {
            if (negotiation && this.state.phase === "negotiating") {
                if (negotiation.pending) {
                    this.handleAccept(sender);
                    return;
                }
                if (negotiation.consentAllStage === "awaiting") {
                    this.handleConsentAllAnswer(sender, true);
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
                if (negotiation.consentAllStage === "awaiting") {
                    this.handleConsentAllAnswer(sender, false);
                    return;
                }
                const key = nextNegotiationKey(negotiation.config);
                if (key !== null && isYesNoKey(key)) {
                    this.handleYesNoAnswer(sender, false);
                }
            }
            return;
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
            `!challenge @PlayerName - Challenge a player to a match\n` +
            `!help setup - Challenge and match setup\n` +
            `!help game - During the match\n` +
            `!help shop - The shop and spending\n`;

        if (this.isAdmin(sender)) {
            text += `!help admin - Admin commands\n`;
        }

        text +=
            `!feedback <text> - Send feedback (whisper only)\n` +
            `Tip: all commands work in chat or as a whisper to me.`;

        this.sendLongWhisper(sender, text);
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
            `!challenge @PlayerName - Start a challenge\n` +
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
            `!mercy - Concede early: forfeit half your points and owe a service\n\n` +
            `=== Streaks, Boosts & Curses ===\n` +
            `Each win: dice + streak + boost → pot × round multiplier\n` +
            `Natural 20: +2 streak. Natural 1: -1 to your rolls until you win.\n` +
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
            `bondage - Apply bondage to your opponent (you pay half goes to them)\n` +
            `locks - Lock your opponent's bondage; they can buy out anytime from their post-bank menu\n` +
            `buyback - Buy back something you sold, at double the price\n` +
            `toys - Purchase a timed toy session\n` +
            `actions & services - Request a service from your opponent\n` +
            `back - Return to the post-bank menu\n` +
            `cancel - Back out\n\n` +
            `=== Bondage Removal ===\n` +
            `!removebondage <slot> - (placer) Remove bondage you applied, free\n` +
            `!buybondage <slot> - (wearer) Request a buyout — placer sets the price`;

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
            `!feedback list - View all feedback`;

        this.sendLongWhisper(sender, text);
    }

    private findPlayersByName(name: string, excludeMemberNumber: number): Player[] {
        const lower = name.toLowerCase();
        const matches: Player[] = [];
        for (const player of this.roomMembers.values()) {
            if (player.memberNumber === excludeMemberNumber) continue;
            if (player.name.toLowerCase() === lower) matches.push(player);
        }
        return matches;
    }

    private handleChallenge(sender: number, args: string): void {
        if (this.checkPendingUpdate()) return;

        if (this.state.phase !== "idle") {
            return;
        }

        const targetName = args.replace(/^@/, "").trim();
        if (!targetName) {
            this.bot.sendChat("Usage: !challenge @PlayerName");
            return;
        }

        const challenger = this.roomMembers.get(sender);
        if (!challenger) return;

        if (this.pendingChallengeDisambiguation?.challengerNumber === sender) {
            this.pendingChallengeDisambiguation = null;
        }

        const matches = this.findPlayersByName(targetName, sender);
        if (matches.length === 0) {
            this.bot.sendChat(`Could not find a player named "${targetName}" in the room.`);
            return;
        }

        if (matches.length > 1) {
            this.pendingChallengeDisambiguation = { challengerNumber: sender, candidates: matches };
            this.bot.whisper(sender,
                `Multiple players match that name: ` +
                matches.map((p, i) => `${i + 1}. ${p.name} (member #${p.memberNumber})`).join(", ") +
                ` — reply with the number to choose.`
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
            endGameLockVote: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            waitingForWardrobe: null,
            mercyRequest: null,
            mercyCooldowns: new Map(),
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
        this.bot.sendChat(
            `${opponent.name} accepted! Let's negotiate the match settings. ` +
            `Either player can type !cancel at any time to abort.`
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

    private handleCancel(sender: number): void {
        const state = this.state;

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

    // Either party in an in-progress toy rental can back out — mirrors
    // handleLockDealCancel. Safe at every stage, including "awaiting_duration",
    // since the toy is only actually applied once a duration is chosen.
    private handleToyDealCancel(sender: number): void {
        const deal = this.state.toyDeal;
        if (!deal) return;

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

        if (state.clothingDeal && sender === state.clothingDeal.buyer) {
            const deal = state.clothingDeal;
            if (deal.stage !== "awaiting_item_price" && deal.stage !== "awaiting_item" && deal.stage !== "awaiting_price") {
                this.bot.whisper(deal.opponent, `${this.playerName(deal.buyer)} cancelled the clothing deal.`);
            }
            this.bot.whisper(sender, "Clothing deal cancelled.");
            state.clothingDeal = null;
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

        const players: [PlayerState, PlayerState] = [
            { memberNumber: negotiation.challenger.memberNumber, name: negotiation.challenger.name, balance: 0, streak: 0, boost: 0, cursedPenalty: 0, pendingBalance: 0, soldItems: [] },
            { memberNumber: negotiation.opponent.memberNumber, name: negotiation.opponent.name, balance: 0, streak: 0, boost: 0, cursedPenalty: 0, pendingBalance: 0, soldItems: [] },
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
            endGameLockVote: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            waitingForWardrobe: null,
            mercyRequest: null,
            mercyCooldowns: new Map(),
        };

        const summary = [
            `Minimum rounds: ${config.minRounds}`,
            `Stripping: ${formatValue("stripping", config.stripping)}`,
            `Bondage: ${formatValue("bondage", config.bondage)}` + (config.bondage ? ` (applied by the other player; lock time set via purchases)` : ""),
            `Toys: ${formatValue("toys", config.toys)}`,
            `Services: ${formatValue("services", config.services)}`,
        ].join(", ");

        this.bot.sendChat(
            `All settings agreed! ${summary}. The WinnersDice match between ${players[0].name} and ${players[1].name} is starting!`
        );

        this.startMatch();
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

        if (total1 === total2) return false;

        const winner = total1 > total2 ? p1 : p2;
        const loser = winner === p1 ? p2 : p1;
        const winnerTotal = winner === p1 ? total1 : total2;
        const winnerDice = winner === p1 ? dice1 : dice2;

        // A Natural 1 stacks a -1 cursed penalty on the roller's future
        // rolls until they win one (cleared below when a cursed player wins).
        if (dice1 === 1) {
            p1.cursedPenalty -= 1;
            this.bot.whisper(p1.memberNumber, `💀 Snake eyes! -1 to your rolls until your next win.`);
        }
        if (dice2 === 1) {
            p2.cursedPenalty -= 1;
            this.bot.whisper(p2.memberNumber, `💀 Snake eyes! -1 to your rolls until your next win.`);
        }

        // A Natural 20 grants +2 streak instead of +1, announced in chat.
        if (winnerDice === 20) {
            this.bot.sendChat(`🎯 Natural 20! ${winner.name}'s streak jumps by 2!`);
        }
        winner.streak = Math.min(winner.streak + (winnerDice === 20 ? 2 : 1), maxStreak);
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
        const loserPoints = loserRoll.total * result.round;

        this.bot.sendChat(
            `🎲 Roll ${result.rollNumber} — ${winner.name} rolls ${fmtBreakdown(winnerRoll)} = ${winnerRoll.total} × ${result.round} = ${winnerPoints} points → Pot: ${result.potTotal} points`
        );
        this.bot.sendChat(
            `${loser.name} rolls ${fmtBreakdown(loserRoll)} = ${loserRoll.total} × ${result.round} = ${loserPoints} points → ${winner.name} wins this roll!`
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
        if (this.blockedByServiceDeal(sender)) return;
        if (this.blockedByMercy(sender)) return;

        const winner = state.players.find(p => p.memberNumber === sender)!;
        winner.balance += state.pot;
        const banked = state.pot;
        state.pot = 0;
        state.spendingBalance = winner.balance;

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
        if (this.blockedByServiceDeal(sender)) return;
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
        if (this.blockedByServiceDeal(sender)) return;
        if (this.blockedByMercy(sender)) return;
        if (state.endGameProposal || state.endGameLockVote || state.activeEndGame) return;

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

        this.recordGameCompletion(finalWinnerMemberNumber, [p1, p2]);

        this.clearPendingWardrobeChecks();
        this.releaseAllActiveLocks();
        this.releaseWinnerBondage(winner.memberNumber);
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

        if (state.endGameProposal || state.endGameLockVote || state.activeEndGame ||
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
        this.recordGameCompletion(winner.memberNumber, state.players);

        this.clearPendingWardrobeChecks();
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
    // bespoke cost math: the loser's cost is winnerFloor - agreedMinutes,
    // deducted from their raw balance since they're not in a bank session).
    // Ends either in EXECUTION (timer + password lock, plus any requested
    // extra lock slots) or a BLOCK (loser counters to zero or below — both
    // sides lose their committed points, game continues).
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
            requestedLockSlots: [],
            description: "",
            negotiationStep: 0,
            winnerFloor: 0,
            loserCeiling: null,
            winnerLastOffer: 0,
            loserLastCounter: null,
            winnerPointsCommitted: 0,
            loserPointsCommitted: 0,
        };

        this.bot.whisper(winner.memberNumber, this.endGameBalanceLine(winner.memberNumber));
        this.bot.whisper(loser.memberNumber, this.endGameBalanceLine(loser.memberNumber));

        this.bot.whisper(winner.memberNumber,
            `⚔️ End game initiated. Let's set the terms.\n\n` +
            `Q1 of 5 — How many minutes do you want to claim? Each point = 1 minute and will be spent from your balance ` +
            `(you have ${state.spendingBalance} pts available). Type a number.`
        );
    }

    private handleEndGameProposalCancel(sender: number): void {
        const proposal = this.state.endGameProposal;
        if (!proposal) return;

        this.state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;
        this.bot.whisper(sender, "End game proposal cancelled.");
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
        proposal.winnerFloor = n;
        proposal.winnerLastOffer = n;
        proposal.negotiationStep = 1;
        proposal.proposalStage = "q2_location";

        this.bot.whisper(proposal.winnerMemberNumber,
            `✅ ${n} minutes noted — that will cost you ${n} pts if agreed.\n\n` +
            `Q2 of 5 — Where do you want to take this?\n1. Stay in this room\n2. Move to a different room (recommended for longer sessions)`
        );
        return true;
    }

    private handleEndGameQ2(proposal: EndGameProposal, lower: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "1" || trimmed === "stay") {
            proposal.location = "stay";
            proposal.proposalStage = "q3_privacy";
            this.bot.whisper(proposal.winnerMemberNumber,
                `Q3 of 5 — How do you want to set the room?\n1. Public — open for others to watch or join\n2. Private — just the two of you`);
            return true;
        }
        if (trimmed === "2" || trimmed === "move") {
            proposal.location = "move";
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
            `⚔️ ${winner.name} has proposed an end game:\n\n` +
            `• Time claimed: ${proposal.proposedMinutes} minutes\n` +
            `• Location: ${locationText}\n` +
            `• Locks: ${locksText}\n` +
            `• Their plans: ${proposal.description}\n` +
            `──────────────────────\n` +
            `Your balance: ${loser.balance} pts | ${winner.name}'s balance: ${winner.balance} pts\n\n` +
            `To ACCEPT: say "yes" — ${winner.name} will pay ${proposal.proposedMinutes} pts, you pay nothing.\n` +
            `To NEGOTIATE: reply "counter [minutes]" with a lower number.\n` +
            `  ↳ If you counter with [X] minutes, ${winner.name} pays [X] pts and YOU PAY ${proposal.proposedMinutes} - X pts from your balance to buy off the difference.\n` +
            `  ↳ You cannot decline — only accept or negotiate.\n\n` +
            `(Up to 5 rounds. ${winner.name} gets the final say on round 5.)`
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
            this.closeEndGameDeal(proposal, proposal.winnerLastOffer);
            return true;
        }

        if (trimmed.startsWith("counter")) {
            const n = extractNumber(raw);
            if (n === null) {
                this.bot.whisper(proposal.loserMemberNumber, `Counter with how many minutes? e.g. "counter 20"`);
                return true;
            }
            return this.applyEndGameLoserCounter(proposal, n);
        }

        this.bot.whisper(proposal.loserMemberNumber, `You cannot decline — reply "yes" to accept, or "counter <minutes>" to negotiate.`);
        return true;
    }

    private applyEndGameLoserCounter(proposal: EndGameProposal, n: number): boolean {
        const loser = this.state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        if (n <= 0) {
            this.blockEndGame(proposal, n);
            return true;
        }

        const isFirstCounter = proposal.negotiationStep === 1;

        if (isFirstCounter && n >= proposal.winnerLastOffer) {
            this.closeEndGameDeal(proposal, proposal.winnerLastOffer);
            return true;
        }

        if (!isFirstCounter && proposal.loserCeiling !== null && n > proposal.loserCeiling) {
            this.bot.whisper(loser.memberNumber,
                `Your counter must be lower than your previous counter of ${proposal.loserCeiling} min. (You're locked to go down from there.)`);
            return true;
        }

        const cost = proposal.winnerFloor - n;
        if (loser.balance < cost) {
            this.bot.whisper(loser.memberNumber,
                `You don't have enough points to back that counter. You'd need ${cost} pts but only have ${loser.balance}.`);
            return true;
        }

        proposal.loserLastCounter = n;
        if (isFirstCounter) proposal.loserCeiling = n;
        proposal.negotiationStep = isFirstCounter ? 2 : 4;

        this.sendEndGameStateWhisper(proposal);
        return true;
    }

    private handleEndGameWinnerResponse(proposal: EndGameProposal, lower: string, raw: string): boolean {
        const trimmed = lower.trim();
        if (trimmed === "yes" || trimmed === "accept") {
            const closeAt = proposal.loserLastCounter ?? proposal.winnerFloor;
            this.closeEndGameDeal(proposal, closeAt);
            return true;
        }

        if (trimmed.startsWith("counter")) {
            const n = extractNumber(raw);
            if (n === null) {
                this.bot.whisper(proposal.winnerMemberNumber, `Counter with how many minutes? e.g. "counter 25"`);
                return true;
            }
            return this.applyEndGameWinnerCounter(proposal, n);
        }

        this.bot.whisper(proposal.winnerMemberNumber, `Reply "yes" to accept, or "counter <minutes>" to negotiate.`);
        return true;
    }

    private applyEndGameWinnerCounter(proposal: EndGameProposal, n: number): boolean {
        const state = this.state;
        const isFinal = proposal.negotiationStep === 4;

        if (n < proposal.winnerFloor) {
            this.bot.whisper(proposal.winnerMemberNumber, `Your counter must be at least your opening offer of ${proposal.winnerFloor} min.`);
            return true;
        }
        if (isFinal && n < proposal.winnerLastOffer) {
            this.bot.whisper(proposal.winnerMemberNumber, `Your final offer must be at least your previous offer of ${proposal.winnerLastOffer} min.`);
            return true;
        }

        if (proposal.loserLastCounter !== null && n >= proposal.loserLastCounter) {
            this.closeEndGameDeal(proposal, proposal.loserLastCounter);
            return true;
        }

        if (state.spendingBalance < n) {
            this.bot.whisper(proposal.winnerMemberNumber, `You can't afford that — ${n} pts is more than your ${state.spendingBalance} balance.`);
            return true;
        }

        proposal.winnerLastOffer = n;

        if (isFinal) {
            this.closeEndGameDeal(proposal, n);
            return true;
        }

        proposal.negotiationStep = 3;
        this.sendEndGameStateWhisper(proposal);
        return true;
    }

    private sendEndGameStateWhisper(proposal: EndGameProposal): void {
        const winner = this.playerName(proposal.winnerMemberNumber);
        const loser = this.playerName(proposal.loserMemberNumber);
        const loserCost = proposal.loserLastCounter !== null ? proposal.winnerFloor - proposal.loserLastCounter : 0;
        const nextTurn = (proposal.negotiationStep === 2 || proposal.negotiationStep === 4) ? winner : loser;

        const text =
            `📊 Current negotiation state:\n` +
            `• ${winner}'s offer: ${proposal.winnerLastOffer} min (costs them ${proposal.winnerLastOffer} pts)\n` +
            `• ${loser}'s counter: ${proposal.loserLastCounter ?? "not yet set"} min (would cost them ${loserCost} pts)\n` +
            `${nextTurn}'s turn — step ${proposal.negotiationStep} of 5`;

        this.bot.whisper(proposal.winnerMemberNumber, text);
        this.bot.whisper(proposal.loserMemberNumber, text);
    }

    // The loser countered to zero (or below) — the "nuclear option". Both
    // sides lose their currently-committed points with no refund, and the
    // match continues as if endgame had never been called.
    private blockEndGame(proposal: EndGameProposal, blockValue: number): void {
        const state = this.state;
        const winner = state.players!.find(p => p.memberNumber === proposal.winnerMemberNumber)!;
        const loser = state.players!.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        const winnerCost = Math.min(proposal.winnerLastOffer, state.spendingBalance);
        const loserCost = Math.min(Math.max(proposal.winnerFloor - blockValue, 0), loser.balance);

        state.spendingBalance -= winnerCost;
        winner.balance = state.spendingBalance;
        loser.balance -= loserCost;

        this.bot.sendChat("The end game was blocked. The game continues.");
        this.bot.whisper(winner.memberNumber, `${loser.name} blocked the negotiation — you lose the ${winnerCost} pts you had committed.`);
        this.bot.whisper(loser.memberNumber, `You blocked the negotiation — you lose ${loserCost} pts for walking away.`);

        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;
        state.awaitingPostBank = winner.memberNumber;
        this.bot.whisper(winner.memberNumber, this.postBankPromptText(winner.memberNumber));
    }

    private closeEndGameDeal(proposal: EndGameProposal, finalMinutes: number): void {
        proposal.proposalStage = "executing";
        this.executeEndGame(proposal, finalMinutes);
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

    // Settles the agreed end game: deducts both sides' committed points
    // (STUB — should go to a per-pair bank, not just vanish; see wd_todo.md),
    // applies an Exclusive lock to any requested extra slots that already
    // have bondage on them, and announces the terms per location/privacy.
    // The timer/password lock itself doesn't go on yet — that waits for the
    // lock-time vote (see startEndGameLockVote) to settle the final duration.
    private executeEndGame(proposal: EndGameProposal, finalMinutes: number): void {
        const state = this.state;
        if (!state.players) return;

        const winner = state.players.find(p => p.memberNumber === proposal.winnerMemberNumber)!;
        const loser = state.players.find(p => p.memberNumber === proposal.loserMemberNumber)!;

        const winnerCost = Math.min(finalMinutes, state.spendingBalance);
        const loserCost = Math.min(Math.max(proposal.winnerFloor - finalMinutes, 0), loser.balance);

        state.spendingBalance -= winnerCost;
        winner.balance = state.spendingBalance;
        loser.balance -= loserCost;

        proposal.winnerPointsCommitted = winnerCost;
        proposal.loserPointsCommitted = loserCost;

        log(`[STUB] Per-pair bank: ${winner.name} banks ${winnerCost} pts, ${loser.name} banks ${loserCost} pts. TODO: persist to a per-pair points bank instead of discarding.`);

        const lockProperty = this.buildLockProperty();
        const appliedLockSlots: string[] = [];
        for (const group of proposal.requestedLockSlots) {
            const slotDisplay = PICK_SLOTS.find(s => s.group === group)?.display;
            const entry = slotDisplay
                ? state.activeBondage.find(b => b.wearerMemberNumber === loser.memberNumber && b.slot === slotDisplay)
                : undefined;
            if (!entry) continue; // nothing worn there — nothing to lock
            this.bot.applyItem(loser.memberNumber, group, entry.itemName, "Default", lockProperty);
            appliedLockSlots.push(group);
        }
        if (appliedLockSlots.length < proposal.requestedLockSlots.length) {
            const skipped = proposal.requestedLockSlots.filter(s => !appliedLockSlots.includes(s));
            this.bot.whisper(winner.memberNumber, `Note: couldn't lock ${skipped.join(", ")} — nothing is worn there.`);
        }

        if (proposal.location === "move") {
            this.bot.sendChat(`⚔️ End game terms agreed! ${winner.name} and ${loser.name} — consider moving to a private room for this session.`);
        } else if (proposal.privacy === "public") {
            this.bot.sendChat(`⚔️ End game underway! ${winner.name} has claimed ${finalMinutes} minutes with ${loser.name}. The room is open for observers.`);
        } else {
            this.bot.sendChat(`⚔️ End game underway between ${winner.name} and ${loser.name}.`);
        }

        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;

        this.startEndGameLockVote(winner.memberNumber, loser.memberNumber, winnerCost, loserCost, appliedLockSlots);
    }

    // Suggested lock-time vote baseline — scales with room size. With the
    // game's current strictly-1v1 player list this is always max(10, 10) =
    // 10, but is written off state.players.length rather than hardcoded so
    // it scales correctly if the player list is ever widened.
    private endGameSuggestedLockMinutes(): number {
        const playerCount = this.state.players?.length ?? 2;
        return Math.max(10, playerCount * 5);
    }

    // After the end game's extra lock slots are applied, give every loser a
    // 30-second window to nudge the suggested timer/password lock duration
    // before it actually goes on. No reply within the window counts as
    // "accept" (see finalizeEndGameLockVote).
    private startEndGameLockVote(
        winnerMemberNumber: number,
        loserMemberNumber: number,
        winnerPointsSpent: number,
        loserPointsSpent: number,
        appliedLockSlots: string[],
    ): void {
        const suggested = this.endGameSuggestedLockMinutes();
        const timeout = setTimeout(() => this.finalizeEndGameLockVote(), 30 * 1000);

        this.state.endGameLockVote = {
            winnerMemberNumber,
            loserMemberNumbers: [loserMemberNumber],
            suggestedMinutes: suggested,
            votes: new Map(),
            winnerPointsSpent,
            loserPointsSpent,
            appliedLockSlots,
            timeout,
        };

        this.bot.whisper(loserMemberNumber,
            `Lock time vote: ${suggested} min proposed. Reply: 1 = less (−5 min)  2 = accept  3 = more (+5 min). You have 30 seconds.`);
    }

    // Dispatches a loser's vote reply. Returns true if the message was
    // consumed (whether or not it was a valid 1/2/3). Ignores anything from
    // someone who isn't one of the polled losers, or a second reply from
    // someone who already voted.
    private handleEndGameLockVoteMessage(sender: number, raw: string): boolean {
        const vote = this.state.endGameLockVote;
        if (!vote || !vote.loserMemberNumbers.includes(sender)) return false;
        if (vote.votes.has(sender)) return true;

        const trimmed = raw.trim();
        if (trimmed !== "1" && trimmed !== "2" && trimmed !== "3") {
            this.bot.whisper(sender, `Please reply 1 (less), 2 (accept), or 3 (more).`);
            return true;
        }

        vote.votes.set(sender, Number(trimmed) as 1 | 2 | 3);

        if (vote.votes.size === vote.loserMemberNumbers.length) {
            clearTimeout(vote.timeout);
            this.finalizeEndGameLockVote();
        }
        return true;
    }

    // Tallies whatever votes came in — missing votes count as "accept" —
    // and moves on to actually applying the timer/password lock. Guards
    // against running twice (once from the last vote in, once from the
    // timeout) by clearing state.endGameLockVote first.
    private finalizeEndGameLockVote(): void {
        const vote = this.state.endGameLockVote;
        if (!vote) return;
        clearTimeout(vote.timeout);
        this.state.endGameLockVote = null;

        let lessCount = 0;
        let moreCount = 0;
        for (const loserMemberNumber of vote.loserMemberNumbers) {
            const choice = vote.votes.get(loserMemberNumber) ?? 2;
            if (choice === 1) lessCount++;
            else if (choice === 3) moreCount++;
        }

        const finalMinutes = Math.max(10, vote.suggestedMinutes + moreCount * 5 - lessCount * 5);
        this.bot.sendChat(`⏱️ Lock time vote result: ${finalMinutes} minutes.`);

        this.applyEndGameTimerLock(vote, finalMinutes);
    }

    // Applies the timer/password lock to the loser's leash slot at the
    // vote's final duration, hands the winner the password, and schedules
    // expireEndGame() for when it's up.
    private applyEndGameTimerLock(vote: EndGameLockVote, finalMinutes: number): void {
        const state = this.state;
        const loserMemberNumber = vote.loserMemberNumbers[0];

        const password = String(Math.floor(1000 + Math.random() * 9000));
        this.bot.applyItem(loserMemberNumber, END_GAME_LEASH_GROUP, END_GAME_LEASH_ITEM, "Default", this.buildTimerPasswordLockProperty(password, finalMinutes));
        this.bot.whisper(vote.winnerMemberNumber, `🔑 Lock password for ${this.playerName(loserMemberNumber)}'s leash: ${password} — this is only shown once.`);

        const timer = setTimeout(() => this.expireEndGame(), finalMinutes * 60 * 1000);
        state.activeEndGame = {
            winnerMemberNumber: vote.winnerMemberNumber,
            loserMemberNumber,
            agreedMinutes: finalMinutes,
            winnerPointsSpent: vote.winnerPointsSpent,
            loserPointsSpent: vote.loserPointsSpent,
            timer,
            appliedLockSlots: vote.appliedLockSlots,
        };
    }

    // Fires when the agreed end game time is up: strips the timer/password
    // leash lock and any extra requested locks, announces it, and finishes
    // the match. Guards against a stale timer in case activeEndGame was
    // already cleared some other way (safeword, reset) in the meantime.
    private expireEndGame(): void {
        const active = this.state.activeEndGame;
        if (!active) return;

        this.bot.removeItem(active.loserMemberNumber, END_GAME_LEASH_GROUP);
        for (const group of active.appliedLockSlots) {
            const slotDisplay = PICK_SLOTS.find(s => s.group === group)?.display;
            const entry = slotDisplay
                ? this.state.activeBondage.find(b => b.wearerMemberNumber === active.loserMemberNumber && b.slot === slotDisplay)
                : undefined;
            if (entry) {
                this.bot.applyItem(active.loserMemberNumber, group, entry.itemName, "Default", {});
            }
        }

        this.bot.sendChat(`⏱️ ${this.playerName(active.winnerMemberNumber)}'s claimed time with ${this.playerName(active.loserMemberNumber)} has ended.`);

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
            options.push({ key: "locks", label: `locks — buy a lock on ${opponent.name}'s bondage with a removal price (they can accept, decline, or counter)` });
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
            `\n0. Back — return to continue/endgame`
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
            if (state.clothingDeal) {
                this.bot.whisper(sender, "There's already a clothing deal in progress — finish that first.");
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
            if (state.clothingDeal || state.bondageDeal) {
                this.bot.whisper(sender, "There's already a deal in progress — finish that first.");
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
            if (state.clothingDeal || state.bondageDeal || state.lockDeal || state.toyDeal) {
                this.bot.whisper(sender, "There's already a deal in progress — finish that first.");
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
            if (state.clothingDeal || state.bondageDeal || state.lockDeal) {
                this.bot.whisper(sender, "There's already a deal in progress — finish that first.");
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
    }

    // ============================================================
    // STREAK BOOST PURCHASE
    // ============================================================

    private startBoostPurchase(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        const player = state.players.find(p => p.memberNumber === sender)!;
        state.awaitingBoostLevel = sender;

        this.bot.sendChat(`⚡ ${this.playerName(sender)} is picking up a power-up...`);
        this.bot.whisper(sender,
            `A boost adds straight to your roll total and persists across rounds — it only drains by 1 each time you lose, so a +3 boost survives 3 losses.\n\n` +
            `Streak Boost prices:\n` +
            `+1 Boost — 40 points\n` +
            `+2 Boost — 100 points\n` +
            `+3 Boost — 225 points\n` +
            `+4 Boost — 500 points\n` +
            `+5 Boost — 1,000 points\n` +
            `(your current boost: +${player.boost}, max total: +${MAX_BOOST})\n` +
            `How many levels? (say 1-5, or 0 to go back)`
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

        const cost = BOOST_PRICES[level - 1];
        if (state.spendingBalance < cost) {
            this.bot.whisper(sender, `You can't afford that — +${level} Boost costs ${cost} points and you have ${state.spendingBalance}. Type !cancel to exit the shop or choose a cheaper level.`);
            state.awaitingBoostLevel = null;
            this.returnToSpendMenu(sender);
            return;
        }

        state.spendingBalance -= cost;
        player.boost += level;
        state.awaitingBoostLevel = null;

        this.bot.whisper(sender, `Boost purchased! Your boost is now +${player.boost}. Each loss reduces it by 1.`);
        this.returnToSpendMenu(sender);
    }

    // ============================================================
    // BUYBACK
    // ============================================================

    private startBuyback(sender: number): void {
        const state = this.state;
        if (!state.players) return;
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
        if (state.bondageDeal || state.lockDeal || state.toyDeal || state.serviceDeal) {
            this.bot.whisper(buyer, "There's already a deal in progress — finish that first.");
            return;
        }
        const opponent = state.players.find(p => p.memberNumber !== buyer)!;

        state.clothingDeal = {
            buyer,
            opponent: opponent.memberNumber,
            item: null,
            price: null,
            counterPrice: null,
            stage: "awaiting_item_price",
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
        }
    }

    // Parses the buyer's item/price input for stages awaiting_item_price,
    // awaiting_item, and awaiting_price. Always consumes the message.
    private handleClothingItemPriceInput(deal: ClothingDeal, raw: string): boolean {
        const trimmedLower = raw.trim().toLowerCase();
        if (trimmedLower === "cancel" || trimmedLower === "!cancel") {
            this.handleShopCancel(deal.buyer);
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
            this.handleShopCancel(deal.buyer);
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
                this.bot.whisper(deal.opponent, "What price would you like to counter with?");
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
            this.bot.whisper(deal.opponent, "What price would you like to counter with?");
            return true;
        }

        // This is the opponent's only counter-offer in a clothing deal (the
        // buyer can only accept/decline it afterward) — so it's always the
        // "first counter-offer" Rule A caps, using deal.price (still the
        // buyer's untouched original offer at this point) as the baseline.
        const { amount: capped, notice } = applyFirstCounterCap(deal.price!, n);
        if (notice) this.bot.whisper(deal.opponent, notice);

        deal.counterPrice = capped;
        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.buyer, `${this.playerName(deal.opponent)} counters: ${deal.item} for ${capped} points. Accept or decline?`);
        return true;
    }

    // The buyer can only accept or decline the opponent's counter — no
    // further counter-offers from the buyer.
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

        this.bot.whisper(deal.buyer, "Accept or decline the counter-offer?");
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

        const waitMsg = `⏳ Waiting for ${opponent.name} to remove ${item} from their wardrobe. The game is paused until then.`;
        this.bot.whisper(deal.buyer, waitMsg);
        this.bot.whisper(deal.opponent, waitMsg);

        this.startWardrobeCheck(deal.buyer, deal.opponent, item);

        state.clothingDeal = null;
    }

    // Watches for a ChatRoomSyncSingle wardrobe change from `opponent`
    // within WARDROBE_CHECK_TIMEOUT_MS, blocking all game commands until it
    // arrives. If none arrives in time, nudges the buyer to follow up
    // directly, but keeps the game paused.
    private startWardrobeCheck(buyer: number, opponent: number, item: string): void {
        const existing = this.pendingWardrobeChecks.get(opponent);
        if (existing) clearTimeout(existing.timer);

        const timeoutAt = Date.now() + WARDROBE_CHECK_TIMEOUT_MS;
        this.state.waitingForWardrobe = { memberNumber: opponent, item, timeoutAt };

        const timer = setTimeout(() => {
            this.bot.whisper(buyer, `⚠️ ${this.playerName(opponent)} hasn't made a wardrobe change yet. You may need to follow up.`);
        }, WARDROBE_CHECK_TIMEOUT_MS);

        this.pendingWardrobeChecks.set(opponent, { buyer, item, timer });
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
        if (state.clothingDeal || state.bondageDeal || state.lockDeal || state.toyDeal || state.serviceDeal) {
            this.bot.whisper(buyer, "There's already a deal in progress — finish that first.");
            return;
        }
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
                return false;
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
            `${this.playerName(deal.buyer)} wants to buy a service: "${deal.description}" for ${deal.price} pts. ` +
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
        this.bot.whisper(deal.seller, `${this.playerName(deal.buyer)} counters: "${deal.description}" for ${deal.price} points. Accept, decline, or counter?`);
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

        this.bot.sendChat(`✅ ${buyer.name} purchased a service from ${seller.name}: "${description}" for ${price} pts. ${seller.name} has 5 minutes.`);

        deal.price = price;
        deal.stage = "active";
        this.startServiceTimer(deal);
    }

    // Schedules the 3-minute warning whisper and the 5-minute expiry for an
    // active service deal.
    private startServiceTimer(deal: ServiceDeal): void {
        deal.warningHandle = setTimeout(() => {
            this.bot.whisper(deal.buyer, "⏳ 3 minutes remaining on the service.");
            this.bot.whisper(deal.seller, "⏳ 3 minutes remaining on the service.");
        }, 2 * 60 * 1000);

        deal.timerHandle = setTimeout(() => this.expireServiceDeal(deal), 5 * 60 * 1000);
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

    // Top-N most popular items for this slot (from this bot's own usage
    // data), filled out with random catalog items so the list is never
    // sparse on a cold start (StripDiceBot's shared picker instead falls
    // back to bootstrap preset outfits, which WD has none of).
    private buildBondagePickList(group: string, excluded: string[]): { options: string[]; hasRandom: boolean } {
        const catalogItems = this.itemCatalog.get(group) ?? [];
        const usage = this.bondageUsage[group] ?? {};

        const options: string[] = Object.entries(usage)
            .filter(([name, count]) => count > 0 && !excluded.includes(name) && catalogItems.includes(name))
            .sort((a, b) => b[1] - a[1])
            .slice(0, PICK_LIST_TOP_N)
            .map(([name]) => name);
        const popularCount = options.length;

        const rest = catalogItems.filter(n => !options.includes(n) && !excluded.includes(n));
        const shuffled = [...rest].sort(() => Math.random() - 0.5);
        while (options.length < PICK_LIST_TOP_N && shuffled.length > 0) {
            options.push(shuffled.shift()!);
        }

        return { options, hasRandom: options.length > popularCount };
    }

    private formatBondagePickList(slotDisplay: string, wearerName: string, options: string[], hasRandom: boolean): string {
        const lines = [`Slot: ${slotDisplay} — pick an item to apply to ${wearerName}:`];
        options.forEach((name, i) => {
            const marker = hasRandom && i === options.length - 1 ? ` ← random pick (not in top ${PICK_LIST_TOP_N})` : "";
            lines.push(`${i + 1}. ${name}${marker}`);
        });
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
        if (state.clothingDeal || state.bondageDeal || state.lockDeal || state.toyDeal || state.serviceDeal) {
            this.bot.whisper(buyer, "There's already a deal in progress — finish that first.");
            return;
        }
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

        if (this.state.activeLocks.some(l => l.wearerMemberNumber === sender && l.slot === match.slot)) {
            this.bot.whisper(sender, `That slot is locked with an Exclusive lock — pay its removal price from your post-bank menu ("remove locks") instead.`);
            return;
        }

        state.bondageDeal = {
            kind: "removal",
            placer: match.placerMemberNumber,
            wearer: sender,
            slot: match.slot,
            itemName: match.itemName,
            itemOptions: [],
            price: null,
            counterPrice: null,
            stage: "awaiting_price",
            pendingFuzzyItem: null,
            negotiationStep: 0,
            initiatorFloor: null,
            responderCeiling: null,
        };

        this.bot.whisper(match.placerMemberNumber,
            `${this.playerName(sender)} wants to buy back the ${match.itemName} on their ${match.slot}. How many points do you want to charge for removal?`);
        this.bot.whisper(sender, `⏳ Offer sent to ${this.playerName(match.placerMemberNumber)}. Waiting for their response...`);
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

        const { options, hasRandom } = this.buildBondagePickList(match.group, []);
        if (options.length === 0) {
            this.bot.whisper(deal.placer, "No items are available for that slot right now — pick a different one.");
            return true;
        }

        deal.slot = match.display;
        deal.itemOptions = options;
        deal.stage = "awaiting_item";
        this.sendLongWhisper(deal.placer, this.formatBondagePickList(match.display, wearerName, options, hasRandom));
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
                const alreadyShown = new Set(deal.itemOptions);
                const rest = (this.itemCatalog.get(group) ?? []).filter(n => !alreadyShown.has(n));
                if (rest.length === 0) {
                    this.bot.whisper(deal.placer, `No item matching "${trimmed}" — and no more items left to list for this slot.`);
                    return true;
                }
                const more = rest.slice(0, 10);
                deal.itemOptions = more;
                const remaining = rest.length - more.length;
                this.sendLongWhisper(deal.placer,
                    `No item matching "${trimmed}" in this slot. Here are ${more.length} more — reply with a number:\n` +
                    more.map((name, i) => `${i + 1}. ${name}`).join("\n") +
                    (remaining > 0 ? `\n...and ${remaining} more — type part of the name to search further.` : "")
                );
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
        } else if (wearer.balance < price) {
            this.bot.whisper(deal.wearer, `You can't afford that — ${price} points is more than your ${wearer.balance} balance. The deal is off.`);
            this.bot.whisper(deal.placer, `${wearer.name} can't cover ${price} points — the deal is off.`);
            state.bondageDeal = null;
            this.returnToSpendMenu(deal.placer);
            return;
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
            });
            this.incrementBondageUsage(group, itemName);
            state.removableBondage = state.removableBondage.filter(
                r => !(r.wearerMemberNumber === deal.wearer && r.slot === deal.slot)
            );

            this.bot.sendChat(`⛓️ Deal! ${placer.name} paid ${price} points to apply ${itemName} to ${wearer.name}'s ${deal.slot}. ${wearer.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points.`);
        } else {
            wearer.balance -= price;
            placer.pendingBalance += half;

            this.bot.removeItem(deal.wearer, group);
            state.activeBondage = state.activeBondage.filter(b => !(b.wearerMemberNumber === deal.wearer && b.slot === deal.slot));
            state.activeLocks = state.activeLocks.filter(l => !(l.wearerMemberNumber === deal.wearer && l.slot === deal.slot));
            if (ALLOW_FREE_REAPPLY) {
                state.removableBondage.push({
                    slot: deal.slot!,
                    itemName,
                    assetName: itemName,
                    placerMemberNumber: deal.placer,
                    wearerMemberNumber: deal.wearer,
                });
            }

            this.bot.sendChat(`🔓 Deal! ${wearer.name} paid ${price} points to have ${itemName} removed from their ${deal.slot}. ${placer.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points.`);
        }

        state.bondageDeal = null;
        this.returnToSpendMenu(deal.placer);
    }

    // Physically releases every active bondage item via the BC socket and
    // clears the tracking arrays — used for a force-reset (!reset) or a
    // safeword halt, where both players need to be freed immediately. A
    // normal match end goes through releaseWinnerBondage() instead, since
    // the loser's bondage is meant to stay on (the end-game timer lock
    // handles stripping them later).
    private releaseAllActiveBondage(): void {
        for (const entry of this.state.activeBondage) {
            this.bot.removeItem(entry.wearerMemberNumber, this.groupForSlotDisplay(entry.slot));
        }
        this.state.activeBondage = [];
        this.state.removableBondage = [];
    }

    // Strips only the winner's active bondage at the end of a match — the
    // loser's stays on, since the end-game timer lock is responsible for
    // freeing them. Removal is staggered one item at a time
    // (END_GAME_STRIP_STAGGER_MS apart) rather than fired all at once, and
    // each removal is verified against the winner's synced appearance,
    // retrying up to END_GAME_STRIP_MAX_ATTEMPTS times before giving up and
    // asking the winner to remove the item manually.
    private releaseWinnerBondage(winnerMemberNumber: number): void {
        const toRemove = this.state.activeBondage.filter(b => b.wearerMemberNumber === winnerMemberNumber);

        toRemove.forEach((entry, i) => {
            setTimeout(() => {
                this.stripWinnerItem(winnerMemberNumber, entry.slot, this.groupForSlotDisplay(entry.slot), 1);
            }, i * END_GAME_STRIP_STAGGER_MS);
        });

        this.state.activeBondage = this.state.activeBondage.filter(b => b.wearerMemberNumber !== winnerMemberNumber);
        this.state.removableBondage = this.state.removableBondage.filter(b => b.wearerMemberNumber !== winnerMemberNumber);
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
        if (state.clothingDeal || state.bondageDeal || state.lockDeal || state.toyDeal || state.serviceDeal) {
            this.bot.whisper(sender, "There's already a deal in progress — finish that first.");
            return;
        }
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
        this.bot.sendChat(`🔒 ${this.playerName(sender)} is thinking about adding some extra security to ${this.playerName(wearer.memberNumber)}'s situation...`);
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
            `Propose a removal price — ${this.playerName(deal.wearer)} can accept, decline, or counter. How many points?`);
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
            `${placerName} wants to apply an Exclusive lock to your ${lockedList} — removal would cost ${deal.price} points, payable anytime from your post-bank menu. Accept? (yes/no, or 'counter <number>')`);
        this.bot.whisper(deal.placer,
            `⏳ Your lock offer (${lockedList} for ${deal.price} points removal) has been sent to ${wearerName}. Waiting for their response...`);
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
                this.bot.whisper(deal.wearer, "What removal price would you like to counter with?" + counterOfferHint(deal));
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
            this.bot.whisper(deal.wearer, "What removal price would you like to counter with?" + counterOfferHint(deal));
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
        this.bot.whisper(deal.placer, `${this.playerName(deal.wearer)} counters: ${deal.counterPrice} points removal. Accept, decline, or counter?`);
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
                this.bot.whisper(deal.placer, "What removal price would you like to counter with?" + counterOfferHint(deal));
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
            this.bot.whisper(deal.placer, "What removal price would you like to counter with?" + counterOfferHint(deal));
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
            `${this.playerName(deal.placer)} counters: ${deal.price} points removal. Accept, decline, or counter?`);
        return true;
    }

    // Settles an agreed lock deal: applies the Exclusive lock(s) immediately
    // and records the agreed price on each ActiveLock so the later removal
    // cost can be computed (see lockRemovalCost). No points change hands
    // here — only removal costs the wearer.
    private finalizeLockDeal(deal: LockDeal, price: number): void {
        const state = this.state;
        state.lockDeal = null;
        if (!state.players) return;

        const placerName = this.playerName(deal.placer);
        const wearerName = this.playerName(deal.wearer);
        const lockProperty = this.buildLockProperty();

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
        const removalCost = price * LOCK_REMOVAL_MULTIPLIER;
        this.bot.sendChat(`🔒 ${placerName} locked ${wearerName}'s ${lockedList} with an Exclusive lock — removal costs ${removalCost} points.`);
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

        this.bot.sendChat(`🔓 ${wearer.name} paid ${total} points to have their locked ${removedSlots} unlocked.`);
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

    // Top-N curated popular toys, filled out with random catalog items so
    // the list is never sparse — mirrors buildBondagePickList.
    private buildToyPickList(): { options: ToyCatalogEntry[]; hasRandom: boolean } {
        const popular = POPULAR_TOY_ASSET_NAMES
            .map(name => this.toyCatalog.find(t => t.assetName === name))
            .filter((t): t is ToyCatalogEntry => t !== undefined);
        const popularCount = popular.length;

        const rest = this.toyCatalog.filter(t => !popular.includes(t));
        const shuffled = [...rest].sort(() => Math.random() - 0.5);
        const options = [...popular];
        while (options.length < PICK_LIST_TOP_N && shuffled.length > 0) {
            options.push(shuffled.shift()!);
        }

        return { options, hasRandom: options.length > popularCount };
    }

    private formatToyPickList(options: ToyCatalogEntry[], hasRandom: boolean): string {
        const lines = [`Pick a toy:`];
        options.forEach((t, i) => {
            const marker = hasRandom && i === options.length - 1 ? ` ← random pick (not in top ${PICK_LIST_TOP_N})` : "";
            lines.push(`${i + 1}. ${t.label}${marker}`);
        });
        lines.push("0. Back");
        lines.push(`Or type any toy name, or "list" to see the full catalog.`);
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
        if (state.clothingDeal || state.bondageDeal || state.lockDeal || state.toyDeal || state.serviceDeal) {
            this.bot.whisper(winner, "There's already a deal in progress — finish that first.");
            return;
        }
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
        const { options, hasRandom } = this.buildToyPickList();
        state.toyDeal = {
            winner,
            loser: loser.memberNumber,
            toyAssetName: null,
            toyLabel: null,
            toyOptions: options.map(t => t.assetName),
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
        this.sendLongWhisper(winner, this.formatToyPickList(options, hasRandom));
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
                this.bot.whisper(deal.winner, `No toy matching "${trimmed}" — pick a number from the list, type part of the name, or "list" for the full catalog.`);
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

        this.bot.sendChat(`🧸 Deal! ${winner.name} paid ${price} points for ${minutes} minute(s) with the ${itemLabel}. ${loser.name} receives ${half} points (pending — available next Bank). Bot fee: ${half} points.`);

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

        if (data.Character) this.roomCharacters.set(memberNumber, data.Character as BCCharacter);

        const pending = this.pendingWardrobeChecks.get(memberNumber);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingWardrobeChecks.delete(memberNumber);

        if (this.state.waitingForWardrobe?.memberNumber === memberNumber) {
            this.state.waitingForWardrobe = null;
        }

        this.bot.sendChat(`👗 ${this.playerName(memberNumber)} has handed over their ${pending.item}! The game continues.`);

        this.sendPostWardrobeMenu(pending.buyer);
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
        this.clearPendingWardrobeChecks();
        // TODO: Save/resume end game state across sessions — design TBD.
        this.clearEndGameState();
        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();
        this.clearServiceDeal();
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
        this.clearPendingWardrobeChecks();
        // TODO: Save/resume end game state across sessions — design TBD.
        this.clearEndGameState();
        this.releaseAllActiveLocks();
        this.releaseAllActiveBondage();
        this.releaseActiveToy();
        this.clearServiceDeal();
        this.state = this.createIdleState();
        this.bot.sendChat("Game has been reset by admin.");
    }

    // Cancels any in-progress end game proposal/negotiation and, if a timer
    // lock is actively running, cancels its timer and strips the leash lock.
    // Any additional requested lock slots are left for releaseAllActiveBondage()
    // to strip along with the item they're locked to (see executeEndGame —
    // those locks are only ever applied over an already-tracked activeBondage
    // entry, so the normal teardown covers them).
    private clearEndGameState(): void {
        const state = this.state;
        state.endGameProposal = null;
        this.endGameAwaitingLockSlotsInput = false;

        if (state.endGameLockVote) {
            clearTimeout(state.endGameLockVote.timeout);
            state.endGameLockVote = null;
        }

        if (state.activeEndGame) {
            clearTimeout(state.activeEndGame.timer);
            this.bot.removeItem(state.activeEndGame.loserMemberNumber, END_GAME_LEASH_GROUP);
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
        const validStatuses: FeedbackItemStatus[] = ["reviewing", "testing", "implemented", "partly_implemented"];

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

        chunks.forEach((c, i) => {
            setTimeout(() => this.bot.whisper(memberNumber, c), i * 300);
        });
    }

    // ============================================================
    // PLAYER TRACKING
    // ============================================================

    public onMemberJoin(memberNumber: number, name: string, char?: BCCharacter): void {
        if (memberNumber === this.bot.getMemberNumber()) return;
        if (char) this.roomCharacters.set(memberNumber, char);
        this.recordPlayerSeen(memberNumber, name);
        this.sendWelcomeWhisper(memberNumber, name);
        this.notifyFeedbackStatus(memberNumber, name);
    }

    public onRoomSync(characters: BCCharacter[]): void {
        for (const char of characters) {
            if (char.MemberNumber === undefined || char.MemberNumber === this.bot.getMemberNumber()) continue;
            const name = char.Nickname || char.Name || `Player #${char.MemberNumber}`;
            this.roomCharacters.set(char.MemberNumber, char);
            this.recordPlayerSeen(char.MemberNumber, name);
        }
    }

    private sendWelcomeWhisper(memberNumber: number, name: string): void {
        this.bot.whisper(memberNumber,
            `Welcome, ${name}! WinnersDice has been getting regular updates thanks to player feedback. ` +
            `Play a round and let us know what you think — type !challenge @opponent to start or !help to see the rules. 🎲`
        );
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
    }

    private savePlayerRecords(): void {
        try {
            fs.writeFileSync(this.playerRecordsPath, JSON.stringify(this.playerRecords, null, 2), "utf8");
        } catch (err) {
            logError(`[WD] Failed to write players.json: ${err}`);
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
                feedbackGiven: this.loadFeedbackMemberNumbers().has(memberNumber),
            };
        }
        this.savePlayerRecords();
    }

    // Called once a match concludes, crediting both participants with a
    // completed game and the winner (if any) with a win.
    private recordGameCompletion(winnerMemberNumber: number | null, participants: PlayerState[]): void {
        for (const participant of participants) {
            const record = this.playerRecords[String(participant.memberNumber)];
            if (!record) continue;
            record.gamesPlayed++;
            if (winnerMemberNumber !== null && participant.memberNumber === winnerMemberNumber) {
                record.gamesWon++;
            }
        }
        this.savePlayerRecords();
    }

    // ============================================================
    // GRACEFUL UPDATE / REBOOT
    // ============================================================

    private checkPendingUpdate(): boolean {
        if (!fs.existsSync(this.pendingUpdatePath)) return false;

        let note = "";
        try {
            note = fs.readFileSync(this.pendingUpdatePath, "utf8").trim();
        } catch {
            note = "";
        }

        const message = note
            ? `Heads up — I'll be restarting shortly for an update: ${note}. Be right back!`
            : `Heads up — I'll be restarting shortly for an update. Be right back!`;

        this.bot.sendChat(message);
        log(`Pending update detected${note ? ` (${note})` : ""}. Restarting...`);

        try {
            fs.unlinkSync(this.pendingUpdatePath);
        } catch (err) {
            logError(`[WD] Failed to delete pending_update.txt: ${err}`);
        }

        setTimeout(() => {
            process.exit(0);
        }, 2000);

        return true;
    }
}
