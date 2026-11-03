// Runs a command and, if it fails, runs it once more.
//   node scripts/ci_retry.mjs <command> [args...]
// For profile_viewer.mjs, a single long run whose scenarios build on each other's
// UI state and so cannot be retried one at a time. The multi-run profile scripts
// retry a failed run themselves (profile_run_retry.mjs). The first failure is reported as a CI warning so a
// flaky pass stays visible; the second result decides the exit code.
import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/ci_retry.mjs <command> [args...]");
  process.exit(2);
}

function run() {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}

const label = [command, ...args].join(" ");
const first = run();
if (first === 0) process.exit(0);

console.log(`::warning title=Retrying failed step::"${label}" exited ${first}; running it once more.`);
const second = run();
if (second === 0) console.log(`::warning title=Flaky step::"${label}" failed once and passed on retry.`);
process.exit(second);
