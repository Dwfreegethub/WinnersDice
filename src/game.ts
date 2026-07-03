import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { log, logError, centralTimestamp } from "./logger";
import { secrets } from "./secrets";
import {
    BCCharacter,
    Player,
    ClothingDeal,
    DiceRoll,
    FeedbackItemStatus,
    FeedbackStatusEntry,
    GameConfig,
    GameState,
    NegotiationKey,
    NegotiationState,
    PlayerRecord,
    PlayerState,
    RoundResult,
    SoldItem,
    SpendOption,
} from "./types";

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
// Bondage-dependent settings are only inserted once bondage itself is settled.
// Note: bondage application is no longer negotiated — the other player always applies it.
function nextNegotiationKey(config: Partial<GameConfig>): NegotiationKey | null {
    for (const key of NEGOTIATION_ORDER) {
        if (!(key in config)) return key;
    }
    if (config.bondage && !("lockDuration" in config)) return "lockDuration";
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
        case "services": return "Services";
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
        case "bondage": return "Enable bondage?";
        case "toys": return "Enable toys?";
        case "services": return "Enable services?";
        default: return `Enable ${settingLabel(key)}?`;
    }
}

function rollD20(): number {
    return Math.floor(Math.random() * 20) + 1;
}

// Default cap on each player's earned streak, used until an admin changes it
// with !setstreak between games.
const DEFAULT_MAX_STREAK = 10;

// Cost in points to purchase +1 through +5 boost (index 0 = level 1).
const BOOST_PRICES = [50, 150, 300, 600, 1000];

// Maximum total boost a player can hold at once.
const MAX_BOOST = 5;

