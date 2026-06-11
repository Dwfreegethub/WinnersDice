// ============================================================
// SHARED TYPE DEFINITIONS
// ============================================================

// A room member tracked by the bot's infrastructure layer.
export interface Player {
    memberNumber: number;
    name: string;
}

// Minimal shape of a Bondage Club character record, as seen in
// ChatRoomSync / ChatRoomSyncMemberJoin payloads.
export interface BCCharacter {
    MemberNumber: number;
    Name?: string;
    Nickname?: string;
    ItemPermission?: number;
    WhiteList?: number[];
    [key: string]: any;
}

// Incoming chat room message (ChatRoomMessage event).
export interface BCChatMessage {
    Type: string;
    Content: string;
    Sender: number;
    Target?: number;
    Dictionary?: any[];
    [key: string]: any;
}

// ChatRoomSync event payload.
export interface BCRoomSync {
    Character?: BCCharacter[];
    Visibility?: string[];
    Private?: boolean;
    [key: string]: any;
}

// ChatRoomSyncMemberJoin / ChatRoomSyncMemberLeave event payload.
export interface BCMemberEvent {
    SourceMemberNumber: number;
    Character?: BCCharacter;
    [key: string]: any;
}

// ============================================================
// WINNERSDICE GAME TYPES
// ============================================================

export type BondageAppliedBy = "bot" | "player";

// The agreed rules for a match, settled during pre-game negotiation.
export interface GameConfig {
    minRounds: number;
    stripping: boolean;
    bondage: boolean;
    bondageAppliedBy: BondageAppliedBy | null;
    lockDuration: number;
    toys: boolean;
    services: boolean;
}

export type NegotiationKey = keyof GameConfig;

// A proposed value for one setting, awaiting a response from the other player.
export interface NegotiationProposal {
    key: NegotiationKey;
    value: any;
    proposedBy: number;
}

export interface NegotiationState {
    challenger: Player;
    opponent: Player;
    config: Partial<GameConfig>;
    pending: NegotiationProposal | null;
    // Yes/no answers for the setting currently being asked, keyed by member number.
    answers: Partial<Record<number, boolean>>;
}

// Per-player running totals for a match.
export interface PlayerState {
    memberNumber: number;
    name: string;
    banked: number;
    unbankedPot: number;
    streak: number;
    frozen: boolean;
}

export type GamePhase = "idle" | "negotiating" | "playing" | "ended";

export interface GameState {
    phase: GamePhase;
    config: GameConfig | null;
    players: [PlayerState, PlayerState] | null;
    round: number;
    // Member number of the round's winner, while they decide bank/press/endgame.
    awaitingDecision: number | null;
    negotiation: NegotiationState | null;
}

// A single player's 2d6 roll for a round, including their streak bonus.
export interface DiceRoll {
    memberNumber: number;
    dice: [number, number];
    bonus: number;
    total: number;
}

export interface RoundResult {
    round: number;
    rolls: [DiceRoll, DiceRoll];
    winner: number;
    pot: number;
    winnerStreak: number;
    winnerAdvantage: number;
}
