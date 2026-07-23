import { io, Socket } from "socket.io-client";
import { log, logError, logEvent } from "./logger";
import { secrets, botRole } from "./secrets";

const BC_SERVER = "https://bondage-club-server.herokuapp.com/";
const HEARTBEAT_TIMEOUT = 3 * 60 * 1000; // 3 minutes without ServerInfo = assume void

export class BCConnection {
    private socket: Socket;
    private playerNumber: number = 0;
    private friendList: number[] = [];
    private connected: boolean = false;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private onReconnectCallback: (() => void) | null = null;
    private isReconnecting: boolean = false;

    constructor() {
        this.socket = io(BC_SERVER, {
            transports: ["websocket"],
            extraHeaders: {
                "Origin": "https://bondageprojects.elementfx.com"
            },
            reconnection: true,
            reconnectionDelay: 5000,
            reconnectionDelayMax: 30000,
            reconnectionAttempts: Infinity,
        });
    }

    public connect(): Promise<void> {
        return new Promise((resolve, reject) => {

            this.socket.on("connect", () => {
                if (this.isReconnecting) {
                    log("Reconnected to server. Logging back in...");
                } else {
                    log("Socket connected. Logging in...");
                }
                this.socket.emit("AccountLogin", {
                    AccountName: secrets.username,
                    Password: secrets.password,
                });
            });

            this.socket.on("LoginResponse", (data: any) => {
                if (typeof data === "string") {
                    logError(`Login failed: ${data}`);
                    if (!this.isReconnecting) reject(new Error(data));
                    return;
                }
                this.playerNumber = data.MemberNumber;
                this.connected = true;
                this.friendList = Array.isArray(data.FriendList) ? data.FriendList.slice() : [];
                log(`Friend list loaded: ${this.friendList.length} entries.`);

                this.socket.emit("AccountUpdate", {
                    Inventory:      data.Inventory      ?? [],
                    OnlineSettings: data.OnlineSettings ?? {}
                });
                this.socket.emit("AccountUpdate", { Game: data.Game ?? {} });
                this.socket.emit("AccountUpdate", { AssetFamily: "Female3DCG" });

                if (this.isReconnecting) {
                    log(`Re-logged in as #${this.playerNumber}. Rejoining room...`);
                    this.joinRoom();
                    if (this.onReconnectCallback) this.onReconnectCallback();
                    this.isReconnecting = false;
                } else {
                    log(`Logged in successfully! Member #${this.playerNumber}`);
                    log("Initialization sequence sent.");
                    resolve();
                }

                this.resetHeartbeat();
            });

            this.socket.on("ServerInfo", () => {
                this.resetHeartbeat();
            });

            this.socket.on("ChatRoomCreateResponse", (data: any) => {
                if (data === "ChatRoomCreated") {
                    log("Room created successfully!");
                } else if (data === "RoomAlreadyExist") {
                    log("Room already exists, joining instead...");
                    this.socket.emit("ChatRoomJoin", { Name: secrets.roomName });
                } else {
                    logError(`Room creation failed: ${JSON.stringify(data)}`);
                }
            });

            this.socket.on("ChatRoomJoinResponse", (data: any) => {
                if (data === "JoinedRoom" || data === "ok") {
                    log("Joined existing room successfully!");
                } else {
                    logError(`Failed to join room: ${JSON.stringify(data)}`);
                }
            });

            this.socket.on("connect_error", (err: any) => {
                logError(`Connection error: ${err.message}`);
                if (!this.isReconnecting) reject(err);
            });

            this.socket.on("disconnect", (reason: string) => {
                log(`Disconnected: ${reason}`);
                this.connected = false;
                this.isReconnecting = true;
                this.clearHeartbeat();
                if (reason === "io server disconnect") {
                    // Server forced disconnect — manually reconnect
                    this.socket.connect();
                }
                // All other reasons: Socket.IO auto-reconnects
            });

        });
    }

