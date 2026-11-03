// Retry for the profile scripts that loop over independent runs, each in a fresh
// browser context. A run that fails is repeated once under CI; runs that already
// passed are kept. Set PROFILE_RUN_RETRIES to override (0 turns it off).
export const runRetries = Math.max(0, Number(process.env.PROFILE_RUN_RETRIES ?? (process.env.CI ? 1 : 0)));

// Records the failed attempt in the report (so a flaky pass stays visible in the
// uploaded summary) and annotates the CI log.
export function noteRetry(report, run, error) {
  (report.retriedRuns ||= []).push({ run: run + 1, error: String(error?.message || error) });
  console.log(`::warning title=Retrying failed profile run::Run ${run + 1} failed (${String(error?.message || error).split("\n")[0]}); running it once more.`);
}
