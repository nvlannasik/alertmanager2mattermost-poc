// Writes slack.json: every message the agent posts in an incident thread, built by the agent's OWN
// Slack builders (not copies), on one synthetic incident. The Mattermost templates are translated
// from this file, so they show what the agent really sends today. Re-run after a Slack template
// changes:
//
//   cd <workspace>/devops-ai-agent && npx tsx ../alertmanager2mattermost-poc/agent-flow/fixtures/gen.ts
//
// Slack user ids in here are placeholders, mapped to Mattermost usernames at post time:
//   UONCALL  — the approver named on the card (MM_APPROVER)
//   UCLICKER — whoever clicked a button (filled in by callback.mjs)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGroupAlertText } from "../../../devops-ai-agent/src/agent/correlation/index.js";
import { buildRcaBlocks, formatRunFooter } from "../../../devops-ai-agent/src/utils/slack/blocks.js";
import { buildRemediationCard, remediationStatusBlocks } from "../../../devops-ai-agent/src/utils/slack/remediation-card.js";
import { resolvedBlocks, answeredBlocks } from "../../../devops-ai-agent/src/app/feedback.js";
import { renderForSlack } from "../../../devops-ai-agent/src/agent/changes/index.js";
import { verdictMessage } from "../../../devops-ai-agent/src/agent/remediation/verify.js";
import { repeatLine } from "../../../devops-ai-agent/src/agent/incidents/repeat.js";
import { userFacingError, AllBackendsFailedError } from "../../../devops-ai-agent/src/agent/llm/failure.js";

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

// ── the alert (root post) ───────────────────────────────────────────────────
const labels = { alertname: "SampleAppHighErrorRate", severity: "critical", namespace: "sample-apps", service: "storefront", cluster: "dev", job: "kubernetes-pods" };
const ann = { summary: "High 5xx rate on storefront", description: "storefront answers 28.4% of requests with 5xx over the last 5m." };
const alerts = [
  { status: "firing" as const, labels: { ...labels, pod: "storefront-6d9f7c8b5-x2k4p" }, annotations: ann, startsAt: iso(6) },
  { status: "firing" as const, labels: { ...labels, pod: "storefront-6d9f7c8b5-q7m9z" }, annotations: ann, startsAt: iso(5) },
];
const groupLabels = { alertname: labels.alertname, namespace: labels.namespace, cluster: labels.cluster };
const alertText = buildGroupAlertText(groupLabels, alerts);

// ── the RCA, in the template's shape (rca-format.md) ────────────────────────
const rca = `*🔴 Severity:* \`Critical\`

*⚡ TL;DR*
\`storefront\` answers 28.4% of requests with 5xx because its calls to \`checkout-gateway\` time out after 50 ms.
Immediate: set \`GATEWAY_TIMEOUT_MS\` on \`sample-apps/Deployment/checkout-gateway\` back to 2000.

*⚠️ Impact if Unresolved*
About one checkout in four fails. Every request that reaches \`checkout-gateway\` waits on \`orders-api\`, so the failure rate rises with traffic.

*🔧 Recommended Actions*
1. *Immediate:* Set \`GATEWAY_TIMEOUT_MS\` back to \`2000\` on \`sample-apps/Deployment/checkout-gateway\` (GitOps PR).
2. *Short-term:* Add an alert on \`http_client_requests_total{status="timeout"}\` per peer, so a timeout shows before the 5xx rate does.
3. *Long-term:* Review timeout changes against the peer's p99 latency before merging.

*🧭 Runbook*
1. *Verify:*
\`\`\`
kubectl -n sample-apps get deploy checkout-gateway -o jsonpath='{.spec.template.spec.containers[0].env}'
\`\`\`
2. *Confirm:*
\`\`\`
kubectl -n sample-apps rollout status deploy/checkout-gateway
\`\`\`

*📍 Root Cause*
1. *Symptom:* \`storefront\` returns 5xx on 28.4% of requests — _SampleAppHighErrorRate_
2. *Because:* its calls to \`checkout-gateway\` end in \`status="timeout"\` — _prometheus_query_
3. *Because:* \`checkout-gateway\` gives \`orders-api\` 50 ms, and \`orders-api\` p99 is 180 ms — _prometheus_query_
4. *Because:* revision 14 of \`checkout-gateway\` (2 h ago) changed \`GATEWAY_TIMEOUT_MS\` from 2000 to 50 — _k8s_change_timeline_

*📊 Evidence*
• 5xx ratio on \`storefront\` is 0.284 over 5m — _prometheus_query_ \`sum(rate(http_server_requests_total{service="storefront",status=~"5.."}[5m]))\`
• \`storefront\` → \`checkout-gateway\` calls: 31% \`timeout\` — _prometheus_query_ \`http_client_requests_total{peer="checkout-gateway"}\`
• Logs: "gateway call failed: timed out after 50ms" ×412 in 10m — _loki_query_range_ \`{namespace="sample-apps", app="checkout-gateway"}\`
• All 4 pods Ready, 0 restarts — _k8s_list_pods_ \`sample-apps\`

*🚫 Ruled Out*
• Pod health: every pod is Ready with no restarts — _k8s_list_pods_
• \`orders-api\` errors: its own 5xx ratio is 0.2% — _prometheus_query_

*📈 Confidence:* \`High\` — the timeout change, the timeout status on the client metric and the log lines agree.`;

