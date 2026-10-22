# Roadmap — `v0_03` and beyond

Written when v0_02 was finished. It answers: what should come next, in what
order, why, and how we will know it is done.

**This is a plan, not a promise.** Items have acceptance criteria so they can be
argued with before they are built. Items marked *decision needed* require a call
before implementation; they are collected at the end.

Sizes are rough: **S** ≈ an afternoon, **M** ≈ a day or two, **L** ≈ a week of
part-time work.

---

## Where v0_02 left off

Done: one owner of the hardware; many clients; a versioned protocol; discovery;
single-instance locking; detached lifecycle; 45 behaviour checks.

The known limits are the raw material for this roadmap:

1. **No authentication or authorisation.** Any process that can open the socket is
   trusted, and any client can `stop` or `shutdown`.
2. **No client identity.** A run does not say which terminal started it.
3. **`--live` is all-or-nothing.** Any attached client can drive the real
   keyboard and mouse.
4. **Printable ASCII only.** Text with accents, emoji or CJK cannot be typed.
5. **No interactive conveniences.** No completion, no history, no structured
   output for scripting.
6. **Fixed extensibility.** Subroutines are compiled into the program; a run
   returns nothing but success/failure.
7. **Operations are thin.** No log rotation, no health signal, no reload.
8. **One platform verified.** No CI matrix, and the interactive paths have no PTY
   tests.

---

## Themes for v0_03

The next version should make the daemon **trustworthy** before making it
**pleasant**. A service that any local process can drive, and that any client can
shut down, is not something to build ergonomics on top of.

Proposed theme: **“Trusted local clients.”**

---

## P0 — Security and trust

### 1. Handshake authentication — **M** · *decision needed*

**Why.** Today “can open the socket” equals “full control”. On a shared account
that is unacceptable, and it blocks every other security feature.

**Sketch.**
- On start, the daemon generates a 32-byte random token.
- It writes `session.token` into the state directory with owner-only permissions
  (`0600` on POSIX; on Windows, tighten the ACL or document the gap).
- `hello` carries the token; the daemon compares in constant time.
- A missing or wrong token gets `problem` and the connection closes.
- The token rotates on every daemon start; clients read it from the state
  directory, so “same user, same state dir” is the trust boundary.

**Acceptance.**
- Unauthenticated clients can `ping` only, and are refused for everything else.
- A wrong token is indistinguishable from a missing one in timing.
- Tests: correct token works; wrong token is refused; token file mode is 0600 on
  POSIX.

**Open.** Whether to keep an explicit `--no-auth` escape hatch for local
development (with a loud warning), or make auth mandatory.

### 2. Capability policy — **M** · *decision needed*

**Why.** Authentication says *who*; authorisation says *what*. Even with a token,
one careless script with full rights can shut down the service.

**Sketch.**
- Client roles at connect time: `control` (everything) and `read` (`help`,
  `list`, `status` only).
- The daemon enforces roles server-side; the client only displays what it was
  granted.
- Policy source: a flag (`--allow read`) or a small `policy.json` in the state
  directory.

**Acceptance.**
- A `read` client receives an error result for `stop`, `shutdown`, and any
  subroutine.
- The refusal names the reason, not just “denied”.
- Tests cover both roles against every built-in command.

**Open.** Whether roles are enough, or per-subroutine allowlists are needed now
(they may be YAGNI until plugins exist — item 13).

### 3. Client identity and attribution — **S**

**Why.** “Who started this run?” is the first question anyone asks in a shared
daemon, and it is currently unanswerable.

**Sketch.**
- `hello` already carries `clientName`; send the pid and a short id too.
- `TaskSnapshot` gains `startedBy?: { clientId, clientName }`.
- `list` shows the owner; `list --all` too; logs include the client id.

**Acceptance.**
- Two clients starting different runs produce rows that identify each owner.
- A run started before a client disconnected keeps its attribution.
- Tests assert the field appears and survives disconnect.

### 4. Live-mode guardrails — **S/M** · *decision needed*

**Why.** `--live` plus a daemon means any attached terminal can type into your
real desktop. The banner warns; that is not a control.

**Sketch.**
- The daemon requires an explicit `--allow-live` flag to start with the real
  driver; `--live` without it is refused with an explanation.
- Attached clients get a confirmation prompt before their first input command,
  bypassable with `--yes` (for scripts).
- `status` states loudly that live input is enabled and how many clients may use
  it.

**Acceptance.**
- A live daemon cannot be started without the explicit flag.
- A non-interactive client without `--yes` is refused before any input.
- Dry-run mode is unaffected.

