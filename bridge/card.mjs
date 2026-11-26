// The pure half of the bridge: merge an Alertmanager notification into a group's state, and render
// that state as the group's ONE Mattermost post (edited in place) plus the thread replies that say
// what changed. No I/O here — bridge.mjs does the posting.
//
// One Alertmanager group (its groupKey) = one post. Every notification for the group carries every
// alert still firing in it (plus the ones resolved since the last notification, with send_resolved),
// so an alert that WAS firing and is absent from an untruncated notification is no longer firing.
import { createHash } from "node:crypto";

/** The post prop that holds a group's state, so the post itself is the store. */
export const STATE_PROP = "am_bridge";
/** Marks the bridge's "still firing" summary posts. */
export const SUMMARY_PROP = "am_bridge_summary";
/** Alerts kept per group; resolved ones go first. Post props are capped by Mattermost. */
export const MAX_ALERTS = 100;

const SEVERITY = {
  critical: { rank: 4, emoji: "🔴", color: "#d93025" },
  error: { rank: 3, emoji: "🔴", color: "#d93025" },
  high: { rank: 3, emoji: "🟠", color: "#e8710a" },
  warning: { rank: 2, emoji: "🟠", color: "#f9ab00" },
  medium: { rank: 2, emoji: "🟡", color: "#f9ab00" },
  info: { rank: 1, emoji: "🔵", color: "#1a73e8" },
  low: { rank: 1, emoji: "🔵", color: "#1a73e8" },
};
const UNKNOWN_SEVERITY = { rank: 0, emoji: "⚪", color: "#5f6368" };
const RESOLVED_COLOR = "#188038";
const ACK_COLOR = "#9334e6";
export const severityOf = (s) => SEVERITY[String(s ?? "").toLowerCase()] ?? UNKNOWN_SEVERITY;

const KEEP_ANNOTATIONS = ["summary", "description", "message", "runbook_url", "runbook"];
/** Labels never worth a line: identity of the group, or noise that changes on every restart. */
const NOT_A_SUBJECT = new Set(["alertname", "severity", "uid", "container_id", "image_id", "prometheus", "endpoint"]);
const PREFERRED_SUBJECT = ["pod", "container", "node", "instance", "service", "deployment", "statefulset", "daemonset", "job_name", "persistentvolumeclaim", "job"];

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k]).map((k) => [k, o[k]]));
/** Alertmanager writes 0001-01-01 for "no end yet". */
const validTime = (s) => (s && Number.isFinite(Date.parse(s)) && Date.parse(s) > Date.parse("2000-01-01") ? s : undefined);

export function fingerprintOf(alert) {
  if (alert.fingerprint) return alert.fingerprint;
  const labels = Object.entries(alert.labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(labels)).digest("hex").slice(0, 16);
}

export const groupKeyOf = (payload) =>
  payload.groupKey || JSON.stringify(Object.entries(payload.groupLabels ?? {}).sort(([a], [b]) => a.localeCompare(b)));

function fresh(payload, nowIso) {
  return {
    v: 1,
    groupKey: groupKeyOf(payload),
    status: "firing",
    alertname: payload.groupLabels?.alertname ?? payload.commonLabels?.alertname ?? payload.alerts?.[0]?.labels?.alertname ?? "Alert",
    groupLabels: payload.groupLabels ?? {},
    commonLabels: payload.commonLabels ?? {},
    commonAnnotations: pick(payload.commonAnnotations, KEEP_ANNOTATIONS),
    receiver: payload.receiver ?? "",
    externalURL: payload.externalURL ?? "",
    createdAt: nowIso,
    updatedAt: nowIso,
    alerts: {},
  };
}

/**
 * Merges one notification. Returns `create: true` when this is a NEW post: the group had none, or its
 * last one is resolved (a new firing is a new incident, posted at the bottom of the channel where it is
 * seen — never an old post turned red again further up). `events` are the thread replies to post.
 */
