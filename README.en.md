# 42game-shooters

[![Linux.do](https://img.shields.io/badge/Linux.do-community-0EA5E9?logo=discourse&logoColor=white)](https://linux.do)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-game.42w.shop-22C55E?logo=googlechrome&logoColor=white)](https://game.42w.shop)

[Chinese README](./README.md)

`42game-shooters` is an open-source derivative release based on the upstream project [`jay6697117/shooters`](https://github.com/jay6697117/shooters), continuing under the [MIT License](./LICENSE).

This public repository keeps the gameplay code, Node.js server, admin UI, assets, and PVP-related scripts required for further development and deployment, while excluding local tooling, caches, generated output, historical runtime data, and other non-public material.

Thanks to the Linux.do community for the testing, feedback, and discussion support.

Live demo: <https://game.42w.shop>

## Current Public Feature Set

- 3D arcade shooter web frontend with `index.html` as the main entry
- Node.js backend and admin panel in `admin.html`
- PVE plus online PVP support, with `duel` and `deathmatch`
- room-code join flow, matchmaking, spectating, replay viewing, event panels, and leaderboards
- Linux.do OAuth login, admin management, reward policy controls, and CDK-related APIs
- mobile-browser support with a dedicated touch HUD for movement, camera, firing, reload, dash, weapon switch, and grenades

## Mobile Web Notes

- "Mobile version" currently means the browser-playable web version, not a native app wrapper
- Touch + narrow-screen devices automatically switch into the mobile control layer, while desktop keyboard/mouse flow stays unchanged
- Combat is landscape-first on mobile; portrait combat shows a rotate prompt to preserve visibility
- The mobile HUD is adapted for device safe areas with `env(safe-area-inset-*)`

## Rewards and Public-Release Boundaries

- The default public posture is intentionally conservative, with `ALLOW_CLIENT_REPORTED_AWARDS=false`
- The public build no longer assumes that client-reported match results should automatically trigger reward issuance
- Runtime data, match history, replay artifacts, and similar generated files live under `data/` and are not part of the repository

## Quick Start

1. Prepare a working Node.js environment
2. Create `.env` from `.env.example`
3. Fill in the required environment variables
4. Run:

```bash
node server.mjs
```

Or use:

```bash
npm run dev
```

The default local address is `http://127.0.0.1:4173` as shown in `.env.example`.

On first startup, the server will create the required runtime files under `data/`.

## Common Scripts

- `npm run start`: start the server
- `npm run dev`: start in local development mode
- `npm run test:auth`: verify login and reward dispatch flow
- `npm run test:pvp`: verify PVP core, room flow, and real-time combat behavior
- `npm run test:security`: verify regression scenarios around historical rewards

## Environment Variables

See `.env.example` for the canonical list. Main settings include:

- `HOST`, `PORT`, `BASE_URL`: listener and base URL
- `LINUX_DO_CLIENT_ID`, `LINUX_DO_CLIENT_SECRET`, and related fields: Linux.do OAuth config
- `ADMIN_LINUX_DO_USERNAMES`: admin usernames
- `ALLOW_CLIENT_REPORTED_AWARDS`: whether client-reported reward results are accepted; keeping it disabled is recommended for the public setup
- `PVP_EDGE_BASE_URL`, `PVP_EDGE_SHARED_SECRET`, and related fields: server-side PVP verification and token settings

## Deployment Notes

- Public deployment usually needs a reverse proxy that forwards `/api/*` and WebSocket traffic to the Node service correctly
- `BASE_URL` should match the actual public web origin
- Do not commit `.env`, `data/`, replay files, runtime logs, or any user data into the repository

## Repository Structure

- `index.html`: main game entry
- `admin.html`: admin entry
- `assets/`: game assets
- `src/`: frontend logic
- `server/`: backend logic
- `scripts/`: tests and verification scripts
- `data/`: runtime data directory generated after startup

Runtime JSON data, `data/pvp-replays/`, `output/`, `node_modules/`, and similar local-only files are excluded via `.gitignore`.

## Attribution

- This project is a derivative release of the upstream repository; please keep upstream attribution intact
- The repository remains under MIT; keep [LICENSE](./LICENSE) in redistributions
- This public release excludes local tooling directories, caches, output directories, and historical runtime data
