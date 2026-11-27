# bridge — Alertmanager → Mattermost

Standard alerting without the agent: an Alertmanager webhook receiver that posts each alert GROUP to
Mattermost once and then edits that one post as the group changes — red/orange while firing, green when
resolved — so a resolve never arrives as a separate message far below the alert it belongs to.

What keeps an alert from sinking or being missed:

| | |
|---|---|
| **One post per group, edited in place** | FIRING → RESOLVED on the same post (colour, title, the table of alerts). No second "resolved" post to match up by eye. |
| **Pinned while firing** | The channel's *Pinned messages* list is exactly what is still firing; a resolve unpins it. |
| **🔥 / ✅ reaction** | Visible in the channel view without opening anything. |
| **The thread is the timeline** | "1 more firing", "1 resolved · 2 still firing", "⏰ Still firing · 4h · not acknowledged", "✅ All resolved after 38m". |
| **Firing again = a new post at the bottom** | Never an old post turned red again higher up. The new one links the previous one, the previous one's thread links the new one. |
| **👀 Acknowledge by reaction** | The bot puts a 👀 reaction under every firing post; one click on it acknowledges. The post turns purple and says who has it; reminders and the summary say "not acknowledged" until someone does. No inbound connection: the bridge reads the reactions back over REST. |
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
node send-test-alerts.mjs --step     # Enter between steps — click 👀 on a firing post before it resolves
```

Start the bridge with `REMIND_MINUTES=0` to see the "still firing" reminder at step 5.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `MM_URL`, `MM_TOKEN`, `MM_TEAM`, `MM_CHANNEL` | — | Required. `MM_CHANNEL` is the default; `?channel=<name>` on the webhook URL routes a receiver elsewhere. |
| `PORT` | `8080` | |
| `BRIDGE_TOKEN` | — | Required bearer token on `/alertmanager`, and the secret inside the Acknowledge button. Unset = no auth (PoC only). |
| `ACK_REACTION` | `eyes` | The emoji that acknowledges (👀). `off` = no acknowledge by reaction. |
| `ACK_POLL_SECONDS` | `30` | How often the reactions of the unacknowledged firing posts are read — one bulk request (`POST /posts/ids/reactions`) per round, none while nothing is open. |
| `BRIDGE_URL` | — | Optional, and the ONE inbound path: the bridge's URL **as the Mattermost server reaches it** (e.g. `http://10.0.0.5:8080`). Set = an Acknowledge button as well. |
| `CARD_STYLE` | `table` | `table`: one status line, a meta line (namespace · cluster · started · acknowledged · resolved) and a table with a row per alert. `detailed`: the first layout, with fields and a line per alert. |
| `CARD_LINKS` | `grafana,jira` | The shortcuts under the card, in this order. Also available: `silence`, `source`, `runbook`. A link that cannot be built is left out. |
| `GRAFANA_URL` | — | Grafana's base URL. Needed for 📊 Grafana unless a rule's `dashboard_url` annotation is a full URL. |
| `GRAFANA_DATASOURCE_UID` | — | The Prometheus data source's uid in Grafana. Set = 📊 Grafana opens Explore on the alert's own expression, from 30 min before it started. |
| `GRAFANA_ORG_ID` | `1` | |
| `JIRA_URL` | — | Jira's base URL (Server, Data Center or Cloud). Set = a Jira shortcut. |
| `JIRA_PROJECT_ID`, `JIRA_ISSUE_TYPE_ID` | — | Numeric ids. Both set = 📝 Jira opens the create form prefilled (summary, description, alerts, a link back to the Mattermost post); unset = 🔎 Jira searches for tickets that mention the alert. |
| `ALERTMANAGER_URL` | payload `externalURL` | User-facing Alertmanager URL, for the `silence` link. |
| `PROMETHEUS_URL` | — | Rewrites the origin of `generatorURL`, for the `source` link (usually Prometheus' in-cluster hostname). |
| `DISPLAY_TZ` | `Asia/Jakarta` | Times shown as `10:02 WIB`. |
| `MM_PIN_FIRING` | `true` | Pin while firing, unpin on resolve. |
| `MM_REACTIONS` | `true` | 🔥 while firing, ✅ when resolved (the 👀 chip is `ACK_REACTION`'s, apart from this). |
| `MM_MENTION` | — | E.g. `@channel` or `@oncall`, added to a NEW post whose severity is in `MM_MENTION_SEVERITIES` (default `critical`). Edits never notify, so it is only on the first post. |
| `REMIND_MINUTES` | `60` | Least minutes between "still firing" replies on Alertmanager's repeats; `0` = every repeat, `off` = never. The post's footer is updated on every repeat regardless. |
| `SUMMARY_MINUTES` | `0` (off) | Re-post the still-firing summary this often. |
| `LOOKBACK_PAGES` | `3` | Pages of 200 posts read back on start to find the groups' posts. |

## The Grafana and Jira shortcuts

Both are plain links: the bridge never calls Grafana or Jira, so they need no token and no network path
from the bridge — only from the person clicking.

📊 **Grafana**, first that applies:
1. the rule's own dashboard — annotation `dashboard_url` (or `grafana_url`, `dashboard`); a path such as
   `/d/abc/pods?var-namespace={{ $labels.namespace }}` is joined to `GRAFANA_URL`;
2. with `GRAFANA_DATASOURCE_UID`, Explore on the alert's expression (read from Prometheus' `generatorURL`),
   from 30 minutes before it started to now (to 15 minutes after the resolve, once resolved);
3. Grafana's alert list, searched for the alert name.

📝 **Jira** opens `…/secure/CreateIssueDetails!init.jspa` with the project, issue type, a summary such as
`[critical] KubePodCrashLooping in sample-apps (dev)` and a description listing the alerts and a link back
to the Mattermost post (the bridge edits the post once right after creating it, to put that link in).
The ids:

```sh
curl -s -u "$JIRA_USER:$JIRA_TOKEN" "$JIRA_URL/rest/api/2/project/OPS" | jq -r .id   # project key OPS → JIRA_PROJECT_ID
curl -s -u "$JIRA_USER:$JIRA_TOKEN" "$JIRA_URL/rest/api/2/issuetype" | jq -r '.[] | "\(.id)  \(.name)"'   # → JIRA_ISSUE_TYPE_ID
```

(On Jira Server / Data Center, a personal access token goes in `-H "Authorization: Bearer …"` instead of `-u`.)

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

### Acknowledge

By default acknowledging needs nothing from the network but what posting needs: the bot reacts 👀 under
every firing post, the first person to click that chip acknowledges (at the time they clicked), the bot's
own chip goes and theirs stays. The post is updated within `ACK_POLL_SECONDS`.

### The optional Acknowledge button does nothing when clicked

The click is sent by the Mattermost **server**, not by your browser: it POSTs to `BRIDGE_URL/action`. The
bridge logs every click it receives — `[bridge] click ack by <user> on post <id> → <status> <answer>`:

- **No such line** — the click never reached the bridge. The Mattermost server cannot reach `BRIDGE_URL`
  (firewall, NAT, a laptop on another network: this is the bridge's one inbound path), or it refuses a
  private address until the host is listed in *System Console → Environment → Developer → Allow untrusted
  internal connections to*. The Mattermost server's log names which.
- **`→ 403`** — the post carries a different secret: it was made while the bridge ran with another `BRIDGE_TOKEN`.
- **`not tracked`** — the post is older than `LOOKBACK_PAGES` × 200 posts, or in a channel other than `MM_CHANNEL`.

Without `BRIDGE_URL` there is no button and no inbound path from Mattermost at all.

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
