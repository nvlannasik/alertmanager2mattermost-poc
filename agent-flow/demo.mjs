#!/usr/bin/env node
// Posts one whole incident thread to Mattermost, message for message as the agent posts it to Slack
// today: the alert, the progress notice edited in place, the RCA card, the approval card, the status
// after the click, the verification, and the resolve message with its feedback buttons.
// Every message comes from fixtures/slack.json (the agent's own Slack builders) through slack-to-mm.mjs.
//
//   MM_URL, MM_TOKEN, MM_TEAM, MM_CHANNEL   required
//   MM_CALLBACK_URL   optional: real buttons (run callback.mjs). Without it the clicks are simulated.
//   MM_APPROVER       optional: Mattermost username named on the card (default: the token's own user)
//
//   --dry-run     print every request, send nothing
//   --no-pause    do not wait between steps
//   --gitops      the GitOps PR card (a diff) instead of the direct restart card
//   --extras      also post the other thread lines: recurrence, related alert, still firing,
//                 fired again, and the "LLM backends out of credit" message
import { readFileSync } from "node:fs";
import { mattermost } from "../lib/mm-client.mjs";
import { toPost, splitForMattermost } from "./slack-to-mm.mjs";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const PAUSE_MS = args.has("--no-pause") || DRY ? 0 : 3000;
const need = (k) => process.env[k] ?? (DRY ? `<${k}>` : (console.error(`missing ${k} — see README.md §0`), process.exit(2)));
const TEAM = need("MM_TEAM");
const CHANNEL = need("MM_CHANNEL");
const CALLBACK = process.env.MM_CALLBACK_URL;

const fx = JSON.parse(readFileSync(new URL("./fixtures/slack.json", import.meta.url)));
const mm = mattermost({ dry: DRY });
const pause = (what) =>
  PAUSE_MS ? (console.log(`   … ${what} (${PAUSE_MS / 1000}s)`), new Promise((r) => setTimeout(r, PAUSE_MS))) : Promise.resolve();

async function main() {
  const me = await mm.me();
  const ch = await mm.channel(TEAM, CHANNEL);
  const opts = { users: { UONCALL: process.env.MM_APPROVER ?? me.username, UCLICKER: me.username }, callbackUrl: CALLBACK };
  const tr = (msg) => toPost(msg, opts);
  /** One Slack message may be several Mattermost posts when it is long; the first one's id is returned. */
  const post = async (msg, rootId) => {
    const p = tr(msg);
    const parts = splitForMattermost(p.message);
    let first;
    for (const [i, part] of parts.entries()) {
      const isLast = i === parts.length - 1;
      const created = await mm.post(ch.id, { message: part, ...(isLast && p.props?.attachments?.length ? { props: p.props } : {}) }, rootId);
      first ??= created;
    }
    return first;
  };
  console.log(`bot @${me.username} → ~${CHANNEL} (${ch.id})${CALLBACK ? ` · buttons → ${CALLBACK}` : " · no MM_CALLBACK_URL: clicks are simulated"}`);

  // 1. the alert, in the channel (Slack: chat.postMessage, no thread)
  const root = await post(fx.alertRoot);
  console.log(`1. alert root post ${root.id}`);

  // 2. the progress notice in its thread, edited in place each round (Slack: chat.update)
  if (args.has("--extras")) await post(fx.recurrence, root.id);
  const notice = await post(fx.notice.start, root.id);
  console.log(`2. progress notice ${notice.id}`);
  for (const r of [...fx.notice.rounds, fx.notice.done]) {
    await pause("investigating");
    await mm.update(notice.id, { message: tr(r).message });
  }
  console.log("   notice edited through 3 rounds → complete");

  // 3. the RCA card
  const rca = await post(fx.rca, root.id);
  console.log(`3. RCA ${rca.id}`);
  await pause("RCA");

  // 4. the approval card
  const card = args.has("--gitops") ? fx.cardGitOps : fx.card;
  const cardPost = await post(card, root.id);
  console.log(`4. approval card ${cardPost.id}${CALLBACK ? " — click Approve or Reject; callback.mjs updates it" : ""}`);

  if (!CALLBACK) {
    // what the click does in Slack: the card becomes its status line, twice
    await pause("simulating an Approve click");
    await mm.update(cardPost.id, tr(fx.cardStatus.executing));
    await pause("executing");
    await mm.update(cardPost.id, tr(args.has("--gitops") ? fx.cardStatus.prOpened : fx.cardStatus.executed));
    console.log("   card → executing → done (simulated)");
    await pause("verification");
    await post(fx.verified, root.id);
    console.log("5. verification posted");
  }

  // 6. the resolve message: buttons when a callback can answer them
  await pause("resolve");
  await post(fx.resolved, root.id);
  console.log(`6. resolve message${CALLBACK ? " with RCA-was-right / something-else buttons" : ""}`);

  if (args.has("--extras")) {
    for (const k of ["related", "stillFiring", "firedAgain", "llmFailed"]) await post(fx.lines[k], root.id);
    console.log("7. extras: recurrence, related alert, still firing, fired again, LLM failure");
  }
  console.log("\ndone.");
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
