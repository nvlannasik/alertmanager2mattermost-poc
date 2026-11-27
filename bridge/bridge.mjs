#!/usr/bin/env node
// Alertmanager → Mattermost, one post per alert group, edited in place from FIRING to RESOLVED.
//
//   POST /alertmanager[?channel=<name>]   Alertmanager webhook (send_resolved: true)
//   POST /action                          Mattermost button clicks (Acknowledge)
//   GET  /status                          the groups still firing, as JSON
//   GET  /healthz
//
// The group's state lives in its own post's props (card.mjs STATE_PROP), so a restart loses nothing:
// on first use of a channel the bridge reads its pinned posts and recent posts back. See README.md.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { mattermost } from "../lib/mm-client.mjs";
import { applyNotification, groupKeyOf, renderEvent, renderRoot, renderSummary, STATE_PROP, SUMMARY_PROP } from "./card.mjs";

const bool = (v, dflt) => (v === undefined || v === "" ? dflt : !/^(0|false|no|off)$/i.test(v));

export function configFromEnv(env = process.env) {
  const bridgeUrl = (env.BRIDGE_URL ?? "").replace(/\/+$/, "");
  return {
    port: Number(env.PORT ?? 8080),
    team: env.MM_TEAM,
    channel: env.MM_CHANNEL,
    token: env.BRIDGE_TOKEN || "",
    actionUrl: bridgeUrl ? `${bridgeUrl}/action` : "",
    // the card: "table" (default) or "detailed", and its shortcut links in order
    cardStyle: env.CARD_STYLE === "detailed" ? "detailed" : "table",
    cardLinks: (env.CARD_LINKS ?? "grafana,jira").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    grafanaUrl: env.GRAFANA_URL || "",
    grafanaDatasource: env.GRAFANA_DATASOURCE_UID || "",
    grafanaOrgId: env.GRAFANA_ORG_ID || "1",
    jiraUrl: env.JIRA_URL || "",
    jiraProjectId: env.JIRA_PROJECT_ID || "",
    jiraIssueTypeId: env.JIRA_ISSUE_TYPE_ID || "",
    alertmanagerUrl: env.ALERTMANAGER_URL || "",
    prometheusUrl: env.PROMETHEUS_URL || "",
    tz: env.DISPLAY_TZ || "Asia/Jakarta",
    pin: bool(env.MM_PIN_FIRING, true),
    reactions: bool(env.MM_REACTIONS, true),
    mention: env.MM_MENTION || "",
    mentionSeverities: (env.MM_MENTION_SEVERITIES ?? "critical").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    // minimum minutes between "still firing" replies on Alertmanager's repeats; 0 = every repeat, off = never
    remindMinutes: /^(off|never|-1)$/i.test(env.REMIND_MINUTES ?? "") ? Infinity : Number(env.REMIND_MINUTES ?? 60),
    summaryMinutes: Number(env.SUMMARY_MINUTES ?? 0),
    // Acknowledge by reaction, no inbound: the bot puts this emoji under every firing post and anyone else's
    // click on it acknowledges, read back every ACK_POLL_SECONDS. "off" = none.
    ackReaction: /^(off|none|false|0)$/i.test(env.ACK_REACTION ?? "") ? "" : env.ACK_REACTION || "eyes",
    ackPollSeconds: Number(env.ACK_POLL_SECONDS ?? 30),
    lookbackPages: Number(env.LOOKBACK_PAGES ?? 3),
  };
}

