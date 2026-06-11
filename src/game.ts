import { BCConnection } from "./connection";
import {
    Player,
    DiceRoll,
    GameConfig,
    GameState,
    NegotiationKey,
    NegotiationState,
    PlayerState,
    RoundResult,
} from "./types";

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

    constructor(bot: BCConnection, roomMembers: Map<number, Player>) {
        this.bot = bot;
        this.roomMembers = roomMembers;
        this.state = this.createIdleState();
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

    public handleChatMessage(sender: number, content: string): void {
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
        }
    }

    private handleHelp(sender: number): void {
        this.bot.sendChat(
            "WinnersDice commands: " +
            "!challenge @PlayerName (start a match) | " +
            "Setup: !yes / !no answer the bot's yes-or-no questions, " +
            "!propose <value> / !accept / !counter <value> / !decline settle minimum rounds, bondage application, and lock duration, " +
            "!cancel aborts the negotiation | " +
            "!bank, !press, !endgame (during play)."
        );
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
        do {
            dice1 = rollD20();
            dice2 = rollD20();
            total1 = dice1 + bonus1;
            total2 = dice2 + bonus2;
        } while (total1 === total2);

        const winner = total1 > total2 ? p1 : p2;
        const loser = winner === p1 ? p2 : p1;
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

        const fmtRoll = (name: string, roll: DiceRoll) =>
            `${name} rolled ${roll.dice}${roll.bonus > 0 ? ` +${roll.bonus}` : ""} = ${roll.total}`;

        const choices = ["!bank to lock in the pot", "!press to keep your advantage and continue"];
        if (this.state.round >= this.state.config!.minRounds) {
            choices.push("!endgame to end the match now");
        }

        this.bot.sendChat(
            `Round ${result.round}: ${fmtRoll(p1.name, r1)} | ${fmtRoll(p2.name, r2)}. ` +
            `${winner.name} wins the round and adds ${result.pot} points to their pot (now ${winner.unbankedPot}). ` +
            `Streak: ${result.winnerStreak} (next roll advantage: +${result.winnerAdvantage}). ` +
            `${winner.name}, choose: ${choices.join(", ")}.`
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
        if (p1.banked === p2.banked) {
            resultMsg = "It's a tie!";
        } else {
            const finalWinner = p1.banked > p2.banked ? p1 : p2;
            resultMsg = `${finalWinner.name} wins WinnersDice!`;
        }

        this.bot.sendChat(
            `${winner.name} ends the match! Final scores — ${p1.name}: ${p1.banked}, ${p2.name}: ${p2.banked}. ${resultMsg}`
        );

        this.state = this.createIdleState();
    }
}
