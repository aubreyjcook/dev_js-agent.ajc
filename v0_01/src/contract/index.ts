/**
 * Shared vocabulary for the whole program.
 *
 * This module is the *seam* between the two halves of the agent:
 *
 *   - `src/core`         the agent: owns hardware input (keyboard/mouse)
 *   - `src/subroutines`  scripted behaviours that drive the agent
 *
 * Neither half may import from the other. Both may import from `src/contract`.
 * Editing this folder is a deliberate API change that affects both halves, so
 * everything here is intentionally small and implementation-free (types only).
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
