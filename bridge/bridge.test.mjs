// node --test   (from this folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createBridge, configFromEnv, handler } from "./bridge.mjs";
import { applyNotification, renderRoot, renderEvent, subjectKeys, span, STATE_PROP, SUMMARY_PROP } from "./card.mjs";
import { fakeMattermost } from "./fake-mm.mjs";
import { alert, notification, crashLabels, crashAnn, crashGroup, memLabels, memAnn, memGroup } from "./payloads.mjs";

const T0 = Date.parse("2026-11-27T03:00:00Z"); // 10:00 WIB
const at = (min) => new Date(T0 + min * 60_000);
const iso = (min) => at(min).toISOString();
const quiet = { info() {}, warn() {}, error() {} };

function setup(env = {}) {
  const mm = fakeMattermost();
  let clock = at(0);
  const cfg = configFromEnv({ MM_TEAM: "ops", MM_CHANNEL: "alerts", ...env });
  const bridge = createBridge({ mm, cfg, log: quiet, now: () => clock });
  return { mm, cfg, bridge, setNow: (min) => (clock = at(min)) };
}

const crash = (pod, opts = {}) => alert(crashLabels(pod), { annotations: crashAnn, startsAt: iso(0), ...opts });

// ── card.mjs ────────────────────────────────────────────────────────────────

test("span reads like a person", () => {
  assert.equal(span(30_000), "<1m");
  assert.equal(span(12 * 60_000), "12m");
  assert.equal(span(125 * 60_000), "2h 5m");
  assert.equal(span(120 * 60_000), "2h");
  assert.equal(span(27 * 3_600_000), "1d 3h");
});

test("subject: the label that tells alerts apart; none for one alert without one", () => {
  const a = [crash("a"), crash("b")].map((x) => ({ labels: x.labels }));
  assert.deepEqual(subjectKeys(a, crashGroup), ["pod"]);
  assert.deepEqual(subjectKeys([{ labels: memLabels }], memGroup), ["node"]);
  assert.deepEqual(subjectKeys([{ labels: { alertname: "Watchdog", severity: "none" } }], {}), []);
});

test("an alert absent from a complete notification is no longer firing; from a truncated one, still is", () => {
  const first = applyNotification(null, notification(crashGroup, [crash("a"), crash("b")]), at(0));
  const later = applyNotification(first.state, notification(crashGroup, [crash("b")]), at(5));
  assert.deepEqual(later.events.map((e) => e.type), ["resolved"]);
  assert.equal(Object.values(later.state.alerts).find((a) => a.labels.pod === "a").status, "resolved");
  const truncated = applyNotification(first.state, notification(crashGroup, [crash("b")], { truncatedAlerts: 1 }), at(5));
  assert.deepEqual(truncated.events.map((e) => e.type), ["repeat"]);
});

