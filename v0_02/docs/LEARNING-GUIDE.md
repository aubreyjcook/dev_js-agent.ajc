# Learning guide: how `v0_01` works, and the TypeScript it uses

> **This guide was written for v0_01 and is kept because most of it still
> describes v0_02 exactly.**
>
> Unchanged and still accurate: the contract, the agent core, both input drivers,
> the task registry, cancellation, the subroutine layer, and the async patterns.
>
> Superseded by v0_02: **section 11 (the terminal)**, because `TerminalSession`
> was split into a `CommandBroker` plus local and remote front ends. Read
> [`V0_02-CHANGES.md`](V0_02-CHANGES.md) for that, for the daemon, and for the
> new protocol, discovery and lifecycle code.
>
> Where the two documents disagree, `V0_02-CHANGES.md` is correct.

This document is for someone who can read JavaScript and wants to learn
TypeScript by studying a real program. It explains what each part of `js-agent`
does, why it is shaped that way, and which TypeScript features are doing the
work.

It is not a reference manual. It is a guided tour. Read it with the code open
beside you.

**How to read this document**

- Section 1–3 set up the mental model. Read them in order.
- Sections 4–10 walk the code bottom-up: types first, then behaviour, then the
  front end. Each section names the files it covers.
- Section 11 is a TypeScript feature reference. Dip into it whenever a feature
  in an earlier section is unfamiliar.
- Section 12 onward covers async and testing patterns, then how to extend the
  program, then a debugging playbook and the Windows caveats.