// How long the bot waits for a wardrobe change after a clothing deal is
// agreed before nudging the buyer to follow up directly.
const WARDROBE_CHECK_TIMEOUT_MS = 2 * 60 * 1000;

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

    constructor(bot: BCConnection, roomMembers: Map<number, Player>) {
        this.bot = bot;
        this.roomMembers = roomMembers;
        this.state = this.createIdleState();
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
            negotiation: null,
            pendingRolls: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            waitingForWardrobe: null,
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

        switch (cmd) {
            case "!help":
                this.handleHelp(sender);
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
                this.handleYesNoAnswer(sender, true);
                break;
            case "!no":
                this.handleYesNoAnswer(sender, false);
                break;
            case "!cancel":
                this.handleCancel(sender);
                break;
            case "!roll":
                this.handleRoll(sender);
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

        // An in-progress clothing deal can involve messages from either the
        // buyer or the opponent, regardless of who's awaitingPostBank.
        if (this.state.clothingDeal && this.handleClothingDealMessage(sender, msg, lower)) {
            return;
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
        // rounds or lock duration) and hasn't proposed a value yet — treat
        // any extractable number in their reply as that proposal.
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
                const key = nextNegotiationKey(negotiation.config);
                if (key !== null && isYesNoKey(key)) {
                    this.handleYesNoAnswer(sender, true);
                }
            }
            return;
        }

        if (lower === "no" || lower === "n") {
            if (negotiation && this.state.phase === "negotiating" && !negotiation.pending) {
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

        if (lower === "bot" || lower === "auto" || lower === "you" || lower === "self" || lower === "me" || lower === "manual") {
            this.handleRollModeAnswer(sender, lower);
            return;
        }

        if (lower === "roll") {
            this.handleRoll(sender);
            return;
        }
    }

    private handleHelp(sender: number): void {
        let text =
            `=== WinnersDice Commands ===\n` +
            `!challenge @PlayerName - Challenge a player to a match\n` +
            `!help - Show this message\n\n` +
            `=== Setup (Negotiating Match Rules) ===\n` +
            `yes / no - Answer the bot's yes-or-no questions (!yes / !no also work)\n` +
            `When asked for a number, just say it (e.g. "4" or "4 rounds")\n` +
            `accept - Accept the other player's proposal (!accept also works)\n` +
            `counter <value> - Counter-propose a different value (!counter also works; just "counter" will prompt you for the value)\n` +
            `!decline - Decline and end the negotiation\n` +
            `!cancel - Abort the negotiation entirely\n\n` +
            `=== During the Game ===\n` +
            `Only the winner of a roll gets to choose what's next — the loser waits.\n` +
            `!bank - Lock in your pot and ask what's next (spend / continue / endgame)\n` +
            `!press - Keep your streak and roll again in the same round, risking it all\n` +
            `!endgame - Call the match early (after the minimum rounds)\n` +
            `!roll - Roll your dice (only if you chose to roll for yourselves)\n\n` +
            `=== Streaks, Boosts & Curses ===\n` +
            `Winning a roll adds your dice + streak + boost to your pot, then × the round multiplier.\n` +
            `Rolling a Natural 20 adds +2 to your streak instead of +1 (announced in chat).\n` +
            `Rolling a Natural 1 curses you with -1 to your rolls until you win one (also announced).\n` +
            `Streak resets to 0 when you lose a roll or a round ends (banker says "continue").\n` +
            `Boost is purchased from the spend menu, persists across rounds, and drains by 1 on each loss.\n\n` +
            `=== After Banking ===\n` +
            `'continue' - Start the next round (multiplier goes up, streaks reset, boosts persist)\n` +
            `'spend' - Open the spend menu to trade with your opponent\n` +
            `'endgame' - Call the match (available after the minimum rounds)\n\n` +
            `=== Spend Menu ===\n` +
            `'boost' - Purchase a streak boost (+1 to +5, persists across rounds, max +${MAX_BOOST})\n` +
            `'clothing' - Offer to buy an item of clothing from your opponent for a price; ` +
            `they can accept, decline, or counter\n` +
            `'buyback' - Buy back an item you've sold, for double its sale price\n` +
            `'bondage' / 'toys' / 'services' - coming soon\n` +
            `'back' - Return to the continue/spend/endgame prompt\n\n` +
            `=== Feedback ===\n` +
            `!feedback <text> - Send feedback to the developers (whisper only)`;

        if (this.isAdmin(sender)) {
            text +=
                `\n\n=== Admin Commands ===\n` +
                `!reset - End the current match immediately and reset to idle\n` +
                `!setstreak <n> - Set the streak bonus cap (default ${DEFAULT_MAX_STREAK})\n` +
                `!setstatus <memberNumber> <status> - Set a player's feedback status (reviewing, testing, implemented, partly_implemented)\n` +
                `!feedback list - View a summary of all tracked feedback`;
        }

        this.sendLongWhisper(sender, text);
    }

    private findPlayerByName(name: string, excludeMemberNumber: number): Player | null {
        const lower = name.toLowerCase();
        for (const player of this.roomMembers.values()) {
            if (player.memberNumber === excludeMemberNumber) continue;
            if (player.name.toLowerCase() === lower) return player;
        }
        return null;
    }

    private handleChallenge(sender: number, args: string): void {
        if (this.state.phase !== "idle") {
            this.bot.sendChat("A WinnersDice match is already in progress. Type !cancel to abort an ongoing negotiation first.");
            return;
        }

        if (this.checkPendingUpdate()) return;

        const targetName = args.replace(/^@/, "").trim();
        if (!targetName) {
            this.bot.sendChat("Usage: !challenge @PlayerName");
            return;
        }

        const challenger = this.roomMembers.get(sender);
        if (!challenger) return;

        const opponent = this.findPlayerByName(targetName, sender);
        if (!opponent) {
            this.bot.sendChat(`Could not find a player named "${targetName}" in the room.`);
            return;
        }

        const negotiation: NegotiationState = {
            challenger,
            opponent,
            config: {},
            pending: null,
            answers: {},
            awaitingCounterFrom: null,
            rollModeAnswers: {},
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
            negotiation,
            pendingRolls: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            waitingForWardrobe: null,
        };

        this.bot.sendChat(
            `${challenger.name} has challenged ${opponent.name} to WinnersDice! Let's negotiate the match settings. ` +
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
            if (negotiation.config.rollMode === undefined) {
                this.promptRollMode();
                return;
            }
            this.finishNegotiation();
            return;
        }

        if (isYesNoKey(key)) {
            negotiation.answers = {};
            this.bot.sendChat(
                `${negotiation.challenger.name} and ${negotiation.opponent.name}: ${yesNoQuestion(key)} (reply "yes" or "no")`
            );
            return;
        }

        this.bot.sendChat(`${negotiation.challenger.name}, ${numericQuestion(key)}`);
    }

    private promptRollMode(): void {
        const negotiation = this.state.negotiation;
        if (!negotiation) return;

        negotiation.rollModeAnswers = {};
        this.bot.sendChat(
            `${negotiation.challenger.name} and ${negotiation.opponent.name}: do you want me to roll for you, or would you like to roll yourself? (say "bot" or "self")`
        );
    }

    private handleRollModeAnswer(sender: number, raw: string): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation) return;
        if (nextNegotiationKey(negotiation.config) !== null) return;
        if (negotiation.config.rollMode !== undefined) return;

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        let choice: "bot" | "self" | null = null;
        if (raw === "bot" || raw === "auto" || raw === "you") choice = "bot";
        else if (raw === "self" || raw === "me" || raw === "manual") choice = "self";
        if (!choice) return;

        negotiation.rollModeAnswers[sender] = choice;

        const challengerAnswer = negotiation.rollModeAnswers[negotiation.challenger.memberNumber];
        const opponentAnswer = negotiation.rollModeAnswers[negotiation.opponent.memberNumber];

        if (challengerAnswer === undefined || opponentAnswer === undefined) {
            const responder = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
            const other = responder === negotiation.challenger ? negotiation.opponent : negotiation.challenger;
            this.bot.sendChat(
                `${responder.name} would like ${choice === "self" ? "to roll for themselves" : "the bot to roll for them"}. Waiting on ${other.name}...`
            );
            return;
        }

        negotiation.config.rollMode = (challengerAnswer === "self" && opponentAnswer === "self") ? "self" : "bot";

        this.bot.sendChat(
            negotiation.config.rollMode === "self"
                ? `Got it — both of you will roll for yourselves. Type !roll when it's your turn each round.`
                : `Got it — I'll roll the dice for both of you each round.`
        );

        this.promptNextSetting();
    }

    private handlePropose(sender: number, args: string): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation) return;

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
            if ((counterKey === "minRounds" || counterKey === "lockDuration") && extractNumber(args) === null) {
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

    private handleCancel(sender: number): void {
        const negotiation = this.state.negotiation;
        if (this.state.phase !== "negotiating" || !negotiation) return;

        if (sender !== negotiation.challenger.memberNumber && sender !== negotiation.opponent.memberNumber) {
            return;
        }

        const player = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
        this.bot.sendChat(`${player.name} cancelled the negotiation. No match will be played.`);
        this.state = this.createIdleState();
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
            lockDuration: negotiation.config.bondage ? (negotiation.config.lockDuration ?? 10) : 0,
            toys: negotiation.config.toys ?? false,
            services: negotiation.config.services ?? false,
            rollMode: negotiation.config.rollMode ?? "bot",
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
            negotiation: null,
            pendingRolls: null,
            spendingBalance: 0,
            awaitingBoostLevel: null,
            awaitingBuyback: null,
            waitingForWardrobe: null,
        };

        const summary = [
            `Minimum rounds: ${config.minRounds}`,
            `Stripping: ${formatValue("stripping", config.stripping)}`,
            `Bondage: ${formatValue("bondage", config.bondage)}` + (config.bondage ? ` (applied by the other player, ${config.lockDuration} min locks)` : ""),
            `Toys: ${formatValue("toys", config.toys)}`,
            `Services: ${formatValue("services", config.services)}`,
            `Rolling: ${config.rollMode === "self" ? "you'll roll for yourselves with !roll" : "I'll roll for both of you"}`,
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

        if (state.config.rollMode === "self") {
            state.pendingRolls = {};
            for (const player of state.players) {
                this.bot.whisper(player.memberNumber, `It's your turn! Type !roll for Round ${state.currentRound} — Roll ${state.rollNumber}.`);
            }
            return;
        }

        while (true) {
            if (this.resolveRoll(rollD20(), rollD20())) break;
        }
    }

    private handleRoll(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;
        if (state.config.rollMode !== "self") return;
        if (!state.players.some(p => p.memberNumber === sender)) return;
        if (this.blockedByWardrobe(sender)) return;

        if (!state.pendingRolls) state.pendingRolls = {};
        if (state.pendingRolls[sender] !== undefined) {
            this.bot.whisper(sender, "You've already rolled this round — waiting on your opponent.");
            return;
        }

        const [p1, p2] = state.players;
        const dice = rollD20();
        state.pendingRolls[sender] = dice;

        const roller = sender === p1.memberNumber ? p1 : p2;
        this.bot.sendChat(`${roller.name} rolls... ${dice}!`);

        const dice1 = state.pendingRolls[p1.memberNumber];
        const dice2 = state.pendingRolls[p2.memberNumber];
        if (dice1 === undefined || dice2 === undefined) {
            const other = roller === p1 ? p2 : p1;
            this.bot.whisper(other.memberNumber, `It's your turn! Type !roll for Round ${state.currentRound} — Roll ${state.rollNumber}.`);
            return;
        }

        state.pendingRolls = null;
        if (!this.resolveRoll(dice1, dice2)) {
            this.bot.sendChat("Those rolls cancel out — roll again, both of you!");
            state.pendingRolls = {};
            for (const player of state.players) {
                this.bot.whisper(player.memberNumber, `It's your turn! Type !roll for Round ${state.currentRound} — Roll ${state.rollNumber}.`);
            }
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
            `🎲 Roll ${result.rollNumber} — ${winner.name} rolls ${fmtBreakdown(winnerRoll)} = ${winnerRoll.total} × ${result.round} = ${winnerPoints} pts → Pot: ${result.potTotal} pts`
        );
        this.bot.sendChat(
            `${loser.name} rolls ${fmtBreakdown(loserRoll)} = ${loserRoll.total} × ${result.round} = ${loserPoints} pts → ${winner.name} wins this roll!`
        );
        this.bot.sendChat(`${winner.name} can bank ${result.potTotal} pts or keep rolling to build the pot.`);

        this.bot.whisper(
            winner.memberNumber,
            `!bank to take it, !press to keep rolling, or !endgame to call the match (after round ${this.state.config!.minRounds}).`
        );
        this.bot.whisper(loser.memberNumber, `${winner.name} won that roll — waiting for them to decide bank/press/endgame... (Pot: ${result.potTotal} pts)`);
    }

    private handleBank(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config || state.awaitingDecision !== sender) return;
        if (this.blockedByWardrobe(sender)) return;

        const winner = state.players.find(p => p.memberNumber === sender)!;
        winner.balance += state.pot;
        const banked = state.pot;
        state.pot = 0;
        state.spendingBalance = winner.balance;

        this.bot.sendChat(`${winner.name} banks the pot of ${banked} pts! Balance: ${winner.balance}.`);

        state.awaitingDecision = null;
        state.awaitingPostBank = sender;
        state.spendMenuOpen = false;
        this.bot.whisper(
            sender,
            `You've banked ${banked} pts (balance: ${winner.balance})! Streak was ${winner.streak}, Boost was ${winner.boost}.\n` +
            this.postBankPromptText()
        );
    }

    // The continue/spend/endgame prompt shown after banking, and re-shown
    // once a paused clothing deal's wardrobe change comes through.
    private postBankPromptText(): string {
        const state = this.state;
        const nextRound = this.currentRound + 1;
        return `What next?\n` +
            `• 'continue' — start Round ${nextRound} (×${nextRound} next round, streak resets)\n` +
            `• 'spend' — use your points\n` +
            `• 'endgame' — call the match (available after round ${state.config!.minRounds})`;
    }

    // Handles a banked player's reply to the spend/continue/endgame prompt
    // (or, if the spend menu is open, their spend-menu choice).
    private handlePostBankAnswer(sender: number, lower: string, raw: string): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;

        if (this.blockedByWardrobe(sender)) return;

        if (state.spendMenuOpen) {
            this.handleSpendMenuChoice(sender, lower, raw);
            return;
        }

        if (lower === "continue" || lower === "keep going" || lower === "keep playing" || lower === "play" || lower === "next") {
            state.awaitingPostBank = null;
            this.startNewRound(sender);
            return;
        }

        if (lower === "spend") {
            this.openSpendMenu(sender);
            return;
        }

        if (lower === "endgame" || lower === "end" || lower === "done" || lower === "end game") {
            if (state.currentRound < state.config.minRounds) {
                this.bot.whisper(sender, `Not yet — minimum rounds not reached. Say 'spend' or 'continue'.`);
                return;
            }
            state.awaitingPostBank = null;
            this.finishMatch(sender);
            return;
        }

        this.bot.whisper(sender, "I didn't catch that — say 'spend', 'continue', or 'endgame'.");
    }

    private handlePress(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || state.awaitingDecision !== sender) return;
        if (this.blockedByWardrobe(sender)) return;

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
            this.bot.whisper(other.memberNumber, `Your pending earnings of ${other.pendingBalance} pts from trades are now available to spend!`);
            other.pendingBalance = 0;
        }

        this.bot.sendChat(`🏦 ${banker.name} banks and continues! Starting Round ${state.currentRound} (×${state.currentRound} multiplier) — streaks reset!`);

        this.playRound();
    }

    private handleEndgame(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;
        if (state.awaitingDecision !== sender && state.awaitingPostBank !== sender) return;
        if (this.blockedByWardrobe(sender)) return;

        if (state.currentRound < state.config.minRounds) {
            if (state.awaitingPostBank === sender) {
                this.bot.whisper(sender, `Not yet — minimum rounds not reached. Say 'spend' or 'continue'.`);
            } else {
                this.bot.whisper(sender, `The minimum of ${state.config.minRounds} rounds hasn't been reached yet — !bank or !press to continue.`);
            }
            return;
        }

        if (state.awaitingPostBank === sender) {
            const winner = state.players.find(p => p.memberNumber === sender)!;
            winner.balance = state.spendingBalance;
        }

        state.awaitingPostBank = null;
        state.spendMenuOpen = false;
        this.finishMatch(sender);
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
        this.state = this.createIdleState();

        this.checkPendingUpdate();
    }

    // ============================================================
    // SPEND MENU & CLOTHING TRADES
    // ============================================================

    // Whispers the banked player their spend options, based on what was
    // negotiated for this match.
    private openSpendMenu(sender: number): void {
        const state = this.state;
        if (!state.players || !state.config) return;

        const player = state.players.find(p => p.memberNumber === sender)!;
        const options: string[] = [];
        options.push(`• 'boost' — purchase a streak boost that persists across rounds (max +${MAX_BOOST})`);
        if (state.config.stripping) options.push(`• 'clothing' — buy an item of clothing from your opponent`);
        if (state.config.bondage) options.push(`• 'bondage' — buy bondage to apply to your opponent (coming soon)`);
        if (state.config.toys) options.push(`• 'toys' — buy toy use (coming soon)`);
        if (state.config.services) options.push(`• 'services' — buy a service (coming soon)`);
        if (player.soldItems.length > 0) options.push(`• 'buyback' — buy back an item you've sold`);

        state.spendMenuOpen = true;
        this.bot.whisper(sender,
            `Spend menu (${state.spendingBalance} pts available) — what would you like to do?\n` +
            options.join("\n") +
            `\nOr say 'back' to return to continue/endgame.`
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

        if (lower === "back") {
            state.spendMenuOpen = false;
            this.bot.whisper(sender, "Okay — say 'continue' to keep playing, 'spend' to browse the spend menu again, or 'endgame' to call the match.");
            return;
        }

        if (lower === "boost") {
            this.startBoostPurchase(sender);
            return;
        }

        if (lower === "clothing") {
            if (!state.config.stripping) {
                this.bot.whisper(sender, "Clothing trades aren't available in this match.");
                return;
            }
            this.startClothingDeal(sender);
            return;
        }

        if (lower === "bondage" || lower === "toys" || lower === "services") {
            if (!state.config[lower]) {
                this.bot.whisper(sender, `${settingLabel(lower)} wasn't enabled for this match.`);
                return;
            }
            this.bot.whisper(sender, `Buying ${lower} isn't implemented yet — coming soon! Say 'spend' for other options, 'continue', or 'endgame'.`);
            return;
        }

        if (lower === "buyback") {
            if (player.soldItems.length === 0) {
                this.bot.whisper(sender, "You don't have any sold items to buy back.");
                return;
            }
            this.startBuyback(sender);
            return;
        }

        this.bot.whisper(sender, "I didn't catch that — say 'boost', 'clothing', 'bondage', 'toys', 'services', 'buyback', or 'back'.");
    }

    // ============================================================
    // STREAK BOOST PURCHASE
    // ============================================================

    private startBoostPurchase(sender: number): void {
        const state = this.state;
        if (!state.players) return;
        const player = state.players.find(p => p.memberNumber === sender)!;
        state.awaitingBoostLevel = sender;

        this.bot.whisper(sender,
            `Streak Boost prices:\n` +
            `+1 Boost — 50 pts\n` +
            `+2 Boost — 150 pts\n` +
            `+3 Boost — 300 pts\n` +
            `+4 Boost — 600 pts\n` +
            `+5 Boost — 1,000 pts\n` +
            `(your current boost: +${player.boost}, max total: +${MAX_BOOST})\n` +
            `How many levels? (say 1-5)`
        );
    }

    private handleBoostLevelResponse(sender: number, raw: string): void {
        const state = this.state;
        if (!state.players) return;
        const player = state.players.find(p => p.memberNumber === sender)!;

        const n = extractNumber(raw);
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
            this.bot.whisper(sender, `You only have ${state.spendingBalance} pts available — not enough for that.`);
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

        if (player.soldItems.length === 1) {
            const sold = player.soldItems[0];
            this.bot.whisper(sender, `Want to buy back your ${sold.item}? Cost: ${sold.salePrice * 2} pts. (say yes or no)`);
            return;
        }

        const lines = player.soldItems.map(s => `• ${s.item} — ${s.salePrice * 2} pts`);
        this.bot.whisper(sender,
            `Which item would you like to buy back?\n` +
            lines.join("\n") +
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
            this.bot.whisper(sender, `You only have ${state.spendingBalance} pts available — not enough for that.`);
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
        const message = `${player.name} is buying back their ${item} for ${cost} pts. ${holder.name} receives ${chosen.salePrice} pts (pending).`;
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
        const opponent = state.players.find(p => p.memberNumber !== buyer)!;

        state.clothingDeal = {
            buyer,
            opponent: opponent.memberNumber,
            item: null,
            price: null,
            counterPrice: null,
            stage: "awaiting_item_price",
        };

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
                this.bot.whisper(deal.buyer, `Got ${price} pts — what item do you want?`);
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
            this.bot.whisper(deal.buyer, `You only have ${state.spendingBalance} pts available — not enough for that. What would you like to buy and for how much?`);
            deal.item = null;
            deal.price = null;
            deal.stage = "awaiting_item_price";
            return;
        }

        deal.stage = "awaiting_opponent_response";
        this.bot.whisper(deal.opponent,
            `${this.playerName(deal.buyer)} wants to buy your ${deal.item} for ${deal.price} pts. ` +
            `Accept, decline, or counter with a different price? (say 'accept', 'decline', or 'counter <number>')`
        );
        this.bot.whisper(deal.buyer,
            `⏳ Your offer for ${deal.item} at ${deal.price} pts has been sent to ${this.playerName(deal.opponent)}. Waiting for their response...`
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

        deal.counterPrice = n;
        deal.stage = "awaiting_buyer_counter_response";
        this.bot.whisper(deal.buyer, `${this.playerName(deal.opponent)} counters: ${deal.item} for ${n} pts. Accept or decline?`);
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
            this.bot.whisper(deal.buyer, `You only have ${state.spendingBalance} pts available — not enough for that.`);
            this.bot.whisper(deal.opponent, `${this.playerName(deal.buyer)} can't cover ${price} pts — the deal is off.`);
            state.clothingDeal = null;
            this.returnToSpendMenu(deal.buyer);
            return;
        }

        const half = Math.floor(price / 2);

        state.spendingBalance -= price;
        opponent.pendingBalance += half;
        opponent.soldItems.push({ item, salePrice: price, soldBy: buyer.memberNumber });

        const breakdown = `Deal! ${item} sold for ${price} pts. ${opponent.name} receives ${half} pts (available next time you bank). Bot fee: ${half} pts.`;
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

    private clearPendingWardrobeChecks(): void {
        for (const pending of this.pendingWardrobeChecks.values()) {
            clearTimeout(pending.timer);
        }
        this.pendingWardrobeChecks.clear();
        this.state.waitingForWardrobe = null;
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
            this.bot.whisper(buyer, `Game resumes — here's what you can do next:\n` + this.postBankPromptText());
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

        this.clearPendingWardrobeChecks();
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
        return memberNumber === secrets.adminMemberNumber || memberNumber === this.bot.getMemberNumber();
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

        this.clearPendingWardrobeChecks();
        this.state = this.createIdleState();
        this.bot.sendChat("Game has been reset by admin.");
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
