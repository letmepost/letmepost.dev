// Inspect (default) or drain the onboarding-email backlog.
//   railway run --service worker -- node drain-onboarding-email.mjs
//   railway run --service worker -- node drain-onboarding-email.mjs --drain
import { Queue } from "bullmq";
import IORedis from "ioredis";

const DRAIN = process.argv.includes("--drain");
const url = process.env.REDIS_URL;
if (!url) { console.error("REDIS_URL not set — run via `railway run`"); process.exit(1); }

const connection = new IORedis(url, { maxRetriesPerRequest: null });
const q = new Queue("onboarding-email", { connection });

console.log("counts:", await q.getJobCounts("waiting","delayed","active","completed","failed","paused"));

const jobs = [...await q.getDelayed(0, 5000), ...await q.getWaiting(0, 5000)];
const byKind = {};
let oldest = null;
for (const j of jobs) {
  const kind = j.data?.kind ?? "?";
  byKind[kind] = (byKind[kind] ?? 0) + 1;
  const due = (j.timestamp ?? 0) + (j.opts?.delay ?? 0);
  if (due && (oldest === null || due < oldest)) oldest = due;
}
console.log("pending by kind:", byKind);
console.log("total pending:", jobs.length);
if (oldest) {
  const days = Math.floor((Date.now() - oldest) / 86400000);
  console.log(`oldest job was due ${days} day(s) ago (${new Date(oldest).toISOString()})`);
}

if (DRAIN) {
  let removed = 0;
  for (const j of jobs) { await j.remove().then(() => removed++).catch(() => {}); }
  console.log(`DRAINED ${removed} job(s). Queue is still paused — resume when the code fix ships.`);
} else {
  console.log("\nDry run. Re-run with --drain to remove these.");
}

await q.close();
await connection.quit();
