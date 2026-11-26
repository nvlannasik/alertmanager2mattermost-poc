#!/usr/bin/env node
// Listens on Mattermost's WebSocket and prints what a bot would react to: posts that mention the token's
// user, reactions and edits. Node 26's global WebSocket, no dependencies.
//   MM_URL, MM_TOKEN
const URL_ = (process.env.MM_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.MM_TOKEN;
if (!URL_ || !TOKEN) {
  console.error("missing MM_URL / MM_TOKEN — see README.md §0");
  process.exit(2);
}

const me = await (await fetch(`${URL_}/api/v4/users/me`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
console.log(`listening as @${me.username} (${me.id})`);

const ws = new WebSocket(`${URL_.replace(/^http/, "ws")}/api/v4/websocket`);
ws.addEventListener("open", () => ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token: TOKEN } })));
ws.addEventListener("message", (m) => {
  const ev = JSON.parse(String(m.data));
  if (ev.seq_reply === 1) return console.log(`auth: ${ev.status}`);
  const d = ev.data ?? {};
  if (ev.event === "posted") {
    const post = JSON.parse(d.post ?? "{}");
    const mentions = d.mentions ? JSON.parse(d.mentions) : [];
    const mentioned = mentions.includes(me.id);
    if (post.user_id === me.id) return; // our own posts
    console.log(`${mentioned ? "MENTION" : "post"} in ${d.channel_name ?? post.channel_id} root=${post.root_id || "-"} by ${d.sender_name}: ${post.message}`);
  } else if (ev.event === "reaction_added" || ev.event === "reaction_removed") {
    const r = JSON.parse(d.reaction ?? "{}");
    console.log(`${ev.event}: :${r.emoji_name}: on ${r.post_id} by ${r.user_id}`);
  } else if (ev.event === "post_edited") {
    const post = JSON.parse(d.post ?? "{}");
    console.log(`edited: ${post.id} → ${post.message.split("\n")[0]}`);
  }
});
ws.addEventListener("close", (e) => console.log(`closed: ${e.code} ${e.reason}`));
ws.addEventListener("error", (e) => console.error(`error: ${e.message ?? e}`));
