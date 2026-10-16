import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Store } from "../src/store";
import { loadConfig } from "../src/config";

let state: any, started: any[], closed: string[], label: string | undefined;
mock.module("../src/herdr", () => ({
  paneState: async () => state,
  spawnAgent: async (opts: any) => { started.push(opts); return { pane: "new-pane", tab: "new-tab", terminal: "new-terminal", session: "test-session" }; },
  resolveWorkspace: async () => "workspace",
  workspaces: async () => [{ workspace_id: "workspace", label: "Telegram" }],
  paneClose: async (pane: string) => { closed.push(pane); },
  tabRename: async () => ({}),
  tabLabel: async () => label,
}));
const { Lifecycle } = await import("../src/lifecycle");
const { Watcher } = await import("../src/session");
let dir: string, path: string, cfg: ReturnType<typeof loadConfig>, store: Store, life: InstanceType<typeof Lifecycle>;
let watchers: Map<number, any>, notices: string[], sends: string[], calls: any[], tg: any;
let oldHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tgb-life-")); oldHome = process.env.CODEX_HOME; process.env.CODEX_HOME = join(dir, "codex");
  mkdirSync(join(process.env.CODEX_HOME, "sessions/2026/10/16"), { recursive: true });
  path = join(process.env.CODEX_HOME, "sessions/2026/10/16/rollout-now-test-session.jsonl"); writeFileSync(path, "");
  cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "fake", TG_CHAT_ID: "-1", TG_ALLOWED_USERS: "1", TG_BRIDGE_WORKDIR: dir, TG_BRIDGE_STATE_DIR: join(dir, "state") });
  store = new Store(cfg.stateDir); watchers = new Map(); notices = []; sends = []; calls = []; started = []; closed = [];
  state = { state: "gone" };
  label = undefined;
  tg = {
    chatId: -1,
    call: async (name: string, body: any) => { calls.push({ name, body }); return { ok: true, result: { message_thread_id: 41 } }; },
    notice: async (_: any, text: string) => { notices.push(text); },
    send: async (_: any, text: string) => { sends.push(text); return 1; },
    sendState: async (_: any, text: string) => { sends.push(text); return { state: "ok", id: 1 }; },
    edit: async () => true, react: async () => {}, topicAlive: async () => true,
  };
  life = new Lifecycle(cfg, tg, store, watchers, "/bridge/tg-send");
});
afterEach(() => {
  for (const w of watchers.values()) w.stop();
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  rmSync(dir, { recursive: true });
});
const live = () => ({ state: "live", terminal: "terminal", agent: { agent_kind: "codex", agent_status: "working", agent_session: { value: "test-session" }, cwd: dir, workspace_id: "workspace", tab_id: "tab", terminal_id: "terminal" } });

