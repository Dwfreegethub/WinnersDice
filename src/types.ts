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
    // TODO: not asked up front anymore — will be set per-purchase from the
    // spend menu once bondage purchases are implemented. Defaults to 0.
    lockDuration: number;
    toys: boolean;
    services: boolean;
    // Cap on each player's earned streak. Admin-settable via !setstreak between games.
    maxStreak: number;
}

// Settled via the !propose/!accept/!counter/!decline flow (or the yes/no flow).
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
    // "awaiting" -> the challenged player has been whispered and hasn't yet
    // said whether they accept the challenge at all; "accepted" -> they said
    // yes and normal negotiation (below) proceeds.
    acceptanceStage: "awaiting" | "accepted";
    // Fires if the challenged player doesn't answer in time; cleared as soon
    // as they answer (or the challenge/negotiation is cancelled some other way).
    acceptanceTimer: NodeJS.Timeout | null;
    config: Partial<GameConfig>;
    pending: NegotiationProposal | null;
    // Yes/no answers for the setting currently being asked, keyed by member number.
    answers: Partial<Record<number, boolean>>;
    // Set while waiting for a player to send their counter-proposal value
    // after they typed "counter"/"!counter" with no value.
    awaitingCounterFrom: number | null;
    // Tracks the single up-front "do you agree to all of this" consent question,
    // asked once before the individual stripping/bondage/toys/services questions.
    // "not_asked" -> ask it the next time a yes/no setting comes up; "awaiting" ->
    // question sent, waiting on one or both replies; "done" -> resolved (either all
    // four settings were enabled directly, or at least one player said no and the
    // individual questions proceed as the fallback).
    consentAllStage: "not_asked" | "awaiting" | "done";
    consentAllAnswers: Partial<Record<number, boolean>>;
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

// A piece of bondage currently applied in a match. `slot` is the picker-facing
// display name (see bondagePicker.ts PICK_SLOTS) — the BC item group is
// derived from it via PICK_SLOTS rather than stored redundantly.
export interface ActiveBondage {
    slot: string;
    itemName: string;
    assetName: string; // BC asset name for removal — same as itemName in this catalog
    placerMemberNumber: number;
    wearerMemberNumber: number;
    removalPrice?: number; // set once the wearer's buyback negotiation lands on a price
}

// An Exclusive lock the bot applied to a worn bondage item. The bot bypasses
// BC's normal lock permissions entirely (apply/remove both go straight
// through the socket), so this is purely bookkeeping for the removal price.
export interface ActiveLock {
    slot: string;
    placerMemberNumber: number;
    wearerMemberNumber: number;
    // The price agreed during the lock deal negotiation. Removal costs a
    // fixed multiple of this — the same multiplier as clothing buyback
    // (see LOCK_REMOVAL_MULTIPLIER in game.ts).
    agreedPrice: number;
}

export type LockDealStage =
    // Waiting for the placer's slot choice (or "all").
    | "awaiting_slot"
    // Waiting for the placer to propose a removal price for the chosen slot(s).
    | "awaiting_price"
    // Waiting for the wearer to accept/decline/counter.
    | "awaiting_opponent_response"
    // Wearer said "counter" with no value — waiting for the number.
    | "awaiting_opponent_counter_value"
    // Waiting for the placer to accept/decline/counter the wearer's counter.
    | "awaiting_buyer_counter_response"
    // Placer said "counter" with no value — waiting for the number.
    | "awaiting_buyer_counter_value";

// In-progress lock purchase from the spend menu: the placer picks which of
// the wearer's bondage slots to lock (or "all") and proposes a removal
// price; the wearer and placer then negotiate through the structured 5-step
// price negotiation (see applyInitiatorOffer/applyResponderCounter in
// game.ts) — same shape as a bondage "apply" deal. Only on acceptance does
// the bot actually apply the lock(s).
export interface LockDeal {
    placer: number;
    wearer: number;
    // Slot display names chosen to lock, resolved once stage moves to "awaiting_price".
    slots: string[];
    // The placer's (initiator's) most recent offer.
    price: number | null;
    // The wearer's (responder's) most recent counter.
    counterPrice: number | null;
    stage: LockDealStage;
    // 0 before the placer's first offer; 1-5 tracking the structured
    // negotiation steps described in game.ts (applyInitiatorOffer/applyResponderCounter).
    negotiationStep: number;
    // The placer's opening offer — their counters can never go below this.
    initiatorFloor: number | null;
    // The wearer's first counter — their later counters can never go above this.
    responderCeiling: number | null;
}

