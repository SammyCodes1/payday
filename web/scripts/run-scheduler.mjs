#!/usr/bin/env node
// Triggers re-evaluation of due SCHEDULED invoices. Run from cron / Task Scheduler, e.g. hourly.
// Needs PAYDAY_APP_ORIGIN and CRON_SECRET in the environment (never hard-code the secret).
const origin = process.env.PAYDAY_APP_ORIGIN;
const secret = process.env.CRON_SECRET;
if (!origin || !secret) {
  console.error("set PAYDAY_APP_ORIGIN and CRON_SECRET");
  process.exit(2);
}
const res = await fetch(new URL("/api/cron/due", origin), { method: "POST", headers: { authorization: `Bearer ${secret}` } });
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
