// Slack message → Mattermost post. The agent's Slack builders stay the one source of every template;
// this translates what they produce, so a Mattermost adapter would not need a second copy of them.
//
//   mrkdwnToMarkdown(text, opts)      Slack mrkdwn → Mattermost Markdown
//   toPost({ text, blocks }, opts)    → { message, props? } for POST /api/v4/posts (or a callback `update`)
//
// opts: { users: { SLACKID: "mm-username" }, emoji: { custom: "standard" }, callbackUrl }
//
// Block mapping:
//   header   → "### text"          (Slack's header is plain text, one line)
//   divider  → "---"               (always with blank lines around it, or the line above becomes a heading)
//   section  → its mrkdwn, translated
//   table    → a Markdown table    (cells are rich_text spans: code / bold / italic)
//   context  → "_text_"            (Mattermost has no small print in a message; in an attachment it is the footer)
//   actions  → attachment buttons  (Mattermost has buttons only inside an attachment)
//
// Text stays in the MESSAGE, never in the attachment: an @mention notifies only from the message.

/** Slack's custom emoji the agent uses, and a standard one Mattermost has out of the box. */
export const DEFAULT_EMOJI = {
  alert: "rotating_light",
  "pepe-hacker": "mag",
  "pepe-perfect": "white_check_mark",
  denied: "no_entry_sign",
};

/** Split off code (fences and inline spans): nothing inside them is markup. */
function outsideCode(text, fn) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

export function mrkdwnToMarkdown(text, { users = {}, emoji = DEFAULT_EMOJI } = {}) {
  if (!text) return "";
  return outsideCode(text, (s) =>
    s
      // links and mentions: <url|label>, <url>, <@U123>, <!here>, <#C123|name>, <!date^…|fallback>
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "[$2]($1)")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/<mailto:([^|>]+)\|([^>]+)>/g, "[$2](mailto:$1)")
      .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${users[id] ?? id}`)
      .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
      .replace(/<!subteam\^[A-Z0-9]+\|(@?[^>]+)>/g, (_, n) => (n.startsWith("@") ? n : `@${n}`))
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "~$1")
      .replace(/<!date\^[^|>]*\|([^>]+)>/g, "$1")
      // *bold* → **bold**; ~strike~ → ~~strike~~ (Mattermost reads *x* as italic, ~x~ as nothing)
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/gm, "$1**$2**")
      .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?![\w~])/gm, "$1~~$2~~")
      // custom emoji Mattermost does not have
      .replace(/:([a-z0-9_+-]+):/g, (m, name) => (emoji[name] ? `:${emoji[name]}:` : m))
      // Slack's three escapes; Mattermost renders the characters themselves
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  );
}

/** A rich_text table cell → Markdown inline text. */
function cellToMarkdown(cell) {
  if (cell.type === "raw_text") return cell.text;
  const spans = (cell.elements ?? []).flatMap((e) => e.elements ?? []);
  return spans
    .map((sp) => {
      const t = sp.text ?? "";
      if (sp.style?.code) return `\`${t}\``;
      if (sp.style?.bold) return `**${t}**`;
      if (sp.style?.italic) return `_${t}_`;
      return t;
    })
    .join("");
}

const cellText = (c) => cellToMarkdown(c).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim() || "—";

function tableToMarkdown(block) {
  const [head, ...rows] = block.rows ?? [];
  if (!head) return "";
  const line = (r) => `| ${r.map(cellText).join(" | ")} |`;
  return [line(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}

/** Letters and digits only: Mattermost refuses any other character in an action id. */
const actionId = (s) => String(s).replace(/[^A-Za-z0-9]/g, "") || "action";

const BUTTON_STYLE = { primary: "primary", danger: "danger" };

function buttons(block, callbackUrl) {
  return (block.elements ?? [])
    .filter((e) => e.type === "button")
    .map((b) => ({
      id: actionId(b.action_id),
      name: b.text?.text ?? b.action_id,
      style: BUTTON_STYLE[b.style] ?? "default",
      // what callback.mjs gets back on a click: the Slack action_id and value, unchanged
      integration: { url: callbackUrl, context: { action: b.action_id, value: b.value ?? "" } },
    }));
}

/**
 * One Slack message → one Mattermost post. Blocks win over `text`, as in Slack (text is then only the
 * notification fallback). With an actions block and a callback URL, the buttons go in an attachment
 * and the context line becomes its footer.
 */
export function toPost(msg, opts = {}) {
  const md = (t) => mrkdwnToMarkdown(t, opts);
  if (!msg.blocks || msg.blocks.length === 0) return { message: md(msg.text) };

  // In block order: { text } for the message, { context } for small print, buttons apart.
  const items = [];
  const actions = [];
  for (const b of msg.blocks) {
    switch (b.type) {
      case "header":
        items.push({ text: `### ${b.text?.text ?? ""}` });
        break;
      case "divider":
        items.push({ text: "---" });
        break;
      case "section":
        if (b.text?.text) items.push({ text: b.text.type === "plain_text" ? b.text.text : md(b.text.text) });
        if (b.fields?.length) items.push({ text: b.fields.map((f) => md(f.text)).join("\n") });
        break;
      case "table":
        items.push({ text: tableToMarkdown(b) });
        break;
      case "context":
        items.push({ context: (b.elements ?? []).map((e) => (e.type === "mrkdwn" ? md(e.text) : e.text ?? "")).join(" ") });
        break;
      case "actions":
        actions.push(b);
        break;
      default:
        // image / rich_text / anything new: say so rather than drop it silently
        items.push({ text: `_[unsupported Slack block: ${b.type}]_` });
    }
  }

  const buttonList = opts.callbackUrl ? actions.flatMap((a) => buttons(a, opts.callbackUrl)) : [];
  if (buttonList.length > 0) {
    // context lines become the attachment's footer (small grey print under the buttons)
    const footer = items.filter((i) => i.context).map((i) => i.context).join(" · ");
    return {
      message: items.filter((i) => i.text !== undefined).map((i) => i.text).join("\n\n"),
      props: { attachments: [{ fallback: md(msg.text ?? "") || "action", ...(footer ? { footer } : {}), actions: buttonList }] },
    };
  }
  // No buttons: a context line keeps its place (the RCA footer sits between Confidence and Recent
  // changes), as italic — unless it already carries markup, which italics would break.
  const lines = items.map((i) => (i.text !== undefined ? i.text : /[_*`]/.test(i.context) ? i.context : `_${i.context}_`));
  if (actions.length) lines.push("_(buttons need MM_CALLBACK_URL — not shown)_");
  // `attachments: []` so the same post can serve as a callback `update` that removes old buttons
  return { message: lines.join("\n\n"), props: { attachments: [] } };
}

/**
 * Mattermost's post limit is 16383 characters by default (ServiceSettings.MaxPostSize). Cuts on a
 * blank line outside a code fence, like the agent's splitForSlack does for Slack's limit.
 */
export function splitForMattermost(message, max = 16000) {
  if (message.length <= max) return [message];
  const chunks = [];
  let cur = "";
  let inFence = false;
  for (const para of message.split(/\n\n/)) {
    const fences = (para.match(/```/g) ?? []).length;
    const next = cur ? `${cur}\n\n${para}` : para;
    if (next.length > max && cur && !inFence) {
      chunks.push(cur);
      cur = para;
    } else {
      cur = next;
    }
    if (fences % 2 === 1) inFence = !inFence;
  }
  if (cur) chunks.push(cur);
  return chunks;
}