Code references look like [`press-key.ts:36`](../src/subroutines/builtin/press-key.ts#L36) —
that is the file, then the line.

---

## 1. What the program is

`js-agent` drives your computer's keyboard and mouse, and lets you script that
driving from a terminal prompt.

```
$ npm start
  js-agent 0.1.0 · target 0.01
  input driver   recorder (dry run — nothing is sent)
  ...
js-agent> move-mouse 400 300
[sub-1] move-mouse: running · moving to 400,300
[sub-1] move-mouse: completed · cursor at 400,300
js-agent> list
Running subroutines: none
js-agent> stop
Nothing is running.
js-agent> exit
```

Two separate concerns live inside it:

| Concern | What it means | Folder |
|---|---|---|
| **The agent core** | Send keystrokes and mouse events to the OS. Track what is running. | `src/core/` |
| **Subroutines** | Named, scripted behaviours built from those primitives. | `src/subroutines/` |

The interesting part of this program is not the mouse-moving. It is *how those
two concerns are kept apart*, because that is the part you will reuse in every
codebase you ever work on.

---

## 2. Getting it running

```bash
cd v0_01
npm install
npm run check      # tsc --noEmit — type-check only, no files written
npm test           # 28 behaviour checks (v0_01's suite; v0_02 has 45)
npm start          # interactive, dry run (nothing reaches your real desktop)
npm run live       # interactive, real keyboard and mouse
```

### What each dependency is for

Look at [`package.json`](../package.json):

- **`@nut-tree-fork/nut-js`** — the native library that actually presses keys
  and moves the cursor. It ships prebuilt binaries, so `npm install` does not
  need a C++ compiler.
- **`tsx`** — runs `.ts` files directly in Node by stripping types on the fly.
- **`typescript`** — provides `tsc`, the type checker.
- **`@types/node`** — the type definitions for Node itself: `process`,
  `setTimeout`, `node:fs`, and so on. Without it, TypeScript would not know what
  `process.platform` is.

### The honest note about `tsx`

`tsx` is a *development* convenience. It uses `esbuild` under the hood, which
does **not** type-check — it only strips types and runs the code. That is why
`npm run check` exists as a separate command. This split is normal in
TypeScript projects and worth internalising:

> **Running TypeScript and checking TypeScript are two different jobs.**
> `tsx` (or `ts-node`, or a bundler) runs it. `tsc --noEmit` checks it. A green
> run tells you nothing about whether the types are sound.

---

## 3. The toolchain, explained

### [`tsconfig.json`](../tsconfig.json) line by line

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",              // what JavaScript version to emit
    "lib": ["ES2023"],               // which built-in APIs exist to type against
    "module": "NodeNext",            // the module system of the OUTPUT
    "moduleResolution": "NodeNext",  // how `import` specifiers are resolved
    "types": ["node"],               // pull in @types/node globally
```

`target` and `lib` are separate on purpose. `target` says "what syntax may I
emit", `lib` says "what global types exist". We emit modern JavaScript (Node 20+
is required) and type against ES2023 built-ins.

`module`/`moduleResolution: NodeNext` means *use Node's real ESM rules*. In
practice this is what makes the `.js` extension in import paths mandatory — see
the next subsection.

```jsonc
    "strict": true,
```

This is not one flag. It turns on a family of checks, the most important being:

- `strictNullChecks` — `null` and `undefined` are not assignable to everything.
  This is the single biggest source of safety in TypeScript, and the single
  biggest difference from JavaScript.
- `noImplicitAny` — a value with no inferable type is an error, not silently
  `any`.
- `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`,
  `alwaysStrict`, and friends.

Every flag below is *extra* strictness on top of `strict`:

```jsonc
    "noUncheckedIndexedAccess": true,
```

Indexing an array or record yields `T | undefined`. So `chord[0]` has type
`string | undefined`, not `string`. It forces you to handle the empty case. You
will see this bite — and get handled — in
[`registry.ts`](../src/subroutines/registry.ts) wherever an argument is read
by position.

```jsonc
    "noImplicitOverride": true,
```

If a subclass method overrides a base method, it must say `override`. There are
no subclasses in this codebase today, so this flag is future-proofing.

```jsonc
    "noUnusedLocals": true,
    "noUnusedParameters": true,
```

An unused variable or parameter is a compile error. Annoying at first; excellent
at keeping dead code out. During development I had to delete several helpers
that had become unreachable, and this flag is why.

```jsonc
    "verbatimModuleSyntax": true,
```

Type-only imports must be written `import type { Foo } from '…'`. This matters
because the output of a TypeScript compile should not contain a runtime `import`
of something that only existed as a type — with `verbatimModuleSyntax` you are
forced to be explicit, and the emitted JavaScript is exactly what you wrote. It
is also what makes Node's native type-stripping viable, since nothing has to be
inferred away.

```jsonc
    "isolatedModules": true,
```

Guarantees each file can be transpiled *independently*, without looking at other
files. Bundlers and type-strippers need this. It rules out a few
cross-file-only constructs (like re-exporting a type without saying `type`).

```jsonc
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"],
```

`skipLibCheck` skips type-checking inside `node_modules` — faster, and it stops
third-party type bugs from failing your build. `noEmit` means `tsc` is a pure
checker here; `tsx` does the running. `include` is the file set: everything
under `src`.

### Why imports say `.js` but the files are `.ts`

You will see this everywhere:

```ts
import { Agent } from '../core/agent.js';   // ← .js, but the file is agent.ts
```

This looks wrong. It is correct, and the reason is worth understanding because
it confuses almost everyone:

1. Node's ESM resolver requires an explicit file extension. `import './agent'`
   does not work in Node ESM; you must write `./agent.js`.
2. Node does not know or care that TypeScript exists. It will look for a file
   literally named `agent.js`.
3. TypeScript's job is to be a *superset* of JavaScript: whatever you write must
   work after compilation. So when you write `./agent.js`, TypeScript's
   `NodeNext` resolution mode says "the developer means the **output** file
   `agent.js`, so the **input** file must be `agent.ts`", and resolves it to the
   `.ts` source.

So the `.js` extension describes the module *as it will exist at runtime*, which
is the only thing Node can be told about. `tsx` and Node's own type-stripping
both follow the same rule.

> **A mistake I actually made while writing this**, worth learning from: in
> `src/app.ts`, which sits at the top of `src/`, I wrote the import for the
> contract folder as `'../contract/index.js'`. That path resolves to
> `v0_01/contract/index.js` — one level *above* `src/` — because `..` from
> `src/` is the package root, not `src/`. The correct specifier was
> `'./contract/index.js'`. The error message was `Cannot find module
> '../contract/index.js'`, and I initially misread the compiler's resolution
> trace as a TypeScript bug. It was not. **Read the trace: it prints the exact
> candidate path it tried.** That path is almost always enough to spot the
> mistake.

### `npm run live` versus `npm start`

`npm start` selects a *recording* input device: it validates every request,
records it, and sends nothing to the operating system. `npm run live` selects
the real one. This is a design decision, not a testing hack — it means the whole
program can be exercised without hijacking your keyboard. How it works is the
subject of section 6.

---

## 4. The core design idea: dependency direction

Before any syntax, understand the shape. Here is the whole architecture:

```
                     ┌───────────────────────────┐
                     │  src/terminal/            │  the prompt: reads a line,
                     │  session, commands, banner│  runs a command, prints
                     └─────────┬─────────────────┘
                               │ uses both halves
              ┌────────────────┴────────────────┐
              ▼                                 ▼
   ┌────────────────────┐            ┌──────────────────────┐
   │  src/core/         │            │  src/subroutines/    │
   │  Agent, drivers,   │◄───────────│  registry + built-ins│
   │  TaskRegistry      │  AgentApi  │                      │
   └─────────┬──────────┘ (interface)└──────────┬───────────┘
             │                                  │
             └──────────────┬───────────────────┘
                            ▼
                 ┌─────────────────────┐
                 │  src/contract/      │   types only. no code.
                 │  the "seam"         │
                 └─────────────────────┘
```

Three rules define the design:

1. **`core/` and `subroutines/` never import each other.**
   Grep for it and you will find nothing. `core/` does not know what a
   subroutine is; `subroutines/` cannot reach the keyboard directly.

2. **Both halves may import `contract/`.** The contract holds *types and
   interfaces* — the vocabulary they share — and no implementation.

3. **`terminal/` is the only module that knows both halves.**
   It is the front end. It is allowed to be aware of everything because its job
   is to present everything.

This arrangement is called **dependency inversion**, and the practical payoff is
concrete: because `subroutines/` depends only on the `AgentApi` *interface*, you
can replace the entire input layer — as this project already does twice, with a
real driver and a recording driver — without editing a single subroutine.

### Where does new code go?

`src/app.ts` answers this in its header comment, and it is the question you
should ask before writing anything:

| If the new capability… | it belongs in |
|---|---|
| touches the OS's keyboard/mouse | `src/core/` |
| sequences agent primitives ("do A, then B") | `src/subroutines/builtin/` |
| is a new terminal verb (`help`, `stop`, …) | `src/terminal/commands.ts` |
| is a shared type both halves need | `src/contract/` |
| is a leaf utility with no domain knowledge | `src/shared/` |

---

## 5. The contract: types as a foundation

**Files:** [`src/contract/`](../src/contract/index.ts)

This folder contains no logic. It is the shared vocabulary. Learning to read it
first is the fastest way to understand the program.

### Interfaces describe shape, not implementation

[`src/contract/input.ts`](../src/contract/input.ts) defines what a hardware
input device must be able to do:

```ts
export interface InputDevice {
  readonly name: string;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;

  typeText(request: TypeTextRequest, signal?: CancellationSignal): Promise<void>;
  pressKey(request: PressKeyRequest, signal?: CancellationSignal): Promise<void>;

  getCursorPosition(): Promise<Point>;
  moveMouse(request: MoveMouseRequest, signal?: CancellationSignal): Promise<void>;
  clickMouse(request?: ClickMouseRequest, signal?: CancellationSignal): Promise<void>;
  scroll(request: ScrollRequest, signal?: CancellationSignal): Promise<void>;
}
```

Things to notice as a learner:

- `interface` declares a **contract**, containing no code. Anything that
  satisfies the shape *is* an `InputDevice` — TypeScript is structurally typed,
  so a class does not need to say `implements InputDevice` for it to count
  (though ours do, for documentation and error-checking value).
- `readonly` on `name` and `isOpen` means "callers may read these, but must not
  assign them". It is a compile-time promise, enforced by the checker.
- Every method returns `Promise<...>` because all I/O is asynchronous. The
  `Promise<void>` return tells callers "await this; there is no value".
- `signal?: CancellationSignal` — the `?` marks an **optional** parameter. Its
  type is therefore `CancellationSignal | undefined`. This is the mechanism by
  which "please be interruptible" is threaded through every layer (section 9).

### The request types explain themselves

```ts
export interface TypeTextRequest {
  text: string;
  charDelayMs?: number;   // optional: falls back to TIMING.charDelay
}

export interface PressKeyRequest {
  chord: string[];        // ['ctrl', 'c']
  keyDelayMs?: number;
}
```

Bundling parameters into a named object rather than passing five positional
arguments is a deliberate choice. `pressKey(['ctrl','c'], 40)` is unreadable at
the call site; `pressKey({ chord: ['ctrl','c'], keyDelayMs: 40 })` is not, and
adding a sixth option later cannot silently shift an argument's meaning.

The constants live beside the types:

```ts
export const TIMING = {
  charDelay: 28, keyDelay: 40, clickDelay: 60, settle: 350, moveDuration: 260,
} as const;
```

`as const` deserves attention. Without it, TypeScript infers `{ charDelay:
number, … }` and someone could write `TIMING.charDelay = 5`. With `as const`,
every property becomes a `readonly` literal type, and the whole object is deeply
immutable at the type level. It is the idiomatic way to express "this is a table
of fixed values".

### String literal unions: enums without the baggage

[`src/contract/point.ts`](../src/contract/point.ts):

```ts
export type MouseButton = 'left' | 'middle' | 'right';
```

This is a **union of string literals**. It behaves like an enum — you get
autocompletion and exhaustiveness checking — but the values *are* plain strings
at runtime. No generated object, no reverse mapping, nothing to import. Prefer
this to `enum` in almost all modern TypeScript.

The same file declares a much larger union, `NamedKey`, of every key name the
agent accepts (`'ctrl' | 'enter' | 'f1' | … | 'numpadenter'`). A union that long
is documentation as much as type-checking; it tells a reader exactly what the
keyboard vocabulary is.

### Discriminated unions: modelling outcomes

The most instructive type in the contract is in
[`src/contract/subroutine.ts`](../src/contract/subroutine.ts):

```ts
export type PrepareRunResult =
  | { ok: true; run: PreparedRun }
  | { ok: false; reason: 'unknown' | 'busy' | 'invalid'; message: string };
```

This is a **discriminated union**: several object shapes sharing a literal
property (the *discriminant*, here `ok`) that lets TypeScript narrow which shape
you have. It is how you model "one of several outcomes" without exceptions and
without `null`-checking guesswork.

Used at the call site in [`session.ts`](../../v0_01/src/terminal/session.ts):

```ts
const prepared = this.#runtime.subroutines.prepareRun(parsed.name, parsed.args);
if (!prepared.ok) {
  // Here TypeScript KNOWS this is the failure branch.
  // `prepared.message` is available; `prepared.run` is not.
  this.#writeError(prepared.message);
  return { status: 'error', message: prepared.message };
}
// Past this point TypeScript KNOWS it is the success branch.
// `prepared.run` is available; `prepared.message` is not.
void this.#runtime.subroutines.start(prepared.run)...
```

Once you have written `if (!prepared.ok) return …`, the compiler *narrows* the
remaining type to `{ ok: true; run: PreparedRun }`. Trying to read
`prepared.message` after that is a compile error, because the failure branch
cannot reach there. That is control-flow-based type narrowing, and it is one of
TypeScript's most valuable features.

This type exists because of a real bug (section 13 tells the story). It is a
good example of types being used to encode a *behavioural* contract: "validation
succeeds or fails, and it happens synchronously".

### Task states, and a union that pays off

[`src/contract/tasks.ts`](../src/contract/tasks.ts):

```ts
export const TASK_STATES = ['pending','running','completed','failed','cancelled'] as const;
export type TaskState = (typeof TASK_STATES)[number];
```

This is the **array-plus-indexed-access** idiom, and it is worth memorising:

1. `TASK_STATES` is a real runtime array — you can iterate it, log it, build a
   CLI choice list from it.
2. `as const` freezes its element types to string literals.
3. `(typeof TASK_STATES)[number]` is an **indexed access type**: "the type of
   indexing that array by a number" — i.e. the union of its elements:
   `'pending' | 'running' | …`.

So one declaration produces both a value and its type, and they cannot drift
apart. If you add `'paused'` to the array, `TaskState` gains it automatically and
every `switch` that lacks a case will be flagged.

```ts
export function isActiveState(state: TaskState): boolean {
  return state === 'pending' || state === 'running';
}

export function isTerminalState(state: TaskState): boolean {
  return !isActiveState(state);
}
```

Those two predicates look trivial, but they are the difference between code that
says `state === 'completed' || state === 'failed' || state === 'cancelled'` in
twenty places and code that says `isTerminalState(state)` everywhere. When
"finished" later needs a nuance, there is one place to change.

### `unique symbol`: a brand you cannot forge

The subtlest type in the codebase is in
[`src/contract/subroutine.ts`](../src/contract/subroutine.ts):

```ts
export interface PreparedRun {
  readonly [preparedRunBrand]: true;
}

declare const preparedRunBrand: unique symbol;
```

`PreparedRun` has no real fields. It carries a *phantom* property keyed by a
symbol that is never given a runtime value (`declare const` promises the symbol
exists without emitting code for it). The effect: nobody outside the module can
construct or inspect one, because nobody else can name the key.

Why bother? `prepareRun` returns data that must only be handed back to `start`.
The brand makes "you may hold this, but not make one or look inside" enforceable
rather than a comment. The registry is the only module that converts between the
opaque public type and its real internal shape:

```ts
interface InternalPreparedRun {
  subroutine: Subroutine;
  params: Record<string, string>;
}

function asPreparedRun(internal: InternalPreparedRun): PreparedRun {
  return internal as unknown as PreparedRun;
}
```

That double cast (`as unknown as`) is the standard escape hatch when two types
genuinely do not overlap. Using `as unknown as` rather than a plain `as` is
deliberate: it makes the assertion loud and greppable, so it reads as an
intentional boundary crossing rather than an incidental type lie.

---

## 6. Polymorphism in practice: one interface, two devices

**Files:** [`src/core/input/nut-input-device.ts`](../src/core/input/nut-input-device.ts),
[`src/core/input/recording-input-device.ts`](../src/core/input/recording-input-device.ts)

This is the clearest illustration in the project of why interfaces matter, so
read both files together.

Both classes declare `implements InputDevice`, so both must satisfy exactly the
same public shape. One talks to your real desktop; the other does not.

### The real driver

```ts
export class NutInputDevice implements InputDevice {
  readonly name = 'nut-js';

  readonly #options: Required<Omit<NutInputDeviceOptions, 'clock'>>;
  readonly #clock: SleepClock;
  #open = false;
  #screenSize?: { width: number; height: number };
```

Four TypeScript features in four lines:

- **`#options`** is a **private field** (the `#` syntax is JavaScript's own,
  not TypeScript's `private` keyword). It is genuinely inaccessible from outside
  — not just "please don't touch". The class is the only thing that can read it.
- **`readonly`** — assigned once, in the constructor, then frozen for the
  object's lifetime.
- **`Required<Omit<T, 'clock'>>`** is a type-level computation. `Omit` produces
  "the options type minus the `clock` key"; `Required` strips the optional `?`
  from every remaining property. The result: inside the class, `#options` is
  known to have every setting filled in with no `undefined` to handle, even
  though callers may pass a partial object.

  This is the pattern for *normalising options in the constructor*: callers get
  a friendly all-optional type, the class gets a strict all-present type, and
  neither has to repeat `?? default` at every use site.

- **`#screenSize?: { width: number; height: number }`** — an optional field
  whose type is a small inline object type. It is `undefined` until `open()`
  runs, and the type says so honestly.

The constructor fills in the defaults:

```ts
constructor(options: NutInputDeviceOptions = {}) {
  this.#options = {
    charDelayMs: options.charDelayMs ?? TIMING.charDelay,
    keyDelayMs: options.keyDelayMs ?? TIMING.keyDelay,
    clickDelayMs: options.clickDelayMs ?? TIMING.clickDelay,
    maxTextLength: options.maxTextLength ?? 4_096,
  };
  this.#clock = options.clock ?? realSleep;
}
```

`options: NutInputDeviceOptions = {}` gives the parameter a default, so
`new NutInputDevice()` type-checks even though `options` is not optional.
`??` is the **nullish coalescing operator**: it falls back only when the left
side is `null` or `undefined`, so `0` and `''` are respected as real values.
(`||` would treat `0` as missing — a classic bug source in timing code.)

### Why a `clock` is injectable

```ts
#clock: SleepClock;
// ...
async #pause(ms: number, signal?: CancellationSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal === undefined) {
    await this.#clock(ms);
    return;
  }
  await cancellableSleep(ms, signal, this.#clock);
}
```

A `SleepClock` is just `(ms: number) => Promise<void>`. Defaulting it to the real
`sleep` but allowing injection means a test can pass a fake clock and run a
"wait five seconds" path instantly. This is **dependency injection** in its
smallest useful form, and it is why the type alias lives in the contract:

```ts
export type SleepClock = (ms: number) => Promise<void>;
```

### Validating before acting

```ts
#assertText(text: string): void {
  if (text.length === 0) throw new InputUnavailableError('Nothing to type: text was empty.');
  if (text.length > this.#options.maxTextLength) {
    throw new InputUnavailableError(
      `Refusing to type ${text.length} characters in one step ` +
        `(limit ${this.#options.maxTextLength}). Split it into chunks.`,
    );
  }
  if (!PRINTABLE_ASCII.test(text)) {
    const offending = [...text].find((character) => !/[\x20-\x7E]/.test(character));
    throw new InputUnavailableError(
      `Cannot type ${JSON.stringify(offending)}: this driver reproduces ` +
        'printable ASCII only. Strip or transliterate the text first.',
    );
  }
}
```

The `[...text]` spread is not decoration: it iterates by **code point**, so an
emoji or an accented character counted as one unit rather than being split into
its UTF-16 surrogate halves. `text.split('')` would break an emoji in two and
report nonsense.

### Always release a held modifier

```ts
async pressKey(request: PressKeyRequest, signal?: CancellationSignal): Promise<void> {
  this.#assertReady(signal);
  const chord = resolveChord(request.chord);
  const keyDelay = request.keyDelayMs ?? this.#options.keyDelayMs;
  try {
    await keyboard.pressKey(...chord);      // modifiers first, then keys
    await this.#pause(keyDelay, signal);
  } finally {
    // Always release, even if the press or the pause failed: a stuck modifier
    // is far worse than a failed keystroke.
    try {
      await keyboard.releaseKey(...[...chord].reverse());
    } catch {
      // Nothing useful to do here; a pending error is more relevant.
    }
  }
  signal?.throwIfCancelled();
}
```

`try/finally` guarantees cleanup on every exit path — success, thrown error, or
thrown-and-caught. When the thing being cleaned up is "Ctrl is physically held
down", that guarantee is not optional.

Note the empty `catch {}` with a comment. Silently swallowing an error is
usually a smell; here it is correct and *documented as such*, because the
release failing must not mask the original error. Write the comment.

`signal?.throwIfCancelled()` uses **optional chaining** — if `signal` is
`undefined`, the whole expression short-circuits to `undefined` instead of
throwing.

### The recording twin

[`recording-input-device.ts`](../src/core/input/recording-input-device.ts)
implements the same interface and produces a transcript:

```ts
export type RecordedAction =
  | { type: 'typeText'; text: string }
  | { type: 'pressKey'; chord: string[] }
  | { type: 'moveMouse'; to: Point }
  | { type: 'clickMouse'; button: string; times: number; at?: Point }
  | { type: 'scroll'; axis: 'vertical' | 'horizontal'; steps: number };
```

Another discriminated union, this time discriminated by `type`. Discriminating on
`type` is the convention; combined with `switch`, it gives exhaustiveness
checking:

```ts
switch (action.type) {
  case 'typeText':  return action.text.length;   // `text` known to exist here
  case 'pressKey':  return action.chord.length;  // `chord` known to exist here
  // ...
}
```

It also *validates exactly as the real driver would*, which is the point:

```ts
async pressKey(request: PressKeyRequest, signal?: CancellationSignal): Promise<void> {
  this.#prepare(signal);
  // Validate the key names exactly as the live driver would, so dry runs catch
  // a typo like `crtl` instead of hiding it.
  resolveChord(request.chord);
  this.#actions.push({ type: 'pressKey', chord: [...request.chord] });
  // ...
}
```

A dry run that skips validation is worse than no dry run: it gives false
confidence. `resolveChord` is imported from the real driver's module precisely
so both paths reject `pressKey crtl+c` identically.

**The lesson:** an interface plus two implementations is not over-engineering
when the second implementation is your test harness, your dry-run mode, and your
documentation of the contract, all at once.

---

## 7. The agent: turning requests into tracked work

**File:** [`src/core/agent.ts`](../src/core/agent.ts)

### Class, fields, constructor

```ts
export class Agent implements AgentApi {
  readonly name: string;

  readonly #device: InputDevice;
  readonly #tasks: TaskRegistry;
  readonly #log: Logger;
  #ready = false;
  #inputsPerformed = 0;
  #starting?: Promise<void>;

  constructor(options: AgentOptions) {
    this.#device = options.device;
    this.#tasks = options.tasks;
    this.#log = options.logger.child('agent');
    this.name = options.name ?? 'js-agent';
  }
```

`implements AgentApi` is the mechanism that keeps the halves honest: if the
contract gains a method and the class does not, `npm run check` fails
immediately. The contract is not documentation that rots; it is enforced.

`AgentOptions` (an interface at the top of the file) is how dependencies are
supplied — the device, the shared registry, a logger. The class does not build
these itself. That is what makes it testable and what lets `app.ts` decide
whether the device is real or recorded.

### Getters as read-only views

```ts
get ready(): boolean {
  return this.#ready;
}

get device(): InputDevice {
  return this.#device;
}
```

`#ready` is mutable inside the class but the outside world only gets a `get`,
so `agent.ready = true` is a compile error. This is a **getter-only property**:
it reads like a field, is implemented as a method, and cannot be assigned.

### Guarding against a startup race

```ts
async start(): Promise<void> {
  if (this.#ready) return;
  // Guard against two `start` calls racing on the same device.
  this.#starting ??= this.#openDevice();
  await this.#starting;
}
```

`??=` is **nullish assignment**: "if `#starting` is null or undefined, assign
this; otherwise leave it alone". So the first `start()` kicks off `#openDevice()`
and stores the promise; any concurrent `start()` sees the stored promise and
awaits the same one instead of opening the device twice.

This is a general and reusable idiom for idempotent async initialisation. Note
that it caches the *promise*, not a boolean — a boolean flag would be set too
late, after the `await`.

### The input pipeline: one place that tracks every action

Every public input method funnels into a single private helper. Here is
`typeText`:

```ts
async typeText(request: TypeTextRequest): Promise<void> {
  await this.#performInput(
    'type-text',                                  // action name for the task record
    `typing ${request.text.length} char(s)`,      // initial detail
    async (signal) => {                           // the actual work
      await this.#device.typeText(request, signal);
      return `${request.text.length} char(s)`;    // final detail
    },
  );
}
```

Read the signature of the helper carefully, because it is the most advanced type
in the file:

```ts
async #performInput(
  action: string,
  detail: string,
  run: (signal: CancellationSignal) => Promise<string>,
): Promise<void> {
```

`run` is a **callback parameter**: the caller supplies the work. Its last type
argument is the function's return type — here `Promise<string>`, meaning "resolve
with a short human-readable summary that we will store as the task's detail".

This shape — "a function that receives the cancellation signal and does the
thing" — is how one helper can wrap a dozen different operations while tracking,
timing, and cancelling all of them identically.

### The body, and error triage

```ts
if (!this.#ready) {
  throw new Error(`Agent is not started; cannot ${action}. Call start() first.`);
}

const task = this.#tasks.create('input', action);
const taskSignal = this.#tasks.signalFor(task.id);
// `dispose` matters: the program-wide token lives as long as the process, so
// every input that registers on it must unregister when it finishes.
const { signal, dispose } = linkSignals(taskSignal, this.#tasks.controller.signal);
this.#tasks.update(task.id, { state: 'running', detail });

try {
  const completed = await run(signal);
  this.#inputsPerformed += 1;
  this.#tasks.finish(task.id, 'completed', { detail: completed });
} catch (error) {
  const failure = toError(error);
  if (signal.isCancelled || failure instanceof OperationCancelledError) {
    this.#tasks.finish(task.id, 'cancelled', { detail: 'stopped' });
  } else {
    this.#tasks.finish(task.id, 'failed', {
      error: { name: failure.name, message: failure.message },
    });
  }
  throw failure;
} finally {
  dispose();
}
```

Points for a learner:

- **`catch (error)`** — with `useUnknownInCatchVariables` (part of `strict`),
  `error` has type `unknown`, not `any`. You must narrow before using it. That
  is why `toError` exists:

  ```ts
  export function toError(value: unknown): Error {
    if (value instanceof Error) return value;
    if (typeof value === 'string') return new Error(value);
    return new Error(`Non-error thrown: ${JSON.stringify(value)}`);
  }
  ```

  `instanceof` narrows `unknown` to `Error`; `typeof` narrows it to `string`.
  Anything else gets stringified. Never assume a thrown thing is an `Error` —
  code in the wild throws strings and plain objects.

- **`failure instanceof OperationCancelledError`** distinguishes "the user asked
  us to stop" from "this broke". Cancellation is reported as `cancelled`, an
  error as `failed`. Getting this wrong means `stop` looks like a crash.

- **`finally { dispose(); }`** — the task's signal may have registered listeners
  on the long-lived program-wide token. Without `dispose`, a program that sends
  ten thousand keystrokes would accumulate ten thousand closures. This was a real
  leak I designed out; see `linkSignals` below.

### `linkSignals`: combining cancellation sources

```ts
export function linkSignals(
  ...signals: (CancellationSignal | undefined)[]
): { signal: CancellationSignal; dispose: () => void } {
  const sources = signals.filter(
    (signal): signal is CancellationSignal => signal !== undefined,
  );
  if (sources.length === 1) {
    return { signal: sources[0] as CancellationSignal, dispose: () => {} };
  }
  ...
}
```

Three TypeScript features here:

- **Rest parameters** `...signals: T[]` collect any number of arguments.
- **`(CancellationSignal | undefined)[]`** because callers may pass nothing.
- **`(signal): signal is CancellationSignal => …`** is a **type predicate**. It
  tells the compiler that this filter does not merely return booleans — it
  *narrows the array's element type*. After the filter, `sources` is
  `CancellationSignal[]`, not `(CancellationSignal | undefined)[]`. Without the
  predicate, every later use would need a redundant `!`.

The combined signal fires when *either* source cancels:

```ts
const signal: CancellationSignal = {
  get isCancelled() {
    return isCancelled();
  },
  throwIfCancelled: () => { if (isCancelled()) throw new OperationCancelledError('Cancelled'); },
  onCancel: (listener: () => void) => {
    if (isCancelled()) { listener(); return; }
    listeners.add(listener);
    for (const source of sources) {
      const wrapper = (): void => {
        // Deleting first makes the wrapper idempotent: several sources may
        // trip at once, and the listener must only run once.
        if (!listeners.delete(listener)) return;
        listener();
      };
      registrations.push({ source, wrapper });
      source.onCancel(wrapper);
    }
  },
  offCancel: (listener: () => void) => {
    listeners.delete(listener);
  },
};
```

A **getter inside an object literal** (`get isCancelled()`) is legal and useful:
it stays live rather than snapshotting a boolean at construction time.

The `wrapper` closure is the careful part. The same listener is registered on
two sources, so it can be invoked twice; the `listeners.delete` check makes the
second invocation a no-op. Keeping the `registrations` list is what lets
`dispose()` unregister exactly the wrappers it created and nothing else.

---

## 8. `TaskRegistry`: the single source of truth for "what is running"

**File:** [`src/core/task-registry.ts`](../src/core/task-registry.ts)

Both halves write here. That is deliberate: it is the one place the terminal
looks, which is why `list` can show a subroutine *and* the input it is currently
performing, and why `stop` can halt both.

### The data model

```ts
export type TaskObserver = (snapshot: TaskSnapshot) => void;

interface TaskRecord {
  id: string;
  kind: TaskKind;          // 'subroutine' | 'input'
  name: string;
  state: TaskState;
  detail?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: TaskError;
  readonly token: CancelToken;
}
```

Two types, on purpose:

- **`TaskRecord`** is the private, mutable internal shape. It holds a live
  `token` (the cancellation switch) and is never handed out.
- **`TaskSnapshot`** (in the contract) is the frozen, serialisable view callers
  receive.

This split prevents the classic bug where a caller mutates internal state or
holds a reference that changes underneath them. `snapshotOf` does the conversion:

```ts
function snapshotOf(record: TaskRecord): TaskSnapshot {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    state: record.state,
    createdAt: record.createdAt,
    ...(record.detail !== undefined ? { detail: record.detail } : {}),
    ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
    // ...
  };
}
```

That spread-with-conditional pattern is worth learning. `TaskSnapshot` declares
`detail?: string`. Under `exactOptionalPropertyTypes: false` (this project's
setting) you could write `detail: record.detail` and it would type-check even
when `undefined`. But producing a key whose value is `undefined` is subtly
different from omitting the key — it shows up in `Object.keys`, in JSON, and in
`in` checks. The conditional spread only adds the key when there is a value. The
formatting is ugly; the semantics are precise.

### Collections, typed

```ts
export class TaskRegistry {
  readonly #records = new Map<string, TaskRecord>();
  readonly #controller: CancellationController;
  readonly #historyLimit: number;
  #counter = 0;
  #observer?: TaskObserver;
  readonly #idleWaiters = new Set<() => void>();
```

- `new Map<string, TaskRecord>()` — a typed map. `get` returns
  `TaskRecord | undefined`, which pairs correctly with
  `noUncheckedIndexedAccess`.
- `new Set<() => void>()` — a set of functions, used to notify waiters. A `Set`
  rather than an array gives free de-duplication and O(1) delete.
- `#observer?: TaskObserver` — an optional callback. The terminal installs one to
  print progress; that is the observer pattern in about ten lines.
- `#counter = 0` — with no annotation, TypeScript infers `number` from the
  initialiser. Inference is normally preferred over annotation for locals and
  fields.

The constructor shows **default parameters**:

```ts
constructor(
  options: TaskRegistryOptions = {},
  controller: CancellationController = new CancelToken(),
) {
  this.#historyLimit = Math.max(1, options.historyLimit ?? 500);
  this.#controller = controller;
}
```

The second parameter is what makes the registry testable: pass a token you
control and you can cancel the whole world on demand.

### State transitions, guarded

```ts
update(
  id: string,
  patch: { state?: TaskState; detail?: string; error?: TaskError },
): TaskSnapshot | undefined {
  const record = this.#records.get(id);
  if (record === undefined) return undefined;
  if (isTerminalState(record.state)) return snapshotOf(record);

  if (patch.state !== undefined) {
    record.state = patch.state;
    if (patch.state === 'running' && record.startedAt === undefined) {
      record.startedAt = Date.now();
    }
    if (isTerminalState(patch.state)) {
      record.finishedAt = Date.now();
    }
  }
  if (patch.detail !== undefined) record.detail = patch.detail;
  if (patch.error !== undefined) record.error = patch.error;

  this.#notify(record);
  return snapshotOf(record);
}
```

The `isTerminalState(record.state)` early return is a small piece of policy with
big consequences: a finished task is final. `stop` and `complete` can race, and
whichever lands first wins. Without this guard, a cancelled task could be
overwritten as completed a millisecond later and `list` would lie.

The `patch: { state?: …; detail?: …; error?: … }` parameter type is an **inline
object type** — a one-off shape not worth naming. `update(id, { state: 'running'
})` reads well at the call site and cannot be confused with a positional
argument.

### Waiting for quiescence without polling

```ts
whenIdle(kind?: TaskKind): Promise<void> {
  if (this.active(kind === undefined ? {} : { kind }).length === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const waiter = (): void => {
      if (this.active(kind === undefined ? {} : { kind }).length === 0) {
        this.#idleWaiters.delete(waiter);
        resolve();
      }
    };
    this.#idleWaiters.add(waiter);
  });
}
```

This declares "resolve when nothing of this kind is active", and does it by
registering a callback rather than by `setInterval`-ing until the world is calm.
The cleanup (`#idleWaiters.delete(waiter)`) happens *inside* the promise executor
via closure — the `waiter` function refers to itself, which is legal because
function declarations are hoisted.

The `kind === undefined ? {} : { kind }` dance exists only because
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` make "pass nothing"
different from "pass undefined". It is a small tax that buys real safety
elsewhere.

Used by shutdown:

```ts
async stop(): Promise<void> {
  this.#ready = false;
  await this.#tasks.whenIdle('input');
  await this.#device.close();
}
```

The agent stops accepting new input, lets in-flight input finish, and only then
releases the device. Stopping mid-keystroke is how you end up with a modifier
held down.

---

## 9. Cancellation: cooperative, explicit, testable

**File:** [`src/contract/signals.ts`](../src/contract/signals.ts)

There are no threads and no signals in the Unix sense. Cancellation is a shared
object that code checks periodically. The interface is deliberately tiny:

```ts
export interface CancellationSignal {
  readonly isCancelled: boolean;
  throwIfCancelled(): void;
  onCancel(listener: () => void): void;
  offCancel(listener: () => void): void;
}
```

And its writable counterpart:

```ts
export interface CancellationController {
  readonly signal: CancellationSignal;
  cancel(reason?: string): void;
}
```

Splitting the readable `Signal` from the writable `Controller` is a technique
worth stealing: a subroutine receives a `CancellationSignal` and therefore
*cannot* cancel anything — not itself, not anyone else. Only the registry, which
holds the `CancelToken`, has the `cancel` method.

Notice also `readonly isCancelled: boolean` in the interface but a getter in the
implementation. An interface can declare a readonly property; a class satisfies
it with `get`. Callers see a property; you implement it as a computation.

### `CancelToken`

```ts
export class CancelToken implements CancellationController {
  #cancelled = false;
  #reason: string | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #signal: CancellationSignal;

  constructor() {
    this.#signal = {
      isCancelled: false,
      throwIfCancelled: () => {
        if (this.#cancelled) {
          throw new CancelledError(this.#reason ?? 'Cancelled');
        }
      },
      onCancel: (listener: () => void) => {
        if (this.#cancelled) { listener(); return; }
        this.#listeners.add(listener);
      },
      offCancel: (listener: () => void) => {
        this.#listeners.delete(listener);
      },
    };
    Object.defineProperty(this.#signal, 'isCancelled', {
      get: () => this.#cancelled,
      enumerable: true,
    });
  }
```

Why the `Object.defineProperty` instead of a plain `get isCancelled()` in the
object literal (as `linkSignals` uses)? Because the object literal is built once,
and a literal getter *would* work here too — but the explicit `defineProperty`
documents the intent: this property is dynamic, reflecting `#cancelled` at read
time. Be aware this is a matter of style; the literal form is usually cleaner and
is what the rest of the file uses.

```ts
  cancel(reason?: string): void {
    if (this.#cancelled) return;              // idempotent
    this.#cancelled = true;
    this.#reason = reason;
    const listeners = [...this.#listeners];   // copy before iterating
    this.#listeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A failing listener must not prevent the remaining ones from running.
      }
    }
  }
}
```

Two lessons:

1. **Idempotence.** Cancel twice, no harm.
2. **Copy before iterating** when callbacks might mutate the collection. Calling
   a listener could register or remove another; iterating the live `Set` while
   it changes is undefined behaviour waiting to happen. `[...this.#listeners]`
   snapshots it.

### A subtle bug worth studying

The original `cancellableSleep` was:

```ts
export function cancellableSleep(ms, signal, clock = realSleep): Promise<void> {
  if (ms <= 0) { signal.throwIfCancelled(); return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => {
    const onCancel = () => reject(new CancelledError('Interrupted while waiting'));
    signal.onCancel(onCancel);
    clock(ms).then(() => { signal.offCancel(onCancel); resolve(); },
                   (e) => { signal.offCancel(onCancel); reject(e); });
    if (signal.isCancelled) signal.offCancel(onCancel);   // ← the bug
  });
}
```

If the signal was *already* cancelled, `signal.onCancel(onCancel)` fires
immediately and rejects — correct. But the last line then *unregistered* the
listener, and the promise had already been rejected... except in the case where
`realSleep` also used an `unref`'d timer, so nothing kept the process alive and
the race resolved unpredictably. In practice `stop` could hang forever.

The fix separates settling from cleanup explicitly:

```ts
export function cancellableSleep(ms, signal, clock = realSleep): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      signal.offCancel(onCancel);
      return true;
    };

    function onCancel(): void {
      if (finish()) reject(new CancelledError('Interrupted while waiting'));
    }

    if (ms <= 0) {
      finish();
      if (signal.isCancelled) reject(new CancelledError('Cancelled before waiting'));
      else resolve();
      return;
    }

    if (signal.isCancelled) {
      finish();
      reject(new CancelledError('Cancelled before waiting'));
      return;
    }

    signal.onCancel(onCancel);
    clock(ms).then(
      () => { if (finish()) resolve(); },
      (error: unknown) => { if (finish()) reject(error); },
    );
  });
}
```

The `settled` flag plus `finish()` gives an exact-once guarantee across three
racing outcomes: cancellation, timer expiry, and a clock that throws. Note
`function onCancel()` (a hoisted declaration) is referenced by `finish` above it
— function declarations hoist, `const` arrow functions do not.

**The transferable lesson:** whenever a promise can settle from more than one
source, write one `finish()` guard and route every path through it. "Resolve
twice" is silently ignored by `Promise`, but "never settle" hangs forever and is
much harder to debug.

Also note why `realSleep` is **not** `unref`'d:

```ts
export const realSleep: SleepClock = (ms) =>
  new Promise<void>((resolve) => {
    // Deliberately *not* unref'd. A pending delay means the program is waiting
    // for something it asked to happen; letting the loop drain would abandon it
    // mid-action.
    setTimeout(resolve, ms);
  });
```

`timer.unref()` tells Node "this timer should not keep the process alive". That
is right for a background heartbeat and wrong for a sleep the program is
awaiting: the process would exit before the work it requested.

---

## 10. The subroutine layer: behaviour, one file per behaviour

**Files:** [`src/subroutines/registry.ts`](../src/subroutines/registry.ts),
[`src/subroutines/builtin/`](../src/subroutines/builtin/index.ts)

### The contract a subroutine must satisfy

From [`src/contract/subroutine.ts`](../src/contract/subroutine.ts):

```ts
export interface Subroutine {
  readonly name: string;
  readonly summary: string;
  readonly description?: string;
  readonly params?: readonly SubroutineParam[];
  readonly entry: (ctx: SubroutineContext) => Promise<void>;
}
```

Note the **function-typed property**: `entry` is a field whose type is a
function. An interface can express "this object has a method-like field" this
way, and it composes better than a method signature when you want to reference
the type (`Subroutine['entry']`).

`readonly params?: readonly SubroutineParam[]` has `readonly` twice, at two
levels: the property cannot be reassigned, *and* the array cannot be mutated.
TypeScript's `readonly T[]` is compile-time only, but it stops `subroutine.params.push(...)`
at the call site, which is the whole point.

And the context a subroutine is handed:

```ts
export interface SubroutineContext {
  readonly agent: AgentApi;
  readonly signal: CancellationSignal;
  readonly params: Readonly<Record<string, string>>;
  param(name: string): string;
  paramOr(name: string, fallback: string): string;
  readonly log: { debug(...): void; info(...): void; warn(...): void; error(...): void };
  status(detail: string): void;
  sleep(ms: number): Promise<void>;
}
```

`Readonly<Record<string, string>>` is a mapped type from the standard library:
"an object with string keys and string values, none of them writable". It is the
idiomatic way to say "a bag of strings I will only read".

### A real subroutine, annotated

[`press-key.ts`](../src/subroutines/builtin/press-key.ts):

```ts
export const pressKey: Subroutine = {
  name: 'press-key',
  summary: 'press a key, or hold a chord such as ctrl+shift+escape',
  description:
    'Joins the keys with "+" to hold them together. Modifiers ("ctrl", ' +
    '"shift", "alt", "super") are pressed first and always released, even if ' +
    'the press fails. Key names are layout-independent: "enter", "escape", ' +
    '"pageup", "f5", "numpad4", or a single character like "a" or "#".',
  params: [
    { name: 'chord', required: true, description: 'keys joined with "+", e.g. ctrl+shift+t or enter' },
    { name: 'repeat', required: false, description: 'how many times to send the chord', defaultValue: '1' },
    { name: 'key-delay-ms', required: false, description: 'pause after each press, in milliseconds', defaultValue: String(TIMING.keyDelay) },
  ],

  async entry(ctx) {
    const raw = ctx.param('chord');
    const chord = raw.split('+').map((part) => part.trim()).filter((part) => part.length > 0);
    if (chord.length === 0) {
      throw new Error('No keys given. Try: press-key ctrl+c');
    }

    const repeat = parseCount(ctx.paramOr('repeat', '1'));
    const keyDelayMs = parseDelay(ctx.paramOr('key-delay-ms', ''), TIMING.keyDelay);

    ctx.status(`pressing ${chord.join('+')} x${repeat}`);
    for (let index = 0; index < repeat; index += 1) {
      ctx.signal.throwIfCancelled();
      await ctx.agent.pressKey({ chord, keyDelayMs });
      ctx.status(`pressed ${chord.join('+')} ${index + 1}/${repeat}`);
    }
  },
};
```

Everything a learner should notice:

- **`: Subroutine` is a type annotation on a `const`.** This is the single most
  useful pattern in the file. Because the value is annotated, `name`, `summary`
  and `entry` are checked *at the declaration*: misspell `summery` and the error
  appears here, not three modules away. It also means `name` is inferred as
  `string` rather than a narrower literal — which is what we want, since the
  registry stores it in a `Map<string, Subroutine>`.

- **`async entry(ctx)`** — the parameter has no annotation, and it does not need
  one. Because the object is annotated `: Subroutine`, TypeScript knows `entry`
  must be `(ctx: SubroutineContext) => Promise<void>` and **contextually types**
  the parameter. This is contextual typing, and it is why good library types make
  your code shorter.

- **`ctx` is the only way out.** No `import` of the device, no `process`, no
  `console`. The subroutine cannot break the rules structurally because it has
  not been given the means.

- **`ctx.signal.throwIfCancelled()` sits inside the loop**, before each press.
  That is the entire cost of being cancellable: one line, in the right place.
  The rule is *between steps*, not once at the top.

- **`ctx.status(...)` is progress reporting.** It writes a short note into the
  task record, which is what `list` displays. This is how a long operation stays
  observable without printing anything itself.

- **`throw new Error(...)`** is how a subroutine fails. It never calls
  `process.exit`, and it never decides its own fate — the registry catches the
  throw and records `failed`.

### Validation helpers: pure functions with guard clauses

```ts
function parseCount(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`"${raw}" is not a repeat count between 1 and 100.`);
  }
  return value;
}
```

`Number(raw)` returns `number` (possibly `NaN`), and `Number.isInteger(NaN)` is
`false`, so one condition covers both "not a number" and "not a whole number".
The function's declared return type `number` is a promise the compiler checks:
every path either throws or returns a number. Note the message includes the
offending input in quotes — write errors for the person who has to read them.

### The registry: catalogue, validation, execution

```ts
export class SubroutineRegistry implements SubroutineApi {
  readonly #agent: AgentApi;
  readonly #tasks: TaskRegistry;
  readonly #log: Logger;
  readonly #byName = new Map<string, Subroutine>();
  readonly #order: Subroutine[] = [];
  readonly #inFlight = new Map<string, Promise<SubroutineRunResult>>();
```

Two collections for one concept: a `Map` for O(1) lookup by name and an array
that preserves registration order for `help`. A single `Map` would iterate in
insertion order in practice, but keeping an explicit array makes the ordering
guarantee a stated intention rather than a JS implementation detail.

```ts
register(subroutine: Subroutine): this {
  const name = normaliseName(subroutine.name);
  if (name.length === 0) throw new Error('A subroutine needs a name.');
  if (this.#byName.has(name)) throw new Error(`Duplicate subroutine name "${name}".`);
  this.#byName.set(name, subroutine);
  this.#order.push(subroutine);
  return this;
}
```

The `: this` return type is the **fluent interface** idiom — it lets callers
chain `registry.register(a).register(b)`. Duplicate detection at registration
turns a whole class of bugs (two subroutines claiming `press-key`) into a
startup crash with a clear message, rather than ambiguous behaviour at runtime.

### Validation split from execution

```ts
prepareRun(name: string, rawParams: readonly string[]): PrepareRunResult {
  const subroutine = this.get(name);
  if (subroutine === undefined) {
    const available = [...this.#byName.keys()].sort().join(', ');
    return { ok: false, reason: 'unknown',
      message: `Unknown subroutine "${name}". Registered: ${available || '(none)'}.` };
  }

  const clash = this.active().find(
    (task) => normaliseName(task.name) === normaliseName(displayName),
  );
  if (clash !== undefined) {
    return { ok: false, reason: 'busy',
      message: `"${displayName}" is already running as ${clash.id}. ` +
        'Wait for it, or use `list` and `stop` first.' };
  }

  let params: Record<string, string>;
  try {
    params = resolveParams(subroutine, rawParams);
  } catch (error) {
    return { ok: false, reason: 'invalid', message: toError(error).message };
  }

  return { ok: true, run: asPreparedRun({ subroutine, params }) };
}
```

This deliberately returns a result object instead of throwing, and it is
**synchronous**. Both decisions were forced by a real bug (section 13): a
validation failure thrown inside an `async` method becomes a *rejected promise*,
which a caller cannot inspect without awaiting the whole run — and the whole run
might take minutes. The lesson is general:

> **If a caller needs to know something *now*, do not put that check behind an
> `await`.** Split the synchronous decision from the asynchronous work.

`catch (error) { return { ok: false, …, message: toError(error).message } }` also
demonstrates converting a thrown exception into a value at a boundary — a
technique for turning unpredictable internals into a predictable API.

### Running a prepared action as a tracked task

```ts
async start(prepared: PreparedRun, options: { quiet?: boolean } = {}): Promise<SubroutineRunResult> {
  const { subroutine, params } = prepared as unknown as InternalPreparedRun;
  const displayName = subroutine.name;
  const quiet = options.quiet === true;
  const log = this.#log.child(displayName);
  const task = this.#tasks.create('subroutine', displayName);
  const signal = this.#tasks.signalFor(task.id);
  if (signal === undefined) {
    throw new Error(`Task ${task.id} vanished before it could start.`);
  }

  // Publish the running state *before* starting the run.
  //
  // It matters: a subroutine's synchronous prefix (its first `ctx.status(...)`)
  // executes immediately when `#execute` is called, so publishing afterwards
  // would overwrite the subroutine's own detail with "starting".
  this.#tasks.update(task.id, { state: 'running', detail: 'starting' });
  const execution = this.#execute(subroutine, { taskId: task.id, signal, params, log });
  this.#inFlight.set(task.id, execution);
  if (!quiet) log.info(`started (${task.id})`);

  const result = await execution;
  this.#inFlight.delete(task.id);
  ...
}
```

`options: { quiet?: boolean } = {}` again normalises an optional bag. Then
`quiet = options.quiet === true` — comparing to `true` explicitly rather than
relying on truthiness, so that if the type ever widens, the behaviour stays
obvious.

The ordering comment records a bug that is invisible in the code: `#execute`
runs its synchronous prefix *immediately* when called, so a subroutine's first
`ctx.status(...)` landed **before** the registry's own `detail: 'starting'`
write, and got overwritten. Publishing first fixed it. When you find a bug like
this, write the comment — the next reader will otherwise "clean up" the
seemingly redundant ordering.

### The context factory

```ts
function createContext(args: {
  agent: AgentApi;
  registry: TaskRegistry;
  subroutine: Subroutine;
  taskId: string;
  signal: CancellationSignal;
  params: Record<string, string>;
  log: Logger;
}): SubroutineContext & { currentDetail: () => string | undefined } {
  const { agent, registry, subroutine, taskId, signal, log } = args;
  const params = Object.freeze({ ...args.params });
  let detail: string | undefined;

  return {
    agent,
    signal,
    params,
    param(name: string): string {
      const value = params[name];
      if (value === undefined || value === '') {
        throw new Error(`"${subroutine.name}" is missing required parameter "${name}".`);
      }
      return value;
    },
    paramOr(name: string, fallback: string): string {
      const value = params[name];
      return value === undefined || value === '' ? fallback : value;
    },
    // ...
    status(next: string): void {
      detail = next;
      registry.update(taskId, { detail: next });
    },
    sleep: (ms: number) => cancellableSleep(ms, signal),
    currentDetail: () => detail,
  };
}
```

Several things worth pulling apart:

- **`args: { … }` as an inline object type with seven fields** avoids a
  seven-parameter function. If this shape were reused it would earn a named
  interface; used once, inline is fine. Judgement, not dogma.

- **`SubroutineContext & { currentDetail: … }`** uses the **intersection type**
  `&`: "a `SubroutineContext`, *plus* this extra method". Intersections compose
  types without inheritance. The return type advertises that callers get
  something slightly richer than the interface — here, the registry needs to read
  the last status note back when finishing the task.

- **`Object.freeze({ ...args.params })`** copies and freezes. The spread prevents
  the caller's object from being aliased; `Object.freeze` makes the frozen-ness a
  runtime guarantee, not just the compile-time `Readonly` promise.

- **`let detail: string | undefined;` closed over by `status` and
  `currentDetail`.** Two closures over one variable: one writes, one reads. This
  is a small piece of private state that does not need a class.

- **`sleep: (ms: number) => cancellableSleep(ms, signal)`** — the arrow function
  captures `signal`, so a subroutine's `ctx.sleep` is automatically cancellable.
  A subroutine cannot accidentally sleep uncancellably.

### `resolveParams`: the longest function, and why

```ts
export function resolveParams(
  subroutine: Subroutine,
  raw: readonly string[],
): Record<string, string> {
  const declared: readonly SubroutineParam[] = subroutine.params ?? [];
  const resolved: Record<string, string> = {};
  const restIndex = declared.findIndex((param) => param.rest === true);
  const positionalEnd = restIndex === -1 ? declared.length : restIndex;

  for (const [index, param] of declared.entries()) {
    if (param.rest === true) {
      const joined = raw.slice(index).join(' ').trim();
      if (joined === '') {
        if (param.defaultValue !== undefined) resolved[param.name] = param.defaultValue;
        else if (param.required) {
          throw new Error(`"${subroutine.name}" needs ${param.name}: ${param.description}`);
        }
        continue;
      }
      resolved[param.name] = joined;
      continue;
    }
    if (index >= positionalEnd) continue;

    const rawValue = raw[index];                 // string | undefined
    if (rawValue === undefined || rawValue === '') {
      if (param.defaultValue !== undefined) { resolved[param.name] = param.defaultValue; continue; }
      if (param.required) {
        throw new Error(`"${subroutine.name}" needs ${param.name}: ${param.description}`);
      }
      continue;
    }
    resolved[param.name] = rawValue;
  }

  // A rest parameter absorbs everything after it by definition, so there can be
  // no such thing as a stray argument once one is declared.
  if (restIndex === -1) {
    const extras = raw.slice(declared.length).filter((value) => value !== '');
    if (extras.length > 0) {
      throw new Error(
        `"${subroutine.name}" accepts at most ${declared.length} argument(s); ` +
          `got ${raw.length} (unexpected: ${extras.join(', ')}).`,
      );
    }
  }

  return resolved;
}
```

- `declared.entries()` gives `[index, value]` pairs; destructuring in the `for`
  header is idiomatic.
- `rawValue: string | undefined` **because of `noUncheckedIndexedAccess`**. The
  code must handle "the user did not supply this argument" — and it does, by
  falling through to defaults or throwing. Without the flag, `rawValue` would be
  typed `string` and the `undefined` check would look like paranoia; in reality
  it was load-bearing.
- **`rest: true`** is a small feature with outsized ergonomic payoff. It lets
  `type-text hello world` work like `type-text "hello world"`.
- Validation errors name the subroutine, the parameter, and the parameter's
  description. That sentence is generated from the declaration in the same file,
  so help text and error text cannot drift.

### The barrel: one place that knows the whole catalogue

```ts
export const builtinSubroutines: readonly Subroutine[] = [
  pressKey, typeText, moveMouse, clickMouse, scroll, goto, demo,
];
```

Adding a subroutine means one new file and one line here. Nothing in `core/`
changes. Nothing in `terminal/` changes. **That is the payoff of the whole
architecture**, and it is worth measuring any design by: how many files must
change to add a behaviour? Here, two.

---

## 11. The terminal: the only module that knows both halves

> **v0_02 note.** This chapter describes v0_01's `TerminalSession`. In v0_02 it
> was split: dispatch moved to `terminal/broker.ts`, and the prompt became
> `terminal/local-session.ts` (local) and `terminal/remote-session.ts` (attached).
> The links below point at the v0_01 source because that is the code this chapter
> describes. For the v0_02 behaviour, see [`V0_02-CHANGES.md`](V0_02-CHANGES.md)
> §2 and §11.

**Files:** [`src/terminal/session.ts`](../../v0_01/src/terminal/session.ts),
[`commands.ts`](../src/terminal/commands.ts),
[`banner.ts`](../src/terminal/banner.ts),
[`parse-command-line.ts`](../src/terminal/parse-command-line.ts)

### Commands as data

```ts
export interface Command {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly usage?: string;
  readonly run: (context: CommandContext, args: readonly string[]) => Promise<void> | void;
}
```

`Promise<void> | void` is a **union return type**: the function may be async or
not, and callers `await` it either way (`await` on a non-promise is legal and
immediate). Commands that only print (`help`, `exit`) are synchronous; `stop` is
async. The type accommodates both without forcing ceremony on the simple ones.

The commands themselves are plain object literals in an array:

```ts
export const COMMANDS: readonly Command[] = [HELP, LIST, STOP, STATUS, EXIT];

export function findCommand(name: string): Command | undefined {
  const needle = name.toLowerCase();
  return COMMANDS.find(
    (command) => command.name === needle || command.aliases?.includes(needle) === true,
  );
}
```

`command.aliases?.includes(needle) === true` combines optional chaining with an
explicit `=== true`, because `find`'s predicate must return a boolean and
`undefined` is not one. Writing `=== true` rather than relying on truthiness is
a habit that pays off when values can be `0` or `''`.

`CommandContext` is itself the narrowing device:

```ts
export interface CommandContext {
  /** Narrow, read-only view of the agent: commands never send input themselves. */
  readonly agent: AgentStatusSource;
  readonly subroutines: SubroutineApi;
  readonly write: (line: string) => void;
  readonly requestExit: () => void;
  readonly log: Logger;
}
```

A command gets `AgentStatusSource` — a two-method interface with `name`,
`ready` and `status()` — not the full `Agent`. So `commands.ts` *cannot* type on
your keyboard even if someone tries, because it has no reference to `typeText`.
This is the **interface segregation principle** made mechanical: hand out the
narrowest interface that does the job, and illegal states become
unrepresentable.

### The session: two entry points, one dispatcher

```ts
export type DispatchStatus = 'ok' | 'empty' | 'exit' | 'error';

export class TerminalSession {
  readonly #runtime: TerminalRuntime;
  readonly #version: string;
  readonly #live: boolean;
  readonly #logLevel: string;
  readonly #write: (line: string) => void;
  readonly #writeError: (line: string) => void;

  #rl?: ReadlineInterface;
  #exitRequested = false;
  #closed = false;
  #busy = false;
  #promptVisible = false;
  #shuttingDown = false;
  #onExit?: () => void;
  readonly #pending: string[] = [];
```

`DispatchStatus` is a union of four string literals, used as the return type of
`dispatch`. The two `run*` methods share the same `dispatch` so that interactive
and scripted behaviour cannot drift — a design rule worth stating out loud in a
comment, as the file does.

```ts
constructor(options: TerminalSessionOptions) {
  this.#runtime = options.runtime;
  this.#version = options.version;
  const sink = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  this.#write = sink;
  this.#writeError = options.writeError ?? sink;
}
```

The `write` injection deserves note: it is how the whole terminal can be tested
or embedded without touching real stdout. `writeError` defaults to the same sink,
so by default errors appear inline with output.

### `dispatch`: branching with an explicit escape

```ts
async dispatch(line: string): Promise<{ status: DispatchStatus; message?: string }> {
  const trimmed = line.trim();
  if (trimmed === '') return { status: 'empty' };

  const parsed = parseCommandLine(trimmed);
  if (parsed.name === '') return { status: 'empty' };

  const builtin = findCommand(parsed.name);

  if (builtin !== undefined) {
    try {
      await builtin.run(this.#context(), parsed.args);
    } catch (error) {
      const message = toMessage(error);
      this.#writeError(message);
      return { status: 'error', message };
    }
    return this.#exitRequested ? { status: 'exit' } : { status: 'ok' };
  }

  if (this.#runtime.subroutines.get(parsed.name) === undefined) {
    const message = `Unknown command or subroutine "${parsed.name}". ` +
      'Try `help`, or `help ' + parsed.name + '` for details.';
    this.#writeError(message);
    return { status: 'error', message };
  }

  // A subroutine is validated synchronously before it starts, so a mistake at
  // the prompt is reported as a failure of *this* command rather than
  // vanishing into a background task.
  const prepared = this.#runtime.subroutines.prepareRun(parsed.name, parsed.args);
  if (!prepared.ok) {
    this.#writeError(prepared.message);
    return { status: 'error', message: prepared.message };
  }

  // Deliberately not awaited: a long-running subroutine must not block the
  // prompt, so `list` and `stop` stay responsive while it works.
  void this.#runtime.subroutines.start(prepared.run).catch((error: unknown) => {
    this.#writeError(toMessage(error));
  });
  return { status: 'ok' };
}
```

Learn from the shape:

- **Early returns for the easy cases.** No nested `if/else` pyramids.
- **Return values, not exceptions.** `dispatch` answers with a status; the caller
  decides what it means. The one `try/catch` is around `builtin.run` because a
  command implementation may throw.
- **`void somePromise.catch(...)`** is the explicit "fire and forget, but do not
  let a rejection become unhandled". `void` says to the reader (and to linters)
  that dropping the promise is intentional. Every fire-and-forget needs a
  `.catch`; `void` plus `.catch` is the honest way to write it.
- **`prepared.ok` narrowing** is the discriminated union from section 5, doing
  real work: after `if (!prepared.ok) return …`, `prepared.run` is known to exist.

### The prompt: state that must stay in sync

```ts
#prompt(): void {
  if (this.#exitRequested || this.#closed || this.#busy) return;
  if (!isInteractive() || this.#promptVisible) return;
  this.#promptVisible = true;
  process.stdout.write(PROMPT);
}

#closePrompt(): void {
  if (!this.#promptVisible) return;
  process.stdout.write('\n');
  this.#promptVisible = false;
}
```

`#promptVisible` exists because asynchronous output — a subroutine finishing
while the prompt is displayed — would otherwise land on the same line as
`js-agent> `. So the observer closes the prompt, writes, and reopens:

```ts
#installObservers(): void {
  this.#runtime.tasks.observe((snapshot) => {
    if (snapshot.kind !== 'subroutine') return;
    if (this.#shuttingDown) return;

    const detail = snapshot.detail !== undefined ? ` · ${snapshot.detail}` : '';
    const line = `[${snapshot.id}] ${snapshot.name}: ${snapshot.state}${detail}`;
    this.#closePrompt();
    this.#write(line);
    this.#prompt();
  });
}
```

This is a small state machine expressed as a boolean. When you find yourself
tracking "is the prompt showing?", that is the moment to name it as a field
rather than infer it, because inference is what breaks.

### `runOnce` versus `runInteractive`

```ts
async runOnce(lines: readonly string[]): Promise<number> {
  this.#write(`js-agent ${this.#version} · ${this.#live ? 'LIVE input' : 'dry run'} · ` +
    `driver ${this.#live ? 'nut-js' : 'recorder'}`);
  this.#installObservers();

  let code = 0;
  const since = Date.now();

  for (const [index, line] of lines.entries()) {
    const { status } = await this.dispatch(line);
    if (status === 'error') code = 1;

    // A scripted sequence means "do this, then this", so settle before moving
    // on: otherwise `--exec "move-mouse …" --exec status` would report the
    // cursor from before the move it just asked for.
    //
    // The exception is a `stop` coming next — it must be able to interrupt
    // something that is still running, which is the whole point of it.
    const next = lines[index + 1];
    const stoppingNext = next !== undefined && parseCommandLine(next).name === 'stop';
    if (!stoppingNext) await this.#drain();
  }

  const failed = this.#runtime.subroutines
    .recent({ since })
    .filter((task) => task.state === 'failed');
  if (failed.length > 0) {
    this.#writeError(`${failed.length} subroutine run(s) failed:`);
    for (const task of failed) {
      const reason = task.error !== undefined ? `: ${task.error.message}` : '';
      this.#writeError(`  ${task.id} ${task.name}${reason}`);
    }
    code = 1;
  }

  await this.#teardown();
  return code;
}
```

Notable:

- **`.filter((task) => task.state === 'failed')`** returns `TaskSnapshot[]`; the
  predicate is a plain boolean check, no type predicate needed because the
  element type does not change.
- **Destructured tuple in the loop** `for (const [index, line] of lines.entries())`
  is the clean way to get both index and value.
- **`next !== undefined &&`** guards the index access before using `next`, which
  `noUncheckedIndexedAccess` requires.
- **Exit codes as the contract with the shell.** 0 success, 1 command or
  subroutine failure, 2 usage error. Counters that a script can branch on.

The banner for the interactive path comes from a pure function, which is why it
is testable:

```ts
export function renderBanner(agent: AgentHostSource, options: BannerOptions): string[] {
  const host = agent.hostInfo();
  return [
    '',
    `  js-agent ${options.version}  ·  target 0.01`,
    `  input driver   ${host.driver} (${options.live ? 'LIVE — real keyboard and mouse' : 'dry run — nothing is sent'})`,
    // ...
  ];
}
```

Returning `string[]` rather than writing to stdout is the difference between a
function you can assert on and one you cannot. **Push I/O to the edges; keep the
middle pure.** The test for it lives in
[`scripts/check.mjs`](../scripts/check.mjs) and simply matches the joined lines.

### Parsing, and a real lesson about quotes

[`src/shared/command-line.ts`](../src/shared/command-line.ts) splits a line
into a name and arguments, honouring single and double quotes:

```ts
const ARGUMENT_PATTERN = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;

export function parseArguments(input: string): string[] {
  const args: string[] = [];
  ARGUMENT_PATTERN.lastIndex = 0;     // ← crucial for a /g regex reused across calls
  let match: RegExpExecArray | null;
  while ((match = ARGUMENT_PATTERN.exec(input)) !== null) {
    const [, doubleQuoted, singleQuoted, bare] = match;
    if (doubleQuoted !== undefined) args.push(unescape(doubleQuoted));
    else if (singleQuoted !== undefined) args.push(unescape(singleQuoted));
    else if (bare !== undefined) args.push(bare);
  }
  return args;
}
```

- A regex with the `g` flag **carries state** (`lastIndex`). Module-level regexes
  reused across calls must reset it, or the second call silently skips matches.
  This is one of JavaScript's nastier footguns and TypeScript cannot catch it.
- Destructuring a `RegExpExecArray` with a hole — `const [, a, b, c] = match` —
  is succinct. Each group is typed `string | undefined`, and the explicit
  `!== undefined` checks satisfy `noUncheckedIndexedAccess`.
- The parser lives in `shared/`, not `terminal/`, because the `goto` subroutine
  also parses a mini-syntax inside one argument. Two consumers, one
  implementation.

---

## 12. Composition and entry: where it all comes together

### [`src/app.ts`](../src/app.ts) — the composition root

```ts
export async function createApp(options: CreateRuntimeOptions): Promise<App> {
  const { config } = options;
  const log = ConsoleLogger.create({ level: config.logLevel, prefix: 'js-agent' });

  const device = options.device ?? createDevice(config);
  const tasks = new TaskRegistry();
  const agent = new Agent({ device, tasks, logger: log });
  await agent.start();

  const subroutines = new SubroutineRegistry({
    agent,
    tasks,
    logger: log,
    subroutines: [...builtinSubroutines, ...(options.subroutines ?? [])],
  });

  let shuttingDown: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    // Idempotent: SIGINT during an `exit` command must not double-close things.
    shuttingDown ??= (async () => {
      tasks.controller.cancel('Shutting down');
      await subroutines.stopAll('Shutting down');
      await agent.stop();
      log.debug('runtime stopped');
    })();
    return shuttingDown;
  };

  const session = new TerminalSession({
    runtime: { agent, subroutines, tasks, log, shutdown },
    version: options.version,
    live: agent.hostInfo().live,
    logLevel: config.logLevel,
  });

  return { version: options.version, live: agent.hostInfo().live, config, agent, subroutines, tasks, session, shutdown };
}
```

This is the **composition root**: the one place where concrete implementations
are chosen and wired. Everywhere else in the program deals in interfaces. The
benefits are concentration — "what is this thing made of?" has exactly one
answer — and substitutability, since `options.device` lets a test inject a fake
driver with one line.

The shutdown function is worth studying:

```ts
let shuttingDown: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  shuttingDown ??= (async () => { /* ... */ })();
  return shuttingDown;
};
```

`let x: Promise<void> | undefined` then `??=` then returning the same promise:
this is **memoised async initialisation**, and it makes shutdown safe to call
from several places (the `exit` command, a SIGINT, the `finally` in `main`)
without running the teardown twice. An **IIFE** — `(async () => { … })()` — is
used to get a promise out of an async block inline.

Note that the ordering inside shutdown is load-bearing and commented only by its
sequence: cancel the program-wide token, stop the subroutines, then stop the
agent. Each step depends on the previous one having quiesced.

### [`src/index.ts`](../src/index.ts) — the entry point

```ts
async function main(argv: readonly string[]): Promise<number> {
  let config;
  try {
    config = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;                      // not ours: let it fail loudly
  }

  if (config.help) {
    process.stdout.write(renderCliHelp());
    return 0;
  }

  const app = await createApp({ config, version: readVersion() });

  const onInterrupt = (): void => app.session.interrupt();
  process.on('SIGINT', onInterrupt);

  try {
    return config.exec.length > 0
      ? await app.session.runOnce(config.exec)
      : await app.session.runInteractive();
  } finally {
    process.off('SIGINT', onInterrupt);
    await app.shutdown().catch(() => undefined);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`js-agent failed to start: ${message}\n`);
    process.exitCode = 1;
  });
