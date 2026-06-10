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
