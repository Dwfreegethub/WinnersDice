import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { log, centralTimestamp } from "./logger";
import { secrets } from "./secrets";
import {
    BCCharacter,
    Player,
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
function nextNegotiationKey(config: Partial<GameConfig>): NegotiationKey | null {
    for (const key of NEGOTIATION_ORDER) {
        if (!(key in config)) return key;
    }
    if (config.bondage) {
        if (!("bondageAppliedBy" in config)) return "bondageAppliedBy";
        if (!("lockDuration" in config)) return "lockDuration";
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
        case "services": return "Services";
    }
}

function describeSetting(key: NegotiationKey): string {
    switch (key) {
        case "minRounds": return "minimum rounds before the winner can end the game (default 3)";
        case "stripping": return "stripping (yes/no, default no)";
        case "bondage": return "bondage (yes/no, default no)";
        case "bondageAppliedBy": return "bondage application — bot or player (default bot)";
        case "lockDuration": return "lock duration in minutes (default 10)";
        case "toys": return "toys (yes/no, default no)";
        case "services": return "services (yes/no, default no)";
    }
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

// Cap on the streak bonus added to a d20 roll (1-20 range).
const MAX_STREAK_BONUS = 5;

function formatValue(key: NegotiationKey, value: any): string {
    if (typeof value === "boolean") return value ? "yes" : "no";
    return String(value);
}

// Returns the parsed value on success, or an error message string on failure.
function parseProposalValue(key: NegotiationKey, raw: string): { value: any } | string {
    const v = raw.trim().toLowerCase();
    switch (key) {
        case "minRounds": {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1 || n > 20) return "Minimum rounds must be a number between 1 and 20.";
            return { value: n };
        }
        case "lockDuration": {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1 || n > 120) return "Lock duration must be a number of minutes between 1 and 120.";
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
            round: 1,
            awaitingDecision: null,
            negotiation: null,
        };
    }

    public handleChatMessage(sender: number, content: string, isWhisper: boolean): void {
        const msg = content.trim();
        if (!msg.startsWith("!")) return;

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
            case "!feedback":
                this.handleFeedback(sender, args, isWhisper);
                break;
            case "!setstatus":
                this.handleSetStatus(sender, args, isWhisper);
                break;
        }
    }

    private handleHelp(sender: number): void {
        let text =
            `=== WinnersDice Commands ===\n` +
            `!challenge @PlayerName - Challenge a player to a match\n` +
            `!help - Show this message\n\n` +
            `=== Setup (Negotiating Match Rules) ===\n` +
            `!yes / !no - Answer the bot's yes-or-no questions\n` +
            `!propose <value> - Propose a value for the current setting\n` +
            `!accept - Accept the other player's proposal\n` +
            `!counter <value> - Counter-propose a different value\n` +
            `!decline - Decline and end the negotiation\n` +
            `!cancel - Abort the negotiation entirely\n\n` +
            `=== During the Game ===\n` +
            `!bank - Lock in your pot and pass the turn safely\n` +
            `!press - Keep your streak and roll again, risking it all\n` +
            `!endgame - Call the match early (after the minimum rounds)\n\n` +
            `=== Feedback ===\n` +
            `!feedback <text> - Send feedback to the developers (whisper only)`;

        if (this.isAdmin(sender)) {
            text +=
                `\n\n=== Admin Commands ===\n` +
                `!reset - End the current match immediately and reset to idle\n` +
                `!setstatus <memberNumber> <status> - Set a player's feedback status (reviewing, testing, implemented, partly_implemented)\n` +
                `!feedback list - View a summary of all tracked feedback`;
        }

        this.bot.whisper(sender, text);
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
        };

        this.state = {
            phase: "negotiating",
            config: null,
            players: null,
            round: 1,
            awaitingDecision: null,
            negotiation,
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

        const key = nextNegotiationKey(negotiation.config);
        if (key === null) {
            this.finishNegotiation();
            return;
        }

        negotiation.pending = null;

        if (isYesNoKey(key)) {
            negotiation.answers = {};
            this.bot.sendChat(
                `${negotiation.challenger.name} and ${negotiation.opponent.name}: ${yesNoQuestion(key)} Reply !yes or !no.`
            );
            return;
        }

        this.bot.sendChat(`${negotiation.challenger.name}, propose a value for ${describeSetting(key)}. Use !propose <value>.`);
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
            this.bot.sendChat(`${settingLabel(key)} is a yes/no setting — both players reply !yes or !no.`);
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
            `${negotiation.opponent.name}, type !accept or !counter <value>.`
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

        const parsed = parseProposalValue(negotiation.pending.key, args);
        if (typeof parsed === "string") {
            this.bot.sendChat(parsed);
            return;
        }

        const counterer = sender === negotiation.challenger.memberNumber ? negotiation.challenger : negotiation.opponent;
        const other = counterer === negotiation.challenger ? negotiation.opponent : negotiation.challenger;

        negotiation.pending = { key: negotiation.pending.key, value: parsed.value, proposedBy: sender };

        this.bot.sendChat(
            `${counterer.name} counters: ${settingLabel(negotiation.pending.key)} = ${formatValue(negotiation.pending.key, parsed.value)}. ` +
            `${other.name}, type !accept or !counter <value>.`
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

        const config: GameConfig = {
            minRounds: negotiation.config.minRounds ?? 3,
            stripping: negotiation.config.stripping ?? false,
            bondage: negotiation.config.bondage ?? false,
            bondageAppliedBy: negotiation.config.bondage ? (negotiation.config.bondageAppliedBy ?? "bot") : null,
            lockDuration: negotiation.config.bondage ? (negotiation.config.lockDuration ?? 10) : 0,
            toys: negotiation.config.toys ?? false,
            services: negotiation.config.services ?? false,
        };

        const players: [PlayerState, PlayerState] = [
            { memberNumber: negotiation.challenger.memberNumber, name: negotiation.challenger.name, banked: 0, unbankedPot: 0, streak: 0, frozen: false },
            { memberNumber: negotiation.opponent.memberNumber, name: negotiation.opponent.name, banked: 0, unbankedPot: 0, streak: 0, frozen: false },
        ];

        this.state = {
            phase: "playing",
            config,
            players,
            round: 1,
            awaitingDecision: null,
            negotiation: null,
        };

        const summary = [
            `Minimum rounds: ${config.minRounds}`,
            `Stripping: ${formatValue("stripping", config.stripping)}`,
            `Bondage: ${formatValue("bondage", config.bondage)}` + (config.bondage ? ` (${config.bondageAppliedBy}-applied, ${config.lockDuration} min locks)` : ""),
            `Toys: ${formatValue("toys", config.toys)}`,
            `Services: ${formatValue("services", config.services)}`,
        ].join(", ");

        this.bot.sendChat(
            `All settings agreed! ${summary}. The WinnersDice match between ${players[0].name} and ${players[1].name} is starting!`
        );

        this.startMatch();
    }

    private startMatch(): void {
        this.bot.sendChat(`Round ${this.state.round} — both players roll!`);
        this.playRound();
    }

    private playRound(): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config) return;

        const [p1, p2] = state.players;
        const bonus1 = Math.min(p1.streak, MAX_STREAK_BONUS);
        const bonus2 = Math.min(p2.streak, MAX_STREAK_BONUS);

        let dice1: number;
        let dice2: number;
        let total1: number;
        let total2: number;
        let winner: PlayerState;
        let loser: PlayerState;
        while (true) {
            dice1 = rollD20();
            dice2 = rollD20();
            total1 = dice1 + bonus1;
            total2 = dice2 + bonus2;

            const p1Natural1 = dice1 === 1;
            const p2Natural1 = dice2 === 1;
            const p1Natural20 = dice1 === 20;
            const p2Natural20 = dice2 === 20;

            // Matching natural 1s or natural 20s cancel each other out - reroll.
            if ((p1Natural1 && p2Natural1) || (p1Natural20 && p2Natural20)) continue;

            if (p1Natural1 || p2Natural20) {
                winner = p2;
                loser = p1;
                break;
            }
            if (p2Natural1 || p1Natural20) {
                winner = p1;
                loser = p2;
                break;
            }
            if (total1 === total2) continue;

            winner = total1 > total2 ? p1 : p2;
            loser = winner === p1 ? p2 : p1;
            break;
        }

        const winnerDice = winner === p1 ? dice1 : dice2;

        const pot = winnerDice * state.round;

        winner.streak += 1;
        loser.streak = 0;
        loser.frozen = true;
        winner.frozen = false;
        winner.unbankedPot += pot;

        state.awaitingDecision = winner.memberNumber;

        const result: RoundResult = {
            round: state.round,
            rolls: [
                { memberNumber: p1.memberNumber, dice: dice1, bonus: bonus1, total: total1 },
                { memberNumber: p2.memberNumber, dice: dice2, bonus: bonus2, total: total2 },
            ],
            winner: winner.memberNumber,
            pot,
            winnerStreak: winner.streak,
            winnerAdvantage: Math.min(winner.streak, MAX_STREAK_BONUS),
        };

        this.announceRoundResult(result);
    }

    private announceRoundResult(result: RoundResult): void {
        const [p1, p2] = this.state.players!;
        const winner = result.winner === p1.memberNumber ? p1 : p2;
        const [r1, r2] = result.rolls;

        const fmtRoll = (name: string, roll: DiceRoll) => {
            const breakdown = roll.bonus > 0 ? `${roll.dice} +${roll.bonus} = ${roll.total}` : `${roll.total}`;
            const natural = roll.dice === 1 ? " 🎲 Natural 1!" : roll.dice === 20 ? " 🎲 Natural 20!" : "";
            return `Round ${result.round}: ${name} rolls... ${breakdown}${natural}`;
        };

        this.bot.sendChat(fmtRoll(p1.name, r1));
        this.bot.sendChat(fmtRoll(p2.name, r2));
        this.bot.sendChat(
            `${winner.name} wins the round — +${result.pot} points to the pot (total: ${winner.unbankedPot}). ` +
            `Streak: ${result.winnerStreak}`
        );

        this.bot.whisper(
            winner.memberNumber,
            "Your move: !bank to lock in your pot, !press to keep your streak and continue, " +
            "or !endgame to call the match (after min rounds)."
        );
    }

    private handleBank(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || state.awaitingDecision !== sender) return;

        const winner = state.players.find(p => p.memberNumber === sender)!;
        winner.banked += winner.unbankedPot;
        winner.unbankedPot = 0;

        this.bot.sendChat(`${winner.name} banks the pot. Banked total: ${winner.banked}.`);
        this.advanceRound();
    }

    private handlePress(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || state.awaitingDecision !== sender) return;

        const winner = state.players.find(p => p.memberNumber === sender)!;
        const advantage = Math.min(winner.streak, MAX_STREAK_BONUS);

        this.bot.sendChat(
            `${winner.name} presses on, keeping ${winner.unbankedPot} points at risk with a +${advantage} advantage on the next roll.`
        );
        this.advanceRound();
    }

    private advanceRound(): void {
        this.state.awaitingDecision = null;
        this.state.round += 1;
        this.bot.sendChat(`Round ${this.state.round} — both players roll!`);
        this.playRound();
    }

    private handleEndgame(sender: number): void {
        const state = this.state;
        if (state.phase !== "playing" || !state.players || !state.config || state.awaitingDecision !== sender) return;

        if (state.round < state.config.minRounds) {
            this.bot.sendChat(`The minimum of ${state.config.minRounds} rounds hasn't been reached yet — !bank or !press to continue.`);
            return;
        }

        const winner = state.players.find(p => p.memberNumber === sender)!;
        winner.banked += winner.unbankedPot;
        winner.unbankedPot = 0;

        const [p1, p2] = state.players;
        let resultMsg: string;
        let finalWinnerMemberNumber: number | null = null;
        if (p1.banked === p2.banked) {
            resultMsg = "It's a tie!";
        } else {
            const finalWinner = p1.banked > p2.banked ? p1 : p2;
            finalWinnerMemberNumber = finalWinner.memberNumber;
            resultMsg = `${finalWinner.name} wins WinnersDice!`;
        }

        this.bot.sendChat(
            `${winner.name} ends the match! Final scores — ${p1.name}: ${p1.banked}, ${p2.name}: ${p2.banked}. ${resultMsg}`
        );

        this.recordGameCompletion(finalWinnerMemberNumber, [p1, p2]);

        this.state = this.createIdleState();

        this.checkPendingUpdate();
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

        this.state = this.createIdleState();
        this.bot.sendChat("Game has been reset by admin.");
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
        fs.appendFileSync(this.feedbackLogPath, line, "utf8");
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
        fs.writeFileSync(this.feedbackStatusPath, JSON.stringify(this.feedbackStatus, null, 2), "utf8");
    }

    private notifyFeedbackStatus(memberNumber: number, name: string): void {
        if (this.feedbackNotified.has(memberNumber)) return;
        const entry = this.feedbackStatus[String(memberNumber)];
        if (!entry || entry.items.length === 0) return;
        this.feedbackNotified.add(memberNumber);

        const itemsToShow = entry.items.filter(item =>
            !(RESOLVED_FEEDBACK_STATUSES.has(item.status) && item.statusShown)
        );
        if (itemsToShow.length === 0) return;

        const lines = itemsToShow.map((item, i) =>
            `${i + 1}. "${item.text}" — ${FEEDBACK_STATUS_LABELS[item.status] ?? item.status}`
        );

        this.sendLongWhisper(memberNumber,
            `Hi ${name}! Here's an update on the feedback you've sent us:\n` +
            lines.join("\n") +
            `\n\nThanks for helping us improve the game! 💕`
        );

        let changed = false;
        for (const item of itemsToShow) {
            if (RESOLVED_FEEDBACK_STATUSES.has(item.status) && !item.statusShown) {
                item.statusShown = true;
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

    public onMemberJoin(memberNumber: number, name: string): void {
        if (memberNumber === this.bot.getMemberNumber()) return;
        this.recordPlayerSeen(memberNumber, name);
        this.sendWelcomeWhisper(memberNumber, name);
        this.notifyFeedbackStatus(memberNumber, name);
    }

    public onRoomSync(characters: BCCharacter[]): void {
        for (const char of characters) {
            if (char.MemberNumber === undefined || char.MemberNumber === this.bot.getMemberNumber()) continue;
            const name = char.Nickname || char.Name || `Player #${char.MemberNumber}`;
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
        fs.writeFileSync(this.playerRecordsPath, JSON.stringify(this.playerRecords, null, 2), "utf8");
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

        fs.unlinkSync(this.pendingUpdatePath);

        setTimeout(() => {
            process.exit(0);
        }, 2000);

        return true;
    }
}
