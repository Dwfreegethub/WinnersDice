/**
 * bondagePicker.ts — shared bondage-picker constants and catalog loader.
 *
 * The BondagePicker class that used to live here has been removed — WinnersDice
 * implements its own in-deal pick flow (see handleBondageSlotChoice /
 * handleBondageItemChoice in game.ts). What remains are the constants and the
 * catalog loader that game.ts still imports directly.
 *
 * StripDiceBot (which does use the full player-pick flow) keeps its own copy of
 * the BondagePicker class in its own bondagePicker.ts.
 */

import * as fs from "fs";

// ============================================================
// TYPES
// ============================================================

/** Picker-facing slot: a display name mapped to the BC item group it applies to. */
export interface PickSlot {
    display: string;
    group: string;
}

// ============================================================
// CONSTANTS
// ============================================================

// Picker-facing display names mapped to BC item groups.
export const PICK_SLOTS: PickSlot[] = [
    { display: "Arms", group: "ItemArms" },
    { display: "Legs", group: "ItemLegs" },
    { display: "Feet", group: "ItemFeet" },
    { display: "Torso", group: "ItemTorso" },
    { display: "Torso (upper)", group: "ItemTorso2" },
    { display: "Hands", group: "ItemHands" },
    { display: "Head", group: "ItemHead" },
    { display: "Hood", group: "ItemHood" },
    { display: "Neck", group: "ItemNeck" },
    { display: "Mouth", group: "ItemMouth" },
    { display: "Boots", group: "ItemBoots" },
    { display: "Nipples", group: "ItemNipples" },
    { display: "Breast", group: "ItemBreast" },
    { display: "Pelvis", group: "ItemPelvis" },
    { display: "Vulva", group: "ItemVulva" },
    { display: "Clit", group: "ItemVulvaPiercings" },
];

// How many items to show per page in the bondage/toy pick list.
// "M for more" pages through the full catalog in slices of this size.
export const PICK_LIST_TOP_N = 9;

// Recently-added BC items (by asset codename) to spotlight: pinned to the top
// of their slot's pick list with a 🆕 marker regardless of usage, since players
// like trying new gear and a zero-usage item would otherwise never rank. Remove
// a codename once it's no longer "new". Display-only — usage stats untouched.
export const NEW_ITEMS: ReadonlySet<string> = new Set<string>([
    "CybertechMask", // R130 — ItemHood/ItemHead
    "ModularVulvaPiercings", // R130 "Chastity Tunnel Piercings" — ItemVulvaPiercings (verified in-game 2026-07-19)
]);

// ============================================================
// CATALOG LOADER
// ============================================================

// Full BC item catalog (group -> item names). Missing/invalid file returns an
// empty map (disables player-pick bondage mode) rather than crashing the caller.
export function loadBcItemCatalog(itemsPath: string, log: (message: string) => void = () => {}): Map<string, string[]> {
    const catalog = new Map<string, string[]>();
    try {
        const raw = fs.readFileSync(itemsPath, "utf8");
        const data: { group: string; items: string[] }[] = JSON.parse(raw);
        for (const entry of data) {
            if (entry?.group && Array.isArray(entry.items)) {
                catalog.set(entry.group, entry.items);
            }
        }
    } catch (err) {
        log(`WARNING: Could not load ${itemsPath} — player-pick bondage mode disabled: ${err}`);
    }
    return catalog;
}