    private resetHeartbeat(): void {
        this.clearHeartbeat();
        this.heartbeatTimer = setTimeout(() => {
            logError("No ServerInfo received in 3 minutes — possible void. Forcing reconnect...");
            this.connected = false;
            this.isReconnecting = true;
            this.socket.disconnect();
            this.socket.connect();
        }, HEARTBEAT_TIMEOUT);
    }

    private clearHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    public onReconnect(callback: () => void): void {
        this.onReconnectCallback = callback;
    }

    public joinRoom(): void {
        this.createRoom(secrets.roomName);
    }

    // Room-bot use (multi-room mode): creates a room under an arbitrary
    // name, e.g. a randomized Private room name (see design_multi_room.md).
    // Found live 2026-07-16: ChatRoomAdmin/Update does NOT rename an
    // existing room (Visibility/Locked updates via configureRoomForMatch
    // do take effect, just not Name) — so a name change has to go through
    // leaveRoom() + createRoom() instead, same as the bot's own startup.
    public createRoom(name: string): void {
        log(`Creating room: ${name}`);
        this.socket.emit("ChatRoomCreate", {
            Name: name,
            Description: "WinnersDice is a high-stakes, two-player dice duel with adult consequences. Challenge someone, negotiate what's on the line -rounds, stripping, bondage, toys, maybe more- then roll.",
            Background: "NightClub",
            Space: "X",
            Game: "",
            Admin: [this.playerNumber, ...secrets.adminMemberNumbers],
            Ban: [],
            Limit: secrets.roomLimit,
            BlockCategory: [],
            Language: "EN",
            // The lobby bot (main) needs a publicly-listed room so players can
            // actually find and join it to challenge each other. Room bots
            // (gamebot1+) create hidden rooms — theirs get reconfigured per
            // match by configureRoomForMatch (spectator=public, private=hidden).
            Visibility: botRole === "main" ? ["All"] : ["Admin"],
            Access: ["All"],
        });
    }

    // Room-bot use: leaves the current room, e.g. right before createRoom()
    // with a different name. Payload/response handling is unverified —
    // ChatRoomLeave is confirmed to exist as a real BC event (seen used by
    // a separate community bot framework, bondage-club-bot-hub-master) but
    // this bot has never called it before. Needs a live test.
    public leaveRoom(): void {
        this.socket.emit("ChatRoomLeave");
    }

    public makeRoomPrivate(): void {
        this.socket.emit("ChatRoomAdmin", {
            MemberNumber: this.playerNumber,
            Action: "Update",
            Room: {
                Name: secrets.roomName,
                Description: "WinnersDice is a high-stakes, two-player dice duel with adult consequences. Challenge someone, negotiate what's on the line -rounds, stripping, bondage, toys, maybe more- then roll.",
                Background: "NightClub",
                Space: "X",
                Game: "",
                Admin: [this.playerNumber, ...secrets.adminMemberNumbers],
                Ban: [],
                Limit: secrets.roomLimit,
                BlockCategory: [],
                Language: "EN",
                Visibility: ["Admin"],
                Access: ["All"],
            },
        });
    }

    // Room-bot use (multi-room mode — see design_multi_room.md): reconfigures
    // the room's name/visibility/lock for a claimed match, or back to its
    // default idle state between matches. Visibility ["All"] = listed/public
    // (Spectator); ["Admin"] = hidden from browse/search (Private, Locked) —
    // confirmed by this bot's own existing joinRoom()/makeRoomPrivate() usage.
    // The `Locked` field itself is NOT verified against WinnersDice/StripDiceBot's
    // own history — it's inferred from a separate community bot framework
    // (bondage-club-bot-hub-master) that sends the same Room shape with a
    // Locked boolean alongside Name/Admin/Limit/etc. Needs a live test.
    public configureRoomForMatch(opts: { name: string; visibility: "public" | "hidden"; locked: boolean }): void {
        this.socket.emit("ChatRoomAdmin", {
            MemberNumber: this.playerNumber,
            Action: "Update",
            Room: {
                Name: opts.name,
                Description: "WinnersDice is a high-stakes, two-player dice duel with adult consequences. Challenge someone, negotiate what's on the line -rounds, stripping, bondage, toys, maybe more- then roll.",
                Background: "NightClub",
                Space: "X",
                Game: "",
                Admin: [this.playerNumber, ...secrets.adminMemberNumbers],
                Ban: [],
                Limit: secrets.roomLimit,
                BlockCategory: [],
                Language: "EN",
                Visibility: opts.visibility === "public" ? ["All"] : ["Admin"],
                Access: ["All"],
                Locked: opts.locked,
            },
        });
    }

