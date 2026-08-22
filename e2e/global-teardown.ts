import { globalTeardown } from './guard';

/**
 * Playwright globalTeardown entry point (wired in playwright.config.ts). Runs ONCE in the Playwright
 * main process after all tests: releases the machine-wide lock. All logic lives in ./guard so the
 * three forked harnesses stay in lockstep.
 */
export default globalTeardown;
