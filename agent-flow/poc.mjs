#!/usr/bin/env node
// Mattermost thread PoC: root post → thread reply → root status changed in place → reaction → thread read
// → ephemeral, and with --button a card with interactive buttons. REST API v4, no dependencies.
//   MM_URL, MM_TOKEN, MM_TEAM, MM_CHANNEL (required); MM_CALLBACK_URL (for --button)
//   --dry-run   print each request and send nothing
//   --button    post a card with Acknowledge / Resolve buttons (needs callback.mjs running)
//   --no-pause  do not wait between steps

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const PAUSE_MS = args.has("--no-pause") || DRY ? 0 : 4000;
const env = (k, dflt) => {
  const v = process.env[k] ?? dflt;
  if (v === undefined) {
    if (DRY) return `<${k}>`;
    console.error(`missing ${k} — see README.md §0`);
    process.exit(2);
  }
  return v;
};
const URL_ = env("MM_URL").replace(/\/+$/, "");
const TOKEN = env("MM_TOKEN");
const TEAM = env("MM_TEAM");
const CHANNEL = env("MM_CHANNEL");

let fakeId = 0;
async function api(method, path, body) {
  if (DRY) {
    console.log(`\n${method} ${URL_}/api/v4${path}`);
    if (body) console.log(JSON.stringify(body, null, 2));
    // ids that look like Mattermost's (26 chars) so the next steps print sensibly
    return { id: `dryrun${String(++fakeId).padStart(20, "0")}`, username: "poc-bot", order: [], posts: {} };
  }
  const res = await fetch(`${URL_}/api/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.message ?? text.slice(0, 200)}`);
  return json;
}

const pause = (what) => (PAUSE_MS ? (console.log(`   … ${what} — look at the channel (${PAUSE_MS / 1000}s)`), new Promise((r) => setTimeout(r, PAUSE_MS))) : Promise.resolve());

/** A Slack-style "status" card as a Mattermost message attachment: colour bar, title, fields. */
const card = (state, extra = {}) => {
  const look = {
    firing: { color: "#d93025", title: "🔥 Firing — PoCAlert", status: "Firing" },
    acknowledged: { color: "#1a73e8", title: "👀 Acknowledged — PoCAlert", status: "Acknowledged" },
    resolved: { color: "#188038", title: "✅ Resolved — PoCAlert", status: "Resolved" },
  }[state];
  return {
    attachments: [
      {
        fallback: `${look.status} — PoCAlert`,
        color: look.color,
        title: look.title,
        text: "Synthetic alert for the Mattermost thread PoC.",
        fields: [
          { title: "Status", value: look.status, short: true },
          { title: "Updated", value: `${new Date().toISOString().slice(11, 16)} UTC`, short: true },
        ],
        ...extra,
      },
    ],
  };
};

async function main() {
  const me = await api("GET", "/users/me");
  const ch = await api("GET", `/teams/name/${encodeURIComponent(TEAM)}/channels/name/${encodeURIComponent(CHANNEL)}`);
  console.log(`1. bot @${me.username} (${me.id}) → channel ${CHANNEL} (${ch.id})`);

  if (args.has("--button")) {
    const cb = env("MM_CALLBACK_URL");
    // Action ids: letters and digits only. `context` comes back to the callback on every click.
    const actions = [
      { id: "ack", name: "Acknowledge", integration: { url: cb, context: { action: "ack" } } },
      { id: "resolve", name: "Resolve", style: "primary", integration: { url: cb, context: { action: "resolve" } } },
    ];
    const post = await api("POST", "/posts", { channel_id: ch.id, message: "PoC alert with buttons", props: card("firing", { actions }) });
    console.log(`2. card with buttons posted: ${post.id} — click them; callback.mjs answers and replaces the card`);
    return;
  }

  const root = await api("POST", "/posts", { channel_id: ch.id, message: "PoC alert", props: card("firing") });
  console.log(`2. root post (red, Firing): ${root.id}`);
  await pause("root post");

  const reply = await api("POST", "/posts", { channel_id: ch.id, root_id: root.id, message: "Investigating… this is a reply **in the thread**, with `code` and a table:\n\n| check | result |\n|---|---|\n| pods | 2/2 ready |\n| alerts | 1 firing |" });
  console.log(`3. reply in thread: ${reply.id} (root_id ${root.id})`);
  await pause("thread reply");

  await api("PUT", `/posts/${root.id}/patch`, { props: card("acknowledged") });
  console.log("4. root changed in place → blue, Acknowledged");
  await pause("acknowledged");

  await api("PUT", `/posts/${root.id}/patch`, { props: card("resolved") });
  console.log("5. root changed in place → green, Resolved");

  await api("POST", "/reactions", { user_id: me.id, post_id: root.id, emoji_name: "white_check_mark" });
  console.log("6. reaction ✅ on the root post");

  const thread = await api("GET", `/posts/${root.id}/thread`);
  console.log(`7. thread has ${thread.order?.length ?? 0} post(s):`);
  for (const id of thread.order ?? []) console.log(`   ${id} root=${thread.posts[id].root_id || "-"} ${thread.posts[id].message.split("\n")[0]}`);

  try {
    await api("POST", "/posts/ephemeral", { user_id: me.id, post: { channel_id: ch.id, root_id: root.id, message: "Ephemeral: only you see this." } });
    console.log("8. ephemeral post sent (visible to the bot user only — set user_id to a human to see it)");
  } catch (e) {
    console.log(`8. ephemeral post refused: ${e.message} — the token lacks create_post_ephemeral`);
  }
  console.log("\ndone. Note the results in README.md's checklist.");
}

main().catch((e) => {
  console.error(`FAILED: ${e.message}`);
  process.exit(1);
});