export type BondageDealKind = "apply" | "removal";

export type BondageDealStage =
    // Waiting for the placer's slot choice (apply deals only).
    | "awaiting_slot"
    // Waiting for the placer's item choice (apply deals only).
    | "awaiting_item"
    // Placer typed a name that only fuzzy-matched (not exact) — waiting for
    // yes/no confirmation before locking in the item.
    | "awaiting_item_confirm"
    // Waiting for the placer to name a price (both apply and removal deals).
    | "awaiting_price"
    // Waiting for the wearer to accept/decline/counter.
    | "awaiting_opponent_response"
    // Wearer said "counter" with no value — waiting for the number.
    | "awaiting_opponent_counter_value"
    // Waiting for the placer to accept/decline/counter the wearer's counter.
    | "awaiting_buyer_counter_response"
    // Placer said "counter" with no value — waiting for the number.
    | "awaiting_buyer_counter_value";

// In-progress bondage purchase (apply or paid removal), negotiated via the
// spend menu (apply) or the !buybondage command (removal). The placer always
// names the price first; the placer and wearer then negotiate through the
// structured 5-step price negotiation (see applyInitiatorOffer/
// applyResponderCounter in game.ts) and the wearer always pays/receives
// according to deal kind.
export interface BondageDeal {
    kind: BondageDealKind;
    placer: number;
    wearer: number;
    slot: string | null;
    itemName: string | null;
    itemOptions: string[];
    // The placer's (initiator's) most recent offer.
    price: number | null;
    // The wearer's (responder's) most recent counter.
    counterPrice: number | null;
    stage: BondageDealStage;
    // Candidate item name awaiting yes/no confirmation, set only when the
    // placer's text only fuzzy-matched (startsWith/includes, not exact).
    pendingFuzzyItem: string | null;
    // 0 before the placer's first offer; 1-5 tracking the structured
    // negotiation steps described in game.ts (applyInitiatorOffer/applyResponderCounter).
    negotiationStep: number;
    // The placer's opening offer — their counters can never go below this.
    initiatorFloor: number | null;
    // The wearer's first counter — their later counters can never go above this.
    responderCeiling: number | null;
}

export type ToyDealStage =
    // Waiting for the winner to pick a toy from the catalog.
    | "awaiting_toy"
    // Waiting for the winner to propose an initial price.
    | "awaiting_price"
    // Waiting for the loser to accept or counter (no decline option for toys).
    | "awaiting_opponent_response"
    // Loser said "counter" with no value — waiting for the number.
    | "awaiting_opponent_counter_value"
    // Waiting for the winner to accept/decline/counter the loser's counter.
    | "awaiting_buyer_counter_response"
    // Winner said "counter" with no value — waiting for the number.
    | "awaiting_buyer_counter_value"
    // Price is agreed — waiting for the winner to pick a duration in minutes.
    | "awaiting_duration";

// In-progress toy rental negotiated via the spend menu: the winner picks a
// toy and proposes a price for the loser's consent, negotiated through the
// same structured 5-step price negotiation as bondage/lock deals (see
// applyInitiatorOffer/applyResponderCounter in game.ts) — except the loser
// can only accept or counter, never decline outright. Once the price is
// agreed, the winner picks a duration and the toy is placed on the WINNER
// (see ActiveToy) rather than the loser.
export interface ToyDeal {
    winner: number;
    loser: number;
    toyAssetName: string | null;
    toyLabel: string | null;
    // The winner's (initiator's) most recent offer.
    price: number | null;
    // The loser's (responder's) most recent counter.
    counterPrice: number | null;
    stage: ToyDealStage;
    // 0 before the winner's first offer; 1-5 tracking the structured
    // negotiation steps described in game.ts (applyInitiatorOffer/applyResponderCounter).
    negotiationStep: number;
    // The winner's opening offer — their counters can never go below this.
    initiatorFloor: number | null;
    // The loser's first counter — their later counters can never go above this.
    responderCeiling: number | null;
    // The price agreed once negotiation concludes, held here while the
    // winner picks a duration (stage "awaiting_duration").
    agreedPrice: number | null;
}

// A toy currently placed on a match winner's ItemHandheld slot, rented from
// their opponent for a fixed real-time duration. Only one can be active at a
// time (per match) since it always occupies the same slot.
export interface ActiveToy {
    slot: "ItemHandheld";
    assetName: string;
    itemLabel: string;
    holderMemberNumber: number;
    timer: NodeJS.Timeout;
    agreedPrice: number;
}