```

- **`catch (error) { if (error instanceof CliError) … throw error; }`** is the
  "only catch what you understand" pattern. Anything unexpected is rethrown so it
  surfaces with a stack trace instead of masquerading as a usage error.
- **`process.exitCode = code` rather than `process.exit(code)`.** Setting the
  exit code lets Node exit naturally once handles close, so buffered output
  flushes. `process.exit()` truncates pending writes — a classic cause of
  mysteriously missing final log lines.
- **`try/finally` for signal handlers.** The `SIGINT` listener is removed on the
  way out, so a second Ctrl+C during shutdown cannot re-enter `interrupt()`.
- **`error.stack ?? error.message`** uses `??` because `stack` is optional on
  `Error` in the Node types.

`readVersion` shows graceful degradation and `unknown` narrowing:

```ts
export function readVersion(): string {
  try {
    const manifestUrl = new URL('../package.json', import.meta.url);
    const manifest: unknown = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'));
    if (
      typeof manifest === 'object' && manifest !== null &&
      typeof (manifest as { version?: unknown }).version === 'string'
    ) {
      return (manifest as { version: string }).version;
    }
  } catch {
    // A missing or malformed manifest must not stop the program from running.
  }
  return '0.0.0-dev';
}
```

`JSON.parse` returns `any`, which is unsafe to trust. Annotating
`const manifest: unknown` deliberately discards that and forces the runtime
checks below: `typeof manifest === 'object'`, `manifest !== null`, and the
version being a string. The intermediate `as { version?: unknown }` cast is how
you ask a question about an `unknown` without asserting the answer. This is the
honest way to consume external data.

---

## 13. TypeScript feature reference

A lookup table of everything the project uses, and where to see it.

### Types and declarations

| Feature | Example | Where |
|---|---|---|
| `interface` | `export interface InputDevice` | [`contract/input.ts`](../src/contract/input.ts) |
| `type` alias | `export type MouseButton = 'left' \| 'middle' \| 'right'` | [`contract/point.ts`](../src/contract/point.ts) |
| string-literal union | `export type TaskKind = 'subroutine' \| 'input'` | [`contract/tasks.ts`](../src/contract/tasks.ts) |
| array → union | `type TaskState = (typeof TASK_STATES)[number]` | [`contract/tasks.ts`](../src/contract/tasks.ts) |
| discriminated union | `PrepareRunResult`, `RecordedAction` | [`contract/subroutine.ts`](../src/contract/subroutine.ts), [`core/input/recording-input-device.ts`](../src/core/input/recording-input-device.ts) |
| intersection `&` | `SubroutineContext & { currentDetail: … }` | [`subroutines/registry.ts`](../src/subroutines/registry.ts) |
| optional property `?` | `detail?: string` | [`contract/tasks.ts`](../src/contract/tasks.ts) |
| `readonly` | `readonly name: string` | throughout the contract |
| `readonly T[]` | `readonly SubroutineParam[]` | [`contract/subroutine.ts`](../src/contract/subroutine.ts) |
| `Readonly<Record<K,V>>` | `Readonly<Record<string, string>>` | [`contract/subroutine.ts`](../src/contract/subroutine.ts) |
| `Required<Omit<T,K>>` | `Required<Omit<NutInputDeviceOptions, 'clock'>>` | [`core/input/nut-input-device.ts`](../src/core/input/nut-input-device.ts) |
| inline object type | `patch: { state?: TaskState; detail?: string }` | [`core/task-registry.ts`](../src/core/task-registry.ts) |
| function-typed property | `entry: (ctx: SubroutineContext) => Promise<void>` | [`contract/subroutine.ts`](../src/contract/subroutine.ts) |
| `as const` | `export const TIMING = { … } as const` | [`contract/input.ts`](../src/contract/input.ts) |
| `unique symbol` brand | `PreparedRun` | [`contract/subroutine.ts`](../src/contract/subroutine.ts) |
| generics | `Map<string, TaskRecord>`, `Promise<void>` | [`core/task-registry.ts`](../src/core/task-registry.ts) |
| type predicate | `(s): s is CancellationSignal => s !== undefined` | [`core/agent.ts`](../src/core/agent.ts) |
| `unknown` + narrowing | `toError(value: unknown)`, `readVersion` | [`core/agent.ts`](../src/core/agent.ts), [`app.ts`](../src/app.ts) |

### Classes

| Feature | Example | Where |
|---|---|---|
| private fields `#` | `#records`, `#open` | [`core/task-registry.ts`](../src/core/task-registry.ts) |
| `implements` | `class Agent implements AgentApi` | [`core/agent.ts`](../src/core/agent.ts) |
| getter-only property | `get ready(): boolean` | [`core/agent.ts`](../src/core/agent.ts) |
| default parameter | `constructor(options = {})` | [`core/task-registry.ts`](../src/core/task-registry.ts) |
| fluent `this` return | `register(…): this` | [`subroutines/registry.ts`](../src/subroutines/registry.ts) |
| parameter properties | `constructor(readonly token: string)` | [`core/input/keymap.ts`](../src/core/input/keymap.ts) |

