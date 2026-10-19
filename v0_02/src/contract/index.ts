/**
 * Shared vocabulary for the whole program.
 *
 * This module is the *seam* between the halves of the program:
 *
 *   - `src/core`         the agent: owns hardware input (keyboard/mouse)
 *   - `src/subroutines`  scripted behaviours that drive the agent
 *   - `src/terminal`     the front ends (local prompt and remote client)
 *   - `src/daemon`       the transport and service plumbing added in v0_02
 *
 * The agent and the subroutines never import each other; the terminal and the
 * daemon never import the agent's internals. All four may import from
 * `src/contract`. Editing this folder is a deliberate API change, so everything
 * here is intentionally small and implementation-free (types only).
 *
 * @module contract
 */

export * from './point.js';
export * from './input.js';
export * from './signals.js';
export * from './logger.js';
export * from './agent-api.js';
export * from './tasks.js';
export * from './subroutine.js';
export * from './commands.js';
export * from './events.js';
export * from './protocol.js';
export * from './transport.js';
