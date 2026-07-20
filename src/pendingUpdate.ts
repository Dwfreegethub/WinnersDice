import * as fs from "fs";
import * as path from "path";

const PENDING_UPDATE_PATH = path.join(__dirname, "..", "pending_update.txt");

export interface PendingUpdate {
    version: string;
    /** One-line summary. This is the only part announced in room chat. */
    headline: string;
    /** Optional longer explanation, shown only through !changelog. */
    detail: string;
    /** False suppresses the room announcement entirely; !changelog still lists it. */
    major: boolean;
    /** headline + detail joined — what !changelog prints for this entry. */
    note: string;
}

// pending_update.txt is never deleted — it's overwritten with a new version
// each time there's a real update.
//
//   line 1  version stamp (a timestamp), optionally suffixed " | minor"
//   line 2  headline — the only line that gets announced in room chat
//   line 3+ optional detail — whispered by !changelog, never posted in room
//
// Marking an update "minor" skips the room announcement; players who were away
// still get nudged to run !changelog on their next visit. Older two-part files
// (version + one blob of text) still parse: the whole blob becomes the
// headline and detail stays empty.
export function readPendingUpdate(): PendingUpdate | null {
    let raw: string;
    try {
        raw = fs.readFileSync(PENDING_UPDATE_PATH, "utf8");
    } catch {
        return null;
    }
    const lines = raw.split("\n");
    const versionLine = (lines[0] ?? "").trim();
    if (!versionLine) return null;

    const [stamp, ...markers] = versionLine.split("|").map(part => part.trim());
    if (!stamp) return null;
    const major = !markers.some(m => m.toLowerCase() === "minor");

    const body = lines.slice(1).map(line => line.trim()).filter(line => line.length > 0);
    const headline = body[0] ?? "";
    const detail = body.slice(1).join("\n");

    return {
        version: stamp,
        headline,
        detail,
        major,
        note: [headline, detail].filter(Boolean).join("\n"),
    };
}

function seenVersionPath(role: string): string {
    return path.join(__dirname, "..", `pending_update_seen_${role}.txt`);
}

// The last update version this process (identified by role, since the lobby
// and room bots share this same directory) has already restarted for. Since
// pending_update.txt is never deleted, both bots can independently notice a
// new version whenever they next check — whichever restarts first no longer
// erases the signal for the other one.
export function getSeenVersion(role: string): string | null {
    try {
        return fs.readFileSync(seenVersionPath(role), "utf8").trim() || null;
    } catch {
        return null;
    }
}

export function markVersionSeen(role: string, version: string): void {
    try {
        fs.writeFileSync(seenVersionPath(role), version, "utf8");
    } catch {
        // Best effort — worst case this role re-announces the same update once more.
    }
}
