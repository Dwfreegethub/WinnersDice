import { BCConnection } from "./connection";

// ============================================================
// WinnersDice
// ============================================================
//
// A 2-player push-your-luck dice game built around a point
// economy.
//
// Core concepts (subject to refinement during implementation):
//
// - Point economy: each player has a running point total. Points
//   are earned by rolling and gambled by continuing to roll.
//
// - Push-your-luck rolling: on a player's turn, they repeatedly
//   roll dice. Each successful roll adds to a "round pot" of
//   points at risk. The player chooses to keep rolling (risking
//   the pot) or stop.
//
// - Banking mechanic: a player can "bank" their round pot at any
//   time, moving those points from "at risk" into their permanent
//   total. Banked points are safe; un-banked points in the pot can
//   be lost on a bad roll, ending the turn with nothing gained.
//
// - Round multipliers: consecutive successful rolls within a turn
//   increase a multiplier applied to points added to the pot,
//   rewarding (and increasing the tension of) greedier play.
//
// - Win condition: first player to reach a target point total (or
//   the player with the higher total after a fixed number of
//   rounds) wins.
//
// This file is currently a placeholder. Game state, turn flow,
// and command handlers will be implemented here.
// ============================================================

export class WinnersDiceGame {
    private bot: BCConnection;

    constructor(bot: BCConnection) {
        this.bot = bot;
    }
}
