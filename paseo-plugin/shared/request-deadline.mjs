/** Absolute deadlines cross local process boundaries; nested work never resets them. */
export function remainingMs(deadline, reserveMs = 0, now = Date.now()) {
  return Math.max(0, deadline - now - reserveMs);
}
export function boundedDeadline(parent, budgetMs, now = Date.now()) {
  return Math.min(Number.isFinite(parent) ? parent : Infinity, now + budgetMs);
}
