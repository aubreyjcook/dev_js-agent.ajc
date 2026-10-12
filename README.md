# dev_js-agent.ajc

A Node.js agent that drives this machine's keyboard and mouse, with a separate
layer of scripted *subroutines* on top, driven from the terminal.

## Current target: [`v0_01/`](v0_01/README.md)

Everything lives in `v0_01/`. It is a self-contained package with its own
`package.json` and dependencies, so it can be built, run and versioned on its
own.

```bash
cd v0_01
npm install
npm start          # interactive, dry run — nothing is sent to the real desktop
npm run live       # interactive, real keyboard and mouse
npm test           # behaviour checks
```

See [`v0_01/README.md`](v0_01/README.md) for the architecture, the command set,
the subroutine catalogue, and how to add to either half.

New to TypeScript, or want the reasoning behind the design? Read
[`v0_01/docs/LEARNING-GUIDE.md`](v0_01/docs/LEARNING-GUIDE.md) — a guided tour of
the program and the language features it uses, written for someone learning
TypeScript.