export function applyNotification(prev, payload, now = new Date()) {
  const nowIso = now.toISOString();
  const incoming = (payload.alerts ?? []).map((a) => ({ ...a, fp: fingerprintOf(a), status: a.status === "resolved" ? "resolved" : "firing" }));
  const anyFiring = incoming.some((a) => a.status === "firing");
  const opening = !prev || prev.status === "resolved";

  if (opening && !anyFiring) {
    // A resolve for a group already resolved (a retry, a second receiver): nothing to do.
    if (prev) return { state: prev, events: [], create: false };
    // A resolve whose firing post is unknown (posted before the bridge ran, or in another channel).
    const state = fresh(payload, nowIso);
    for (const a of incoming) state.alerts[a.fp] = record(a, undefined, nowIso);
    state.status = "resolved";
    state.orphan = true;
    state.resolvedAt = latestEnd(state) ?? nowIso;
    return { state, events: [], create: true };
  }

  const state = opening ? fresh(payload, nowIso) : structuredClone(prev);
  // The group's labels/annotations can only be refreshed; a notification missing them keeps the old ones.
  if (payload.commonLabels && Object.keys(payload.commonLabels).length) state.commonLabels = payload.commonLabels;
  const ann = pick(payload.commonAnnotations, KEEP_ANNOTATIONS);
  if (Object.keys(ann).length) state.commonAnnotations = ann;
  if (payload.receiver) state.receiver = payload.receiver;
  if (payload.externalURL) state.externalURL = payload.externalURL;

  const newlyFiring = [];
  const newlyResolved = [];
  const seen = new Set();
  for (const a of incoming) {
    seen.add(a.fp);
    const old = state.alerts[a.fp];
    if (a.status === "firing" && old?.status !== "firing" && !opening) newlyFiring.push(a.fp);
    if (a.status === "resolved" && old?.status !== "resolved") newlyResolved.push(a.fp);
    state.alerts[a.fp] = record(a, old, nowIso);
  }
  // Absent from a complete notification = no longer firing. A truncated one (webhook max_alerts) proves nothing.
  if (!(payload.truncatedAlerts > 0)) {
    for (const [fp, rec] of Object.entries(state.alerts)) {
      if (!seen.has(fp) && rec.status === "firing") {
        rec.status = "resolved";
        rec.endsAt = nowIso;
        rec.gone = true;
        newlyResolved.push(fp);
      }
    }
  }

  const stillFiring = Object.values(state.alerts).some((a) => a.status === "firing");
  const events = [];
  if (opening) {
    events.push({ type: "opened" });
  } else if (!stillFiring) {
    state.status = "resolved";
    state.resolvedAt = latestEnd(state) ?? nowIso;
    events.push({ type: "all-resolved", fps: newlyResolved });
  } else {
    if (newlyFiring.length) events.push({ type: "firing", fps: newlyFiring });
    if (newlyResolved.length) events.push({ type: "resolved", fps: newlyResolved });
    if (!newlyFiring.length && !newlyResolved.length) events.push({ type: "repeat" });
  }
  state.updatedAt = nowIso;
  prune(state);
  return { state, events, create: opening };
}

function record(a, old, nowIso) {
  return {
    labels: a.labels ?? {},
    annotations: pick(a.annotations, KEEP_ANNOTATIONS),
    status: a.status,
    startsAt: validTime(a.startsAt) ?? old?.startsAt ?? nowIso,
    ...(a.status === "resolved" ? { endsAt: validTime(a.endsAt) ?? old?.endsAt ?? nowIso } : {}),
    ...(a.generatorURL ? { generatorURL: a.generatorURL } : {}),
  };
}

function latestEnd(state) {
  const ends = Object.values(state.alerts).map((a) => Date.parse(a.endsAt ?? "")).filter(Number.isFinite);
  return ends.length ? new Date(Math.max(...ends)).toISOString() : undefined;
}