**Open.** Whether confirmation belongs in the client (visible) or the daemon
(authoritative). Probably both: client prompts, daemon enforces.

---

## P1 — Safety and usability

### 5. Unicode text via the clipboard — **M**

**Why.** The driver presses keycodes, so it can only reproduce ASCII. Clipboard
paste is the standard workaround and unlocks real-world text.

**Sketch.**
- A `paste-text` subroutine: save the current clipboard, set it, send
  `ctrl+v` (or `shift+insert`), restore the clipboard.
- Make `type-text` fall back to paste when the text is not ASCII, behind an
  explicit `--paste` flag at first.
- Use nut-js’s clipboard API; it is already a dependency.

**Acceptance.**
- A string with accents, emoji and CJK round-trips into a text editor in a manual
  test.
- The previous clipboard contents are restored on success and on failure.
- A dry run records a paste action without touching the clipboard.

### 6. Destructive-action confirmations — **S**

**Why.** Some subroutines (`goto` opens a browser; future ones may delete things)
are more consequential than typing.

**Sketch.** A `dangerous: true` flag on a subroutine. Interactive clients prompt;
non-interactive clients require `--yes`. The daemon records the decision.

**Acceptance.** Dangerous subroutines cannot run without either an interactive
confirmation or an explicit flag, in both local and attached sessions.

### 7. Per-client event verbosity — **S**

**Why.** Attached clients currently receive every log record the daemon emits.
A client that only wants task progress cannot opt out, and `--log-level debug`
on the daemon floods every terminal.

**Sketch.** `--events all|tasks|none` on the client; the daemon filters per
connection (it already tracks per-client state).

**Acceptance.** A `tasks` client receives task events and no log records;
behaviour is unchanged when the flag is absent.

### 8. Disconnected-client cleanup — **S**

**Why.** Resources are per connection (timers, pending requests). They are
cleaned up today, but there is no test that holds the daemon to it over many
connect/disconnect cycles.

**Sketch.** Add a soak case: 200 connect/disconnect cycles, assert client count
returns to zero and the listener still accepts.

**Acceptance.** No growth in memory or handles beyond a small threshold; no
lingering sessions in `status`.

---

## P2 — Ergonomics

### 9. Completion and history — **M**

**Why.** The prompt knows every command, subroutine and argument name; typing them
is unnecessary friction.

**Sketch.** A readline `completer` built from the registry and the `params`
metadata; history persisted to `<state-dir>/history` for the local session.

**Acceptance.** Tab completes command names and subroutine names; history survives
a restart; completion is disabled cleanly when stdout is not a TTY.

### 10. Structured output — **S/M**

**Why.** Scripts currently scrape human text, which is brittle.

**Sketch.** `--json` for `list`, `status` and `help`. One stable envelope
(`{ ok, data }`), documented as a compatibility surface with its own version.

**Acceptance.** `list --json` parses in a test; the schema is documented and
unchanged by cosmetic edits to the human output.

### 11. Follow mode — **S**

**Why.** Watching a long run from a second terminal currently means polling.

**Sketch.** `attach --follow`: print events only, no prompt, until Ctrl+C.

**Acceptance.** A follow client prints progress for work started by another
client and exits cleanly on Ctrl+C.

### 12. Targeted waits — **S**

**Why.** `wait` waits for everything. A script may want one run.

**Sketch.** `wait <task-id>` and `list --watch`; the broker already reports task
state.

**Acceptance.** Waiting for a specific id returns when that run finishes, even if
other runs continue.

---

## P3 — Extensibility

### 13. Loadable subroutines — **L** · *decision needed*

**Why.** New behaviours currently require editing and rebuilding the program.
Loading them from a directory makes the subroutine layer a real extension point.

**Sketch.**
- `~/.js-agent/subroutines/*.mjs`, each exporting a `Subroutine` object.
- A manifest with a name, version and API version; refuse mismatches.
- A trust step: the daemon lists files and requires an explicit enable flag, or
  records a hash in the state directory on first load.
- The registry already supports `register()`, so the agent and protocol do not
  change.

**Acceptance.** A new file appears in `help` after a restart or reload; a broken
plugin cannot prevent the daemon from starting; the API version is enforced.

**Open.** Whether plugins may be `dangerous`, and whether they run with any
sandboxing (probably none — say so explicitly).

### 14. Subroutine results — **S/M**

**Why.** A run currently reports only success or failure. Useful behaviours want
to return data (“the URL I opened”, “the text I read”).

