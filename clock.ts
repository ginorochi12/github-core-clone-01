// The trial clock: every timestamp the entry emits comes from MAKEFUN_TRIAL_NOW, never the
// wall clock (RULES.txt: "no wall clock: never Date.now(), new Date() or a timer's reading in a
// request; take dates from MAKEFUN_TRIAL_NOW"). MAKEFUN_TRIAL_NOW is an RFC 3339 instant or
// epoch milliseconds. Each timestamp takes the next second after the previous one, so commit
// ids and created_at values are deterministic and strictly increasing within a run.

/** Parse MAKEFUN_TRIAL_NOW into epoch seconds (RFC 3339, epoch ms, or epoch seconds). */
function trialNowSec(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw !== '') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      // Epoch milliseconds (>1e12) or epoch seconds.
      return Math.floor(numeric > 1_000_000_000_000 ? numeric / 1000 : numeric);
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  // No trial clock configured (local development): fall back to the wall clock once, at startup,
  // and derive every later timestamp from it. No request ever reads the wall clock.
  return Math.floor(Date.now() / 1000);
}

const BASE_SEC = trialNowSec();
let tick = 0;

/** The next timestamp, epoch seconds: the trial's now plus one second per call. */
export function nextTimestampSec(): number {
  tick += 1;
  return BASE_SEC + tick;
}

/** The next timestamp as an ISO 8601 UTC string. */
export function nextTimestampIso(): string {
  return new Date(nextTimestampSec() * 1000).toISOString();
}

/** The trial's opening time as an ISO 8601 UTC string (for created_at of the first objects). */
export function trialNowIso(): string {
  return new Date(BASE_SEC * 1000).toISOString();
}