function prune(state) {
  const entries = Object.entries(state.alerts);
  if (entries.length <= MAX_ALERTS) return;
  const resolvedOldestFirst = entries.filter(([, a]) => a.status === "resolved").sort(([, a], [, b]) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
  let excess = entries.length - MAX_ALERTS;
  for (const [fp] of resolvedOldestFirst) {
    if (excess-- <= 0) break;
    delete state.alerts[fp];
    state.dropped = (state.dropped ?? 0) + 1;
  }
}

// ── rendering ───────────────────────────────────────────────────────────────

export function span(ms) {
  if (!(ms >= 60_000)) return "<1m";
  const m = Math.round(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return min ? `${h}h ${min}m` : `${h}h`;
  return `${min}m`;
}

const TZ_NAMES = { "Asia/Jakarta": "WIB", "Asia/Pontianak": "WIB", "Asia/Makassar": "WITA", "Asia/Jayapura": "WIT", UTC: "UTC", "Etc/UTC": "UTC" };
export function tzLabel(tz) {
  if (TZ_NAMES[tz]) return TZ_NAMES[tz];
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

/** "13:02" today, "26 Nov 13:02" otherwise, in the display time zone. */
export function clock(iso, tz, now = new Date()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "?";
  const day = (x) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return day(d) === day(now) ? hm : `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(d)} ${hm}`;
}

/** Which labels tell the group's alerts apart, most useful first (at most two). */
export function subjectKeys(alerts, groupLabels = {}) {
  const labels = alerts.map((a) => a.labels ?? {});
  const all = [...new Set(labels.flatMap(Object.keys))].filter((k) => !NOT_A_SUBJECT.has(k) && !(k in groupLabels));
  let keys = all.filter((k) => new Set(labels.map((l) => l[k] ?? "")).size > 1);
  if (keys.length === 0) keys = PREFERRED_SUBJECT.filter((k) => all.includes(k)).slice(0, 1);
  const rank = (k) => (PREFERRED_SUBJECT.includes(k) ? PREFERRED_SUBJECT.indexOf(k) : PREFERRED_SUBJECT.length);
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 2);
}

const subjectOf = (a, keys) => keys.filter((k) => a.labels?.[k]).map((k) => `\`${k}=${a.labels[k]}\``).join(" ") || a.annotations?.summary || "alert";

/** A label every alert of the group agrees on. */
function groupLabel(state, key) {
  if (state.groupLabels[key]) return state.groupLabels[key];
  if (state.commonLabels[key]) return state.commonLabels[key];
  const values = new Set(Object.values(state.alerts).map((a) => a.labels?.[key]));
  return values.size === 1 ? [...values][0] : undefined;
}

function groupSeverity(state, alerts) {
  const own = groupLabel(state, "severity");
  if (own) return own;
  return alerts.map((a) => a.labels?.severity).filter(Boolean).sort((a, b) => severityOf(b).rank - severityOf(a).rank)[0] ?? "unknown";
}

function silenceUrl(state, base) {
  if (!base) return undefined;
  const matchers = Object.keys(state.groupLabels).length ? state.groupLabels : { alertname: state.alertname };
  const filter = `{${Object.entries(matchers).map(([k, v]) => `${k}="${v}"`).join(", ")}}`;
  return `${base.replace(/\/+$/, "")}/#/silences/new?filter=${encodeURIComponent(filter)}`;
}

/** generatorURL points at Prometheus' own (often in-cluster) hostname; PROMETHEUS_URL rewrites the origin. */
function sourceUrl(url, prometheusUrl) {
  if (!url) return undefined;
  if (!prometheusUrl) return url;
  try {
    const u = new URL(url);
    const base = new URL(prometheusUrl);
    return `${base.origin}${base.pathname.replace(/\/+$/, "")}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

const byStart = (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt);
const byEndDesc = (a, b) => Date.parse(b.endsAt ?? 0) - Date.parse(a.endsAt ?? 0);

/**
 * The group's post. `cfg`: { tz, now, alertmanagerUrl, prometheusUrl, actionUrl, secret, mention,
 * mentionSeverities, maxLines }. Text that must notify (the mention) stays in `message`.
 */
export function renderRoot(state, cfg = {}) {
  const tz = cfg.tz ?? "UTC";
  const now = cfg.now ?? new Date();
  const maxLines = cfg.maxLines ?? 12;
  const alerts = Object.values(state.alerts);
  const firing = alerts.filter((a) => a.status === "firing").sort(byStart);
  const resolved = alerts.filter((a) => a.status === "resolved").sort(byEndDesc);
  const isFiring = state.status === "firing";
  const sevName = groupSeverity(state, isFiring ? firing : alerts);
  const sev = severityOf(sevName);
  const ns = groupLabel(state, "namespace");
  const cluster = groupLabel(state, "cluster");
  const start = alerts.map((a) => a.startsAt).sort()[0] ?? state.createdAt;

  const counts = alerts.length > 1 ? (isFiring ? `${firing.length} of ${alerts.length} firing` : `${alerts.length} alerts`) : "";
  const head = isFiring ? "🔥 **FIRING**" : "✅ **RESOLVED**";
  const mention = isFiring && cfg.mention && (cfg.mentionSeverities ?? ["critical"]).includes(String(sevName).toLowerCase()) ? `\n${cfg.mention}` : "";
  const message = [head, `**${state.alertname}**`, `${sev.emoji} ${sevName}`, ns && `\`${ns}\``, counts].filter(Boolean).join(" · ") + mention;

  // Summary and description: the group's own when its alerts agree, else one alert's, labelled as such.
  const common = state.commonAnnotations ?? {};
  const one = firing[0]?.annotations ?? alerts[0]?.annotations ?? {};
  const speaks = (k) => (common[k] ? common[k] : alerts.length === 1 ? one[k] : one[k] ? `${one[k]} _(1 of ${alerts.length})_` : undefined);
  const lines = [];
  if (state.previous) {
    lines.push(`🔁 Fired again — the last one resolved ${span(now - Date.parse(state.previous.resolvedAt))} before this ([previous](${state.previous.permalink})).`);
  }
  if (state.orphan) lines.push("_The firing post for this group was not found (sent before the bridge ran, or to another channel)._");
  const summary = speaks("summary");
  const description = speaks("description") ?? speaks("message");
  if (summary) lines.push(`**Summary:** ${summary}`);
  if (description && description !== summary) lines.push(`**Description:** ${description}`);

  const keys = subjectKeys(alerts, state.groupLabels);
  if (alerts.length > 1 || keys.length) {
    const rows = [
      ...firing.map((a) => `🔥 ${subjectOf(a, keys)} · since ${clock(a.startsAt, tz, now)}`),
      ...resolved.map((a) => `✅ ${subjectOf(a, keys)} · resolved ${clock(a.endsAt, tz, now)} after ${span(Date.parse(a.endsAt) - Date.parse(a.startsAt))}`),
    ];
    if (lines.length) lines.push("");
    lines.push(...rows.slice(0, maxLines));
    const more = rows.length - maxLines + (state.dropped ?? 0);
    if (more > 0) lines.push(`_+${more} more_`);
  }

  const runbook = common.runbook_url ?? common.runbook ?? one.runbook_url ?? one.runbook;
  const links = [
    isFiring && silenceUrl(state, cfg.alertmanagerUrl || state.externalURL) && `[🔕 Silence](${silenceUrl(state, cfg.alertmanagerUrl || state.externalURL)})`,
    sourceUrl((firing[0] ?? alerts[0])?.generatorURL, cfg.prometheusUrl) && `[📈 Source](${sourceUrl((firing[0] ?? alerts[0]).generatorURL, cfg.prometheusUrl)})`,
    runbook && `[📘 Runbook](${runbook})`,
  ].filter(Boolean);
  if (links.length) lines.push("", links.join(" · "));

  const tzName = tzLabel(tz);
  const fields = [
    ns && { short: true, title: "Namespace", value: `\`${ns}\`` },
    cluster && { short: true, title: "Cluster", value: cluster },
    { short: true, title: "Started", value: `${clock(start, tz, now)} ${tzName}` },
    !isFiring && { short: true, title: "Resolved", value: `${clock(state.resolvedAt, tz, now)} ${tzName} · after ${span(Date.parse(state.resolvedAt) - Date.parse(start))}` },
    state.ack && { short: true, title: "Acknowledged", value: `@${state.ack.by} · ${clock(state.ack.at, tz, now)}` },
  ].filter(Boolean);

  const color = !isFiring ? RESOLVED_COLOR : state.ack ? ACK_COLOR : sev.color;
  const title = `${isFiring ? (state.ack ? "👀 FIRING · ACKNOWLEDGED" : "🔥 FIRING") : "✅ RESOLVED"} — ${state.alertname}`;
  const actions =
    isFiring && !state.ack && cfg.actionUrl
      ? [{ id: "ack", name: "👀 Acknowledge", style: "primary", integration: { url: cfg.actionUrl, context: { action: "ack", ...(cfg.secret ? { secret: cfg.secret } : {}) } } }]
      : [];
  const attachment = {
    fallback: message.replace(/\*\*/g, "").split("\n")[0],
    color,
    title,
    text: lines.join("\n"),
    fields,
    footer: `${state.receiver || "alertmanager"} · updated ${clock(state.updatedAt, tz, now)} ${tzName}`,
    ...(actions.length ? { actions } : {}),
  };
  return { message, attachments: [attachment] };
}

/** A thread reply for one event, or null for none. */
export function renderEvent(ev, state, cfg = {}) {
  const tz = cfg.tz ?? "UTC";
  const now = cfg.now ?? new Date();
  const alerts = Object.values(state.alerts);
  const keys = subjectKeys(alerts, state.groupLabels);
  const list = (fps) => {
    const names = fps.map((fp) => state.alerts[fp]).filter(Boolean).map((a) => subjectOf(a, keys));
    return names.slice(0, 10).join(", ") + (names.length > 10 ? ` +${names.length - 10} more` : "");
  };
  const firingCount = alerts.filter((a) => a.status === "firing").length;
  const start = alerts.map((a) => a.startsAt).sort()[0] ?? state.createdAt;
  switch (ev.type) {
    case "firing":
      return `🔥 **${ev.fps.length} more firing** — ${list(ev.fps)} · ${firingCount} firing now`;
    case "resolved":
      return `✅ **${ev.fps.length} resolved** — ${list(ev.fps)} · ${firingCount} still firing`;
    case "all-resolved":
      return `✅ **All resolved** at ${clock(state.resolvedAt, tz, now)} ${tzLabel(tz)} · after ${span(Date.parse(state.resolvedAt) - Date.parse(start))}`;
    case "repeat":
      return `⏰ **Still firing** · ${span(now - Date.parse(start))} · ${firingCount} alert${firingCount === 1 ? "" : "s"}${state.ack ? ` · acknowledged by @${state.ack.by}` : " · **not acknowledged**"}`;
    case "ack":
      return `👀 Acknowledged by @${ev.by}`;
    default:
      return null;
  }
}

/** The channel's "still firing" summary: oldest first, unacknowledged ones said so. */
export function renderSummary(entries, cfg = {}) {
  const now = cfg.now ?? new Date();
  const rows = entries
    .map(({ state, permalink }) => {
      const alerts = Object.values(state.alerts);
      const firing = alerts.filter((a) => a.status === "firing");
      const start = alerts.map((a) => a.startsAt).sort()[0] ?? state.createdAt;
      const sevName = groupSeverity(state, firing);
      const ns = groupLabel(state, "namespace");
      return {
        start,
        line: `• ${severityOf(sevName).emoji} [${state.alertname}${ns ? ` · ${ns}` : ""}](${permalink}) — ${firing.length} firing · ${span(now - Date.parse(start))}${state.ack ? ` · 👀 @${state.ack.by}` : " · **not acknowledged**"}`,
      };
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return `📌 **Still firing (${rows.length})** — oldest first\n${rows.map((r) => r.line).join("\n")}`;
}
