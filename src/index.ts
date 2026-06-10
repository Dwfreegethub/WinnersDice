import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { WinnersDiceGame } from "./game";
import { log, logError } from "./logger";
import { Player, BCChatMessage, BCRoomSync, BCMemberEvent } from "./types";

// Tracks everyone currently in the room, by member number.
const roomMembers: Map<number, Player> = new Map();

function getNameFor(memberNumber: number): string {
    return roomMembers.get(memberNumber)?.name ?? `Player #${memberNumber}`;
}

// Strip OOC wrappers: (!command) or [!command] -> !command
function stripOOC(msg: string): string {
    return msg.trim().replace(/^[\(\[]\s*(.*?)\s*[\)\]]$/, '$1');
}

async function main() {
    const pendingUpdatePath = path.join(__dirname, "..", "pending_update.txt");
    if (fs.existsSync(pendingUpdatePath)) {
        fs.unlinkSync(pendingUpdatePath);
        log("Removed leftover pending_update.txt from previous restart.");
    }

    log("WinnersDice starting...");

    const bot = new BCConnection();
    const game = new WinnersDiceGame(bot);

    bot.onMessage((data: BCChatMessage) => {
        log(`MSG [${data.Type}] from ${data.Sender}: ${data.Content}`);

        const memberNumber: number = data.Sender;
        const name = getNameFor(memberNumber);

        if (data.Type === "Whisper") {
            const msg = stripOOC(data.Content);
            log(`Whisper from ${name} (#${memberNumber}): ${msg}`);
            // TODO: dispatch to game whisper command handler
        }

        if (data.Type === "Chat") {
            const msg = stripOOC(data.Content);
            // TODO: dispatch to game chat command handler
        }
    });

    bot.onRoomSync((data: BCRoomSync) => {
        log(`Room synced. Players in room: ${data.Character?.length ?? 0}`);

        roomMembers.clear();
        for (const char of data.Character ?? []) {
            if (char.MemberNumber !== undefined) {
                roomMembers.set(char.MemberNumber, {
                    memberNumber: char.MemberNumber,
                    name: char.Nickname || char.Name || `Player #${char.MemberNumber}`,
                });
            }
        }

        if (data.Visibility?.[0] !== "All" || data.Private) {
            log("Room is not public, updating room settings to make it public...");
            bot.makeRoomPublic();
        }

        bot.sendChat("WinnersDice is online!");
    });

    bot.onMemberJoin((data: BCMemberEvent) => {
        const memberNumber = data.SourceMemberNumber;
        const name = data.Character?.Nickname || data.Character?.Name || `Player #${memberNumber}`;
        log(`${name} (#${memberNumber}) joined the room.`);
        roomMembers.set(memberNumber, { memberNumber, name });
        bot.sendChat(`Welcome to WinnersDice, ${name}!`);
    });

    bot.onMemberLeave((data: BCMemberEvent) => {
        const memberNumber = data.SourceMemberNumber;
        log(`Member #${memberNumber} left the room.`);
        roomMembers.delete(memberNumber);
    });

    bot.onReconnect(() => {
        log("Reconnect complete. Re-announcing bot...");
        bot.sendChat("WinnersDice reconnected!");
    });

    bot.listenAll();

    try {
        await bot.connect();
        bot.joinRoom();
    } catch (err: any) {
        logError(`Failed to start: ${err.message}`);
        process.exit(1);
    }
}

main();
