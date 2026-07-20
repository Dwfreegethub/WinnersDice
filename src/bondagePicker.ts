/**
 * bondagePicker.ts — shared "player-pick" bondage system.
 *
 * Extracted from StripDiceBot's game.ts so it can be reused by other bots
 * (WinnersDice, and future bots built on the shared framework) without
 * copy-pasting the picker flow.
 *
 * WHAT THIS MODULE OWNS
 *   - Pre-game "outfit vs player-pick" mode question and its resolution.
 *   - Slot-consent question for player-pick players (which BC item groups
 *     they allow items to be applied to).
 *   - The full pick flow for one bondage item: picking who picks
 *     (choosePickerFor), slot choice, item choice (numbered list + fuzzy
 *     text match), the target's veto step, and finally applying the item
 *     via the host's bot adapter.
 *   - Popularity tracking (bondage_usage.json) that drives the picker's
 *     top-N item list, and a learned per-item settings library
 *     (item_settings.json) so picked items apply in a sensible
 *     configuration instead of BC's bare default mode.
 *   - Logging selected picks to outfit_candidates.json for later curation
 *     into a bot's outfits.json.
 *
 * WHAT THIS MODULE DOES NOT OWN
 *   - Turn order / dice rolling / clothing removal / game state machine.
 *   - Preset "outfit" mode (BONDAGE_OUTFITS, outfits.json) — that stays
 *     host-side; this module only borrows a host-supplied list of outfits
 *     as a bootstrap fallback for the picker's popularity list and to seed
 *     the item-settings library.
 *   - End-game locking/unlocking.
 *
 * HOW TO WIRE THIS INTO A BOT
 *   1. Implement `BondagePickerBot` on top of your connection (applyItem,
 *      whisper, sendChat — StripDiceBot's BCConnection already has all
 *      three with matching signatures).
 *   2. Implement `BondagePickerHost<YourPlayer>` so the picker can read/
 *      iterate your player roster and hand control back to your game loop
 *      once an item lands. `YourPlayer` just needs to satisfy the
 *      `BondagePickerPlayer` shape (structurally — no need to extend it).
 *   3. Construct one `BondagePicker` per active game (or reuse one across
 *      games and call `resetGameState()` between them) with a
 *      `BondagePickerConfig` pointing at your bot's data files.
 *   4. Drive it from your message handler:
 *        - route "outfit"/"pick" replies to `tryHandleBondageModeAnswer`
 *          while `isAwaitingBondageMode()` is true
 *        - route slot-consent replies to `handleSlotConsentAnswer` while
 *          `hasPendingSlotConsent(memberNumber)` is true
 *        - route the active picker's whispers to `tryHandleBondagePickInput`
 *        - route the target's yes/no/!veto/!accept to `tryHandleVetoYesNo`
 *          / `handleVeto` / `handleVetoAccept`
 *      When a loss makes a naked player due for bondage, call
 *      `noteRoundLoser(player)` then `beginPlayerPickBondage(target)`.
 *   5. When a player leaves/is kicked/safewords mid-pick, check
 *      `pendingPickInvolves(memberNumber)` and call
 *      `cancelPendingBondagePick()` so the game loop can take back control.
 */

import * as fs from "fs";
import * as path from "path";

// ============================================================
// TYPES
// ============================================================

/** One concrete bondage item as applied to (or synthesized for) a player. */
export interface BondageItem {
    group: string;
    name: string;
    color: string | string[];
    property: any;
}

/** A preset or synthesized set of items. Player-pick sessions build one of
 * these on the fly (name: "Player picks") so downstream end-game lock /
 * verify / release machinery can treat player-pick players the same as
 * preset-outfit players. */
export interface BondageOutfit {
    name: string;
    items: BondageItem[];
}

export type BondageMode = "outfit" | "player-pick";

/** Picker-facing slot: a display name mapped to the BC item group it applies to. */
export interface PickSlot {
    display: string;
    group: string;
}

/** One in-flight player-pick selection. Only one can be active per picker instance. */
export interface PendingBondagePick {
    pickerNumber: number;
    targetNumber: number;
    stage: "slot" | "item" | "veto";
    slotDisplay: string | null;  // picker-facing name, e.g. "Mouth"
    slotGroup: string | null;    // actual BC group applied, e.g. "ItemMouth2"
    options: string[];           // current numbered item list
    chosenItem: string | null;
    vetoedItems: { group: string; item: string }[]; // vetoed during this pick session, scoped per group
    timer: NodeJS.Timeout | null; // picker-response or veto timer
}

export interface ItemSettingVariant {
    property: any;
    count: number;
}
/** "Group:ItemName" -> observed configs, most-seen first once trimmed. */
export type ItemSettingsLibrary = Record<string, ItemSettingVariant[]>;

/** Minimum player-state shape the picker needs. Your bot's real Player type
 * doesn't need to extend this — it just needs to have these fields. */
export interface BondagePickerPlayer {
    memberNumber: number;
    name: string;
    bondageMode: BondageMode | null;
    allowedSlots: string[];
    appliedBondageItems: { slot: string; item: string }[];
    lastLossSeq: number;
    isFullyBound: boolean;
    pendingReturn: boolean;
    bondageOutfit: BondageOutfit | null;
    bondageApplied: number;
}

/** Connection/bot adapter — deliberately narrow so the picker isn't coupled
 * to any one bot's connection class. */
export interface BondagePickerBot {
    applyItem(targetNumber: number, group: string, name: string, color: string | string[], property: any): void;
    whisper(targetNumber: number, message: string): void;
    sendChat(message: string): void;
}

/** Callbacks into the host game loop for state the picker doesn't own. */
export interface BondagePickerHost<P extends BondagePickerPlayer = BondagePickerPlayer> {
    getPlayers(): Iterable<P>;
    getPlayer(memberNumber: number): P | undefined;
    getPlayerName(memberNumber: number): string;
    /** True if the target already has an item in this BC group — e.g. a
     * pre-existing appearance item the bot didn't apply itself. */
    hasExistingItem(memberNumber: number, group: string): boolean;
    /** Re-checked after every question window closes (mode question, slot
     * consent) in case the lobby changed while players were answering —
     * mirrors the `players.size < minPlayers || some(!ready)` guard other
     * pre-game phases use. Return false to hold off; your next lobby-ready
     * event should re-drive the picker phases itself. */
    isReadyToStart(): boolean;
    /** Called once mode selection / slot consent has fully resolved and the
     * game should actually begin. */
    startGame(): void;
    /** Called once a picked (or preset) bondage item has landed and its
     * apply delay has elapsed — the player-pick equivalent of
     * continueAfterBondageApply(target, becameFullyBound). */
    onBondageItemApplied(target: P, becameFullyBound: boolean): void;
}

