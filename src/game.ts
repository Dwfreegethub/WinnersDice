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

function rollDie(): number {
    return Math.floor(Math.random() * 6) + 1;
}

function roll2d6(): [number, number] {
    return [rollDie(), rollDie()];
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
            case "!cancel":
                this.handleCancel(sender);
                break;
        }
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
        const bonus1 = Math.min(p1.streak, 3);
        const bonus2 = Math.min(p2.streak, 3);

        let dice1: [number, number];
        let dice2: [number, number];
        let total1: number;
        let total2: number;
        do {
            dice1 = roll2d6();
            dice2 = roll2d6();
            total1 = dice1[0] + dice1[1] + bonus1;
            total2 = dice2[0] + dice2[1] + bonus2;
        } while (total1 === total2);

        const winner = total1 > total2 ? p1 : p2;
        const loser = winner === p1 ? p2 : p1;
        const winnerDice = winner === p1 ? dice1 : dice2;

        const pot = (winnerDice[0] + winnerDice[1]) * state.round;

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
            winnerAdvantage: Math.min(winner.streak, 3),
        };

        this.announceRoundResult(result);
    }

    private announceRoundResult(result: RoundResult): void {
        const [p1, p2] = this.state.players!;
        const winner = result.winner === p1.memberNumber ? p1 : p2;
        const [r1, r2] = result.rolls;

        const fmtRoll = (name: string, roll: DiceRoll) =>
            `${name} rolled [${roll.dice[0]}, ${roll.dice[1]}]${roll.bonus > 0 ? ` +${roll.bonus}` : ""} = ${roll.total}`;

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
}
