# agent-flow — the DevOps AI agent's Slack flow, on Mattermost

Manual checks, before any adapter is written, that Mattermost does what a Slack bot thread flow needs:
post a root message, reply in its thread, change the ROOT message's status in place (attachment colour
+ fields), react, send an ephemeral message, read the thread, a button that replaces its own card, and
hear mentions. Nothing here changes devops-ai-agent: `fixtures/gen.ts` only imports its Slack builders.

Everything uses the Mattermost REST API v4 with `Authorization: Bearer <token>` (a bot account's token,
or a personal access token). Node 26 has `fetch` and `WebSocket` built in, so the scripts need no `npm install`.

Run every command below from this folder (`cd agent-flow`). Standard alerting without the agent is
`../bridge/`.

## 0. Setup

```sh
export MM_URL=https://mattermost.example.internal     # no trailing slash
export MM_TOKEN=...                                   # bot token / personal access token — never commit it
export MM_TEAM=my-team                                # team NAME (from the URL: /<team>/channels/<channel>)
export MM_CHANNEL=poc-alerts                          # channel NAME
```

A bot account: *System Console → Integrations → Bot Accounts → Add Bot Account*, then add the bot to the
team and the channel. A personal access token needs *Enable Personal Access Tokens* in the System Console.

## 1. Manual hits with curl

```sh
H=(-H "Authorization: Bearer $MM_TOKEN" -H "Content-Type: application/json")

# who am I (the bot's user id — needed for reactions and ephemeral posts)
curl -s "${H[@]}" "$MM_URL/api/v4/users/me" | jq '{id, username}'

# the channel id from its team and name
CH=$(curl -s "${H[@]}" "$MM_URL/api/v4/teams/name/$MM_TEAM/channels/name/$MM_CHANNEL" | jq -r .id); echo "$CH"

# a ROOT post with a red attachment ("firing")
ROOT=$(curl -s "${H[@]}" -X POST "$MM_URL/api/v4/posts" -d "{
  \"channel_id\": \"$CH\",
  \"message\": \"PoC alert\",
  \"props\": {\"attachments\": [{\"fallback\": \"Firing\", \"color\": \"#d93025\", \"title\": \"🔥 Firing — PoCAlert\",
    \"fields\": [{\"title\": \"Status\", \"value\": \"Firing\", \"short\": true}, {\"title\": \"Since\", \"value\": \"$(date -u +%H:%M) UTC\", \"short\": true}]}]}
}" | jq -r .id); echo "$ROOT"

# a reply IN ITS THREAD: root_id must be the ROOT post's id, never a reply's
curl -s "${H[@]}" -X POST "$MM_URL/api/v4/posts" -d "{\"channel_id\": \"$CH\", \"root_id\": \"$ROOT\", \"message\": \"Investigating… (reply in thread)\"}" | jq '{id, root_id}'

# change the ROOT post's status in place: green + Resolved
curl -s "${H[@]}" -X PUT "$MM_URL/api/v4/posts/$ROOT/patch" -d '{
  "props": {"attachments": [{"fallback": "Resolved", "color": "#188038", "title": "✅ Resolved — PoCAlert",
    "fields": [{"title": "Status", "value": "Resolved", "short": true}]}]}
}' | jq '{id, edit_at}'

# a reaction on the root post
ME=$(curl -s "${H[@]}" "$MM_URL/api/v4/users/me" | jq -r .id)
curl -s "${H[@]}" -X POST "$MM_URL/api/v4/reactions" -d "{\"user_id\": \"$ME\", \"post_id\": \"$ROOT\", \"emoji_name\": \"white_check_mark\"}" | jq .

# the whole thread, in order
curl -s "${H[@]}" "$MM_URL/api/v4/posts/$ROOT/thread" | jq -r '.order[] as $id | .posts[$id] | "\(.id) root=\(.root_id) \(.message)"'

# an ephemeral message to ONE user (needs the create_post_ephemeral permission — a system admin's
# token has it; a bot may not, which is exactly what this PoC should find out)
TARGET_USER=$ME   # or another user's id
curl -s "${H[@]}" -X POST "$MM_URL/api/v4/posts/ephemeral" -d "{\"user_id\": \"$TARGET_USER\", \"post\": {\"channel_id\": \"$CH\", \"root_id\": \"$ROOT\", \"message\": \"Only you can see this\"}}" | jq '{id}'
```

## 2. The same flow as one script

```sh
node poc.mjs --dry-run     # prints every request, sends nothing
node poc.mjs               # runs it against $MM_URL, pausing between steps so you can watch the channel
```

## 3. A button that changes the card it sits on (needs a callback URL)

Mattermost POSTs a click to the action's `integration.url` **from the Mattermost server**, so that URL must be
reachable from the server — your laptop on the office network works for the PoC.

```sh
export MM_CALLBACK_URL=http://<your-laptop-ip>:8787/action
node callback.mjs                      # terminal 1: answers clicks, replaces the card ("👀 Acknowledged by @you")
node poc.mjs --button                  # terminal 2: posts a card with Acknowledge / Resolve buttons
```