export interface BondagePickerConfig {
    /** bc_items.json — full BC catalog (group -> item names). */
    bcItemsPath: string;
    /** Where to persist per-slot item popularity. */
    bondageUsagePath: string;
    /** Where to persist learned per-item settings (restraining mode, etc). */
    itemSettingsPath: string;
    /** Where to append this game's player-pick selections for later curation. */
    outfitCandidatesPath: string;
    /** Game ends for a player-pick player once this many items are applied.
     * Default 7 (StripDiceBot's median outfit item count). */
    bondageItemLimit?: number;
    /** False disables the veto step entirely (reserved for higher-stakes
     * modes). Default true. */
    allowVeto?: boolean;
    /** How pickItemSetting() chooses among learned configs. Default "popular". */
    itemSettingStrategy?: "popular" | "random" | "weighted";
    /** Preset outfits (if your bot has any) used as a bootstrap fallback:
     * fills out the picker's popularity list before enough usage data
     * exists, and seeds the item-settings library from their properties.
     * Optional — pass [] (or omit) if your bot has no preset outfits. */
    bootstrapOutfits?: BondageOutfit[];
    /** Sink for informational logs (warnings, [BondageMode]/[SlotConsent]
     * event lines). Defaults to a no-op. */
    log?: (message: string) => void;
}

// ============================================================
// CONSTANTS
// ============================================================

// Picker-facing display names mapped to BC item groups.
export const PICK_SLOTS: PickSlot[] = [
    { display: "Arms", group: "ItemArms" },
    { display: "Legs", group: "ItemLegs" },
    { display: "Feet", group: "ItemFeet" },
    { display: "Torso", group: "ItemTorso" },
    { display: "Torso (upper)", group: "ItemTorso2" },
    { display: "Hands", group: "ItemHands" },
    { display: "Head", group: "ItemHead" },
    { display: "Hood", group: "ItemHood" },
    { display: "Neck", group: "ItemNeck" },
    { display: "Mouth", group: "ItemMouth" },
    { display: "Boots", group: "ItemBoots" },
    { display: "Nipples", group: "ItemNipples" },
    { display: "Breast", group: "ItemBreast" },
    { display: "Pelvis", group: "ItemPelvis" },
    { display: "Vulva", group: "ItemVulva" },
    { display: "Clit", group: "ItemVulvaPiercings" },
];

// Consent tiers. Tier 1 is on by default; tier 2 requires explicit consent.
// Tier 3 (Butt) additionally requires a higher-stakes game mode,
// which isn't built yet — the constant exists as a code hook only.
export const TIER1_SLOT_GROUPS = [
    "ItemArms", "ItemLegs", "ItemFeet", "ItemTorso", "ItemTorso2",
    "ItemHands", "ItemHead", "ItemHood", "ItemNeck", "ItemMouth", "ItemBoots",
];
export const TIER2_SLOT_GROUPS = ["ItemNipples", "ItemBreast", "ItemPelvis", "ItemVulva", "ItemVulvaPiercings"];
export const TIER3_SLOT_GROUPS = ["ItemButt"]; // code hook — not selectable yet

// ItemMouth2/ItemMouth3 are overflow layers of Mouth: used automatically when
// ItemMouth is already filled, never exposed as separate picker options.
export const MOUTH_OVERFLOW_GROUPS = ["ItemMouth", "ItemMouth2", "ItemMouth3"];

// Consent-answer token -> BC groups it grants. "torso" covers both layers.
export const CONSENT_TOKEN_GROUPS: Record<string, string[]> = {
    arms: ["ItemArms"],
    legs: ["ItemLegs"],
    feet: ["ItemFeet"],
    torso: ["ItemTorso", "ItemTorso2"],
    hands: ["ItemHands"],
    head: ["ItemHead"],
    hood: ["ItemHood"],
    neck: ["ItemNeck"],
    mouth: ["ItemMouth"],
    boots: ["ItemBoots"],
    nipples: ["ItemNipples"],
    breast: ["ItemBreast"],
    breasts: ["ItemBreast"],
    pelvis: ["ItemPelvis"],
    vulva: ["ItemVulva"],
    clit: ["ItemVulvaPiercings"],
    clitoris: ["ItemVulvaPiercings"],
};

export const DEFAULT_BONDAGE_ITEM_LIMIT = 7;
// How many popular items to list per slot (plus one random wildcard).
export const PICK_LIST_TOP_N = 9;
// Recently-added BC items (by asset codename) to spotlight: pinned to the top
// of their slot's pick list with a 🆕 marker regardless of usage, since players
// like trying new gear and a zero-usage item would otherwise never rank. Remove
// a codename once it's no longer "new". Display-only — usage stats untouched.
export const NEW_ITEMS: ReadonlySet<string> = new Set<string>([
    "CybertechMask", // R130 — ItemHood/ItemHead
    "ModularVulvaPiercings", // R130 "Chastity Tunnel Piercings" — ItemVulvaPiercings (verified in-game 2026-07-19)
]);
// Minimum distinct areas a player-pick player must consent to (Mouth counts
// as one area even though it holds up to 3 gag layers).
export const MIN_CONSENT_AREAS = 6;
export const BONDAGE_MODE_TIMEOUT_MS = 60 * 1000;   // mode question window; unanswered = outfit
export const SLOT_CONSENT_TIMEOUT_MS = 60 * 1000;   // slot-consent window; unanswered = tier-1 defaults
export const PICKER_RESPONSE_TIMEOUT_MS = 60 * 1000; // picker slot/item window; then bot picks randomly
export const VETO_TIMEOUT_MS = 30 * 1000;            // target's veto window; then auto-accept

export const MAX_SETTING_VARIANTS_PER_ITEM = 10; // keep the most popular N configs per item
// How to choose among learned settings when applying a picked item:
// "popular" = most-seen config (ties random); "random" = any learned config;
// "weighted" = random, biased by popularity.
export const ITEM_SETTING_STRATEGY: "popular" | "random" | "weighted" = "popular";

// ============================================================
// HELPERS
// ============================================================

// Strips owner/lock-specific fields from a decoded appearance item's Property
// so only the "mode" (TypeRecord/Effect) is left to learn from.
export function cleanDecodedProperty(property: any): any {
    if (!property) return {};
    const {
        LockedBy, LockMemberNumber, LockMemberName, Password, Hint, LockSet,
        RemoveItem, ShowTimer, EnableRandomInput, MemberNumberList, RemoveTimer,
        ...rest
    } = property;
    if (Array.isArray(rest.Effect)) {
        rest.Effect = rest.Effect.filter((e: string) => e !== "Lock");
    }
    return rest;
}

