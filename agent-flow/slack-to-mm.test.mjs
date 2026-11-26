// node --test   (from this folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mrkdwnToMarkdown as md, toPost, splitForMattermost } from "./slack-to-mm.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/slack.json", import.meta.url)));

test("bold, strike, links, mentions", () => {
  assert.equal(md("*Severity:* 🔴 `critical`"), "**Severity:** 🔴 `critical`");
  assert.equal(md("~old~ new"), "~~old~~ new");
  assert.equal(md("see <https://x.test/a|the PR> or <https://x.test/b>"), "see [the PR](https://x.test/a) or https://x.test/b");
  assert.equal(md("from <@UONCALL> and <@UX>", { users: { UONCALL: "noval" } }), "from @noval and @UX");
  assert.equal(md("<!here> <!channel>"), "@here @channel");
  assert.equal(md("<!date^1795697963^{time}|13:00 UTC>"), "13:00 UTC");
});

test("italics, lists and products of arithmetic are left alone", () => {
  assert.equal(md("_SampleAppHighErrorRate_ and _k8s_list_pods_"), "_SampleAppHighErrorRate_ and _k8s_list_pods_");
  assert.equal(md("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(md("• one\n• two"), "• one\n• two");
  assert.equal(md("**already**"), "**already**");
});

test("nothing inside code changes", () => {
  assert.equal(md("`a*b*c` and *x*"), "`a*b*c` and **x**");
  assert.equal(md("```\n*not bold* <@U1>\n```\n*bold*"), "```\n*not bold* <@U1>\n```\n**bold**");
});

test("custom emoji map to standard ones; unknown stay", () => {
  assert.equal(md(":pepe-hacker: Auto-investigating..."), ":mag: Auto-investigating...");
  assert.equal(md(":alert: *X*"), ":rotating_light: **X**");
  assert.equal(md(":white_check_mark: :made-up:"), ":white_check_mark: :made-up:");
});

test("Slack escapes are undone", () => {
  assert.equal(md("a &lt;b&gt; &amp; c"), "a <b> & c");
});

test("RCA card: header, rules with blank lines, tables, footer in place", () => {
  const { message } = toPost(fx.rca);
  assert.match(message, /^### 🔴 Critical Severity Incident · ☸ dev\n\n---\n\n\*\*⚡ TL;DR\*\*/);
  assert.ok(!/[^\n]\n---/.test(message), "a rule must have a blank line above it, or the line becomes a heading");
  assert.match(message, /\| When \| Action \|\n\|---\|---\|\n\| Immediate \| Set `GATEWAY_TIMEOUT_MS`/);
  assert.match(message, /\| Finding \| Source \|/);
  assert.match(message, /_⏱ 3m 14s · 🧠 deepseek \(deepseek-chat\) · heavy · 4 rounds · 11 tool calls · cluster dev_\n\n\*\*🕑 Recent changes\*\*/);
  // every section of the Slack card is there
  for (const h of ["TL;DR", "Impact if Unresolved", "Recommended Actions", "Runbook", "Root Cause", "Evidence", "Ruled Out", "Confidence"]) {
    assert.ok(message.includes(h), h);
  }
  assert.ok(message.length < 16000);
});

test("a | inside a cell is escaped, never a new column", () => {
  const t = { blocks: [{ type: "table", rows: [[{ type: "raw_text", text: "A" }, { type: "raw_text", text: "B" }], [{ type: "raw_text", text: "x|y" }, { type: "raw_text", text: "" }]] }] };
  assert.match(toPost(t).message, /\| x\\\|y \| — \|/);
});

test("approval card: text in the message (mentions notify), buttons + footer in an attachment", () => {
  const post = toPost(fx.card, { callbackUrl: "http://cb.test/action", users: { UONCALL: "noval" } });
  assert.match(post.message, /^🔧 \*\*Remediation needed\*\* — Rolling restart/);
  assert.match(post.message, /\*\*Approval needed from:\*\* @noval/);
  const [att] = post.props.attachments;
  assert.equal(att.footer, "Expires in 15 minutes · nothing runs without approval");
  assert.deepEqual(att.actions.map((a) => [a.id, a.name, a.style, a.integration.context.action, a.integration.context.value]), [
    ["approveremediation", "✅ Approve", "primary", "approve_remediation", "42"],
    ["rejectremediation", "🚫 Reject", "danger", "reject_remediation", "42"],
  ]);
});

test("GitOps card keeps its diff fence", () => {
  const { message } = toPost(fx.cardGitOps, { callbackUrl: "http://cb.test/action" });
  assert.match(message, /```diff\n--- a\/apps\/dev/);
  assert.match(message, /\+    value: "2000"\n```/);
});

test("without a callback URL the buttons are left out and the post says so", () => {
  const post = toPost(fx.card);
  assert.deepEqual(post.props.attachments, []);
  assert.match(post.message, /buttons need MM_CALLBACK_URL/);
});

test("status after a click clears the buttons", () => {
  const post = toPost(fx.cardStatus.rejected, { users: { UCLICKER: "rina" } });
  assert.equal(post.message, "🚫 Remediation rejected by @rina. Nothing was executed.");
  assert.deepEqual(post.props.attachments, []);
});

test("resolve message with feedback buttons, and after an answer", () => {
  const post = toPost(fx.resolved, { callbackUrl: "http://cb.test/action" });
  assert.match(post.message, /^✅ \*\*Alert resolved\*\* — SampleAppHighErrorRate/);
  assert.deepEqual(post.props.attachments[0].actions.map((a) => a.integration.context), [
    { action: "rca_confirm", value: "7" },
    { action: "rca_correct", value: "7" },
  ]);
  const done = toPost(fx.answered.confirmed, { users: { UCLICKER: "rina" } });
  assert.match(done.message, /\n\n_✅ @rina confirmed the RCA's root cause/);
});

test("plain-text messages translate whole", () => {
  assert.match(toPost(fx.alertRoot).message, /^:rotating_light: \*\*SampleAppHighErrorRate\*\* — 2 alerts\n\*\*Severity:\*\* 🔴 `critical`/);
  assert.match(toPost(fx.lines.llmFailed).message, /^⚠️ \*\*I could not investigate this alert\*\* — every LLM backend/);
});

test("long posts split on blank lines, never inside a fence", () => {
  const fence = "```\n" + "x\n\n".repeat(30) + "```";
  const msg = ["a".repeat(50), fence, "b".repeat(50)].join("\n\n");
  const parts = splitForMattermost(msg, 80);
  for (const p of parts) assert.equal((p.match(/```/g) ?? []).length % 2, 0, p);
  assert.equal(parts.join("\n\n"), msg);
});