// The winner's 5-question end game proposal, followed by the up-to-5-step
// time negotiation with the loser (see EndGameProposal.proposalStage and
// game.ts's handleEndGameNegotiation). Only exists while the proposal is
// being built or negotiated; once agreed, execution happens immediately and
// this is cleared in favor of ActiveEndGame.
export interface EndGameProposal {
    winnerMemberNumber: number;
    loserMemberNumber: number;
    proposalStage: "q1_time" | "q2_location" | "q3_privacy" | "q4_locks" | "q5_description" | "negotiating" | "executing";
    // Winner's answers
    proposedMinutes: number;
    location: "stay" | "move" | null;
    privacy: "public" | "private" | null;
    requestedLockSlots: string[];
    description: string;
    // Negotiation state (5-step) — see game.ts's handleEndGameNegotiation.
    negotiationStep: number;
    winnerFloor: number;
    loserCeiling: number | null;
    winnerLastOffer: number;
    loserLastCounter: number | null;
    // Points tracking — set once execution happens.
    winnerPointsCommitted: number;
    loserPointsCommitted: number;
}

// An agreed, in-progress end game: a real-time timer lock on the loser's
// leash slot plus any additional requested lock slots, released together
// when the timer expires (or the match is safeworded/reset early).
export interface ActiveEndGame {
    winnerMemberNumber: number;
    loserMemberNumber: number;
    agreedMinutes: number;
    winnerPointsSpent: number;
    loserPointsSpent: number;
    timer: NodeJS.Timeout;
    appliedLockSlots: string[];
}

// After the end game's extra lock slots are applied but before the timer/
// password lock goes on the loser's leash, each loser gets a 30-second
// window to nudge the suggested lock duration up or down in 5-minute
// increments (see game.ts's startEndGameLockVote/finalizeEndGameLockVote).
// Carries everything executeEndGame already settled (points spent, applied
// lock slots) through to the vote's finalization, since EndGameProposal is
// cleared once the vote starts.
export interface EndGameLockVote {
    winnerMemberNumber: number;
    loserMemberNumbers: number[];
    suggestedMinutes: number;
    // memberNumber -> 1 (less) | 2 (accept) | 3 (more). Missing entry at
    // finalization time = no reply = counts as accept.
    votes: Map<number, 1 | 2 | 3>;
    winnerPointsSpent: number;
    loserPointsSpent: number;
    appliedLockSlots: string[];
    timeout: NodeJS.Timeout;
}

// The requester's !mercy concession request, walking through the winner's
// accept/reject and the subsequent duration negotiation (see game.ts's
// handleMercyCommand/handleMercyMessage/resolveMercy).
export interface MercyRequest {
    requesterId: number;
    stage: "awaiting_details" | "awaiting_winner_response" | "awaiting_duration" | "awaiting_conceder_response" | "awaiting_winner_counter_response";
    serviceText: string | null;
    winnerDuration: string | null;
    concederCounter: string | null;
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
    // In-progress bondage purchase (apply or paid removal), if any.
    bondageDeal: BondageDeal | null;
    // Bondage currently applied to either player in this match.
    activeBondage: ActiveBondage[];
    // Items a placer just removed for free, still eligible for a free
    // re-apply (ALLOW_FREE_REAPPLY) as long as nothing new has filled the slot.
    removableBondage: ActiveBondage[];
    // Exclusive locks currently applied to either player's worn bondage.
    activeLocks: ActiveLock[];
    // In-progress lock purchase (negotiated via the spend menu), if any.
    lockDeal: LockDeal | null;
    // In-progress toy rental (negotiated via the spend menu), if any.
    toyDeal: ToyDeal | null;
    // The toy currently placed on a winner's ItemHandheld slot, if any.
    activeToy: ActiveToy | null;
    negotiation: NegotiationState | null;
    // In-progress winner-initiated end game proposal/negotiation, if any.
    endGameProposal: EndGameProposal | null;
    // Agreed, currently-running end game (timer lock + extra locks), if any.
    activeEndGame: ActiveEndGame | null;
    // In-progress lock-time vote, between bondage being applied and the
    // timer/password lock going on, if any.
    endGameLockVote: EndGameLockVote | null;
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
    // In-progress !mercy concession request, if any.
    mercyRequest: MercyRequest | null;
    // Member number -> round number a rejected requester must wait until
    // before they can request mercy again (see handleMercyCommand).
    mercyCooldowns: Map<number, number>;
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