// A property is worth learning if it selects a mode (TypeRecord) or carries
// active effects — bare default-mode applications teach us nothing.
export function isLearnableProperty(property: any): boolean {
    if (!property || typeof property !== "object") return false;
    if (property.TypeRecord && typeof property.TypeRecord === "object" && Object.keys(property.TypeRecord).length > 0) return true;
    return Array.isArray(property.Effect) && property.Effect.length > 0;
}

// Stable JSON (sorted keys, recursive) so identical configs dedupe regardless
// of key order in the incoming payload.
export function canonicalJson(value: any): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(",")}]`;
    }
    if (value && typeof value === "object") {
        const keys = Object.keys(value).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function deepClone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// Full BC item catalog (group -> item names). Missing/invalid file disables
// player-pick mode (BondagePicker.itemCatalog.size === 0) rather than
// crashing the caller.
export function loadBcItemCatalog(itemsPath: string, log: (message: string) => void = () => {}): Map<string, string[]> {
    const catalog = new Map<string, string[]>();
    try {
        const raw = fs.readFileSync(itemsPath, "utf8");
        const data: { group: string; items: string[] }[] = JSON.parse(raw);
        for (const entry of data) {
            if (entry?.group && Array.isArray(entry.items)) {
                catalog.set(entry.group, entry.items);
            }
        }
    } catch (err) {
        log(`WARNING: Could not load ${itemsPath} — player-pick bondage mode disabled: ${err}`);
    }
    return catalog;
}

// ============================================================
// BondagePicker
// ============================================================

export class BondagePicker<P extends BondagePickerPlayer = BondagePickerPlayer> {
    /** group -> item names. Empty (size 0) disables player-pick mode entirely. */
    readonly itemCatalog: Map<string, string[]>;

    private bondageUsage: Record<string, Record<string, number>> = {};
    private itemSettings: ItemSettingsLibrary = {};

    private pendingBondagePick: PendingBondagePick | null = null;
    private pickerHistory: number[] = []; // memberNumbers who have picked this game
    private lastRoundLoser: number | null = null;
    private lossSeqCounter: number = 0;

    private awaitingBondageMode: boolean = false;
    private bondageModeTimer: NodeJS.Timeout | null = null;

    private awaitingSlotConsent: boolean = false;
    private slotConsentTimer: NodeJS.Timeout | null = null;
    private pendingSlotConsent: Set<number> = new Set();

    private gameBondageMode: "outfit" | "player-pick" | "mixed" = "outfit";

    private readonly bondageUsagePath: string;
    private readonly itemSettingsPath: string;
    private readonly outfitCandidatesPath: string;
    private readonly bondageItemLimit: number;
    private readonly allowVeto: boolean;
    private readonly itemSettingStrategy: "popular" | "random" | "weighted";
    private readonly bootstrapOutfits: BondageOutfit[];
    private readonly log: (message: string) => void;

    constructor(
        private readonly bot: BondagePickerBot,
        private readonly host: BondagePickerHost<P>,
        config: BondagePickerConfig
    ) {
        this.log = config.log ?? (() => {});
        this.itemCatalog = loadBcItemCatalog(config.bcItemsPath, this.log);
        this.bondageUsagePath = config.bondageUsagePath;
        this.itemSettingsPath = config.itemSettingsPath;
        this.outfitCandidatesPath = config.outfitCandidatesPath;
        this.bondageItemLimit = config.bondageItemLimit ?? DEFAULT_BONDAGE_ITEM_LIMIT;
        this.allowVeto = config.allowVeto ?? true;
        this.itemSettingStrategy = config.itemSettingStrategy ?? ITEM_SETTING_STRATEGY;
        this.bootstrapOutfits = config.bootstrapOutfits ?? [];

        this.loadBondageUsage();
        this.loadItemSettings();
        this.seedItemSettingsFromOutfits();
    }

    // --- status getters ------------------------------------------

    isAwaitingBondageMode(): boolean {
        return this.awaitingBondageMode;
    }

    isAwaitingSlotConsent(): boolean {
        return this.awaitingSlotConsent;
    }

    hasPendingSlotConsent(memberNumber: number): boolean {
        return this.pendingSlotConsent.has(memberNumber);
    }

    getGameBondageMode(): "outfit" | "player-pick" | "mixed" {
        return this.gameBondageMode;
    }

    getPendingPick(): Readonly<PendingBondagePick> | null {
        return this.pendingBondagePick;
    }

    /** True if a pick is in flight involving this member, as either picker or target. */
    pendingPickInvolves(memberNumber: number): boolean {
        return this.pendingBondagePick?.targetNumber === memberNumber
            || this.pendingBondagePick?.pickerNumber === memberNumber;
    }

    // --- pre-game mode selection -------------------------------

    beginBondageModeSelection(): void {
        if (this.itemCatalog.size === 0) {
            // Catalog unavailable — player-pick mode can't work, skip the question.
            for (const player of this.host.getPlayers()) player.bondageMode = "outfit";
            this.gameBondageMode = "outfit";
            this.host.startGame();
            return;
        }

        if (this.bondageModeTimer) {
            clearTimeout(this.bondageModeTimer);
            this.bondageModeTimer = null;
        }
        this.awaitingBondageMode = true;
        for (const player of this.host.getPlayers()) {
            player.bondageMode = null;
            this.bot.whisper(player.memberNumber,
                "How should your bondage penalties be chosen?\n" +
                "outfit — I apply one of my predefined outfits (classic — no more questions)\n" +
                "pick — another player picks your restraints piece by piece (you'll choose which slots are OK next, and can veto items)\n" +
                "Reply \"outfit\" or \"pick\". (60s — no answer counts as outfit)"
            );
            this.log(`[BondageMode] Sent question to ${player.name} (#${player.memberNumber})`);
        }
        this.bondageModeTimer = setTimeout(() => this.resolveBondageModeSelection(), BONDAGE_MODE_TIMEOUT_MS);
    }

    /** Returns true if the message was consumed as a mode answer. Only call
     * this while isAwaitingBondageMode() is true. */
    tryHandleBondageModeAnswer(memberNumber: number, msg: string): boolean {
        let mode: BondageMode | null = null;
        if (["outfit", "o", "preset", "1"].includes(msg)) mode = "outfit";
        else if (["pick", "p", "player-pick", "playerpick", "player pick", "player", "2"].includes(msg)) mode = "player-pick";
        if (!mode) return false;

        const player = this.host.getPlayer(memberNumber);
        if (!player || player.bondageMode !== null) return false;
        player.bondageMode = mode;
        this.log(`[BondageMode] ${player.name} (#${memberNumber}) answered: ${mode}`);
        this.bot.whisper(memberNumber, mode === "outfit"
            ? "Preset outfit it is!"
            : "Player-pick it is — your restraints will be chosen piece by piece. 😈");

        if ([...this.host.getPlayers()].every(p => p.bondageMode !== null)) {
            this.resolveBondageModeSelection();
        }
        return true;
    }

    private resolveBondageModeSelection(): void {
        if (!this.awaitingBondageMode) return;
        this.awaitingBondageMode = false;
        if (this.bondageModeTimer) {
            clearTimeout(this.bondageModeTimer);
            this.bondageModeTimer = null;
        }

        for (const player of this.host.getPlayers()) {
            if (player.bondageMode === null) player.bondageMode = "outfit";
        }

        const players = [...this.host.getPlayers()];
        const pickers = players.filter(p => p.bondageMode === "player-pick");
        this.gameBondageMode = pickers.length === 0
            ? "outfit"
            : (pickers.length === players.length ? "player-pick" : "mixed");
        this.log(`[BondageMode] Result: ${this.gameBondageMode}`);

        if (this.gameBondageMode === "player-pick") {
            this.bot.sendChat("Everyone chose player-pick — all restraints will be chosen piece by piece! 😈");
        } else if (this.gameBondageMode === "mixed") {
            this.bot.sendChat(`${pickers.map(p => p.name).join(", ")} chose player-pick restraints; everyone else gets preset outfits.`);
        }

        // The question window gives time for the lobby to change — if it
        // did, the host's own lobby-ready flow should re-drive this.
        if (!this.host.isReadyToStart()) return;

        // Only player-pick players get the slot-consent question; a pure
        // outfit game has nothing more to ask.
        if (pickers.length > 0) {
            this.beginSlotConsentPhase(pickers);
        } else {
            this.host.startGame();
        }
    }

    // Asks each player-pick player which slots they consent to, then starts
    // the game once everyone answered or the window times out (unanswered
    // players keep the tier-1 defaults).
    beginSlotConsentPhase(pickers: P[]): void {
        if (this.slotConsentTimer) {
            clearTimeout(this.slotConsentTimer);
            this.slotConsentTimer = null;
        }
        this.awaitingSlotConsent = true;
        for (const player of pickers) {
            this.sendSlotConsentQuestion(player.memberNumber);
            this.log(`[SlotConsent] Sent question to ${player.name} (#${player.memberNumber})`);
        }
        this.slotConsentTimer = setTimeout(() => this.resolveSlotConsentPhase(), SLOT_CONSENT_TIMEOUT_MS);
    }

    private resolveSlotConsentPhase(): void {
        if (!this.awaitingSlotConsent) return;
        this.awaitingSlotConsent = false;
        if (this.slotConsentTimer) {
            clearTimeout(this.slotConsentTimer);
            this.slotConsentTimer = null;
        }

        for (const memberNumber of this.pendingSlotConsent) {
            this.bot.whisper(memberNumber, "No answer — using the default slots (all non-sensitive).");
        }
        this.pendingSlotConsent.clear();

        if (!this.host.isReadyToStart()) return;

        this.host.startGame();
    }

    // --- slot consent ------------------------------------------

    private sendSlotConsentQuestion(memberNumber: number): void {
        if (this.itemCatalog.size === 0) return; // player-pick disabled, don't bother
        this.pendingSlotConsent.add(memberNumber);
        this.sendLongWhisper(memberNumber,
            "Which bondage slots do you consent to having items applied to?\n" +
            "Reply with a comma-separated list, or \"all\" for everything. Pick at least 6 different areas.\n" +
            "Slots: Arms, Legs, Feet, Torso, Hands, Head, Hood, Neck, Mouth, Nipples, Breast, Pelvis, Vulva, Clit, Boots\n" +
            "Sensitive slots (Pelvis, Nipples, Breast, Vulva, Clit) are OFF by default — include them explicitly if you want them available.\n" +
            "(60s — no answer keeps the defaults: all non-sensitive slots.)"
        );
    }

    /** Only call this while hasPendingSlotConsent(memberNumber) is true. */
    handleSlotConsentAnswer(memberNumber: number, message: string): void {
        const player = this.host.getPlayer(memberNumber);
        if (!player) {
            this.pendingSlotConsent.delete(memberNumber);
            return;
        }

        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const tokens = message.split(/[,\s]+/).map(norm).filter(t => t.length > 0);

        const groups = new Set<string>();
        const ignored: string[] = [];
        let recognized = false;
        for (const token of tokens) {
            if (token === "all" || token === "everything") {
                for (const g of [...TIER1_SLOT_GROUPS, ...TIER2_SLOT_GROUPS]) groups.add(g);
                recognized = true;
            } else if (token === "none") {
                recognized = true; // explicit empty consent
            } else if (token === "default" || token === "defaults" || token === "skip") {
                for (const g of TIER1_SLOT_GROUPS) groups.add(g);
                recognized = true;
            } else if (token === "butt") {
                ignored.push(`${token} (not available yet)`); // tier 3 — higher-stakes mode not built
            } else if (CONSENT_TOKEN_GROUPS[token]) {
                for (const g of CONSENT_TOKEN_GROUPS[token]) groups.add(g);
                recognized = true;
            } else {
                ignored.push(token);
            }
        }

        if (!recognized) {
            this.bot.whisper(memberNumber,
                "I didn't recognize any slots there. Reply with slot names separated by commas (e.g. \"Arms, Legs, Mouth\"), or \"all\" for everything.");
            return;
        }

        // Player-pick needs room for the full game — require at least
        // MIN_CONSENT_AREAS distinct areas. Mouth holds up to 3 gags and
        // "Torso" covers both torso layers, so 6 areas is enough.
        const areaCount = PICK_SLOTS.filter(s => groups.has(s.group)).length;
        if (areaCount < MIN_CONSENT_AREAS) {
            this.bot.whisper(memberNumber,
                `That's only ${areaCount} area${areaCount === 1 ? "" : "s"} — the game needs room for up to ${this.bondageItemLimit} items, ` +
                `so please pick at least ${MIN_CONSENT_AREAS} different areas. ` +
                `(Mouth can take up to 3 gags, and Torso covers both torso layers.) Send your full list again.`);
            return;
        }

        player.allowedSlots = [...groups];
        this.pendingSlotConsent.delete(memberNumber);
        this.log(`[SlotConsent] ${player.name} (#${memberNumber}) -> ${player.allowedSlots.join(",") || "(none)"}`);

        const displays = PICK_SLOTS.filter(s => groups.has(s.group)).map(s => s.display);
        let reply = groups.size === 0
            ? "Got it — no bondage slots allowed. Pickers won't be able to choose items for you."
            : `Got it — pickable slots for you: ${displays.join(", ")}.`;
        if (ignored.length > 0) reply += ` (Ignored: ${ignored.join(", ")})`;
        this.bot.whisper(memberNumber, reply);

        if (this.awaitingSlotConsent && this.pendingSlotConsent.size === 0) {
            this.resolveSlotConsentPhase();
        }
    }

    // --- pick flow ---------------------------------------------

    /** Entry point when bondage is due for a player-pick-mode player. Have
     * your game loop set whatever "applying bondage" state it needs before
     * calling this. */
    beginPlayerPickBondage(target: P): void {
        const slots = this.availablePickSlots(target);
        if (slots.length === 0) {
            // Nothing consented and unfilled remains — nothing more can be applied.
            this.bot.sendChat(`🔒 ${target.name} has no remaining slots to fill!`);
            this.host.onBondageItemApplied(target, true);
            return;
        }

        const picker = this.choosePickerFor(target);
        this.pickerHistory.push(picker.memberNumber);
        this.pendingBondagePick = {
            pickerNumber: picker.memberNumber,
            targetNumber: target.memberNumber,
            stage: "slot",
            slotDisplay: null,
            slotGroup: null,
            options: [],
            chosenItem: null,
            vetoedItems: [],
            timer: null,
        };

        if (picker.memberNumber === target.memberNumber) {
            this.bot.sendChat(`⛓️ ${target.name} is naked — and gets to pick their own restraint!`);
        } else {
            this.bot.sendChat(`⛓️ ${target.name} is naked! ${picker.name} is picking their next restraint...`);
        }
        this.bot.whisper(picker.memberNumber, this.slotPromptText(target));
        this.startPickTimer();
    }

    // The picker is whoever has gone longest without rolling a 1 (lowest
    // lastLossSeq; 0 = never lost, which outranks everyone). Ties — including
    // round 1, where nobody has lost yet — resolve randomly among the tied.
    // The target never picks their own items.
    choosePickerFor(target: P): P {
        const all = [...this.host.getPlayers()];
        let pool = all.filter(p =>
            p.memberNumber !== target.memberNumber && !p.isFullyBound && !p.pendingReturn);
        if (pool.length === 0) {
            // Everyone else is away — let an away player pick; the response
            // timer auto-picks if they don't respond.
            pool = all.filter(p => p.memberNumber !== target.memberNumber && !p.isFullyBound);
        }
        if (pool.length === 0) return target; // unreachable in practice: game would already be over

        const oldestLoss = Math.min(...pool.map(p => p.lastLossSeq));
        const tied = pool.filter(p => p.lastLossSeq === oldestLoss);
        return tied[Math.floor(Math.random() * tied.length)];
    }

    private slotPromptText(target: P): string {
        const slots = this.availablePickSlots(target).map((s, i) => `${i + 1}. ${s.display}`).join("\n");
        return `It's your turn to pick a bondage item for ${target.name}. Choose a slot:\n${slots}`;
    }

    // Slots the picker may choose for this target: consented, not already
    // filled (Mouth counts as free while any of its overflow layers is), and
    // present in the item catalog.
    availablePickSlots(target: P): PickSlot[] {
        return PICK_SLOTS.filter(s => {
            if (!target.allowedSlots.includes(s.group)) return false;
            const actual = s.group === "ItemMouth"
                ? this.resolveMouthGroup(target)
                : (this.isSlotFilled(target, s.group) ? null : s.group);
            if (!actual) return false;
            return (this.itemCatalog.get(actual) ?? []).length > 0;
        });
    }

    // First free layer of Mouth/Mouth2/Mouth3, or null if all are filled.
    private resolveMouthGroup(target: P): string | null {
        return MOUTH_OVERFLOW_GROUPS.find(g => !this.isSlotFilled(target, g)) ?? null;
    }

    private isSlotFilled(target: P, group: string): boolean {
        if (target.appliedBondageItems.some(e => e.slot === group)) return true;
        return this.host.hasExistingItem(target.memberNumber, group);
    }

    // Whisper input from the active picker (slot name, option number, or
    // free-text item name). Returns true if the message was consumed.
    tryHandleBondagePickInput(memberNumber: number, message: string): boolean {
        const pending = this.pendingBondagePick;
        if (!pending || memberNumber !== pending.pickerNumber) return false;
        const input = message.trim();
        if (input.startsWith("!")) return false; // let commands through

        if (pending.stage === "slot") {
            this.handleSlotChoice(input);
            return true;
        }
        if (pending.stage === "item") {
            this.handleItemChoice(input);
            return true;
        }
        return false;
    }

    // Bare yes/no from the veto target, as aliases for !accept/!veto.
    tryHandleVetoYesNo(memberNumber: number, msg: string): boolean {
        const pending = this.pendingBondagePick;
        if (!pending || pending.stage !== "veto" || memberNumber !== pending.targetNumber) return false;
        if (msg === "yes" || msg === "y") {
            this.handleVetoAccept(memberNumber);
            return true;
        }
        if (msg === "no" || msg === "n") {
            this.handleVeto(memberNumber);
            return true;
        }
        return false;
    }

    private handleSlotChoice(input: string): void {
        const pending = this.pendingBondagePick;
        if (!pending) return;
        const target = this.host.getPlayer(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        const slots = this.availablePickSlots(target);
        const trimmed = input.trim();
        const idx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
        const match = (idx !== null && idx >= 1 && idx <= slots.length) ? slots[idx - 1] : null;
        if (!match) {
            this.bot.whisper(pending.pickerNumber,
                `That's not a valid slot number for ${target.name}. Choose a number:\n` +
                slots.map((s, i) => `${i + 1}. ${s.display}`).join("\n"));
            return;
        }

        const actualGroup = match.group === "ItemMouth" ? this.resolveMouthGroup(target) : match.group;
        if (!actualGroup) {
            this.bot.whisper(pending.pickerNumber, `That slot is already filled — pick a different one.`);
            return;
        }

        const { options, hasRandom } = this.buildPickList(actualGroup, this.vetoedItemsFor(pending, actualGroup));
        if (options.length === 0) {
            this.bot.whisper(pending.pickerNumber, `No items are available for that slot — pick a different one.`);
            return;
        }

        pending.slotDisplay = match.display;
        pending.slotGroup = actualGroup;
        pending.options = options;
        pending.stage = "item";
        this.sendLongWhisper(pending.pickerNumber, this.formatPickList(match.display, options, hasRandom));
        this.startPickTimer();
    }

    private handleItemChoice(input: string): void {
        const pending = this.pendingBondagePick;
        if (!pending || !pending.slotGroup) return;

        let chosen: string | null = null;
        const trimmed = input.trim();
        if (/^\d+$/.test(trimmed)) {
            const idx = parseInt(trimmed, 10);
            if (idx >= 1 && idx <= pending.options.length) {
                chosen = pending.options[idx - 1];
            } else {
                this.bot.whisper(pending.pickerNumber, `Pick a number 1-${pending.options.length} or type an item name.`);
                return;
            }
        } else {
            const result = this.fuzzyMatchItem(pending.slotGroup, trimmed, this.vetoedItemsFor(pending, pending.slotGroup));
            if (result.match) {
                chosen = result.match;
            } else if (result.candidates) {
                this.bot.whisper(pending.pickerNumber,
                    `Multiple matches: ${result.candidates.slice(0, 8).join(", ")} — be more specific.`);
                return;
            } else {
                const excluded = this.vetoedItemsFor(pending, pending.slotGroup);
                const alreadyShown = new Set([...pending.options, ...excluded]);
                const rest = (this.itemCatalog.get(pending.slotGroup) ?? []).filter(n => !alreadyShown.has(n));
                if (rest.length === 0) {
                    this.bot.whisper(pending.pickerNumber, `No item matching "${trimmed}" — and no more items left to list for this slot.`);
                    return;
                }
                const more = rest.slice(0, 10);
                pending.options = more;
                const remaining = rest.length - more.length;
                this.sendLongWhisper(pending.pickerNumber,
                    `No item matching "${trimmed}" in this slot. Here are ${more.length} more — reply with a number:\n` +
                    more.map((name, i) => `${i + 1}. ${name}`).join("\n") +
                    (remaining > 0 ? `\n...and ${remaining} more — type part of the name to search further.` : "")
                );
                return;
            }
        }

        pending.chosenItem = chosen;
        this.beginVetoStage();
    }

    private vetoedItemsFor(pending: PendingBondagePick, group: string): string[] {
        return pending.vetoedItems.filter(v => v.group === group).map(v => v.item);
    }

    // Top-N most popular items for this slot plus one random wildcard.
    // Bootstrap: below N tracked entries, fill from the configured bootstrap
    // outfits for this group in the order they appear, so the list is never empty.
    private buildPickList(group: string, excluded: string[]): { options: string[]; hasRandom: boolean } {
        const catalogItems = this.itemCatalog.get(group) ?? [];
        const usage = this.bondageUsage[group] ?? {};

        // Pin any new items for this slot to the front (see NEW_ITEMS) so
        // players always see the latest gear regardless of usage history.
        const options: string[] = [...NEW_ITEMS].filter(
            n => catalogItems.includes(n) && !excluded.includes(n)
        );

        for (const [name] of Object.entries(usage)
            .filter(([name, count]) => count > 0 && !excluded.includes(name) && catalogItems.includes(name) && !options.includes(name))
            .sort((a, b) => b[1] - a[1])
            .slice(0, PICK_LIST_TOP_N)) {
            if (options.length >= PICK_LIST_TOP_N) break;
            options.push(name);
        }

        if (options.length < PICK_LIST_TOP_N) {
            for (const outfit of this.bootstrapOutfits) {
                for (const item of outfit.items) {
                    if (item.group !== group || options.includes(item.name) || excluded.includes(item.name)) continue;
                    options.push(item.name);
                    if (options.length >= PICK_LIST_TOP_N) break;
                }
                if (options.length >= PICK_LIST_TOP_N) break;
            }
        }

        const rest = catalogItems.filter(n => !options.includes(n) && !excluded.includes(n));
        let hasRandom = false;
        if (rest.length > 0) {
            options.push(rest[Math.floor(Math.random() * rest.length)]);
            hasRandom = true;
        }
        return { options, hasRandom };
    }

    private formatPickList(slotDisplay: string, options: string[], hasRandom: boolean): string {
        const lines = [`Slot: ${slotDisplay} — pick one:`];
        options.forEach((name, i) => {
            const newMarker = NEW_ITEMS.has(name) ? " 🆕 new!" : "";
            const marker = hasRandom && i === options.length - 1 ? ` ← random pick (not in top ${PICK_LIST_TOP_N})` : "";
            lines.push(`${i + 1}. ${name}${newMarker}${marker}`);
        });
        lines.push("Or type any item name from this slot.");
        return lines.join("\n");
    }

    // Case-insensitive fuzzy match against the slot's catalog: exact (spaces
    // stripped), then startsWith, then includes. Multiple hits ask the picker
    // to clarify.
    private fuzzyMatchItem(group: string, input: string, excluded: string[]): { match?: string; candidates?: string[] } {
        const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");
        const q = norm(input);
        if (!q) return {};
        const items = (this.itemCatalog.get(group) ?? []).filter(n => !excluded.includes(n));

        const exact = items.filter(n => norm(n) === q);
        if (exact.length >= 1) return { match: exact[0] };
        const starts = items.filter(n => norm(n).startsWith(q));
        if (starts.length === 1) return { match: starts[0] };
        if (starts.length > 1) return { candidates: starts };
        const includes = items.filter(n => norm(n).includes(q));
        if (includes.length === 1) return { match: includes[0] };
        if (includes.length > 1) return { candidates: includes };
        return {};
    }

    // --- veto flow ---------------------------------------------

    private beginVetoStage(): void {
        const pending = this.pendingBondagePick;
        if (!pending || !pending.chosenItem) return;
        this.clearPickTimer();
        pending.stage = "veto";

        const target = this.host.getPlayer(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        // No veto step for self-picks, or when vetoes are disabled
        // (higher-stakes mode hook — not built yet).
        if (!this.allowVeto || pending.pickerNumber === pending.targetNumber) {
            this.applyPickedItem();
            return;
        }

        this.bot.whisper(target.memberNumber,
            `You are about to have ${pending.chosenItem} applied to your ${pending.slotDisplay}. ` +
            `Type !veto to decline, or !accept to confirm (or wait 30s to auto-accept). Yes/no works too.`);
        pending.timer = setTimeout(() => this.applyPickedItem(), VETO_TIMEOUT_MS);
    }

    handleVeto(memberNumber: number): void {
        const pending = this.pendingBondagePick;
        if (!pending || pending.stage !== "veto" || pending.targetNumber !== memberNumber) {
            this.bot.whisper(memberNumber, "Nothing to veto right now.");
            return;
        }
        this.clearPickTimer();

        const target = this.host.getPlayer(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        const vetoed = pending.chosenItem!;
        pending.vetoedItems.push({ group: pending.slotGroup!, item: vetoed });
        pending.chosenItem = null;
        const pickerName = this.host.getPlayerName(pending.pickerNumber);

        const { options, hasRandom } = this.buildPickList(pending.slotGroup!, this.vetoedItemsFor(pending, pending.slotGroup!));
        if (options.length === 0) {
            // Every item in this slot has been vetoed — back to slot choice.
            pending.stage = "slot";
            pending.slotDisplay = null;
            pending.slotGroup = null;
            pending.options = [];
            this.bot.whisper(pending.pickerNumber,
                `${target.name} vetoed ${vetoed}, and no other items are available for that slot. ${this.slotPromptText(target)}`);
            this.bot.whisper(target.memberNumber, `Vetoed! ${pickerName} is choosing a different slot.`);
            this.startPickTimer();
            return;
        }

        pending.stage = "item";
        pending.options = options;
        this.sendLongWhisper(pending.pickerNumber,
            `${target.name} vetoed ${vetoed} — pick a different item.\n` +
            this.formatPickList(pending.slotDisplay!, options, hasRandom));
        this.bot.whisper(target.memberNumber, `Vetoed! ${pickerName} is picking another item.`);
        this.startPickTimer();
    }

    handleVetoAccept(memberNumber: number): void {
        const pending = this.pendingBondagePick;
        if (!pending || pending.stage !== "veto" || pending.targetNumber !== memberNumber) {
            this.bot.whisper(memberNumber, "Nothing to accept right now.");
            return;
        }
        this.applyPickedItem();
    }

    // --- application -------------------------------------------

    private applyPickedItem(): void {
        const pending = this.pendingBondagePick;
        if (!pending || !pending.chosenItem || !pending.slotGroup) return;
        this.clearPickTimer();
        this.pendingBondagePick = null;

        const target = this.host.getPlayer(pending.targetNumber);
        if (!target) return;

        const itemName = pending.chosenItem;
        const group = pending.slotGroup;
        const pickerName = this.host.getPlayerName(pending.pickerNumber);

        // Apply with the most popular learned configuration for this item
        // (restraining mode etc.); {} = BC default mode if nothing learned yet.
        const setting = { ...this.pickItemSetting(group, itemName), Difficulty: 20 };

        this.bot.sendChat(`⛓️ ${pickerName} chose ${itemName} for ${target.name}'s ${pending.slotDisplay}!`);
        this.bot.applyItem(target.memberNumber, group, itemName, "Default", setting);

        target.appliedBondageItems.push({ slot: group, item: itemName });
        // Mirror the pick into a synthesized outfit so end-game lock /
        // verify / release machinery works unchanged for player-pick players
        // (and re-locks keep the same configuration).
        if (!target.bondageOutfit) {
            target.bondageOutfit = { name: "Player picks", items: [] };
        }
        target.bondageOutfit.items.push({ group, name: itemName, color: "Default", property: setting });

        this.incrementBondageUsage(group, itemName);

        setTimeout(() => {
            target.bondageApplied++;
            const becameFullyBound = target.bondageApplied >= this.bondageItemLimit
                || this.availablePickSlots(target).length === 0;
            this.host.onBondageItemApplied(target, becameFullyBound);
        }, 500);
    }

    // --- timers ------------------------------------------------

    private startPickTimer(): void {
        const pending = this.pendingBondagePick;
        if (!pending) return;
        this.clearPickTimer();
        pending.timer = setTimeout(() => this.handlePickTimeout(), PICKER_RESPONSE_TIMEOUT_MS);
    }

    private clearPickTimer(): void {
        const pending = this.pendingBondagePick;
        if (pending?.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
        }
    }

    /** Cancels any in-flight pick without applying anything — call this when
     * the target or picker leaves/is kicked/safewords mid-pick. */
    cancelPendingBondagePick(): void {
        this.clearPickTimer();
        this.pendingBondagePick = null;
    }

    // Picker went quiet — pick randomly so the game keeps moving. The target
    // still gets their veto window.
    private handlePickTimeout(): void {
        const pending = this.pendingBondagePick;
        if (!pending) return;
        pending.timer = null;

        const target = this.host.getPlayer(pending.targetNumber);
        if (!target) {
            this.cancelPendingBondagePick();
            return;
        }

        if (pending.stage === "slot") {
            const slots = this.availablePickSlots(target);
            if (slots.length === 0) {
                this.cancelPendingBondagePick();
                this.beginPlayerPickBondage(target); // re-enters the no-slots path
                return;
            }
            const slot = slots[Math.floor(Math.random() * slots.length)];
            const actualGroup = slot.group === "ItemMouth" ? this.resolveMouthGroup(target) : slot.group;
            if (!actualGroup) {
                this.cancelPendingBondagePick();
                this.beginPlayerPickBondage(target);
                return;
            }
            const { options } = this.buildPickList(actualGroup, this.vetoedItemsFor(pending, actualGroup));
            if (options.length === 0) {
                this.cancelPendingBondagePick();
                this.beginPlayerPickBondage(target);
                return;
            }
            pending.slotDisplay = slot.display;
            pending.slotGroup = actualGroup;
            pending.options = options;
            pending.chosenItem = options[Math.floor(Math.random() * options.length)];
            this.bot.whisper(pending.pickerNumber, `Time's up — I picked ${pending.chosenItem} (${slot.display}) for you.`);
            this.beginVetoStage();
            return;
        }

        if (pending.stage === "item") {
            pending.chosenItem = pending.options[Math.floor(Math.random() * pending.options.length)];
            this.bot.whisper(pending.pickerNumber, `Time's up — I picked ${pending.chosenItem} for you.`);
            this.beginVetoStage();
        }
    }

    // --- round-loser tracking ------------------------------------

    // Captures who lost this round. Each loss stamps the loser with the
    // current loss sequence number — picker selection favors the player
    // who has gone longest without rolling a 1 (lowest stamp; 0 = never).
    noteRoundLoser(player: P): void {
        this.lastRoundLoser = player.memberNumber;
        this.lossSeqCounter++;
        player.lastLossSeq = this.lossSeqCounter;
    }

    // --- item settings library ---------------------------------

    private loadItemSettings(): void {
        try {
            if (fs.existsSync(this.itemSettingsPath)) {
                this.itemSettings = JSON.parse(fs.readFileSync(this.itemSettingsPath, "utf8"));
            }
        } catch (err) {
            this.log(`WARNING: Could not load ${this.itemSettingsPath} — starting with empty settings library: ${err}`);
            this.itemSettings = {};
        }
    }

    private saveItemSettings(): void {
        try {
            fs.writeFileSync(this.itemSettingsPath, JSON.stringify(this.itemSettings, null, 2), "utf8");
        } catch (err) {
            this.log(`ERROR: Failed to write ${this.itemSettingsPath}: ${err}`);
        }
    }

    // Preloads configurations from the bootstrap outfits so common items have
    // a known-good restraining mode before any room observations come in.
    // Adds only missing variants — never inflates counts across restarts.
    private seedItemSettingsFromOutfits(): void {
        let added = false;
        for (const outfit of this.bootstrapOutfits) {
            for (const item of outfit.items) {
                if (this.recordItemSetting(item.group, item.name, item.property, { increment: false, save: false })) {
                    added = true;
                }
            }
        }
        if (added) this.saveItemSettings();
    }

    // Records one observed configuration for an item. Returns true if the
    // library changed. increment=false only adds unseen variants (seeding).
    // Call this from your bot's item-change observer (e.g. ChatRoomSyncItem)
    // so the picker learns real restraining configurations over time.
    recordItemSetting(group: string, name: string, rawProperty: any, opts: { increment: boolean; save: boolean }): boolean {
        const property = cleanDecodedProperty(rawProperty);
        if (!isLearnableProperty(property)) return false;

        const key = `${group}:${name}`;
        const canon = canonicalJson(property);
        const variants = this.itemSettings[key] ?? (this.itemSettings[key] = []);
        const existing = variants.find(v => canonicalJson(v.property) === canon);

        let changed = false;
        if (existing) {
            if (opts.increment) {
                existing.count++;
                changed = true;
            }
        } else {
            variants.push({ property: deepClone(property), count: 1 });
            if (variants.length > MAX_SETTING_VARIANTS_PER_ITEM) {
                variants.sort((a, b) => b.count - a.count);
                variants.length = MAX_SETTING_VARIANTS_PER_ITEM;
            }
            changed = true;
        }

        if (changed && opts.save) this.saveItemSettings();
        return changed;
    }

    // Chooses the configuration to apply for a picked item, per the
    // configured itemSettingStrategy. Returns {} when nothing has been
    // learned yet (item applies in its BC default mode).
    private pickItemSetting(group: string, name: string): any {
        const variants = this.itemSettings[`${group}:${name}`];
        if (!variants || variants.length === 0) return {};

        if (this.itemSettingStrategy === "random") {
            return deepClone(variants[Math.floor(Math.random() * variants.length)].property);
        }
        if (this.itemSettingStrategy === "weighted") {
            const total = variants.reduce((sum, v) => sum + v.count, 0);
            let roll = Math.random() * total;
            for (const v of variants) {
                roll -= v.count;
                if (roll <= 0) return deepClone(v.property);
            }
            return deepClone(variants[variants.length - 1].property);
        }

        const best = Math.max(...variants.map(v => v.count));
        const top = variants.filter(v => v.count === best);
        return deepClone(top[Math.floor(Math.random() * top.length)].property);
    }

    // --- popularity tracking & candidate logging ---------------

    private loadBondageUsage(): void {
        try {
            if (fs.existsSync(this.bondageUsagePath)) {
                this.bondageUsage = JSON.parse(fs.readFileSync(this.bondageUsagePath, "utf8"));
            }
        } catch (err) {
            this.log(`WARNING: Could not load ${this.bondageUsagePath} — starting with empty usage data: ${err}`);
            this.bondageUsage = {};
        }
    }

    private saveBondageUsage(): void {
        try {
            fs.writeFileSync(this.bondageUsagePath, JSON.stringify(this.bondageUsage, null, 2), "utf8");
        } catch (err) {
            this.log(`ERROR: Failed to write ${this.bondageUsagePath}: ${err}`);
        }
    }

    private incrementBondageUsage(group: string, itemName: string): void {
        if (!this.bondageUsage[group]) this.bondageUsage[group] = {};
        this.bondageUsage[group][itemName] = (this.bondageUsage[group][itemName] ?? 0) + 1;
        this.saveBondageUsage();
    }

    // Appends this game's player-pick selections to outfit_candidates.json
    // for periodic manual review / promotion into a bot's outfits.json.
    logOutfitCandidates(): void {
        const players = [...this.host.getPlayers()];
        const pickPlayers = players.filter(p => p.bondageMode === "player-pick" && p.appliedBondageItems.length > 0);
        if (pickPlayers.length === 0) return;

        const entry = {
            date: new Date().toISOString(),
            players: players.map(p => p.name),
            selections: pickPlayers.flatMap(p =>
                p.appliedBondageItems.map(e => ({ slot: e.slot, item: e.item, appliedTo: p.name }))),
        };

        try {
            let existing: any[] = [];
            if (fs.existsSync(this.outfitCandidatesPath)) {
                const parsed = JSON.parse(fs.readFileSync(this.outfitCandidatesPath, "utf8"));
                if (Array.isArray(parsed)) existing = parsed;
            }
            existing.push(entry);
            fs.writeFileSync(this.outfitCandidatesPath, JSON.stringify(existing, null, 2), "utf8");
            this.log(`Logged ${entry.selections.length} player-pick selection(s) to outfit_candidates.json`);
        } catch (err) {
            this.log(`ERROR: Failed to write ${this.outfitCandidatesPath}: ${err}`);
        }
    }

    // --- misc ----------------------------------------------------

    // maxLen chunking mirrors StripDiceBot's whisper-length limit; override
    // via a higher-level wrapper if your bot's limit differs.
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

    /** Call between games (or on a full game reset) to clear all per-game
     * picker state — mirrors StripDiceBot's resetGame() cleanup. Usage
     * popularity and the learned item-settings library are NOT cleared;
     * those persist across games by design. */
    resetGameState(): void {
        this.lastRoundLoser = null;
        this.lossSeqCounter = 0;
        this.pickerHistory = [];
        this.gameBondageMode = "outfit";
        this.awaitingBondageMode = false;
        if (this.bondageModeTimer) {
            clearTimeout(this.bondageModeTimer);
            this.bondageModeTimer = null;
        }
        this.awaitingSlotConsent = false;
        if (this.slotConsentTimer) {
            clearTimeout(this.slotConsentTimer);
            this.slotConsentTimer = null;
        }
        this.pendingSlotConsent.clear();
        this.cancelPendingBondagePick();
    }
}