const footer = formatRunFooter({ durationMs: 194_000, rounds: 4, toolCalls: 11, model: "deepseek-chat", backend: "deepseek", route: "heavy", cluster: "dev", viaBridge: false });
const rcaBlocks = buildRcaBlocks(rca, footer, "dev");
const changes = renderForSlack({
  namespace: "sample-apps",
  window: { from: iso(24 * 60), to: iso(0) },
  changes: [{ at: iso(120), source: "k8s", kind: "rollout", workload: "Deployment/checkout-gateway", revision: "14", diff: [{ field: "checkout-gateway.env.GATEWAY_TIMEOUT_MS", from: "2000", to: "50" }] }],
  commits: [{ sha: "a1b2c3d4e5f60718", at: iso(125), author: "jdoe", message: "checkout-gateway: tighten the upstream timeout", url: "https://github.com/example/gitops/commit/a1b2c3d4e5f60718", paths: ["apps/dev/applications/checkout-gateway/values.yaml"], helmRelease: "checkout-gateway" }],
  unread: [],
  subjects: ["storefront"],
});
if (changes) rcaBlocks.push(changes);

// ── the approval cards ──────────────────────────────────────────────────────
const direct = { action: "k8s_rollout_restart", namespace: "sample-apps", name: "checkout-gateway", summary: "Rolling restart of `sample-apps/Deployment/checkout-gateway`", reason: "Its pods time out on every call to `orders-api`; a restart clears the connection pool." } as any;
const gitops = { action: "k8s_set_env", namespace: "sample-apps", name: "checkout-gateway", summary: "Set `GATEWAY_TIMEOUT_MS` to `2000` on `checkout-gateway`", reason: "Revision 14 cut it to 50 ms, below the p99 of `orders-api` (180 ms)." } as any;
const diff = `--- a/apps/dev/applications/checkout-gateway/values.yaml
+++ b/apps/dev/applications/checkout-gateway/values.yaml
@@ -12,7 +12,7 @@ env:
   - name: GATEWAY_TIMEOUT_MS
-    value: "50"
+    value: "2000"`;

// Status texts: the strings are remediator.ts's (lines noted), with placeholder values.
const status = (text: string) => ({ text, blocks: remediationStatusBlocks(text) });

// app/alerts.ts postResolved (learnReaction defaults to white_check_mark)
const resolvedText = `✅ *Alert resolved* — SampleAppHighErrorRate in \`sample-apps\` at \`${iso(0)}\`. If a manual fix did it, react :white_check_mark: on the message describing it (or mention me with \`learn\`) so I remember.`;

