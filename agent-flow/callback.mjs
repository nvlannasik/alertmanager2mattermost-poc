#!/usr/bin/env node
// Answers Mattermost interactive-button clicks. Mattermost's SERVER posts
// {user_id, user_name, channel_id, post_id, trigger_id, type, context} here; the JSON answer's `update`
// replaces the post for everyone, `ephemeral_text` is shown to the clicker only. No dependencies.
//
// Two sets of buttons:
//   poc.mjs --button   context.action ack | resolve                 → the PoC status card
//   demo.mjs           context.action = the Slack action_id:
//                        approve_remediation → "⏳ Executing…", then (with MM_URL + MM_TOKEN) "✅ executed"
//                        reject_remediation  → "🚫 rejected by @you"
//                        rca_confirm / rca_correct → the resolve message with who answered what
//                      — the texts are the agent's own (fixtures/slack.json), translated by slack-to-mm.mjs.
//
//   PORT           default 8787
//   MM_APPROVERS   optional, comma-separated Mattermost usernames allowed to approve/reject
//                  (the agent's SLACK_APPROVER_USERS); unset = anyone
//   MM_URL, MM_TOKEN  optional: the second edit after an approve (an answer can replace a post once)
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { toPost } from "./slack-to-mm.mjs";
import { mattermost } from "../lib/mm-client.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const APPROVERS = (process.env.MM_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const fx = JSON.parse(readFileSync(new URL("./fixtures/slack.json", import.meta.url)));
const mm = mattermost();

// ── poc.mjs --button ────────────────────────────────────────────────────────
const pocCard = (state, by) => {
  const look = state === "resolve"
    ? { color: "#188038", title: "✅ Resolved — PoCAlert", status: `Resolved by @${by}` }
    : { color: "#1a73e8", title: "👀 Acknowledged — PoCAlert", status: `Acknowledged by @${by}` };
  // Buttons dropped on resolve; kept (only Resolve) after an acknowledge.
  const actions = state === "resolve" ? [] : [{ id: "resolve", name: "Resolve", style: "primary", integration: { url: process.env.MM_CALLBACK_URL ?? "", context: { action: "resolve" } } }];
  return {
    attachments: [
      {
        fallback: look.status,
        color: look.color,
        title: look.title,
        fields: [
          { title: "Status", value: look.status, short: true },
          { title: "Updated", value: `${new Date().toISOString().slice(11, 16)} UTC`, short: true },
        ],
        ...(actions.length ? { actions } : {}),
      },
    ],
  };
};

// ── the agent's templates ───────────────────────────────────────────────────
const tr = (msg, by) => toPost(msg, { users: { UCLICKER: by, UONCALL: by } });

function answer(action, value, by) {
  switch (action) {
    case "ack":
    case "resolve":
      return { update: { message: "PoC alert with buttons", props: pocCard(action, by) }, ephemeral_text: action === "resolve" ? "You resolved it." : "You acknowledged it." };
    case "approve_remediation": {
      // card 43 is the GitOps one in the fixtures
      const done = value === "43" ? fx.cardStatus.prOpened : fx.cardStatus.executed;
      const executing = tr(fx.cardStatus.executing, by); // the fixture's text names card 42
      executing.message = executing.message.replace("remediation 42", `remediation ${value || "?"}`);
      return { update: executing, later: tr(done, by) };
    }
    case "reject_remediation":
      return { update: tr(fx.cardStatus.rejected, by) };
    case "rca_confirm":
      return { update: tr(fx.answered.confirmed, by) };
    case "rca_correct":
      return { update: tr(fx.answered.corrected, by), ephemeral_text: "Say what the cause was in this thread — it is what `learn` stores." };
    default:
      return { ephemeral_text: `Unknown action \`${action}\`.` };
  }
}

createServer((req, res) => {
  if (req.method !== "POST") return void res.writeHead(405).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let p = {};
    try {
      p = JSON.parse(body || "{}");
    } catch {
      return void res.writeHead(400).end();
    }
    const action = p.context?.action ?? "ack";
    const value = String(p.context?.value ?? "");
    const by = p.user_name ?? p.user_id ?? "someone";
    console.log(`${new Date().toISOString()} click: ${action}${value ? `(${value})` : ""} by ${by} on post ${p.post_id} (channel ${p.channel_id})`);

    // The approver gate, as in app/remediation.ts: refuse with an ephemeral, change nothing.
    const gated = action === "approve_remediation" || action === "reject_remediation";
    if (gated && APPROVERS.length > 0 && !APPROVERS.includes(by)) {
      const denied = { ephemeral_text: ":no_entry_sign: You're not authorized to approve/reject remediations (MM_APPROVERS)." };
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(denied));
    }

    const { later, ...out } = answer(action, value, by);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));

    // Slack's flow edits the card twice (executing, then the result). A callback answer is one edit;
    // the second is a REST patch, which is what the adapter would do after the MCP call returns.
    if (later && p.post_id) {
      if (!mm.configured) return console.log("   (no MM_URL/MM_TOKEN: the card stays at 'Executing')");
      setTimeout(() => {
        mm.update(p.post_id, later).then(
          () => console.log(`   card ${p.post_id} → done`),
          (e) => console.error(`   second edit failed: ${e.message}`)
        );
      }, 3000);
    }
  });
}).listen(PORT, () => console.log(`callback listening on :${PORT} — set MM_CALLBACK_URL to http://<this-host>:${PORT}/action`));
