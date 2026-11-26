# bridge — Alertmanager → Mattermost

Standard alerting without the agent: an Alertmanager webhook receiver that posts each alert GROUP to
Mattermost once and then edits that one post as the group changes — red/orange while firing, green when
resolved — so a resolve never arrives as a separate message far below the alert it belongs to.

What keeps an alert from sinking or being missed:

| | |
|---|---|
| **One post per group, edited in place** | FIRING → RESOLVED on the same post (colour, title, fields, the alert list). No second "resolved" post to match up by eye. |
| **Pinned while firing** | The channel's *Pinned messages* list is exactly what is still firing; a resolve unpins it. |
| **🔥 / ✅ reaction** | Visible in the channel view without opening anything. |
| **The thread is the timeline** | "1 more firing", "1 resolved · 2 still firing", "⏰ Still firing · 4h · not acknowledged", "✅ All resolved after 38m". |
| **Firing again = a new post at the bottom** | Never an old post turned red again higher up. The new one links the previous one, the previous one's thread links the new one. |
| **👀 Acknowledge button** (optional) | The post turns purple and says who has it; reminders and the summary say "not acknowledged" until someone does. |
| **Still-firing summary** (optional) | Every `SUMMARY_MINUTES`, one list of what is still firing, oldest first, re-posted at the bottom; the previous one is deleted. |

The group's state is stored in its own post (`props.am_bridge`), so the bridge keeps no database and
loses nothing on restart: on the first notification for a channel it reads the channel's pinned posts
and its last `LOOKBACK_PAGES × 200` posts back.

## Run it

Node 20 or newer; no dependencies (`fetch` and `node:test` are built in), so there is no `npm install`.
Run the commands from this folder (`cd bridge`).

```sh
export MM_URL=https://mattermost.example.internal MM_TOKEN=...   # a bot token; never commit it
export MM_TEAM=my-team MM_CHANNEL=alerts                           # team and channel NAMES

node bridge.mjs --dry-run      # no Mattermost needed: prints every request it would make
node bridge.mjs                # listens on :8080
```

Try it without an Alertmanager (terminal 2):

```sh
node send-test-alerts.mjs            # 8 steps, 4 s apart: two groups fire, partly resolve, repeat, resolve, fire again
node send-test-alerts.mjs --step     # Enter between steps
```

Start the bridge with `REMIND_MINUTES=0` to see the "still firing" reminder at step 5.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `MM_URL`, `MM_TOKEN`, `MM_TEAM`, `MM_CHANNEL` | — | Required. `MM_CHANNEL` is the default; `?channel=<name>` on the webhook URL routes a receiver elsewhere. |
| `PORT` | `8080` | |
| `BRIDGE_TOKEN` | — | Required bearer token on `/alertmanager`, and the secret inside the Acknowledge button. Unset = no auth (PoC only). |
| `BRIDGE_URL` | — | The bridge's URL **as the Mattermost server reaches it** (e.g. `http://10.0.0.5:8080`). Set = the Acknowledge button. |
| `ALERTMANAGER_URL` | payload `externalURL` | User-facing Alertmanager URL for the 🔕 Silence link. |
| `PROMETHEUS_URL` | — | Rewrites the origin of `generatorURL` (📈 Source), which is usually Prometheus' in-cluster hostname. |
| `DISPLAY_TZ` | `Asia/Jakarta` | Times shown as `10:02 WIB`. |
| `MM_PIN_FIRING` | `true` | Pin while firing, unpin on resolve. |
| `MM_REACTIONS` | `true` | 🔥 while firing, ✅ when resolved. |
| `MM_MENTION` | — | E.g. `@channel` or `@oncall`, added to a NEW post whose severity is in `MM_MENTION_SEVERITIES` (default `critical`). Edits never notify, so it is only on the first post. |
| `REMIND_MINUTES` | `60` | Least minutes between "still firing" replies on Alertmanager's repeats; `0` = every repeat, `off` = never. The post's footer is updated on every repeat regardless. |
| `SUMMARY_MINUTES` | `0` (off) | Re-post the still-firing summary this often. |
| `LOOKBACK_PAGES` | `3` | Pages of 200 posts read back on start to find the groups' posts. |

## Alertmanager

```yaml
receivers:
  - name: mattermost
    webhook_configs:
      - url: http://<bridge-host>:8080/alertmanager          # ?channel=alerts-critical to route
        send_resolved: true                                  # REQUIRED — without it nothing turns green
        max_alerts: 0                                        # 0 = all; a truncated list cannot prove a resolve
        http_config:
          authorization:
            credentials: <BRIDGE_TOKEN>
route:
  receiver: mattermost
  group_by: [alertname, namespace, cluster]                  # one post per group: choose this with care
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h                                        # drives the "still firing" reminders
```

How a notification maps to the post: the group is Alertmanager's `groupKey`. Each notification carries
every alert still firing in the group, so an alert that was firing and is missing from a complete
notification is shown as resolved (`truncatedAlerts > 0` turns that inference off). A resolve whose
firing post the bridge never saw is posted on its own, green, saying so.

## Mattermost settings that matter

- **`ServiceSettings.PostEditTimeLimit`** must be `-1` (the default, unlimited). A limit of e.g. 5 min
  means the bridge cannot turn an alert older than that green; the thread reply is still posted, and
  the failed edit is logged and answered 500 so Alertmanager retries.
- **Pinning** needs the bot to be allowed to pin in the channel (default for channel members).
- **The Acknowledge button** is called by the Mattermost SERVER; for a laptop or an internal host the admin
  may need *System Console → Developer → Allow untrusted internal connections to* (`ServiceSettings.AllowedUntrustedInternalConnections`).
- An edited post shows "Edited" in Mattermost — every root post here will.
- With *Collapsed Reply Threads* on, thread replies notify the thread's followers only; the root post's
  colour and the pinned list are what the channel sees.

## Tests

```sh
node --test      # card rendering and merging, and the bridge against an in-memory Mattermost (fake-mm.mjs)
```

## Files

| | |
|---|---|
| `bridge.mjs` | HTTP server, Mattermost calls, per-group ordering, restart recovery, Acknowledge, summary. |
| `card.mjs` | Pure: merge a notification into the group's state; render the post, the replies and the summary. |
| `payloads.mjs` | Alertmanager webhook payloads for the tests and the simulator. |
| `send-test-alerts.mjs` | Plays Alertmanager against a running bridge. |
| `fake-mm.mjs` | In-memory Mattermost for the tests. |
| `../lib/mm-client.mjs` | The Mattermost REST v4 client, shared with `agent-flow/`. |
