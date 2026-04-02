# shooters-open

[![Linux.do](https://img.shields.io/badge/Linux.do-community-0EA5E9?logo=discourse&logoColor=white)](https://linux.do)

[Chinese README](./README.md)

An open-source derivative release based on the upstream project [`jay6697117/shooters`](https://github.com/jay6697117/shooters), continuing under the [MIT License](./LICENSE).

This repository keeps the gameplay code, Node.js server, assets, and PVP-related scripts required for further development and deployment, while excluding local tooling, caches, generated output, and historical runtime data.

Thanks to the Linux.do community for the testing, feedback, and discussion support.

## Overview

The current public release includes:

- a 3D arcade shooter frontend served from `index.html`
- a Node.js backend and admin page
- PVP modes including `duel` and `deathmatch`
- spectator, replay, and event-panel related capabilities
- Linux.do login, admin management, and reward / CDK related APIs
- 42 Cup event configuration and leaderboard logic

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
- `npm run test:auth`: verify login / reward dispatch flow
- `npm run test:pvp`: verify PVP core and room flow
- `npm run test:security`: verify regression scenarios around historical rewards

## Environment Variables

See `.env.example` for the canonical list. Main settings include:

- `HOST`, `PORT`, `BASE_URL`: listener and base URL
- `LINUX_DO_CLIENT_ID`, `LINUX_DO_CLIENT_SECRET`, etc.: Linux.do OAuth config
- `ADMIN_LINUX_DO_USERNAMES`: admin usernames
- `ALLOW_CLIENT_REPORTED_AWARDS`: whether client-reported rewards are accepted
- `PVP_EDGE_BASE_URL`, `PVP_EDGE_SHARED_SECRET`, etc.: edge validation and token settings for PVP

## Structure

- `assets/`: game assets
- `src/`: frontend logic
- `server/`: backend logic
- `scripts/`: tests and verification scripts
- `data/`: runtime data directory

Runtime JSON data, `output/`, `node_modules/`, and similar local-only files are excluded via `.gitignore`.

## Attribution

- This project is a derivative release of the upstream repository; please keep upstream attribution intact
- The repository remains under MIT; keep [LICENSE](./LICENSE) in redistributions
- This public release excludes local tooling directories, caches, output directories, and historical runtime data