**Parameter properties** are worth a note because they are the one TypeScript
feature this project uses that Node's type-*stripping* cannot handle: writing
`constructor(readonly token: string) {}` implicitly creates and assigns
`this.token`, which is real emitted code, not a type. It works under `tsx`
(which transforms) and under `node --experimental-transform-types`, but not under
strip-only mode. If you ever want to run this with `node --experimental-strip-types`
alone, those declarations must be expanded by hand.

### Functions and control flow

| Feature | Example | Where |
|---|---|---|
| optional parameter | `signal?: CancellationSignal` | [`contract/input.ts`](../src/contract/input.ts) |
| rest parameter | `...signals: (CancellationSignal \| undefined)[]` | [`core/agent.ts`](../src/core/agent.ts) |
| callback parameter | `run: (signal) => Promise<string>` | [`core/agent.ts`](../src/core/agent.ts) |
| contextually typed param | `async entry(ctx) { … }` | every subroutine |
| arrow vs declaration hoisting | `function onCancel()` used above its definition | [`contract/signals.ts`](../src/contract/signals.ts) |
| narrowing via `instanceof` | `if (error instanceof CliError)` | [`index.ts`](../src/index.ts) |
| narrowing via discriminant | `if (!prepared.ok) return …` | [`terminal/session.ts`](../../v0_01/src/terminal/session.ts) |
| optional chaining | `signal?.throwIfCancelled()` | [`core/input/nut-input-device.ts`](../src/core/input/nut-input-device.ts) |
| nullish coalescing | `options.charDelayMs ?? TIMING.charDelay` | [`core/input/nut-input-device.ts`](../src/core/input/nut-input-device.ts) |
| nullish assignment | `this.#starting ??= this.#openDevice()` | [`core/agent.ts`](../src/core/agent.ts) |

