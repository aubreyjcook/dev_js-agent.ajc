# dev_js-agent.ajc

A Node.js agent that drives this machine's keyboard and mouse, with a separate
layer of scripted *subroutines* on top, driven from the terminal.

## Versions

| Target | What it adds |
|---|---|
| [`v0_02/`](v0_02/README.md) | **current** — daemon mode: one process owns the device, any terminal can send it commands; a mode chooser at startup |
| [`v0_01/`](v0_01/README.md) | single process, local terminal only |

Each target is a self-contained package with its own dependencies, so they can be
built, run and versioned independently.

## Documentation map

Every version carries the same set of documents:

| Document | Answers |
|---|---|
| `README.md` | what it is, and how do I start it? |
| `docs/OVERVIEW.md` | how is it put together, and where do I read? |
| `docs/USER-GUIDE.md` | how do I use it, and what do I do when it misbehaves? |
| `docs/LEARNING-GUIDE.md` | why is it written this way? (a TypeScript tour) |
| `docs/V0_0X-CHANGES.md` | what changed in this version, and why? |
| `docs/ROADMAP.md` | what comes next, with acceptance criteria |

Direct links:

- **v0_02** — [README](v0_02/README.md) · [overview](v0_02/docs/OVERVIEW.md) ·
  [user guide](v0_02/docs/USER-GUIDE.md) ·
  [what changed](v0_02/docs/V0_02-CHANGES.md) ·
  [learning guide](v0_02/docs/LEARNING-GUIDE.md) ·
  [roadmap](v0_02/docs/ROADMAP.md)
- **v0_01** — [README](v0_01/README.md) · [overview](v0_01/docs/OVERVIEW.md) ·
  [user guide](v0_01/docs/USER-GUIDE.md) ·
  [what's in v0_01](v0_01/docs/V0_01-CHANGES.md) ·
  [learning guide](v0_01/docs/LEARNING-GUIDE.md) ·
  [roadmap](v0_01/docs/ROADMAP.md)

## Quick start

```bash
cd v0_02
npm install
npm start          # asks: standalone, or daemon
npm test           # 45 behaviour checks
```

Requires **Node 20+**. If you use nvm and the default is older, run `nvm use 24`
first; both check suites exit with a clear message instead of failing inside the
toolchain.

`npm start` defaults to a dry-run input driver, so nothing reaches your real
desktop until you pass `--live`.

Daemon mode, in short:

```bash
npm run daemon:detach                      # background service
npm start -- --mode attach --exec status   # from any terminal
npm start -- --stop-daemon                 # stop the service
```

## Working on this repository

- `agent-instructions.md` (local, git-ignored) records the project’s working
  brief: documentation standards, per-version change notes, roadmaps.
- Each version directory is a standalone npm package; install and test inside it.
- Both suites are behavioural, run in dry-run mode, and use only Node — no test
  framework to install.
