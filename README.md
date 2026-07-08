# WinnersDice

A Bondage Club bot for **WinnersDice** — a 2-player push-your-luck dice game
built around a point economy, a banking mechanic, and round multipliers.

This project is separate from StripDiceBot. It currently contains only the
infrastructure layer (Bondage Club socket connection, login, room creation/join,
reconnect handling, and basic player tracking). Game logic lives in
[`src/game.ts`](src/game.ts) and is not yet implemented.

## Setup

1. `npm install`
2. Create `src/secrets.ts` (gitignored) with your bot account credentials:
   ```ts
   export const secrets = {
       username: "YourBotUsername",
       password: "YourBotPassword",
       roomName: "Winners Dice Game",
       adminMemberNumbers: [208543],
   };
   ```
3. `npm run build`
4. `npm start` (or use `run.ps1` for an auto-restarting wrapper)
