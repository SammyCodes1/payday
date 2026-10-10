/** Injectable clock so the scheduler and decision engine can be tested deterministically. */
let override: (() => Date) | null = null;

export function now(): Date {
  return override ? override() : new Date();
}

export function setClockForTests(fn: (() => Date) | null) {
  override = fn;
}