/** Runs `fn`s with one key one at a time: Alertmanager can send a group's next notification before the last is posted. */
function serializer() {
  const chains = new Map();
  return (key, fn) => {
    const next = (chains.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    chains.set(key, next);
    next.finally(() => chains.get(key) === next && chains.delete(key)).catch(() => {});
    return next;
  };
}

/** Props the server set on our post (from_bot, …): kept on every patch, since a patch replaces props whole. */
const extraProps = (props = {}) => Object.fromEntries(Object.entries(props).filter(([k]) => k !== "attachments" && k !== STATE_PROP));

export function createBridge({ mm, cfg, log = console, now = () => new Date() }) {
  const channels = new Map(); // name → Promise<{ id, name, groups: Map<groupKey, entry>, summaries: string[] }>
  const byPost = new Map(); // postId → { ch, key }
  const serial = serializer();
  let me;
  const self = async () => (me ??= await mm.me());
  const permalink = (postId) => `${mm.url}/${cfg.team}/pl/${postId}`;
  const renderCfg = () => ({ ...cfg, secret: cfg.token, now: now() });
  const soft = (what) => (e) => log.warn(`[bridge] ${what} failed: ${e.message}`);
  const names = new Map();
  const username = async (id) => names.get(id) ?? mm.user(id).then((u) => (names.set(id, u.username), u.username), () => id);

  function remember(ch, key, entry) {
    ch.groups.set(key, entry);
    byPost.set(entry.postId, { ch, key });
  }

  /** The channel and every group post the bridge can find in it — pinned (firing) first, then recent. */
  function channel(name) {
    if (!channels.has(name)) {
      const loading = (async () => {
        const { id: userId } = await self();
        const found = await mm.channel(cfg.team, name);
        const ch = { id: found.id, name, groups: new Map(), summaries: [] };
        const lists = [];
        if (cfg.pin) lists.push(await mm.pinned(ch.id).catch((e) => (soft("reading pinned posts")(e), {})));
        for (let page = 0; page < cfg.lookbackPages; page++) {
          const list = await mm.channelPosts(ch.id, page, 200).catch((e) => (soft("reading channel posts")(e), {}));
          lists.push(list);
          if ((list.order ?? []).length < 200) break;
        }
        const posts = new Map();
        for (const l of lists) for (const id of l.order ?? []) posts.set(id, l.posts[id]);
        // newest post per group wins
        for (const p of [...posts.values()].sort((a, b) => a.create_at - b.create_at)) {
          if (p.user_id !== userId || p.root_id || p.delete_at) continue;
          if (p.props?.[SUMMARY_PROP]) ch.summaries.push(p.id);
          const state = p.props?.[STATE_PROP];
          if (state?.groupKey) remember(ch, state.groupKey, { postId: p.id, state, extra: extraProps(p.props) });
        }
        const open = [...ch.groups.values()].filter((e) => e.state.status === "firing").length;
        log.info(`[bridge] ~${name}: ${ch.groups.size} group post(s) found, ${open} still firing`);
        return ch;
      })();
      channels.set(name, loading);
      loading.catch(() => channels.delete(name)); // retried on the next notification
    }
    return channels.get(name);
  }

  const reply = (ch, rootId, message) => message && mm.post(ch.id, { message }, rootId).catch(soft("thread reply"));
  const patch = (entry) => mm.update(entry.postId, rootProps(entry));
  function rootProps(entry) {
    const { message, attachments } = renderRoot(entry.state, { ...renderCfg(), permalink: entry.postId ? permalink(entry.postId) : "" });
    return { message, props: { ...entry.extra, attachments, [STATE_PROP]: entry.state } };
  }
  async function markFiring(postId) {
    const { id } = await self();
    if (cfg.pin) await mm.pin(postId).catch(soft("pin"));
    if (cfg.reactions) await mm.react(id, postId, "fire").catch(soft("reaction"));
    // the acknowledge "button": one click on this reaction chip
    if (cfg.ackReaction) await mm.react(id, postId, cfg.ackReaction).catch(soft("ack reaction"));
  }
  async function markResolved(postId) {
    const { id } = await self();
    if (cfg.pin) await mm.unpin(postId).catch(soft("unpin"));
    if (cfg.reactions) {
      await mm.unreact(id, postId, "fire").catch(soft("reaction removal"));
      await mm.react(id, postId, "white_check_mark").catch(soft("reaction"));
    }
    if (cfg.ackReaction) await mm.unreact(id, postId, cfg.ackReaction).catch(soft("ack reaction removal"));
  }

  /** One Alertmanager notification. Throws on a Mattermost failure, so Alertmanager retries it. */
  async function notify(payload, channelName = cfg.channel) {
    if (!Array.isArray(payload?.alerts)) throw Object.assign(new Error("not an Alertmanager webhook payload"), { status: 400 });
    const ch = await channel(channelName);
    const key = groupKeyOf(payload);
    return serial(`${ch.id}|${key}`, async () => {
      const prev = ch.groups.get(key);
      const { state, events, create } = applyNotification(prev?.state ?? null, payload, now());

      if (create) {
        if (prev && prev.state.status === "resolved") {
          state.previous = { postId: prev.postId, resolvedAt: prev.state.resolvedAt, permalink: permalink(prev.postId) };
        }
        const entry = { postId: "", state, extra: {} };
        const { message, attachments } = renderRoot(state, renderCfg());
        const post = await mm.post(ch.id, { message, props: { attachments, [STATE_PROP]: state } });
        entry.postId = post.id;
        entry.extra = extraProps(post.props);
        remember(ch, key, entry);
        // The Jira ticket links back to this post, whose id exists only now: one edit to put it in.
        if (cfg.cardLinks.includes("jira") && cfg.jiraUrl && cfg.jiraProjectId && cfg.jiraIssueTypeId) await patch(entry).catch(soft("adding the post link to the Jira shortcut"));
        if (state.status === "firing") await markFiring(post.id);
        else if (cfg.reactions) await mm.react((await self()).id, post.id, "white_check_mark").catch(soft("reaction"));
        if (state.previous) await reply(ch, prev.postId, `🔁 **Fired again** → [new post](${permalink(post.id)})`);
        log.info(`[bridge] ${state.status === "firing" ? "FIRING" : "RESOLVED (orphan)"} ${state.alertname} → post ${post.id}`);
        return { action: "created", postId: post.id };
      }

      if (events.length === 0) return { action: "unchanged", postId: prev.postId };
      const entry = { ...prev, state };
      const reminders = events.filter((e) => e.type === "repeat");
      // A repeat with nothing new is a reminder, spaced by REMIND_MINUTES so a short repeat_interval does not flood the thread.
      const lastReminder = Date.parse(prev.state.remindedAt ?? prev.state.createdAt);
      const remind = reminders.length > 0 && now() - lastReminder >= cfg.remindMinutes * 60_000;
      if (remind) state.remindedAt = now().toISOString();
      else if (reminders.length) state.remindedAt = prev.state.remindedAt;

      // The root first: if the edit fails, Alertmanager retries and the replies are not posted twice.
      await patch(entry);
      remember(ch, key, entry);
      for (const ev of events) {
        if (ev.type === "repeat" && !remind) continue;
        await reply(ch, entry.postId, renderEvent(ev, state, renderCfg()));
      }
      if (state.status === "resolved") await markResolved(entry.postId);
      log.info(`[bridge] ${state.alertname}: ${events.map((e) => e.type).join(", ")} → post ${entry.postId}`);
      return { action: events.map((e) => e.type).join(","), postId: entry.postId };
    });
  }

  /** A Mattermost button click. Returns the JSON Mattermost shows the clicker. Every click is logged with its outcome. */
  async function action(p) {
    const result = await decide(p);
    log.info(`[bridge] click ${p?.context?.action ?? "?"} by ${p?.user_name || p?.user_id || "?"} on post ${p?.post_id ?? "?"} → ${result.status} ${result.body.ephemeral_text}`);
    return result;
  }

  async function decide(p) {
    if (cfg.token && p?.context?.secret !== cfg.token) return { status: 403, body: { ephemeral_text: "Not authorized (the button's secret does not match BRIDGE_TOKEN)." } };
    if (p?.context?.action !== "ack") return { status: 200, body: { ephemeral_text: `Unknown action \`${p?.context?.action}\`.` } };
    // A click can be the first thing a restarted bridge hears: read the default channel back before giving up.
    if (!byPost.has(p.post_id) && cfg.channel) await channel(cfg.channel).catch(soft("reading the channel back"));
    const at = byPost.get(p.post_id);
    if (!at) return { status: 200, body: { ephemeral_text: "This alert is not tracked by the bridge any more." } };
    const r = await acknowledge(at, p.user_name || (await username(p.user_id)), now());
    return { status: 200, body: { ephemeral_text: r.text } };
  }

  /** The one acknowledge path, for the button and the reaction alike. */
  function acknowledge(at, by, when) {
    return serial(`${at.ch.id}|${at.key}`, async () => {
      const prev = at.ch.groups.get(at.key);
      if (prev.state.status !== "firing") return { ok: false, text: "Already resolved." };
      if (prev.state.ack) return { ok: false, text: `Already acknowledged by @${prev.state.ack.by}.` };
      const entry = { ...prev, state: { ...prev.state, ack: { by, at: when.toISOString() } } };
      await patch(entry);
      remember(at.ch, at.key, entry);
      await reply(at.ch, entry.postId, renderEvent({ type: "ack", by }, entry.state, renderCfg()));
      // the bot's own chip goes; the acknowledger's stays
      if (cfg.ackReaction) await mm.unreact((await self()).id, entry.postId, cfg.ackReaction).catch(soft("ack reaction removal"));
      log.info(`[bridge] ${entry.state.alertname}: acknowledged by @${by}`);
      return { ok: true, text: "Acknowledged — the post shows your name." };
    });
  }

  /**
   * Acknowledge by reaction: ONE bulk read of the reactions on every unacknowledged firing post. The first
   * person (not the bot) to click the ack emoji acknowledges, at the time they clicked. Returns how many.
   */
  async function pollAcks() {
    if (!cfg.ackReaction) return 0;
    const open = (await firing()).filter((e) => !e.state.ack);
    if (open.length === 0) return 0;
    const { id: botId } = await self();
    const byPostId = await mm.reactionsFor(open.map((e) => e.postId));
    let acked = 0;
    for (const e of open) {
      const list = Array.isArray(byPostId?.[e.postId]) ? byPostId[e.postId] : [];
      const first = list.filter((r) => r.emoji_name === cfg.ackReaction && r.user_id !== botId).sort((a, b) => a.create_at - b.create_at)[0];
      if (!first) continue;
      const r = await acknowledge({ ch: e.ch, key: e.state.groupKey }, await username(first.user_id), first.create_at > 0 ? new Date(first.create_at) : now());
      if (r.ok) acked++;
    }
    return acked;
  }

  async function firing() {
    const out = [];
    for (const loading of channels.values()) {
      const ch = await loading.catch(() => null);
      if (!ch) continue;
      for (const e of ch.groups.values()) if (e.state.status === "firing") out.push({ ch, ...e, permalink: permalink(e.postId) });
    }
    return out;
  }

  /** Re-posts the "still firing" list at the bottom of each channel and deletes the previous one. */
  async function summarize() {
    const open = await firing();
    for (const loading of channels.values()) {
      const ch = await loading.catch(() => null);
      if (!ch) continue;
      for (const id of ch.summaries.splice(0)) await mm.remove(id).catch(soft("removing the last summary"));
      const mine = open.filter((e) => e.ch === ch);
      if (mine.length === 0) continue;
      const post = await mm.post(ch.id, { message: renderSummary(mine, renderCfg()), props: { [SUMMARY_PROP]: true } }).catch(soft("summary"));
      if (post?.id) ch.summaries.push(post.id);
    }
  }

  return { notify, action, pollAcks, firing, summarize, channel };
}

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 5_000_000) reject(Object.assign(new Error("payload too large"), { status: 413 }));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("not JSON"), { status: 400 }));
      }
    });
  });

