# alertmanager2mattermost-poc

Proofs of concept for moving alerting from Slack to Mattermost, built to settle what Mattermost can and
cannot do **before** anything is implemented for real. Two independent parts; nothing here is production
code, and nothing needs `npm install` (Node 20+; `agent-flow/listen.mjs` needs Node 22+ for `WebSocket`).

| Folder | What it checks |
|---|---|
| [`bridge/`](bridge/README.md) | **Standard alerting, no agent.** An Alertmanager webhook receiver that posts each alert group once and edits that post FIRING → RESOLVED, pinned while firing, with the thread as its timeline — so alerts do not sink or get missed when many fire. REST only, outbound to Mattermost. |
| [`agent-flow/`](agent-flow/README.md) | **The DevOps AI agent's Slack flow on Mattermost.** Threads, in-place edits, reactions, ephemeral posts, interactive buttons, the WebSocket; then the agent's real Slack messages (RCA card, approval card, resolve with feedback buttons…) translated Block Kit → Mattermost and posted as one incident thread. |
| `lib/` | The Mattermost REST v4 client both use. |

## Quick start

```sh
export MM_URL=https://mattermost.example.internal   # no trailing slash
export MM_TOKEN=...                                 # a bot token — only ever from the environment, never committed
export MM_TEAM=my-team MM_CHANNEL=alerts            # team and channel NAMES (from the URL)

npm test                                 # every test in both folders, no Mattermost needed

# bridge: Alertmanager → Mattermost
REMIND_MINUTES=0 npm start               # terminal 1 (node bridge/bridge.mjs; --dry-run needs no Mattermost)
npm run test-alerts -- --step            # terminal 2: plays Alertmanager, Enter between steps

# agent flow: the agent's incident thread
npm run demo -- --dry-run                # prints every request
npm run demo -- --extras                 # posts it
```

Each folder's README has its settings, the Mattermost settings that matter, and a checklist of what
to note down while trying it.