const out = {
  _about: "Generated by fixtures/gen.ts from devops-ai-agent's Slack builders. Do not edit by hand.",
  alertRoot: { text: alertText },
  notice: {
    start: { text: ":pepe-hacker: Auto-investigating..." },
    rounds: [
      { text: ":pepe-hacker: Investigating, round 1 — k8s_list_pods, prometheus_query, alertmanager_get_alerts" },
      { text: ":pepe-hacker: Investigating, round 2 — loki_query_range, prometheus_query" },
      { text: ":pepe-hacker: Investigating, round 3 — k8s_get_resource" },
    ],
    done: { text: ":pepe-perfect: Investigation complete." },
  },
  recurrence: { text: repeatLine({ id: 41, createdAt: new Date(now - 10 * 3_600_000), resolvedAt: new Date(now - 9 * 3_600_000), rootCause: "" }, new Date(now), 5) },
  rca: { text: rca, blocks: rcaBlocks },
  card: { text: `🔧 Remediation needed: ${direct.summary} — approve or reject`, blocks: buildRemediationCard(42, direct, "deployment.apps/checkout-gateway restarted (server dry run)", ["UONCALL"], undefined, "dev") },
  cardGitOps: {
    text: `🔧 Remediation needed (GitOps PR): ${gitops.summary} — approve or reject`,
    blocks: buildRemediationCard(43, gitops, diff, ["UONCALL"], { path: "apps/dev/applications/checkout-gateway/values.yaml", valuesKey: "env[0].value", helmRelease: { name: "checkout-gateway", namespace: "sample-apps" } }, "dev"),
  },
  cardStatus: {
    executing: status("⏳ Executing remediation 42 — approved by <@UCLICKER>..."), // app/remediation.ts:134
    executed: status(`✅ *Remediation executed* — ${direct.summary} (approved by <@UCLICKER>)\n\`deployment.apps/checkout-gateway restarted\``), // remediator.ts:824
    prOpened: status(`✅ *GitOps PR opened* — ${gitops.summary} (approved by <@UCLICKER>)\nhttps://github.com/example/gitops/pull/12\nReview & merge to apply — Flux syncs after merge; nothing changes on the cluster until then. Once it runs, I check whether it fixed the problem.`), // remediator.ts:918
    rejected: status("🚫 Remediation rejected by <@UCLICKER>. Nothing was executed."), // remediator.ts:1071
    expired: status(`:hourglass: *Expired* — nobody approved this within the window, so it was closed: ${direct.summary}. Nothing ran. Ask again if it still matters.`), // app/remediation.ts:219
  },
  verified: { text: verdictMessage({ target: { namespace: "sample-apps", name: "checkout-gateway" }, createdAt: iso(5) } as any, "recovered", "4/4 pods ready; SampleAppHighErrorRate no longer firing") },
  resolved: { text: resolvedText, blocks: resolvedBlocks(resolvedText, 7, true) },
  answered: {
    confirmed: { text: resolvedText, blocks: answeredBlocks(resolvedText, "confirmed", "UCLICKER") },
    corrected: { text: resolvedText, blocks: answeredBlocks(resolvedText, "corrected", "UCLICKER") },
  },
  lines: {
    related: { text: "🔗 *Related alert* — SampleAppHighLatency on `checkout-gateway` (calls storefront → checkout-gateway) · grouped into this incident" }, // app/alerts.ts:244
    stillFiring: { text: "⏳ *Still firing* — SampleAppHighErrorRate, 13 h since this incident opened. Same alert, same labels, and the incident is still open, so it was not investigated again. Mention me to look again, or say `resolved` once it is fixed." }, // app/alerts.ts:317
    firedAgain: { text: "🔁 *Fired again* — SampleAppHighErrorRate, 12 min after it resolved. Same alert, same labels: this is the incident above flapping, so it was reopened here instead of starting a new investigation. The RCA above still stands — mention me if you want it checked again." }, // app/alerts.ts:292
    llmFailed: {
      text: userFacingError(
        new AllBackendsFailedError("heavy", [
          { backend: "deepseek", kind: "credit", summary: "402 Insufficient Balance" },
          { backend: "chatgpt", kind: "credit", summary: "429 You have no credits remaining" },
        ]),
        "alert"
      ),
    },
  },
};

const file = join(dirname(fileURLToPath(import.meta.url)), "slack.json");
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${file}: ${rcaBlocks.length} RCA blocks (${rcaBlocks.filter((b) => b.type === "table").length} tables)`);