### Three flags that will change how you write code

1. **`strictNullChecks`** (via `strict`) — you will handle `undefined`. This is
   the feature that prevents most production crashes.
2. **`noUncheckedIndexedAccess`** — `arr[0]` is `T | undefined`. You will write
   `next !== undefined &&` guards, and they will be real.
3. **`noUnusedLocals` / `noUnusedParameters`** — dead code fails the build.

### A cast you should rarely write

```ts
// Avoid:
const device = value as InputDevice;

// Prefer a runtime check that narrows:
if (isInputDevice(value)) { /* here value IS InputDevice */ }
```

The project uses `as unknown as` exactly once
([`registry.ts`](../src/subroutines/registry.ts)) where the compiler genuinely
cannot know the relationship, and it is commented. Treat every `as` as a claim
you are making to the compiler, and be ready to justify it — a wrong `as` moves
an error from compile time to your users' runtime.

---

## 14. The async patterns used here

Five shapes recur. Recognising them makes the codebase readable quickly.

### 1. `async`/`await` with explicit `Promise<T>` return types

Every asynchronous method declares what it resolves to. `Promise<void>` is "await
it, no value". Declaring the return type is not required when the body makes it
obvious, but here it is done consistently so the contracts are visible from the
signature alone.

### 2. Fire-and-forget with a catch