If the click fails with an "untrusted internal connection" error, the admin must add your host to
*System Console → Environment → Developer → Allow untrusted internal connections to* (`ServiceSettings.AllowedUntrustedInternalConnections`).
Action `id`s are letters and digits only.

## 4. Hearing mentions and reactions (WebSocket)

```sh
node listen.mjs     # prints posts that mention the token's user, reactions, and edits, as they happen
```

## 5. The agent's templates, as they look in Slack today

`demo.mjs` posts one whole incident thread, message for message as the agent posts it to Slack: the
alert, the progress notice edited in place each round, the RCA card, the approval card, the status after
the click, the verification, and the resolve message with its *RCA was right* / *It was something else*
buttons.

```sh
node demo.mjs --dry-run                 # every request, nothing sent
node demo.mjs                           # clicks simulated (no MM_CALLBACK_URL): the card goes executing → done
node demo.mjs --gitops                  # the GitOps PR card (a diff) instead of the restart card
node demo.mjs --extras                  # plus recurrence, related alert, still firing, fired again, LLM out of credit

# real buttons: terminal 1
MM_APPROVERS=you node callback.mjs      # MM_APPROVERS optional (the agent's SLACK_APPROVER_USERS)
# terminal 2
MM_CALLBACK_URL=http://<your-laptop-ip>:8787/action node demo.mjs
```

`MM_APPROVER=<username>` names who the card asks (default: the token's own user). With `MM_URL` and
`MM_TOKEN` also set for `callback.mjs`, an Approve edits the card twice like Slack does — "⏳ Executing…"
in the click's answer, then the result by REST 3 s later.

**Where the texts come from.** `fixtures/slack.json` is written by `fixtures/gen.ts`, which calls the
agent's OWN Slack builders (`buildGroupAlertText`, `buildRcaBlocks`, `formatRunFooter`,
`buildRemediationCard`, `resolvedBlocks`/`answeredBlocks`, `renderForSlack`, `verdictMessage`,
`repeatLine`, `userFacingError`) on one synthetic incident. `slack-to-mm.mjs` translates Slack messages
to Mattermost posts, so there is no second copy of any template. After a Slack template changes:

```sh
# needs a devops-ai-agent checkout beside this repo; everyone else uses the committed slack.json
cd ../../devops-ai-agent && npx tsx ../alertmanager2mattermost-poc/agent-flow/fixtures/gen.ts
cd ../alertmanager2mattermost-poc && node --test   # the translator's tests read the same fixtures
```

| Slack | Mattermost |
|---|---|
| `*bold*`, `~strike~` | `**bold**`, `~~strike~~` (Mattermost reads `*x*` as italic) |
| `<url\|text>`, `<@U123>`, `<!here>` | `[text](url)`, `@username` (via a map), `@here` |
| `header` block | `### text` |
| `divider` | `---`, with a blank line above it (otherwise the line above turns into a heading) |
| `table` (Evidence, Recommended Actions) | Markdown table; `\|` in a cell escaped |
| `context` (run footer, card expiry) | `_italic_` line in place; under buttons, the attachment's `footer` |
| `actions` (buttons) | attachment `actions`, `context: {action: <Slack action_id>, value}`; id letters/digits only |
| `chat.update` | `PUT /posts/{id}/patch` (Mattermost shows "Edited" on the post) |
| custom emoji `:alert:` `:pepe-hacker:` `:pepe-perfect:` `:denied:` | `:rotating_light:` `:mag:` `:white_check_mark:` `:no_entry_sign:` (`DEFAULT_EMOJI`) |

Text always stays in the post's `message`, never in the attachment: an @mention notifies only from the
message, and the card's "Approval needed from" is a mention.

## What to note down

- [ ] Reply with `root_id` shows in the thread (and in the channel when Collapsed Reply Threads is off).
- [ ] `PATCH` on the root changes colour/fields in place, and how the edit is shown (an "(edited)" marker?).
- [ ] Reactions by the bot.
- [ ] Ephemeral posts from the bot token (permission?).
- [ ] The button: does the `update` in the callback's answer replace the card for everyone?
- [ ] WebSocket: `posted` with `mentions`, `reaction_added`, `post_edited`.
- [ ] Markdown: `**bold**`, `_italic_`, tables, code blocks — and how a Slack-style `*bold*` renders (italic).
- [ ] `demo.mjs`: the RCA card's tables, `---` rules and code fences render; the post is not cut ("Show more" is fine).
- [ ] The progress notice edits in place; how visible the "Edited" marker is.
- [ ] The approval card: buttons under the text, the expiry line as the footer, `@approver` notified.
- [ ] Approve → "⏳ Executing…" → "✅ executed" (needs MM_URL/MM_TOKEN on callback.mjs); Reject → one line, buttons gone.
- [ ] *RCA was right* → the resolve message gains "✅ @you confirmed…" and loses its buttons.
