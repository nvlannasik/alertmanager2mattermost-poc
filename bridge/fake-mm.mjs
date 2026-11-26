// An in-memory Mattermost with mm-client.mjs's surface, for the tests. Props are deep-copied on the way
// in and out, like JSON over the wire, so a test cannot pass by sharing an object with the bridge.
const copy = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

export function fakeMattermost({ botId = "bot1", channelId = "ch1" } = {}) {
  let seq = 0;
  let clock = 1_000;
  const posts = new Map();
  const pins = new Set();
  const reactions = new Set(); // `${postId}:${emoji}`
  const calls = [];
  const fail = new Set(); // method names that throw once
  const call = (name, ...args) => {
    calls.push([name, ...args]);
    if (fail.has(name)) {
      fail.delete(name);
      throw new Error(`${name} failed (injected)`);
    }
  };
  const list = (ids) => ({ order: ids, posts: Object.fromEntries(ids.map((id) => [id, copy(posts.get(id))])) });
  return {
    url: "https://mm.test",
    posts,
    pins,
    reactions,
    calls,
    fail,
    async me() {
      call("me");
      return { id: botId, username: "alert-bot" };
    },
    async channel(team, name) {
      call("channel", team, name);
      return { id: channelId, name };
    },
    async post(channel_id, post, rootId) {
      call("post", channel_id, post, rootId);
      const id = `p${++seq}`;
      const p = { id, channel_id, user_id: botId, root_id: rootId ?? "", create_at: ++clock, delete_at: 0, message: post.message, props: { from_bot: "true", ...copy(post.props ?? {}) } };
      posts.set(id, p);
      return copy(p);
    },
    async update(id, patch) {
      call("update", id, patch);
      const p = posts.get(id);
      if (!p) throw new Error(`no post ${id}`);
      if (patch.message !== undefined) p.message = patch.message;
      if (patch.props !== undefined) p.props = copy(patch.props); // a patch replaces props whole
      p.edit_at = ++clock;
      return copy(p);
    },
    async remove(id) {
      call("remove", id);
      posts.get(id).delete_at = ++clock;
      return { status: "OK" };
    },
    async user(id) {
      call("user", id);
      return { id, username: `user-${id}` };
    },
    async pin(id) {
      call("pin", id);
      pins.add(id);
    },
    async unpin(id) {
      call("unpin", id);
      pins.delete(id);
    },
    async react(userId, postId, emoji) {
      call("react", userId, postId, emoji);
      reactions.add(`${postId}:${emoji}`);
    },
    async unreact(userId, postId, emoji) {
      call("unreact", userId, postId, emoji);
      reactions.delete(`${postId}:${emoji}`);
    },
    async channelPosts(channelId, page = 0, perPage = 200) {
      call("channelPosts", channelId, page);
      const ids = [...posts.values()].filter((p) => p.channel_id === channelId).sort((a, b) => b.create_at - a.create_at).map((p) => p.id);
      return list(ids.slice(page * perPage, (page + 1) * perPage));
    },
    async pinned(channelId) {
      call("pinned", channelId);
      return list([...pins].filter((id) => posts.get(id)?.channel_id === channelId));
    },
    /** Test helpers */
    root: (id) => posts.get(id),
    thread: (id) => [...posts.values()].filter((p) => p.root_id === id).map((p) => p.message),
    roots: () => [...posts.values()].filter((p) => !p.root_id && !p.delete_at),
  };
}