```ts
void this.#runtime.subroutines.start(prepared.run).catch((error: unknown) => {
  this.#writeError(toMessage(error));
});
```

Used when starting work that must not block the caller. The `void` marks the
intent; the `.catch` prevents an unhandled rejection from killing the process.
Both halves are mandatory.

### 3. Waiting for quiescence, not sleeping

```ts
whenIdle(kind?: TaskKind): Promise<void>
```

Instead of polling "are we done yet?", the registry resolves a promise when its
waiter list empties. This is event-driven waiting, and it is why `stop` returns
promptly instead of after a guessed timeout.

### 4. Memoised async initialisation

```ts
this.#starting ??= this.#openDevice();
await this.#starting;
```

Store the *promise*, not a boolean. Concurrent callers share one operation.

### 5. Settle-exactly-once guards

```ts
let settled = false;
const finish = (): boolean => {
  if (settled) return false;
  settled = true;
  signal.offCancel(onCancel);
  return true;
};
```

Whenever a promise can settle from multiple sources, funnel them all through one
guard. Promise resolution is idempotent, but *never resolving* is the failure
mode that hangs a program.

### The bug that produced section 5's `PrepareRunResult`

This is worth telling in full because the reasoning is the lesson.

The original `SubroutineRegistry.run` was `async` and called `resolveParams`
inside its body:

```ts
async run(name, rawParams, options = {}): Promise<SubroutineRunResult> {
  const subroutine = this.get(name);
  if (subroutine === undefined) throw new Error(`Unknown subroutine "${name}".`);
  const params = resolveParams(subroutine, rawParams);   // throws on bad args
  // ...
}
```

The terminal called it without awaiting (correctly — a subroutine may run for
minutes):

```ts
void this.#runtime.subroutines.run(name, args).catch((error) => {
  this.#writeError(toMessage(error));
});
return { status: 'ok' };
```

Run `press-key` with no arguments and:

```console
js-agent> press-key
"press-key" needs chord: keys joined with "+", e.g. ctrl+shift+t or enter
js-agent>
```

It *looked* right. `--exec "press-key"` even printed the error. But the exit code
was **0**, so a script would treat "I gave you bad arguments" as success.

The cause: `resolveParams` throws *inside an `async` method*, so the throw does
not propagate synchronously — it becomes a rejected promise. The `try/catch`
guarding the call therefore never fired, and `dispatch` fell through to
`return { status: 'ok' }`. The error text came from the `.catch`, asynchronously,
long after the status had been reported.

Fixing it required making the decision point synchronous:

```ts
const prepared = this.#runtime.subroutines.prepareRun(parsed.name, parsed.args);  // sync
if (!prepared.ok) return { status: 'error', message: prepared.message };
void this.#runtime.subroutines.start(prepared.run).catch(/* … */);
```