    public sendChat(message: string): void {
        this.socket.emit("ChatRoomChat", {
            Type: "Chat",
            Content: message,
            Dictionary: [],
        });
    }

    public whisper(targetNumber: number, message: string): void {
        this.socket.emit("ChatRoomChat", {
            Type: "Whisper",
            Content: message,
            Target: targetNumber,
            Dictionary: [],
        });
    }

    public applyItem(targetNumber: number, group: string, name: string, color: string | string[], property: any): void {
        this.socket.emit("ChatRoomCharacterItemUpdate", {
            Target: targetNumber,
            Group: group,
            Name: name,
            Color: color,
            Difficulty: 2,
            Property: property
        });
    }

    public moveLeft(): void {
        this.socket.emit("ChatRoomAdmin", {
            MemberNumber: this.playerNumber,
            Action: "MoveLeft",
        });
    }

    public removeItem(targetNumber: number, group: string): void {
        this.socket.emit("ChatRoomCharacterItemUpdate", {
            Target: targetNumber,
            Group: group,
            Name: null,
            Color: null,
            Difficulty: 0,
            Property: {}
        });
    }

    public listenAll(): void {
        const events = [
            "ChatRoomSync",
            "ChatRoomSyncMemberJoin",
            "ChatRoomSyncMemberLeave",
            "ChatRoomMessage",
            "ChatRoomSyncItem",
            "ChatRoomSyncSingle",
            "AccountBeep",
        ];
        events.forEach(event => {
            this.socket.on(event, (data: any) => {
                logEvent(event, data);
            });
        });
    }

    public onMessage(handler: (data: any) => void): void {
        this.socket.on("ChatRoomMessage", handler);
    }

    public onRoomSync(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSync", handler);
    }

    public onItemChange(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncItem", handler);
    }

    public onSyncSingle(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncSingle", handler);
    }

    public onMemberJoin(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncMemberJoin", handler);
    }

    public onMemberLeave(handler: (data: any) => void): void {
        this.socket.on("ChatRoomSyncMemberLeave", handler);
    }

    public getMemberNumber(): number {
        return this.playerNumber;
    }

    public isFriend(memberNumber: number): boolean {
        return this.friendList.includes(memberNumber);
    }

    public getFriendCount(): number {
        return this.friendList.length;
    }

    // BC's friend list is mutual-gated: a player only sees the bot if the bot
    // lists them back. The server takes FriendList as a whole-array replace,
    // so the full list goes out every time. It is persisted server-side and
    // returned on the next login. Note this room idles at Visibility ["Admin"],
    // so friends see only that the bot is online — the server withholds the
    // room name and headcount for restricted rooms unless a match has been
    // configured public via configureRoomForMatch.
    public addFriend(memberNumber: number): boolean {
        if (!memberNumber || this.friendList.includes(memberNumber)) return false;
        this.friendList.push(memberNumber);
        this.socket.emit("AccountUpdate", { FriendList: this.friendList });
        log(`Friended #${memberNumber} (${this.friendList.length} total).`);
        return true;
    }

    public removeFriend(memberNumber: number): boolean {
        const index = this.friendList.indexOf(memberNumber);
        if (index < 0) return false;
        this.friendList.splice(index, 1);
        this.socket.emit("AccountUpdate", { FriendList: this.friendList });
        log(`Unfriended #${memberNumber} (${this.friendList.length} total).`);
        return true;
    }

    public isConnected(): boolean {
        return this.connected;
    }
}
