import { io, Socket } from "socket.io-client";
import { log, logError, logEvent } from "./logger";
import { secrets } from "./secrets";

const BC_SERVER = "https://bondage-club-server.herokuapp.com/";
const HEARTBEAT_TIMEOUT = 3 * 60 * 1000; // 3 minutes without ServerInfo = assume void

export class BCConnection {
    private socket: Socket;
    private playerNumber: number = 0;
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
        log(`Creating room: ${secrets.roomName}`);
        this.socket.emit("ChatRoomCreate", {
            Name: secrets.roomName,
            Description: "A WinnersDice game room - type !join to play!",
            Background: "NightClub",
            Space: "X",
            Game: "",
            Admin: [this.playerNumber, ...secrets.adminMemberNumbers],
            Ban: [],
            Limit: 10,
            BlockCategory: [],
            Language: "EN",
            Visibility: ["Admin"],
            Access: ["All"],
        });
    }

    public makeRoomPrivate(): void {
        this.socket.emit("ChatRoomAdmin", {
            MemberNumber: this.playerNumber,
            Action: "Update",
            Room: {
                Name: secrets.roomName,
                Description: "A WinnersDice game room - type !join to play!",
                Background: "NightClub",
                Space: "X",
                Game: "",
                Admin: [this.playerNumber, ...secrets.adminMemberNumbers],
                Ban: [],
                Limit: 10,
                BlockCategory: [],
                Language: "EN",
                Visibility: ["Admin"],
                Access: ["All"],
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
            "ChatRoomSyncCharacter",
            "ChatRoomSyncExpression",
            "ServerInfo",
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

    public isConnected(): boolean {
        return this.connected;
    }
}