test("the root renders the state: colour, title, list, links, fields", () => {
  const { state } = applyNotification(null, notification(crashGroup, [crash("a"), crash("b", { startsAt: iso(2) })]), at(3));
  const { message, attachments: [att] } = renderRoot(state, { tz: "Asia/Jakarta", now: at(3) });
  assert.equal(message, "🔥 **FIRING** · **KubePodCrashLooping** · 🔴 critical · `sample-apps` · 2 of 2 firing");
  assert.equal(att.color, "#d93025");
  assert.equal(att.title, "🔥 FIRING — KubePodCrashLooping");
  assert.match(att.text, /\*\*Summary:\*\* Pod is crash looping\./);
  assert.match(att.text, /🔥 `pod=a` · since 10:00\n🔥 `pod=b` · since 10:02/);
  assert.match(att.text, /\[🔕 Silence\]\(http:\/\/alertmanager:9093\/#\/silences\/new\?filter=%7Balertname%3D%22KubePodCrashLooping%22%2C%20namespace%3D%22sample-apps%22%7D\)/);
  assert.match(att.text, /\[📘 Runbook\]\(https:\/\/runbooks/);
  assert.deepEqual(att.fields.map((f) => f.title), ["Namespace", "Cluster", "Started"]);
  assert.equal(att.fields[2].value, "10:00 WIB");
  assert.equal(att.actions, undefined, "no button without BRIDGE_URL");
});

test("PROMETHEUS_URL rewrites the Source link's origin", () => {
  const { state } = applyNotification(null, notification(memGroup, [alert(memLabels, { annotations: memAnn, startsAt: iso(0) })]), at(0));
  const { attachments: [att] } = renderRoot(state, { prometheusUrl: "https://prometheus.example.org" });
  assert.match(att.text, /\[📈 Source\]\(https:\/\/prometheus\.example\.org\/graph\?g0\.expr=NodeMemoryHighUtilization\)/);
});

test("a mention only while firing, and only for the configured severities", () => {
  const crit = applyNotification(null, notification(crashGroup, [crash("a")]), at(0)).state;
  const warn = applyNotification(null, notification(memGroup, [alert(memLabels, { startsAt: iso(0) })]), at(0)).state;
  assert.match(renderRoot(crit, { mention: "@channel" }).message, /\n@channel$/);
  assert.doesNotMatch(renderRoot(warn, { mention: "@channel" }).message, /@channel/);
  assert.doesNotMatch(renderRoot({ ...crit, status: "resolved", resolvedAt: iso(9) }, { mention: "@channel" }).message, /@channel/);
});

// ── the bridge, against a fake Mattermost ───────────────────────────────────

test("firing → one post, pinned, 🔥; resolved → the SAME post edited green, unpinned, ✅", async () => {
  const { mm, bridge, setNow } = setup();
  const r1 = await bridge.notify(notification(crashGroup, [crash("a")]));
  assert.equal(r1.action, "created");
  const id = r1.postId;
  assert.ok(mm.pins.has(id));
  assert.ok(mm.reactions.has(`${id}:fire`));
  assert.equal(mm.root(id).props.attachments[0].color, "#d93025");

  setNow(38);
  const r2 = await bridge.notify(notification(crashGroup, [crash("a", { status: "resolved", endsAt: iso(37) })]));
  assert.equal(r2.postId, id, "the resolve edits the firing post, it does not post a new one");
  assert.equal(mm.roots().length, 1);
  const post = mm.root(id);
  assert.match(post.message, /^✅ \*\*RESOLVED\*\* · \*\*KubePodCrashLooping\*\*/);
  assert.equal(post.props.attachments[0].color, "#188038");
  assert.equal(post.props.attachments[0].title, "✅ RESOLVED — KubePodCrashLooping");
  assert.match(post.props.attachments[0].fields.find((f) => f.title === "Resolved").value, /^10:37 WIB · after 37m$/);
  assert.equal(post.props.from_bot, "true", "server props survive the patch");
  assert.ok(!mm.pins.has(id));
  assert.ok(!mm.reactions.has(`${id}:fire`) && mm.reactions.has(`${id}:white_check_mark`));
  assert.deepEqual(mm.thread(id), ["✅ **All resolved** at 10:37 WIB · after 37m"]);
});

test("a group's changes land in its thread; the root always shows the whole group", async () => {
  const { mm, bridge, setNow } = setup();
  const { postId } = await bridge.notify(notification(crashGroup, [crash("a"), crash("b")]));
  setNow(5);
  await bridge.notify(notification(crashGroup, [crash("a", { status: "resolved", endsAt: iso(4) }), crash("b")]));
  setNow(10);
  await bridge.notify(notification(crashGroup, [crash("b"), crash("c", { startsAt: iso(9) })]));
  assert.deepEqual(mm.thread(postId), ["✅ **1 resolved** — `pod=a` · 1 still firing", "🔥 **1 more firing** — `pod=c` · 2 firing now"]);
  const root = mm.root(postId);
  assert.match(root.message, /2 of 3 firing$/);
  assert.match(root.props.attachments[0].text, /🔥 `pod=b` · since 10:00\n🔥 `pod=c` · since 10:09\n✅ `pod=a` · resolved 10:04 after 4m/);
});

test("Alertmanager's repeats: a reminder in the thread at most every REMIND_MINUTES", async () => {
  const { mm, bridge, setNow } = setup({ REMIND_MINUTES: "60" });
  const { postId } = await bridge.notify(notification(crashGroup, [crash("a")]));
  for (const m of [30, 61, 90, 125]) {
    setNow(m);
    await bridge.notify(notification(crashGroup, [crash("a")]));
  }
  assert.deepEqual(mm.thread(postId), ["⏰ **Still firing** · 1h 1m · 1 alert · **not acknowledged**", "⏰ **Still firing** · 2h 5m · 1 alert · **not acknowledged**"]);
  const off = setup({ REMIND_MINUTES: "off" });
  const r = await off.bridge.notify(notification(crashGroup, [crash("a")]));
  off.setNow(600);
  await off.bridge.notify(notification(crashGroup, [crash("a")]));
  assert.deepEqual(off.mm.thread(r.postId), []);
});

test("firing again after a resolve is a NEW post at the bottom, linked both ways", async () => {
  const { mm, bridge, setNow } = setup();
  const first = await bridge.notify(notification(crashGroup, [crash("a")]));
  setNow(10);
  await bridge.notify(notification(crashGroup, [crash("a", { status: "resolved", endsAt: iso(10) })]));
  setNow(22);
  const again = await bridge.notify(notification(crashGroup, [crash("a", { startsAt: iso(21) })]));
  assert.equal(again.action, "created");
  assert.notEqual(again.postId, first.postId);
  assert.match(mm.root(again.postId).props.attachments[0].text, /^🔁 Fired again — the last one resolved 12m before this \(\[previous\]\(https:\/\/mm\.test\/ops\/pl\/p1\)\)\./);
  assert.equal(mm.thread(first.postId).at(-1), `🔁 **Fired again** → [new post](https://mm.test/ops/pl/${again.postId})`);
  assert.equal(mm.root(first.postId).props.attachments[0].color, "#188038", "the old post stays resolved");
});

test("a resolve nobody saw fire is posted on its own, green, marked as such", async () => {
  const { mm, bridge } = setup();
  const r = await bridge.notify(notification(memGroup, [alert(memLabels, { status: "resolved", startsAt: iso(-30), endsAt: iso(-1) })]));
  assert.equal(r.action, "created");
  const p = mm.root(r.postId);
  assert.equal(p.props.attachments[0].color, "#188038");
  assert.match(p.props.attachments[0].text, /firing post for this group was not found/);
  assert.ok(!mm.pins.has(r.postId));
  // and a second copy of the same resolve changes nothing
  assert.equal((await bridge.notify(notification(memGroup, [alert(memLabels, { status: "resolved", startsAt: iso(-30), endsAt: iso(-1) })]))).action, "unchanged");
});

test("a restart loses nothing: the next bridge finds the group in the post's own props", async () => {
  const { mm, cfg } = setup();
  const one = createBridge({ mm, cfg, log: quiet, now: () => at(0) });
  const { postId } = await one.notify(notification(crashGroup, [crash("a"), crash("b")]));
  await one.notify(notification(memGroup, [alert(memLabels, { startsAt: iso(0) })]));
  assert.ok(mm.root(postId).props[STATE_PROP].alerts, "the state rides in the post");

  const two = createBridge({ mm, cfg, log: quiet, now: () => at(20) }); // a new process
  const r = await two.notify(notification(crashGroup, [crash("a", { status: "resolved", endsAt: iso(19) }), crash("b", { status: "resolved", endsAt: iso(19) })]));
  assert.equal(r.postId, postId);
  assert.equal(mm.roots().length, 2);
  assert.equal(mm.root(postId).props.attachments[0].color, "#188038");
  assert.equal((await two.firing()).length, 1, "the memory alert is still known as firing");
});

test("notifications for one group are posted in order even when they arrive together", async () => {
  const { mm, bridge, setNow } = setup();
  setNow(1);
  await Promise.all([
    bridge.notify(notification(crashGroup, [crash("a")])),
    bridge.notify(notification(crashGroup, [crash("a"), crash("b")])),
    bridge.notify(notification(crashGroup, [crash("a", { status: "resolved", endsAt: iso(1) }), crash("b", { status: "resolved", endsAt: iso(1) })])),
  ]);
  assert.equal(mm.roots().length, 1, "one post, not three");
  const [root] = mm.roots();
  assert.match(root.message, /RESOLVED/);
  assert.deepEqual(mm.thread(root.id), ["🔥 **1 more firing** — `pod=b` · 2 firing now", "✅ **All resolved** at 10:01 WIB · after 1m"]);
});

test("a failed edit throws (Alertmanager retries) and the retry does not double the replies", async () => {
  const { mm, bridge, setNow } = setup();
  const { postId } = await bridge.notify(notification(crashGroup, [crash("a")]));
  setNow(5);
  mm.fail.add("update");
  const resolved = notification(crashGroup, [crash("a", { status: "resolved", endsAt: iso(5) })]);
  await assert.rejects(bridge.notify(resolved), /update failed/);
  assert.deepEqual(mm.thread(postId), []);
  await bridge.notify(resolved);
  assert.deepEqual(mm.thread(postId), ["✅ **All resolved** at 10:05 WIB · after 5m"]);
});

test("Acknowledge: the button, the click, the post turns purple with who, the button goes", async () => {
  const { mm, bridge, setNow } = setup({ BRIDGE_URL: "http://bridge.test:8080/", BRIDGE_TOKEN: "s3cret" });
  const { postId } = await bridge.notify(notification(crashGroup, [crash("a")]));
  const [button] = mm.root(postId).props.attachments[0].actions;
  assert.deepEqual(button.integration, { url: "http://bridge.test:8080/action", context: { action: "ack", secret: "s3cret" } });
  assert.equal(button.type, "button");

  assert.equal((await bridge.action({ post_id: postId, user_name: "rina", context: { action: "ack", secret: "wrong" } })).status, 403);
  setNow(3);
  const r = await bridge.action({ post_id: postId, user_name: "rina", context: button.integration.context });
  assert.match(r.body.ephemeral_text, /^Acknowledged/);
  const att = mm.root(postId).props.attachments[0];
  assert.equal(att.color, "#9334e6");
  assert.equal(att.title, "👀 FIRING · ACKNOWLEDGED — KubePodCrashLooping");
  assert.equal(att.fields.find((f) => f.title === "Acknowledged").value, "@rina · 10:03");
  assert.equal(att.actions, undefined);
  assert.deepEqual(mm.thread(postId), ["👀 Acknowledged by @rina"]);
  assert.match((await bridge.action({ post_id: postId, user_name: "budi", context: button.integration.context })).body.ephemeral_text, /Already acknowledged by @rina/);
  // the ack survives the group's next notification, and the reminder says who has it
  setNow(70);
  await bridge.notify(notification(crashGroup, [crash("a")]));
  assert.match(mm.thread(postId).at(-1), /acknowledged by @rina$/);
});

test("a click that reaches a restarted bridge before any notification still finds its post", async () => {
  const { mm, cfg } = setup({ BRIDGE_URL: "http://bridge.test:8080" });
  const one = createBridge({ mm, cfg, log: quiet, now: () => at(0) });
  const { postId } = await one.notify(notification(crashGroup, [crash("a")]));
  const logged = [];
  const two = createBridge({ mm, cfg, log: { ...quiet, info: (m) => logged.push(m) }, now: () => at(5) }); // restarted, nothing read yet
  const r = await two.action({ post_id: postId, user_name: "rina", context: { action: "ack" } });
  assert.match(r.body.ephemeral_text, /^Acknowledged/);
  assert.equal(mm.root(postId).props.attachments[0].fields.find((f) => f.title === "Acknowledged").value, "@rina · 10:05");
  assert.ok(logged.some((m) => /click ack by rina on post p1 → 200 Acknowledged/.test(m)), "every click is logged with its outcome");
});

test("the still-firing summary re-posts at the bottom and deletes the last one", async () => {
  const { mm, bridge, setNow } = setup();
  await bridge.notify(notification(crashGroup, [crash("a"), crash("b")]));
  setNow(1);
  await bridge.notify(notification(memGroup, [alert(memLabels, { startsAt: iso(1) })]));
  setNow(60);
  await bridge.summarize();
  const first = mm.roots().find((p) => p.props[SUMMARY_PROP]);
  assert.match(first.message, /^📌 \*\*Still firing \(2\)\*\* — oldest first\n• 🔴 \[KubePodCrashLooping · sample-apps\]\(https:\/\/mm\.test\/ops\/pl\/p1\) — 2 firing · 1h · \*\*not acknowledged\*\*\n• 🟠 \[NodeMemoryHighUtilization\]/);
  await bridge.summarize();
  assert.equal(mm.roots().filter((p) => p.props[SUMMARY_PROP]).length, 1);
  assert.ok(first.delete_at > 0);
});

test("HTTP: webhook auth, a bad payload is 400, a Mattermost failure is 500 (retried)", async () => {
  const { mm, bridge, cfg } = setup({ BRIDGE_TOKEN: "s3cret" });
  const server = createServer(handler(bridge, cfg, quiet)).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (body, token = "s3cret", path = "/alertmanager") =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await send(notification(crashGroup, [crash("a")]), "")).status, 401);
    assert.equal((await send({ hello: 1 })).status, 400);
    const ok = await send(notification(crashGroup, [crash("a")]));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).action, "created");
    mm.fail.add("post");
    assert.equal((await send(notification(memGroup, [alert(memLabels, { startsAt: iso(0) })]))).status, 500);
    const status = await (await fetch(`${base}/status`)).json();
    assert.deepEqual(status.map((s) => [s.alertname, s.firing]), [["KubePodCrashLooping", 1]]);
  } finally {
    server.close();
  }
});

test("?channel= routes a receiver to its own channel", async () => {
  const { mm, bridge } = setup();
  await bridge.notify(notification(crashGroup, [crash("a")]), "alerts-critical");
  assert.deepEqual(mm.calls.filter((c) => c[0] === "channel").map((c) => c[2]), ["alerts-critical"]);
});

test("renderEvent covers every event the bridge posts", () => {
  const { state } = applyNotification(null, notification(crashGroup, [crash("a")]), at(0));
  for (const type of ["firing", "resolved", "all-resolved", "repeat", "ack"]) {
    const s = type === "all-resolved" ? { ...state, resolvedAt: iso(5) } : state;
    assert.ok(renderEvent({ type, fps: Object.keys(state.alerts), by: "x" }, s, { now: at(5) }), type);
  }
  assert.equal(renderEvent({ type: "opened" }, state), null);
});