`prepareRun` is synchronous and returns a discriminated union, so `dispatch` can
report the failure immediately. `start` remains async and keeps the fire-and-forget
behaviour.

**The transferable rules:**

- An `async` function never throws synchronously. If a caller needs to react
  immediately, give them a synchronous function or a result object.
- Prefer a `{ ok: true } | { ok: false }` union over exceptions at API
  boundaries where you want the caller to handle failure deliberately.
- When you see `throw` inside `async`, ask who is going to observe it, and when.

---

## 15. Testing: `scripts/check.mjs`

**File:** [`scripts/check.mjs`](../scripts/check.mjs)

The checks are plain Node, with no test framework. That is a deliberate choice
for a codebase with no test dependency yet: a check that needs only Node will
still run in a year.

```js
function run(commands, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const argv = [tsx, entry];
    for (const command of commands) argv.push('--exec', command);

    const child = spawn(process.execPath, argv, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    // A case that hangs is a failure, not a reason to wait forever.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ output, code: 'timeout' });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output, code });
    });
  });
}
```

Points worth internalising:

- **Each case runs in its own process.** No shared state, no ordering
  dependencies, no "works when run alone" flakiness.
- **Assertions are regexes against real output.** That tests the program as a
  user experiences it — including its wording — rather than testing internal
  functions in isolation. It is a *behavioural* suite.
- **Timeouts are failures.** A hung process is the worst kind of broken, because
  it blocks everything else. The timer converts a hang into a report.
- **Cases are declared as data:**

  ```js
  check('stop cancels a running subroutine', ['demo test-text 3000', 'stop'], [
    ['reports the stop', /Stopped 1 run\(s\): 1 cancelled/],
    ['logs the cancellation', /WARN\s+\[js-agent\/demo\] cancelled/],
  ]);
  ```

  A name, the commands to feed, and labelled expectations. Adding a case is one
  call. `options.expectCode` covers tests that must fail.

- **A filter argument** (`node scripts/check.mjs cancel`) runs a subset, which is
  what makes debugging a single failure pleasant.

### Why the suite caught real bugs

Every bug listed here was found by running, not by reading:

| Bug | How the suite surfaced it |
|---|---|
| `stop` hung forever | the timeout fired instead of a clean exit |
| progress note overwritten by `"starting"` | an assertion on the status line failed |
| bad arguments exited 0 | `expectCode: 1` was not met |
| `press-key a` rejected a valid letter | a case asserting single letters work |
| `--exec` swallowed failures | the failure-report assertion never matched |
| `move-mouse` took 1000+ native calls | live testing showed seconds per move |

That table is the argument for writing behavioural checks early: **each of those
was invisible to the type checker.**

### `scripts/smoke.mjs`

A smaller helper for ad-hoc poking. It exists because passing quoted arguments
through a shell is error-prone (section 17), and it avoids the problem entirely
by handing the child a real argv array:

```bash
node scripts/smoke.mjs "type-text \"hello world\"" "list" "stop"
```

---

## 16. How to extend the program

### Recipe A — a new subroutine

1. Create `src/subroutines/builtin/<name>.ts`.
2. Annotate the object `: Subroutine` and give it `name`, `summary`, `params`,
   and an `async entry(ctx)`.
3. Use only `ctx.*`: `ctx.agent`, `ctx.signal`, `ctx.param`, `ctx.paramOr`,
   `ctx.status`, `ctx.log`, `ctx.sleep`.
4. Check `ctx.signal.throwIfCancelled()` between steps.
5. Add it to `builtinSubroutines` in
   [`builtin/index.ts`](../src/subroutines/builtin/index.ts).
6. Add a case to `scripts/check.mjs`.

```ts
// src/subroutines/builtin/save-file.ts
import type { Subroutine } from '../../contract/index.js';

export const saveFile: Subroutine = {
  name: 'save-file',
  summary: 'press ctrl+s and wait for the dialog',
  params: [
    { name: 'wait-ms', required: false, description: 'settle time', defaultValue: '500' },
  ],

  async entry(ctx) {
    ctx.signal.throwIfCancelled();
    await ctx.agent.pressKey({ chord: ['ctrl', 's'] });
    ctx.status('waiting for the dialog');
    await ctx.sleep(Number(ctx.paramOr('wait-ms', '500')));
    ctx.status('done');
  },
};
```

Note `entry(ctx)` has no parameter type — it is inferred from `: Subroutine`.
That is the payoff of annotating the object rather than each member.

### Recipe B — a new terminal command

Only if it is about *controlling the program*. Anything that sends input is a
subroutine, not a command.

1. Add a `Command` object to [`commands.ts`](../src/terminal/commands.ts) and
   include it in `COMMANDS`.
2. Use `context.write` for output and `context.requestExit()` to ask the session
   to quit — never `process.exit`.
3. If it must not run while things are in flight, use
   `context.subroutines.stopAll()`.

### Recipe C — a new input capability

1. Add the request type and the method to `InputDevice` in
   [`contract/input.ts`](../src/contract/input.ts).
2. The compiler now lists every place that must change — both device
   implementations. This is `implements InputDevice` earning its keep.
3. Add the pass-through on `AgentApi` and `Agent.#performInput`.
4. Mention it in the heading of `NutInputDevice` if it has real-world caveats.

### Recipe D — a different execution backend

Implement `InputDevice` (like `RecordingInputDevice` does) and pass it via
`createApp({ device })`. Nothing else changes.

---

## 17. Debugging playbook

### The commands you will actually use

```bash
npm run check                  # type errors only
npm test                       # behaviour
npm test -- cancel             # a subset, by name substring
node scripts/smoke.mjs "help"  # ad-hoc, with safe quoting
npm start -- --log-level debug # verbose logging
npm start -- --log-level debug --exec "press-key crtl+c"   # one command, then exit
```

`--exec` is the primary debugging tool: it runs commands in order, settles
between them, reports failures with the exit code, and exits. It is how every
fixed bug in this project was isolated.

### Reading a module-not-found error

TypeScript prints the exact path it tried. **Read that path before theorising.**

```
error TS2307: Cannot find module '../contract/index.js'
```

candidates were `v0_01/contract/index.js` — meaning the compiler thought
`src/app.ts` was one directory shallower than it is, which pointed straight at
the wrong relative specifier. I spent far too long suspecting a compiler bug
before reading the trace properly. It was my path.

### Understanding task ids

Ids come from one counter shared by both kinds: `sub-1`, `in-2`, `sub-3`,
`in-4`. So subroutine ids are **not consecutive**, and a test asserting `sub-2`
after `sub-1` will fail. This is intentional — one counter means one unambiguous
ordering across all work — but it surprises people reading `list` output.

### `list --all` and vanished history

The registry keeps only the most recent 500 finished tasks
(`historyLimit`). Long sessions will forget older runs. Active tasks are never
pruned.

### Why your run finished before you could look at it

Input delays are small (28 ms per character by default), so a short subroutine
can complete before the next command is dispatched. Note also that `type-text`
sends its text in chunks of 40 characters, so a run shorter than that reports a
single progress update rather than a count-up. To observe an in-flight state,
slow it down and make it longer than one chunk:

```bash
node scripts/smoke.mjs "type-text aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 200"
```

### Windows and PowerShell quoting

PowerShell rebuilds the command line when handing arguments to a native
executable, and it mangles embedded quotes. You will see `Unexpected argument
"2>&1"` or `Unexpected argument "text 5000 100 100"` — errors from *your own*
argument parser, because the shell split an argument it should have preserved.
Also note that with `--%` (stop-parsing) a trailing `2>&1` becomes a literal
argument.

Three ways out, in order of preference:

1. `node scripts/smoke.mjs "command with \"quotes\""` — argv is passed directly.
2. `cmd /c 'node … --exec "..."'` — single quotes for PowerShell, double for the
   child.
3. Wrap the whole thing in a script file.

Prefer `type-text hello world` to quoted forms; the `rest` parameter exists so
you rarely need quoting at all.

### `esbuild`/`tsx` and sandboxed environments

Under a confined sandbox, `tsx` fails with `spawn EPERM`. This is not a code
problem: `esbuild` launches its service with `stdio: ['pipe','pipe','inherit']`,
and the sandbox forbids child processes from opening pipes. Options are to run
with wider permissions, or to use Node's own TypeScript support:

```bash
node --experimental-transform-types src/app.ts   # handles parameter properties
```

`node --experimental-strip-types` alone will reject parameter properties
(section 13).

---

## 18. Glossary

| Term | Meaning in this codebase |
|---|---|
| **agent** | The core that turns requests into real input. `Agent` in `src/core/agent.ts`. |
| **subroutine** | A named, scripted behaviour built from agent primitives. |
| **driver / device** | An `InputDevice` implementation: `NutInputDevice` (real) or `RecordingInputDevice` (dry run). |
| **task** | One tracked unit of work, `kind: 'subroutine' \| 'input'`, with a state and cancellation token. |
| **signal** | The read-only cancellation handle passed into work. |
| **token** | The writable cancellation source. `CancelToken`. |
| **cancelled vs failed** | Deliberate distinction: `stop` produces `cancelled`, a real error produces `failed`. |
| **dry run** | Running against the recording driver. Nothing reaches the OS. |
| **live** | Running against the real driver. |
| **contract** | `src/contract/` — shared types only, the seam between halves. |
| **composition root** | `src/app.ts` — the one place concrete implementations are chosen. |
| **quiescence / idle** | No task of a given kind is pending or running. `whenIdle`. |
| **drain** | Wait for all work to reach quiescence. `TerminalSession.#drain`. |

---

## 19. Where to go next

Read in this order, and change something as you go:

1. [`src/contract/input.ts`](../src/contract/input.ts) and
   [`tasks.ts`](../src/contract/tasks.ts) — the vocabulary. Small, and
   everything else refers to it.
2. [`src/subroutines/builtin/press-key.ts`](../src/subroutines/builtin/press-key.ts)
   — the smallest complete behaviour. Understand it and you can write
   subroutines.
3. [`src/core/input/recording-input-device.ts`](../src/core/input/recording-input-device.ts)
   — an interface implementation you can read without native code in the way.
4. [`src/core/task-registry.ts`](../src/core/task-registry.ts) — the state
   machine that makes `list` and `stop` possible.
5. [`src/contract/signals.ts`](../src/contract/signals.ts) — cancellation,
   including the settle-once guard.
6. [`src/core/agent.ts`](../src/core/agent.ts) — the input pipeline.
7. [`src/subroutines/registry.ts`](../src/subroutines/registry.ts) — running
   behaviour as tracked work, and the sync/async split.
8. [`src/terminal/session.ts`](../../v0_01/src/terminal/session.ts) — dispatch, the
   prompt, and shutdown.
9. [`src/app.ts`](../src/app.ts) and [`src/index.ts`](../src/index.ts) —
   wiring and entry.

### Exercises, easiest first

1. Add a `pause` subroutine: `<ms>` argument, `ctx.sleep`, a status line. Then
   `stop` it mid-sleep and confirm it reports `cancelled`.
2. Add a `--trace` flag that prints the recording driver's action log
   (`RecordingInputDevice.actions` already keeps it) when the program exits.
3. Change `list` to also show elapsed time for finished runs. Note where the
   timestamp lives and whether you need a new field on `TaskSnapshot`.
4. Make the duplicate-run guard allow the same subroutine twice, and decide how
   `stop` should then behave. Predict which existing test breaks before you run
   it.
5. Write a second `InputDevice` that logs every call to a file instead of
   performing it. Wire it via `createApp({ device })` and confirm no other file
   needed editing — that is the architecture proving itself.
6. Deliberately introduce the old bug: move `prepareRun`'s validation into
   `start`. Run `npm test` and watch `expectCode: 1` catch what the type checker
   happily accepted.

Exercise 6 is the most valuable. Reproducing a bug you have already read about
is how the lesson sticks.
