// ============================================================
// MULTI-ROOM HANDOFF QUEUE
// ============================================================
// See design_multi_room.md. All coordination between the lobby bot and
// room bots happens through handoffs/{pending,claimed,results}/ — no
// shared in-memory state, no direct inter-process calls. handoffs/ is
// gitignored (runtime data, like players.json).

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { log, logError } from "./logger";
import { HandoffEntry, MatchResultEntry } from "./types";

const HANDOFF_ROOT = path.join(__dirname, "..", "handoffs");
const PENDING_DIR = path.join(HANDOFF_ROOT, "pending");
const CLAIMED_DIR = path.join(HANDOFF_ROOT, "claimed");
const RESULTS_DIR = path.join(HANDOFF_ROOT, "results");
const RESULTS_PROCESSED_DIR = path.join(RESULTS_DIR, "processed");

const HANDOFF_EXPIRY_MS = 5 * 60 * 1000;

export function ensureHandoffDirs(): void {
    for (const dir of [PENDING_DIR, CLAIMED_DIR, RESULTS_DIR, RESULTS_PROCESSED_DIR]) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Called by the lobby bot at the end of finishNegotiation() instead of
// starting the match itself. Writes to handoffs/pending/ for a room bot to claim.
export function writeHandoff(entry: Omit<HandoffEntry, "id" | "createdAt" | "expiresAt">): HandoffEntry {
    ensureHandoffDirs();
    const now = Date.now();
    const full: HandoffEntry = {
        ...entry,
        id: crypto.randomUUID(),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + HANDOFF_EXPIRY_MS).toISOString(),
    };
    fs.writeFileSync(path.join(PENDING_DIR, `${full.id}.json`), JSON.stringify(full, null, 2), "utf8");
    log(`[Handoff] Wrote ${full.id} to pending/ (${full.players.challenger.name} vs ${full.players.opponent.name}).`);
    return full;
}

// Unexpired pending handoffs, oldest first. A room bot polls this and
// attempts claimHandoff() on whichever it wants to take.
export function listPendingHandoffs(): HandoffEntry[] {
    ensureHandoffDirs();
    const now = Date.now();
    const entries: HandoffEntry[] = [];
    for (const file of fs.readdirSync(PENDING_DIR)) {
        if (!file.endsWith(".json")) continue;
        try {
            const entry: HandoffEntry = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, file), "utf8"));
            if (new Date(entry.expiresAt).getTime() < now) continue; // expired — left for the lobby bot to reap
            entries.push(entry);
        } catch (err) {
            logError(`[Handoff] Failed to read pending handoff ${file}: ${err}`);
        }
    }
    entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return entries;
}

// Atomically claims a pending handoff via rename into claimed/. Returns the
// claimed entry (with claimedBy set) on success, or null if another bot won
// the race (the source file is already gone by the time rename runs).
export function claimHandoff(entry: HandoffEntry, botRole: string): HandoffEntry | null {
    const fromPath = path.join(PENDING_DIR, `${entry.id}.json`);
    const toPath = path.join(CLAIMED_DIR, `${entry.id}.json`);
    try {
        fs.renameSync(fromPath, toPath);
    } catch {
        return null;
    }
    const claimed: HandoffEntry = { ...entry, claimedBy: botRole };
    fs.writeFileSync(toPath, JSON.stringify(claimed, null, 2), "utf8");
    log(`[Handoff] ${botRole} claimed ${entry.id} (${entry.players.challenger.name} vs ${entry.players.opponent.name}).`);
    return claimed;
}

// Called by a room bot at match end. Writes the outcome to handoffs/results/
// and removes the now-finished claimed file.
export function writeResult(result: MatchResultEntry): void {
    ensureHandoffDirs();
    fs.writeFileSync(path.join(RESULTS_DIR, `${result.handoffId}.json`), JSON.stringify(result, null, 2), "utf8");
    try {
        fs.unlinkSync(path.join(CLAIMED_DIR, `${result.handoffId}.json`));
    } catch {
        // already gone — fine
    }
    log(`[Handoff] Wrote result for ${result.handoffId} (winner #${result.winner}).`);
}

// Unprocessed match results, oldest first. The lobby bot polls this,
// applies each to players.json/pair_balances.json, then calls markResultProcessed().
export function listPendingResults(): MatchResultEntry[] {
    ensureHandoffDirs();
    const entries: MatchResultEntry[] = [];
    for (const file of fs.readdirSync(RESULTS_DIR)) {
        const filePath = path.join(RESULTS_DIR, file);
        if (!file.endsWith(".json") || fs.statSync(filePath).isDirectory()) continue;
        try {
            entries.push(JSON.parse(fs.readFileSync(filePath, "utf8")));
        } catch (err) {
            logError(`[Handoff] Failed to read result ${file}: ${err}`);
        }
    }
    entries.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
    return entries;
}

export function markResultProcessed(handoffId: string): void {
    try {
        fs.renameSync(path.join(RESULTS_DIR, `${handoffId}.json`), path.join(RESULTS_PROCESSED_DIR, `${handoffId}.json`));
    } catch (err) {
        logError(`[Handoff] Failed to move processed result ${handoffId}: ${err}`);
    }
}
