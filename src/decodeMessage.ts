import { BCChatMessage } from "./types";

/**
 * Extracts the player's original intended message from a BC socket data packet.
 * BCX (BondageClub Extended) injects the original text into data.Dictionary
 * as { Tag: "BCX_ORIGINAL_MESSAGE", Text: "..." } when the player is gagged/stuttering.
 * Falls back to data.Content if not present.
 */
function extractOriginalMessage(data: BCChatMessage): string {
    if (Array.isArray(data.Dictionary)) {
        const entry = data.Dictionary.find(
            (d: any) => d?.Tag === "BCX_ORIGINAL_MESSAGE" && typeof d?.Text === "string"
        );
        if (entry) return entry.Text;
    }
    return data.Content ?? "";
}

/**
 * Strips vanilla BC stutter patterns from a message.
 * e.g. "!r-roll" -> "!roll", "!j-join" -> "!join", "y-yes" -> "yes"
 * Used as a fallback for players without BCX.
 */
function unstutter(msg: string): string {
    return msg.replace(/\b(\w)-\1(\w*)/gi, "$1$2");
}

/**
 * Main export: extracts the original BCX message if available,
 * then runs the stutter-stripper as a fallback for vanilla players.
 */
export function decodeMessage(data: BCChatMessage): string {
    return unstutter(extractOriginalMessage(data));
}