**Sketch.** Allow `entry` to return a JSON-serialisable value; store it on the
task snapshot; include it in `result` and `list --json`.

**Acceptance.** A test subroutine returns a value that survives to the client;
existing subroutines are unaffected.

### 15. Per-subroutine concurrency policy — **S**

**Why.** “One run per name” is a safe default, but a future `append-log` may
legitimately run twice. Today that is impossible.

**Sketch.** `concurrency: 'singleton' | 'parallel' | { queue: n }` on the
subroutine; the registry enforces it.

**Acceptance.** A `parallel` subroutine can run twice concurrently and both are
listed; `singleton` still refuses duplicates.

### 16. Broader agent capabilities — **L** · *decision needed*

**Why.** Keyboard and mouse are a subset of “control this machine”. Windows, the
clipboard, and screen reading are natural next steps.

**Sketch.** Extend `AgentApi` and `InputDevice` deliberately, one capability at a
time, with the recording driver implementing each one so it stays testable.

**Acceptance.** Each capability lands with a dry-run implementation, a contract
change, and documentation — never one without the others.

**Open.** Which capability actually earns its place first; this should be driven
by a real use case, not by completeness.

---

## P4 — Operations

### 17. Log rotation — **S**

**Why.** A detached daemon writes `daemon.log` forever.

**Sketch.** `--log-max-bytes`, keep N rotated files; rotate on write threshold.

**Acceptance.** A test writes enough lines to force rotation and checks that the
active file stays under the cap and old files are bounded.

### 18. Health signal — **S**

**Why.** “Is it healthy?” currently requires connecting and sending a command.

**Sketch.** `daemon.json` gains `lastHeartbeatAt`, updated periodically; a
`--status` CLI flag prints a one-line summary (pid, endpoint, clients, uptime)
without attaching.

**Acceptance.** `--status` works with no side effects and exits non-zero when no
daemon is found.

### 19. Graceful reload — **M**

**Why.** Changing log level or loading new subroutines should not drop clients.

**Sketch.** `SIGHUP` re-reads configuration and re-registers plugins; connections
survive.

**Acceptance.** A client stays connected across a reload; invalid new config is
rejected without disturbing the running daemon.

### 20. Protocol compatibility policy — **S**

**Why.** v0_02 refuses any version mismatch. That is safe but blunt once versions
proliferate.

**Sketch.** Decide and document: either strict equality (current) with a clear
upgrade path, or a minor-version negotiation for additive messages. Add a test
that a v1 daemon and a hypothetical v2 client fail predictably.

**Acceptance.** The policy is written down, tested, and referenced by
`PROTOCOL_VERSION`.

---

## P5 — Quality

### 21. CI matrix — **M**

**Why.** Only Windows has been exercised. Pipes, POSIX socket permissions and
process signals all differ.

**Sketch.** GitHub Actions: Windows, Ubuntu, macOS; Node 20 and 22; typecheck,
unit/behaviour suite, TCP and pipe transports.

**Acceptance.** All three platforms green on `main`.

### 22. PTY tests for interactive paths — **M**

**Why.** The menu, prompt handling and Ctrl+C are only tested through a pipe
(no TTY), so the primary UX is under-tested.

**Sketch.** A PTY helper (e.g. `node-pty`) that drives the real prompt: choose a
mode, run a command, press Ctrl+C, assert the transcript.

**Acceptance.** At least three interactive scenarios are covered: menu selection,
prompt output ordering, and detach on Ctrl+C.

### 23. Property-based framing tests — **S**

**Why.** Framing is where byte-level bugs hide: split UTF-8, split messages,
oversized input.

**Sketch.** Generate arbitrary chunk splits of valid message streams and assert
the decoded sequence is identical; assert a peer that never sends a newline is
disconnected.

**Acceptance.** 1,000 randomised cases pass; the size ceiling is enforced.

### 24. Soak and leak test — **S**

**Why.** A daemon is long-lived. Per-command listener growth was a real bug in
v0_01 and deserves a guardrail.

**Sketch.** 10,000 commands through one daemon; assert stable memory, stable
client count, no listener growth.

**Acceptance.** Runs in under a minute in CI (dry run, fast clock).

### 25. Compiled distribution — **M**

**Why.** `npm start` requires `tsx`, which is a development dependency and cannot
run in some restricted environments.

**Sketch.** A `build` script (`tsc` to `dist/`), an entry point that runs under
plain `node`, and a `bin` that points at the built file.

**Acceptance.** A fresh clone can `npm ci && npm run build && node dist/index.js`
with no `tsx`; the test suite passes against the built output.

