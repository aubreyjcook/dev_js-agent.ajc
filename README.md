# dev_js-agent.ajc

A Node.js agent that drives this machine's keyboard and mouse, with a separate
layer of scripted *subroutines* on top, driven from the terminal.

## Versions

| Target | What it adds | Docs |
|---|---|---|
| [`v0_02/`](v0_02/README.md) | **current** — daemon mode: one process owns the device, any terminal can send it commands; mode chooser at startup | [README](v0_02/README.md) · [what changed](v0_02/docs/V0_02-CHANGES.md) · [TypeScript tour](v0_02/docs/LEARNING-GUIDE.md) |
| [`v0_01/`](v0_01/README.md) | single process, local terminal only | [README](v0_01/README.md) · [TypeScript tour](v0_01/docs/LEARNING-GUIDE.md) |

Each target is a self-contained package with its own dependencies, so they can be
built, run and versioned independently.

## Quick start

```bash
cd v0_02
npm install
npm start          # asks: standalone, or daemon
npm test           # 45 behaviour checks
```

`npm start` defaults to a dry-run input driver, so nothing reaches your real
desktop until you pass `--live`.

Daemon mode, in short:

```bash
npm run daemon:detach                      # background service
npm start -- --mode attach --exec status   # from any terminal
npm start -- --stop-daemon                 # stop the service
```
