// A minimal Mattermost REST v4 client, shared by bridge/ and agent-flow/. No dependencies.
//   MM_URL, MM_TOKEN — the token only ever comes from the environment.

export function mattermost({ dry = false } = {}) {
  const url = (process.env.MM_URL ?? (dry ? "<MM_URL>" : "")).replace(/\/+$/, "");
  const token = process.env.MM_TOKEN ?? (dry ? "<MM_TOKEN>" : "");
  let fakeId = 0;

  async function api(method, path, body) {
    if (dry) {
      console.log(`\n${method} ${url}/api/v4${path}`);
      if (body) console.log(JSON.stringify(body, null, 2));
      // 26-char ids like Mattermost's, so the steps after print sensibly
      return { id: `dryrun${String(++fakeId).padStart(20, "0")}`, username: "agent-bot" };
    }
    if (!url || !token) throw new Error("missing MM_URL / MM_TOKEN — see README.md §0");
    const res = await fetch(`${url}/api/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${json.message ?? text.slice(0, 200)}`);
    return json;
  }

  return {
    configured: Boolean(url && token) && !url.startsWith("<"),
    api,
    me: () => api("GET", "/users/me"),
    channel: (team, name) => api("GET", `/teams/name/${encodeURIComponent(team)}/channels/name/${encodeURIComponent(name)}`),
    /** Slack chat.postMessage; `rootId` is Slack's thread_ts. */
    post: (channelId, post, rootId) => api("POST", "/posts", { channel_id: channelId, ...(rootId ? { root_id: rootId } : {}), ...post }),
    /** Slack chat.update: message and props replaced in place. */
    update: (postId, post) => api("PUT", `/posts/${postId}/patch`, post),
    remove: (postId) => api("DELETE", `/posts/${postId}`),
    user: (id) => api("GET", `/users/${id}`),
    pin: (postId) => api("POST", `/posts/${postId}/pin`),
    unpin: (postId) => api("POST", `/posts/${postId}/unpin`),
    react: (userId, postId, emoji) => api("POST", "/reactions", { user_id: userId, post_id: postId, emoji_name: emoji }),
    unreact: (userId, postId, emoji) => api("DELETE", `/users/${userId}/posts/${postId}/reactions/${encodeURIComponent(emoji)}`),
    /** Newest first; `{order, posts}`. */
    channelPosts: (channelId, page = 0, perPage = 200) => api("GET", `/channels/${channelId}/posts?page=${page}&per_page=${perPage}`),
    pinned: (channelId) => api("GET", `/channels/${channelId}/pinned`),
    url,
  };
}
