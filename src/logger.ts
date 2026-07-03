// The bot's host runs in UTC, but we want log timestamps in US Central
// (UTC-5) instead. This is a fixed offset, not DST-aware.
const CENTRAL_OFFSET_MS = 5 * 60 * 60 * 1000;

function centralNow(): Date {
    return new Date(Date.now() - CENTRAL_OFFSET_MS);
}

// ISO-style timestamp in US Central time, for log files (e.g. feedback.log,
// players.json).
export function centralTimestamp(): string {
    return centralNow().toISOString().replace("Z", "-05:00");
}

// HH:MM:SS in US Central time. Built from the UTC ISO string rather than
// toLocaleTimeString so it isn't double-shifted by the system's local timezone.
function centralTimeString(): string {
    return centralNow().toISOString().substring(11, 19);
}

export function log(msg: string): void {
    console.log(`[${centralTimeString()}] ${msg}`);
}

export function logError(msg: string): void {
    console.error(`[${centralTimeString()}] ERROR: ${msg}`);
}

export function logEvent(event: string, data?: any): void {
    console.log(`[${centralTimeString()}] EVENT: ${event}`, JSON.stringify(data, null, 2));
}
