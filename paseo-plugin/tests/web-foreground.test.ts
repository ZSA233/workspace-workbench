import assert from "node:assert/strict";
import test from "node:test";

import { observeWebForeground, webForeground } from "../client/web-foreground.ts";

function eventTarget() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener(type: string, listener: () => void) {
      const current = listeners.get(type) || new Set<() => void>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
    fire(type: string) { for (const listener of listeners.get(type) || []) listener(); },
    listenerCount() { return [...listeners.values()].reduce((total, set) => total + set.size, 0); },
  };
}

test("window blur and hidden document independently pause foreground observation", () => {
  const window = eventTarget();
  const document = { ...eventTarget(), visibilityState: "visible", hasFocus: () => true };
  const target = { ...window, document };
  const states: boolean[] = [];
  assert.equal(webForeground(target), true);
  const dispose = observeWebForeground(target, (active) => states.push(active));
  window.fire("blur");
  document.visibilityState = "hidden";
  document.fire("visibilitychange");
  window.fire("focus");
  assert.deepEqual(states, [true, false, false, false]);
  document.visibilityState = "visible";
  document.fire("visibilitychange");
  assert.equal(states.at(-1), true);
  dispose();
  assert.equal(window.listenerCount() + document.listenerCount(), 0);
  window.fire("blur");
  assert.equal(states.at(-1), true);
});