describe("mixed provider lifecycle (offline)", () => {
  test("new Codex topic persists provider, restart retains it, missing pane resumes Codex", async () => {
    expect(await life.open(41, { fresh: true, kind: "codex", name: "测试" })).toBe(true);
    expect(started[0].kind).toBe("codex"); expect(started[0].args).toEqual([]);
    const reloaded = new Store(cfg.stateDir); expect(reloaded.state.topics[41].kind).toBe("codex");
    await life.open(41);
    expect(started[1].kind).toBe("codex"); expect(started[1].args).toEqual(["resume", "test-session"]);
  });
  test("old bindings without kind still reopen as Claude even when default changes", async () => {
    cfg.agentKind = "codex";
    store.state.topics[41] = { pane: "old", cwd: dir };
    await life.open(41);
    expect(started[0].kind).toBe("claude");
    expect(started[0].args).toContain("--append-system-prompt");
  });
  test("attaches Codex with a handoff, and closing leaves the desktop pane running", async () => {
    state = live();
    writeFileSync(path, [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "问题" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "完整回答" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "完整回答" } }),
    ].join("\n") + "\n");
    expect(await life.attach("pane", { kind: "codex", session: "test-session" })).toEqual({ ok: true, thread: 41 });
    expect(store.state.topics[41].kind).toBe("codex"); expect(sends).toEqual(["完整回答"]);
    await life.close(41, false);
    expect(closed).toEqual([]); expect(store.state.topics[41].closedAt).toBeGreaterThan(0);
    expect(await life.attach("pane", { kind: "codex", session: "test-session" })).toEqual({ ok: true, thread: 41 });
    expect(calls.filter(c => c.name === "createForumTopic")).toHaveLength(1);
  });
  test("wrong session/kind or absent transcript fails before any Telegram mutation", async () => {
    state = live();
    expect((await life.attach("pane", { session: "someone-else" })).ok).toBe(false);
    expect((await life.attach("pane", { kind: "claude" })).ok).toBe(false);
    rmSync(path);
    expect((await life.attach("pane")).ok).toBe(false);
    expect(calls).toEqual([]); expect(Object.keys(store.state.topics)).toHaveLength(0);
  });
  test("concurrent binds create only one topic and revalidate each caller's identity", async () => {
    state = live();
    const results = await Promise.all([life.attach("pane"), life.attach("pane"), life.attach("pane", { session: "wrong" })]);
    expect(results[0].ok).toBe(true); expect(results[1].already).toBe(true); expect(results[2].ok).toBe(false);
    expect(calls.filter(c => c.name === "createForumTopic")).toHaveLength(1);
  });
  test("watcher sends final once, commentary only in progress, with no reasoning", async () => {
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    appendFileSync(path, [
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "正在检查" }] } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ text: "hidden" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "最终答复" }] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "最终答复" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick(); await w.tick();
    expect(sends.filter(s => s === "最终答复")).toHaveLength(1);
    expect(sends.filter(s => s.includes("正在检查"))).toHaveLength(1);
    expect(sends.join("")).not.toContain("hidden"); expect(w.turn).toBeUndefined();
  });
  test("binding uses the Herdr tab label rather than the generated session title", async () => {
    state = live(); label = "客户用法与产品分析";
    expect((await life.attach("pane")).ok).toBe(true);
    expect(calls.find(c => c.name === "createForumTopic").body.name).toBe(label);
    expect(store.state.topics[41].title).toBe(label);
  });
  test("attached topics follow desktop renames, throttled, without redundant Telegram edits", async () => {
    state = live(); state.agent.agent_status = "idle"; label = "Herdr 标签";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session", attached: true, title: "旧话题名" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    await w.tick(); await (w as any).nameSync;
    expect(calls.filter(c => c.name === "editForumTopic").map(c => c.body.name)).toEqual(["Herdr 标签"]);
    expect(bind.title).toBe("Herdr 标签");
    label = "修改后的标签";
    await w.tick(); expect(bind.title).toBe("Herdr 标签");
    (w as any).nextNameCheck = 0; await w.tick(); await (w as any).nameSync;
    expect(bind.title).toBe("修改后的标签");
    (w as any).nextNameCheck = 0; await w.tick(); await (w as any).nameSync; await (w as any).nameSync;
    expect(calls.filter(c => c.name === "editForumTopic")).toHaveLength(2);
    await (w as any).onTitle("自动生成的会话标题");
    expect(bind.title).toBe("修改后的标签");
  });
  test("failed name updates retry and missing labels do not overwrite a topic", async () => {
    state = live(); state.agent.agent_status = "idle";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session", attached: true, title: "原名" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    await w.tick(); expect(bind.title).toBe("原名"); expect(calls).toHaveLength(0);
    label = "新名"; const call = tg.call;
    tg.call = async () => ({ ok: false, description: "temporary failure" });
    (w as any).nextNameCheck = 0; await w.tick(); await (w as any).nameSync; expect(bind.title).toBe("原名");
    tg.call = call;
    (w as any).nextNameCheck = 0; await w.tick(); await (w as any).nameSync; expect(bind.title).toBe("新名");
  });
  test("a pending rename never blocks the answer or starts another rename; stop drops its result", async () => {
    state = live(); label = "new label";
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session", attached: true, title: "old label" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    let resolve!: (v: any) => void;
    let edits = 0;
    tg.call = async () => { edits++; return new Promise(r => { resolve = r; }); };
    appendFileSync(path, [
      { type: "response_item", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text: "answer during rename" }] } },
      { type: "event_msg", payload: { type: "task_complete", last_agent_message: "answer during rename" } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick(); await w.tick();
    expect(sends).toContain("answer during rename"); expect(edits).toBe(1);
    w.stop(); resolve({ ok: true }); await (w as any).nameSync;
    expect(bind.title).toBe("old label");
  });
  test("aborted and completed turns are separated from a following active turn in one poll", async () => {
    state = live();
    const bind = { pane: "pane", cwd: dir, kind: "codex" as const, session: "test-session" };
    store.state.topics[41] = bind;
    const w = new Watcher(41, bind, cfg, tg, store); watchers.set(41, w);
    const user = (text: string) => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    const answer = (text: string) => ({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final", content: [{ type: "output_text", text }] } });
    const end = (text: string) => ({ type: "event_msg", payload: { type: "task_complete", last_agent_message: text } });
    appendFileSync(path, [user("q1"), answer("a1"), end("a1"), user("q2"), answer("a2"), end("a2"),
      user("aborted"), { type: "event_msg", payload: { type: "turn_aborted" } },
      user("still working"), { type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "checking new task" }] } },
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    await w.tick();
    expect(sends.filter(s => s === "a1")).toHaveLength(1); expect(sends.filter(s => s === "a2")).toHaveLength(1);
    expect(w.turn).toBeDefined(); expect(w.turn!.lines.join("\n")).toContain("checking new task");
    expect(w.lastAnswer?.items).toEqual([]);
  });
});
