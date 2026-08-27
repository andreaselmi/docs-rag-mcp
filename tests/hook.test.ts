import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STATE,
  DEBOUNCE_MS,
  STALE_RUN_MS,
  shouldTrigger,
  onEvent,
  onSleeperWake,
  failureNotice,
  type HookState,
} from "../src/hook.js";

// ---- shouldTrigger -------------------------------------------------------

test("shouldTrigger accepts markdown files", () => {
  assert.equal(shouldTrigger("/proj/docs/auth.md"), true);
  assert.equal(shouldTrigger("notes/readme.md"), true);
});

test("shouldTrigger rejects non-markdown, missing paths, and .rag/ internals", () => {
  assert.equal(shouldTrigger("/proj/src/main.ts"), false);
  assert.equal(shouldTrigger(undefined), false);
  assert.equal(shouldTrigger("/proj/.rag/hook.log"), false);
  // even a .md under .rag/ must not trigger (no self-feeding loops)
  assert.equal(shouldTrigger("/proj/.rag/whatever.md"), false);
  assert.equal(shouldTrigger(".rag/nested/file.md"), false);
});

// ---- onEvent -------------------------------------------------------------

test("onEvent: first event runs immediately and claims the window", () => {
  const now = 1_000_000;
  const { action, state } = onEvent(DEFAULT_STATE, now);
  assert.equal(action, "run");
  assert.equal(state.running, true);
  assert.equal(state.lastStart, now);
  assert.equal(state.dirty, false);
  assert.equal(state.sleeperUntil, null);
});

test("onEvent: event inside the window schedules a sleeper at window expiry", () => {
  const start = 1_000_000;
  const afterFirst = onEvent(DEFAULT_STATE, start).state;
  const finished: HookState = { ...afterFirst, running: false, lastRunOk: true };
  const now = start + 5_000; // window still open
  const { action, state } = onEvent(finished, now);
  assert.equal(action, "sleep");
  assert.equal(state.dirty, true);
  assert.equal(state.sleeperUntil, start + DEBOUNCE_MS);
});

test("onEvent: event while a sleeper is already pending just marks dirty", () => {
  const start = 1_000_000;
  const s: HookState = {
    ...DEFAULT_STATE,
    lastStart: start,
    dirty: true,
    sleeperUntil: start + DEBOUNCE_MS,
  };
  const { action, state } = onEvent(s, start + 10_000);
  assert.equal(action, "skip");
  assert.equal(state.dirty, true);
  assert.equal(state.sleeperUntil, start + DEBOUNCE_MS); // unchanged
});

test("onEvent: event after the window expires runs again", () => {
  const start = 1_000_000;
  const s: HookState = { ...DEFAULT_STATE, lastStart: start, running: false };
  const now = start + DEBOUNCE_MS + 1;
  const { action, state } = onEvent(s, now);
  assert.equal(action, "run");
  assert.equal(state.lastStart, now);
});

test("onEvent: a run marked running but older than STALE_RUN_MS is treated as dead", () => {
  const start = 1_000_000;
  const s: HookState = { ...DEFAULT_STATE, lastStart: start, running: true };
  const now = start + STALE_RUN_MS + 1;
  const { action } = onEvent(s, now);
  assert.equal(action, "run");
});

test("onEvent: a sleeper long past its wake time is treated as dead and replaced", () => {
  const start = 1_000_000;
  const s: HookState = {
    ...DEFAULT_STATE,
    lastStart: start,
    dirty: true,
    running: true, // long run still alive per lastStart? no: make window open via lastStart
    sleeperUntil: start + DEBOUNCE_MS,
  };
  // now: window closed but running flag stale AND sleeper stale -> fresh run wins
  const now = start + STALE_RUN_MS + DEBOUNCE_MS + 1;
  const { action } = onEvent(s, now);
  assert.equal(action, "run");
});

// ---- onSleeperWake -------------------------------------------------------

test("onSleeperWake: dirty and window expired -> run", () => {
  const start = 1_000_000;
  const s: HookState = {
    ...DEFAULT_STATE,
    lastStart: start,
    dirty: true,
    sleeperUntil: start + DEBOUNCE_MS,
  };
  const now = start + DEBOUNCE_MS + 1;
  const { action, state } = onSleeperWake(s, now);
  assert.equal(action, "run");
  assert.equal(state.dirty, false);
  assert.equal(state.running, true);
  assert.equal(state.sleeperUntil, null);
});

test("onSleeperWake: nothing dirty -> skip and clear the sleeper", () => {
  const s: HookState = { ...DEFAULT_STATE, dirty: false, sleeperUntil: 5_000 };
  const { action, state } = onSleeperWake(s, 10_000);
  assert.equal(action, "skip");
  assert.equal(state.sleeperUntil, null);
});

test("onSleeperWake: previous run still alive -> re-sleep past the new window", () => {
  const start = 1_000_000;
  const wake = start + DEBOUNCE_MS;
  // a NEW run started (by a later event path) and is still alive at wake time
  const s: HookState = {
    ...DEFAULT_STATE,
    lastStart: wake - 1_000,
    running: true,
    dirty: true,
    sleeperUntil: wake,
  };
  const { action, state } = onSleeperWake(s, wake);
  assert.equal(action, "sleep");
  assert.ok(state.sleeperUntil !== null && state.sleeperUntil > wake);
});

// ---- failureNotice -------------------------------------------------------

test("failureNotice: ping down warns once, then stays silent", () => {
  const first = failureNotice(DEFAULT_STATE, false);
  assert.ok(first.message !== null && first.message.includes("Ollama"));
  assert.equal(first.state.notifiedFailure, true);
  const second = failureNotice(first.state, false);
  assert.equal(second.message, null);
});

test("failureNotice: success resets, so a NEW down episode warns again", () => {
  const down = failureNotice(DEFAULT_STATE, false).state;
  const recovered = failureNotice({ ...down, lastRunOk: true }, true);
  assert.equal(recovered.message, null);
  assert.equal(recovered.state.notifiedFailure, false);
  const downAgain = failureNotice(recovered.state, false);
  assert.ok(downAgain.message !== null);
});

test("failureNotice: failed background run warns once even with Ollama up", () => {
  const s: HookState = { ...DEFAULT_STATE, lastRunOk: false };
  const first = failureNotice(s, true);
  assert.ok(first.message !== null && first.message.includes("re-index failed"));
  const second = failureNotice(first.state, true);
  assert.equal(second.message, null);
});

test("failureNotice: message points at the log file", () => {
  const { message } = failureNotice(DEFAULT_STATE, false);
  assert.ok(message !== null && message.includes(".rag/hook.log"));
});
