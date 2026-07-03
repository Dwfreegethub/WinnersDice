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
    GameVersion?: string;
    OnlineSharedSettings?: {
        // Global toggle — false means this player has blocked all item interactions from others.
        AllowItem?: boolean;
        [key: string]: any;
    };
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
    // "bot" = the bot rolls automatically each round; "self" = both players
    // type !roll themselves each round.
    rollMode: "bot" | "self";
    // Cap on each player's earned streak. Admin-settable via !setstreak between games.
    maxStreak: number;
}

// Settled via the !propose/!accept/!counter/!decline flow (or the yes/no
// flow). rollMode is asked separately as a plain bot/self question.
export type NegotiationKey = Exclude<keyof GameConfig, "rollMode">;

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
    // Set while waiting for a player to send their counter-proposal value
    // after they typed "counter"/"!counter" with no value.
    awaitingCounterFrom: number | null;
    // Roll-mode answers ("bot"/"self") for the final negotiation question, keyed by member number.
    rollModeAnswers: Partial<Record<number, "bot" | "self">>;
}

// An item this player has sold to their opponent, available to buy back
// via the spend menu for double the original sale price.
export interface SoldItem {
    item: string;
    salePrice: number;
    // Member number of the player who currently holds the item (the buyer
    // in the original deal) — they'll need to return it on buyback.
    soldBy: number;
}

// Per-player running totals for a match.
export interface PlayerState {
    memberNumber: number;
    name: string;
    // This player's banked total — only changes when THEY bank the shared
    // pot (see GameState.pot) or via trade settlements.
    balance: number;
    // Added to this player's raw dice roll before any round multiplier.
    // Increases by 1 on winning a roll (2 for a Natural 20), resets to 0
    // when a new round starts (winner banks + continues).
    streak: number;
    // Purchased bonus, added alongside `streak`. Persists across rounds
    // (does not reset on "continue") but drains by 1 on each losing roll.
    boost: number;
    // -1 once this player rolls a natural 1, applied to their effective
    // roll until they win a roll (then cleared back to 0).
    cursedPenalty: number;
    // Points owed from trades (e.g. selling clothing) that aren't spendable
    // yet — moved into `balance` the next time this player banks.
    pendingBalance: number;
    // Items this player has sold to their opponent, available to buy back
    // via the spend menu.
    soldItems: SoldItem[];
}

export type GamePhase = "idle" | "negotiating" | "playing" | "ended";

// Spend-menu items a banked player can choose from.
export type SpendOption = "clothing" | "bondage" | "toys" | "services" | "buyback";

export type ClothingDealStage =
    // Waiting for the buyer's initial "item for price" whisper.
    | "awaiting_item_price"
    // Buyer gave a price but no item.
    | "awaiting_item"
    // Buyer gave an item but no price.
    | "awaiting_price"
    // Waiting for the opponent to accept/decline/counter.
    | "awaiting_opponent_response"
    // Opponent said "counter" with no value — waiting for the number.
    | "awaiting_opponent_counter_value"
    // Opponent countered — waiting for the buyer to accept/decline.
    | "awaiting_buyer_counter_response";

// In-progress clothing purchase negotiated via the spend menu.
export interface ClothingDeal {
    buyer: number;
    opponent: number;
    item: string | null;
    price: number | null;
    counterPrice: number | null;
    stage: ClothingDealStage;
}

export interface GameState {
    phase: GamePhase;
    config: GameConfig | null;
    players: [PlayerState, PlayerState] | null;
    // The shared pot. Builds up as roll winners add their points to it;
    // only the winner of the most recent roll can bank it (pot -> their
    // balance, then pot resets to 0). Persists across rolls and "press"es.
    pot: number;
    // The round multiplier (×1, ×2, ...). Increments only when the winner
    // banks and chooses to continue.
    currentRound: number;
    // The roll count within the current round. Resets to 1 at the start of
    // each round.
    rollNumber: number;
    // Member number of the round's winner, while they decide bank/press/endgame.
    awaitingDecision: number | null;
    // Member number of a player who just banked, while they decide spend/continue/endgame.
    awaitingPostBank: number | null;
    // True while awaitingPostBank player is browsing the spend menu (rather
    // than the top-level continue/spend/endgame prompt).
    spendMenuOpen: boolean;
    // In-progress clothing purchase, if any.
    clothingDeal: ClothingDeal | null;
    negotiation: NegotiationState | null;
    // In "self" roll mode, dice already rolled this round, keyed by member number.
    pendingRolls: Partial<Record<number, number>> | null;
    // The awaitingPostBank player's balance during the current bank/spend
    // session. Initialized to their balance when the session starts; every
    // purchase deducts from this immediately, and it's committed back to
    // `balance` when the session ends (continue/endgame).
    spendingBalance: number;
    // Member number awaiting a 1-5 response to the boost-purchase menu.
    awaitingBoostLevel: number | null;
    // Member number awaiting a response (item choice / yes-no) to the
    // buyback menu.
    awaitingBuyback: number | null;
    // Set after a clothing deal or buyback closes, while waiting for the
    // named member to update their wardrobe. Blocks all game commands.
    waitingForWardrobe: { memberNumber: number; item: string; timeoutAt: number } | null;
}

// A single player's d20 roll for a roll, including their streak/boost
// bonuses and any cursed penalty in effect.
export interface DiceRoll {
    memberNumber: number;
    dice: number;
    streak: number;
    boost: number;
    cursedPenalty: number;
    total: number;
}

export interface RoundResult {
    round: number;
    rollNumber: number;
    rolls: [DiceRoll, DiceRoll];
    winner: number;
    // Points the winner earned from this roll (effectiveRoll × currentRound).
    points: number;
    // The shared pot total after adding `points`.
    potTotal: number;
}

// ============================================================
// PLAYER TRACKING & FEEDBACK
// ============================================================

export interface PlayerRecord {
    memberNumber: number;
    name: string;
    firstSeen: string;
    lastSeen: string;
    gamesPlayed: number;
    gamesWon: number;
    feedbackGiven: boolean;
}

export type FeedbackItemStatus = "pending" | "reviewing" | "testing" | "implemented" | "declined" | "partly_implemented";

export interface FeedbackItem {
    timestamp: string;
    text: string;
    status: FeedbackItemStatus;
    // Resolved statuses (implemented/declined/partly_implemented) are only
    // whispered to the submitter once; this flag is set after that whisper
    // so the entry isn't repeated on later joins. Pending entries are never
    // marked shown.
    statusShown?: boolean;
}

export interface FeedbackStatusEntry {
    name: string;
    items: FeedbackItem[];
    // ISO timestamp of the last time this player was sent the bundled
    // "we're reviewing it" ack. A new ack is only sent if a reviewing/pending/
    // testing item with a newer timestamp arrives.
    reviewingAckDate?: string;
}