export function handler(bridge, cfg, log = console) {
  const send = (res, status, body) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  return async (req, res) => {
    const url = new URL(req.url, "http://bridge");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/status") {
        const open = await bridge.firing();
        return send(res, 200, open.map((e) => ({ channel: e.ch.name, alertname: e.state.alertname, groupKey: e.state.groupKey, since: e.state.createdAt, firing: Object.values(e.state.alerts).filter((a) => a.status === "firing").length, ack: e.state.ack ?? null, post: e.permalink })));
      }
      if (req.method === "POST" && url.pathname === "/alertmanager") {
        if (cfg.token && req.headers.authorization !== `Bearer ${cfg.token}`) return send(res, 401, { error: "unauthorized" });
        const result = await bridge.notify(await readJson(req), url.searchParams.get("channel") || cfg.channel);
        return send(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/action") {
        const { status, body } = await bridge.action(await readJson(req));
        return send(res, status, body);
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      log.error(`[bridge] ${req.method} ${url.pathname}: ${e.message}`);
      // 5xx: Alertmanager retries the notification
      return send(res, e.status ?? 500, { error: e.message });
    }
  };
}

async function main() {
  const dry = process.argv.includes("--dry-run");
  const cfg = configFromEnv();
  for (const k of ["MM_TEAM", "MM_CHANNEL", ...(dry ? [] : ["MM_URL", "MM_TOKEN"])]) {
    if (!process.env[k]) {
      console.error(`missing ${k} — see README.md`);
      process.exit(2);
    }
  }
  const bridge = createBridge({ mm: mattermost({ dry }), cfg });
  bridge.channel(cfg.channel).catch((e) => console.error(`[bridge] could not read ~${cfg.channel} at startup (retried on the next notification): ${e.message}`));
  if (cfg.ackReaction && cfg.ackPollSeconds > 0) setInterval(() => bridge.pollAcks().catch((e) => console.error(`[bridge] reading ack reactions: ${e.message}`)), cfg.ackPollSeconds * 1000);
  if (cfg.summaryMinutes > 0) setInterval(() => bridge.summarize().catch((e) => console.error(`[bridge] summary: ${e.message}`)), cfg.summaryMinutes * 60_000);
  createServer(handler(bridge, cfg)).listen(cfg.port, () =>
    console.log(
      `alert bridge on :${cfg.port} → ~${cfg.channel}${dry ? " (dry run)" : ""} · card ${cfg.cardStyle} [${cfg.cardLinks.join(", ")}] · pin ${cfg.pin ? "on" : "off"} · ack ${[cfg.ackReaction && `:${cfg.ackReaction}: reaction every ${cfg.ackPollSeconds}s`, cfg.actionUrl && "button"].filter(Boolean).join(" + ") || "off"} · webhook auth ${cfg.token ? "on" : "OFF"}`
    )
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
