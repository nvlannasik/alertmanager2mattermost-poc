#!/usr/bin/env node
// Plays Alertmanager: sends the bridge a sequence of webhook notifications for two groups, so the
// whole lifecycle can be watched in Mattermost without a real Alertmanager.
//
//   BRIDGE        default http://localhost:8080/alertmanager   (add ?channel=… to route)
//   BRIDGE_TOKEN  if the bridge has one
//   --no-pause    send everything at once        --step   wait for Enter between steps
//
// Run the bridge with REMIND_MINUTES=0 to see the "still firing" reminder on step 5.
import { createInterface } from "node:readline/promises";
import { alert, notification, crashLabels, crashAnn, crashGroup, memLabels, memAnn, memGroup } from "./payloads.mjs";

const args = new Set(process.argv.slice(2));
const BRIDGE = process.env.BRIDGE ?? "http://localhost:8080/alertmanager";
const PAUSE_MS = args.has("--no-pause") ? 0 : 4000;
const t0 = Date.now() - 6 * 60_000; // the first alerts started 6 minutes ago
const iso = (min) => new Date(t0 + min * 60_000).toISOString();
const crash = (pod, opts = {}) => alert(crashLabels(pod), { annotations: crashAnn, startsAt: iso(0), ...opts });
const mem = (opts = {}) => alert(memLabels, { annotations: memAnn, startsAt: iso(1), ...opts });
// Alertmanager keeps an alert's startsAt for as long as it fires; so must this script.
const third = (opts = {}) => crash("storefront-6d9f7c8b5-w8n2c", { startsAt: iso(5), ...opts });
const now = () => new Date().toISOString();

const steps = [
  ["KubePodCrashLooping fires for 2 pods", () => notification(crashGroup, [crash("storefront-6d9f7c8b5-x2k4p"), crash("storefront-6d9f7c8b5-q7m9z")])],
  ["NodeMemoryHighUtilization fires (warning)", () => notification(memGroup, [mem()])],
  ["one crashlooping pod recovers", () => notification(crashGroup, [crash("storefront-6d9f7c8b5-x2k4p", { status: "resolved", endsAt: now() }), crash("storefront-6d9f7c8b5-q7m9z")])],
  ["a third pod starts crashlooping", () => notification(crashGroup, [crash("storefront-6d9f7c8b5-q7m9z"), third()])],
  ["Alertmanager repeats the group (nothing changed)", () => notification(crashGroup, [crash("storefront-6d9f7c8b5-q7m9z"), third()])],
  ["the memory alert resolves", () => notification(memGroup, [mem({ status: "resolved", endsAt: now() })])],
  ["every crashlooping pod recovers", () => notification(crashGroup, [crash("storefront-6d9f7c8b5-q7m9z", { status: "resolved", endsAt: now() }), third({ status: "resolved", endsAt: now() })])],
  ["it crashloops again → a NEW post, linked to the old one", () => notification(crashGroup, [crash("storefront-6d9f7c8b5-q7m9z", { startsAt: now() })])],
];

const rl = args.has("--step") ? createInterface({ input: process.stdin, output: process.stdout }) : null;
for (const [i, [what, payload]] of steps.entries()) {
  if (i > 0) {
    if (rl) await rl.question("   Enter for the next step… ");
    else if (PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  const res = await fetch(BRIDGE, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(process.env.BRIDGE_TOKEN ? { Authorization: `Bearer ${process.env.BRIDGE_TOKEN}` } : {}) },
    body: JSON.stringify(payload()),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  const body = await res.text();
  console.log(`${i + 1}. ${what} → ${res.status} ${body}`);
  if (!res.ok) process.exitCode = 1;
}
rl?.close();
