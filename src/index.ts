import * as fs from "fs";
import * as path from "path";
import { BCConnection } from "./connection";
import { WinnersDiceGame } from "./game";
import { log, logError } from "./logger";
import { decodeMessage } from "./decodeMessage";
import { Player, BCChatMessage, BCRoomSync, BCMemberEvent } from "./types";
import { botRole, secrets } from "./secrets";

process.on('uncaughtException', (err) => {
    console.error('[CRASH] Uncaught exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[CRASH] Unhandled rejection:', reason);
    process.exit(1);
});

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
    log(`BOT_ROLE=${botRole}`);
    if (!secrets.username || !secrets.password) {
        logError(`No credentials configured for BOT_ROLE=${botRole} in secrets.ts. Refusing to start.`);
        process.exit(1);
    }

    const pendingUpdatePath = path.join(__dirname, "..", "pending_update.txt");
    let updateNote: string | null = null;
    if (fs.existsSync(pendingUpdatePath)) {
        try {
            updateNote = fs.readFileSync(pendingUpdatePath, "utf8").trim();
        } catch {
            updateNote = "";
        }
        fs.unlinkSync(pendingUpdatePath);
        log(`Removed pending_update.txt from previous restart (note: "${updateNote}").`);
    }
    let restartAnnounced = false;

    log("WinnersDice starting...");

    const bot = new BCConnection();
    const game = new WinnersDiceGame(bot, roomMembers);

    bot.onMessage((data: BCChatMessage) => {
        log(`MSG [${data.Type}] from ${data.Sender}: ${data.Content}`);

        const memberNumber: number = data.Sender;
        const name = getNameFor(memberNumber);

        // BC delivers a safeword as an Action message, not a dedicated event.
        if (data.Type === "Action" &&
            (data.Content === "ActionActivateSafewordRevert" ||
                data.Content === "ActionActivateSafewordReleaseAll")) {
            log(`Safeword detected from ${name} (#${memberNumber}): ${data.Content}`);
            game.handleSafewordUsed(memberNumber);
            return;
        }

        if (data.Type === "Whisper") {
            const msg = stripOOC(decodeMessage(data));
            log(`Whisper from ${name} (#${memberNumber}): ${msg}`);
            game.handleChatMessage(memberNumber, msg, true);
        }

        if (data.Type === "Chat") {
            const msg = stripOOC(decodeMessage(data));
            game.handleChatMessage(memberNumber, msg, false);
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

        game.onRoomSync(data.Character ?? []);

        if (data.Visibility?.includes("All")) {
            log("Room is publicly listed, updating room settings to make it private...");
            bot.makeRoomPrivate();
        }

        const myIndex = (data.Character ?? []).findIndex((c) => c.MemberNumber === bot.getMemberNumber());
        if (myIndex > 0) {
            log(`Bot is at position ${myIndex} — moving to the leftmost spot...`);
            for (let i = 0; i < myIndex; i++) {
                bot.moveLeft();
            }
        }

        bot.sendChat("WinnersDice is online!");

        if (!restartAnnounced) {
            restartAnnounced = true;
            if (updateNote !== null) {
                bot.sendChat(updateNote
                    ? `WinnersDice is back with updates! ${updateNote}`
                    : `WinnersDice is back with updates!`);
            } else {
                bot.sendChat("Sorry for the interruption — WinnersDice is back!");
            }
        }
    });

    bot.onMemberJoin((data: BCMemberEvent) => {
        const memberNumber = data.SourceMemberNumber;
        const name = data.Character?.Nickname || data.Character?.Name || `Player #${memberNumber}`;
        log(`${name} (#${memberNumber}) joined the room.`);
        roomMembers.set(memberNumber, { memberNumber, name });
        game.onMemberJoin(memberNumber, name, data.Character);
    });

    bot.onMemberLeave((data: BCMemberEvent) => {
        const memberNumber = data.SourceMemberNumber;
        log(`Member #${memberNumber} left the room.`);
        roomMembers.delete(memberNumber);
        game.onMemberLeave(memberNumber);
    });

    bot.onSyncSingle((data: any) => {
        game.onSyncSingle(data);
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
