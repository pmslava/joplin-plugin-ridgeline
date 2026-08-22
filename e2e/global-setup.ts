import { globalSetup } from './guard';

/**
 * Playwright globalSetup entry point (wired in playwright.config.ts). Runs ONCE in the Playwright main
 * process before any test worker spawns Joplin: acquires the machine-wide lock, sweeps orphans left by
 * previous dead runs, and applies the soft RAM gate. All logic lives in ./guard so the three forked
 * harnesses stay in lockstep.
 */
export default globalSetup;