### 26. Runtime preflight for unsupported Node — **S**

**Why.** The project requires Node 20+, but that is only enforced by `engines`
(a warning) and by the checks’ own guard. Running the program on Node 16 fails
inside `tsx` with module errors that suggest a broken install rather than an old
runtime — a confusing first experience.

**Sketch.** A version check at the top of `index.ts` that prints a one-line
explanation plus `nvm use 24`, and exits 2 before importing anything that needs a
modern runtime. The check script already does this; move the same logic into the
program.

**Acceptance.** `node index.ts --help` on Node 16 explains the requirement and
exits 2. On Node 20+ it is invisible. A test asserts both branches (the old one
can run the built file under a known-old runtime, or the check can be factored
into a function that takes a version string).

---

## Explicit non-goals

To keep the scope honest:

- **Remote network access.** The daemon is local by design; exposing it is a
  different security model.
- **Multi-user server.** One state directory, one user.
- **GUI or tray application.**
- **Screen understanding (OCR, vision, element finding).** That is a different
  product; this one injects input and coordinates.
- **A macro recorder/playback format.** Subroutines already are the format.

---

## Sizing and dependencies

| # | Item | Size | Depends on |
|---|---|---|---|
| 1 | Auth token | M | — |
| 2 | Capability policy | M | 1 |
| 3 | Client identity | S | 1 |
| 4 | Live guardrails | S/M | 1, 2 |
| 5 | Clipboard/paste | M | — |
| 6 | Dangerous confirmations | S | 2 |
| 7 | Event verbosity | S | — |
| 8 | Disconnect cleanup test | S | — |
| 9 | Completion/history | M | — |
| 10 | JSON output | S/M | — |
| 11 | Follow mode | S | 7 |
| 12 | Targeted waits | S | — |
| 13 | Plugin subroutines | L | 1, 2, 6 |
| 14 | Subroutine results | S/M | 13 |
| 15 | Concurrency policy | S | — |
| 16 | New capabilities | L | 5 |
| 17 | Log rotation | S | — |
| 18 | Health signal | S | — |
| 19 | Reload | M | 13 |
| 20 | Protocol policy | S | — |
| 21 | CI matrix | M | — |
| 22 | PTY tests | M | — |
| 23 | Framing properties | S | — |
| 24 | Soak test | S | — |
| 25 | Compiled build | M | — |
| 26 | Runtime preflight | S | — |

---

## Proposed v0_03 milestone: “trusted local clients”

A focused release, not everything above.

**M1 — authentication and identity**
1. Token authentication (#1).
2. Client identity and attribution (#3).
3. `--status` health signal (#18) so the daemon is observable while testing.

**M2 — permission and live safety**
4. Capability policy (#2).
5. Live-mode guardrails (#4).
6. Dangerous-action confirmations (#6) if the policy needs them.

**M3 — proof**
7. PTY tests for the interactive paths (#22).
8. CI matrix (#21).
9. Framing property tests (#23).

**Exit criteria for v0_03**

- Unauthenticated and read-only clients are refused the right things, with clear
  messages, proven by tests.
- Every run records which client started it.
- A live daemon cannot be started without an explicit flag, and cannot be driven
  by a non-interactive client without an explicit acknowledgement.
- Interactive paths are tested through a PTY, and all three platforms are green.
- Documentation: `V0_03-CHANGES.md`, an updated user guide, and this roadmap for
  v0_04.

Items deliberately deferred to v0_04+: plugins, new capabilities, completion and
structured output. They are valuable, but they all rest on a trust model that
does not exist yet.

---

## Open questions

These are the decisions worth settling before writing code. Each changes the
shape of the work, not just its details.

1. **Auth default.** Mandatory token, or opt-out for development? A mandatory
   token changes every documented example and the test fixtures.
2. **Roles versus allowlists.** Is `control` / `read` enough, or is per-command
   policy needed immediately? The answer decides how plugins will be governed.
3. **Confirmation location.** Should “are you sure?” live in the client, the
   daemon, or both? Client-only is bypassable; daemon-only cannot show context.
4. **Plugin trust.** When loadable subroutines arrive, is “same user, opted in”
   acceptable, or must each plugin be explicitly enabled by hash?
5. **Compatibility promise.** Strict protocol equality, or negotiated minor
   versions? This affects how clients and daemons are released together.
6. **Which new capability first**, if any — clipboard is already covered by #5;
   window management and screen reading need a concrete use case before they
   earn contract changes.

Answering 1–3 is enough to start v0_03.
