import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ext from "../index.ts";
import { modelMatch, pickModel, resolve, saveKey } from "../src/settings.ts";
import { buildPrompt } from "../src/prompt.ts";
import { BUILTIN_DIR, editorCommand, known, launchEnv, locate, pick, piCommand, run, userDir, writePrompt, type Run } from "../src/launch.ts";
import { fakePi } from "./fakepi.ts";

const opus = { provider: "bifrost", id: "anthropic/claude-opus-5-5" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5" };

function dirs(global = "", local = "") {
  const root = mkdtempSync(join(tmpdir(), "handoff-"));
  const home = join(root, "home"), cwd = join(root, "proj");
  mkdirSync(join(home, ".config", "piext"), { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(home, ".config", "piext", "config.toml"), global);
  writeFileSync(join(cwd, ".pi", "piext.toml"), local);
  return { home, cwd };
}

// ─── settings ────────────────────────────────────────────────────────────────

test("model patterns: globs across slashes, substrings, case, specificity", () => {
  assert.ok(modelMatch("*opus-5-5", opus) > 0);
  assert.ok(modelMatch("OPUS", opus) > 0);
  assert.ok(modelMatch("bifrost/*", opus) > 0);
  assert.equal(modelMatch("*sonnet*", opus), -1);
  const models = { any: { name: "*" }, opus: { name: "*opus*" }, exact: { name: "bifrost/anthropic/claude-opus-5-5" }, other: { name: ["x", "sonnet"] } };
  assert.equal(pickModel(models, opus), "exact");
  assert.equal(pickModel(models, sonnet), "other");
  assert.equal(pickModel({ a: { name: "*opus*" }, b: { name: "*opus*" } }, opus), "a"); // ties: first
  assert.equal(pickModel({ "claude-opus": {} }, opus), "claude-opus"); // no name: the key
  assert.equal(saveKey(opus), "claude-opus-5-5");
});

test("general keys from every level, then the model table from every level", () => {
  const { home, cwd } = dirs(
    `[handoff]\nthreshold = 0.8\nturns = 20\n[handoff.models.opus]\nname = "*opus-5-5"\nthreshold = 0.6\n`,
    `[handoff]\nthreshold = 0.7\non_compact = false\n[handoff.models.opus]\nturns = 10\n`,
  );
  const entries = [{ type: "custom", customType: "piext-config", data: { ns: "handoff", table: { threshold: 0.9 } } }];
  const e = resolve({ cwd, home, entries, model: opus });
  assert.equal(e.model, "opus");
  assert.equal(e.settings.threshold, 0.6); // the model table beats the session's general key
  assert.equal(e.settings.turns, 10);
  assert.equal(e.settings.on_compact, false);
  assert.deepEqual(e.sources.threshold, { scope: "global", table: "models.opus" });
  assert.deepEqual(e.sources.turns, { scope: "local", table: "models.opus" });
  assert.deepEqual(e.sources.on_compact, { scope: "local" });
  const s = resolve({ cwd, home, entries, model: sonnet });
  assert.equal(s.model, undefined);
  assert.equal(s.settings.threshold, 0.9);
  assert.deepEqual(s.sources.threshold, { scope: "session" });
});

test("bad values are reported and fall back", () => {
  const { home, cwd } = dirs(`[handoff]\nthreshold = 75\nmode = "sometimes"\n`);
  const e = resolve({ cwd, home, model: opus });
  assert.equal(e.settings.threshold, 0.75);
  assert.equal(e.settings.mode, "auto");
  assert.equal(e.errors.length, 2);
});

test("the prompt", () => {
  const p = buildPrompt({ instructions: "Do X.", summary: "Did Y.", files: ["a.ts"], tasks: [{ id: 1, subject: "t", status: "pending" }, { id: 2, subject: "done", status: "completed" }], cwd: "/p", branch: "main", previousSession: "/s.jsonl", reason: "the user asked for it" });
  assert.match(p, /## Instructions\n\nDo X\.\n/);
  assert.match(p, /- #1 \[pending\] t/);
  assert.doesNotMatch(p, /done/);
  assert.match(p, /- Branch: main\n- Previous session: \/s\.jsonl/);
});

test("settings: launcher is one or a list; close_old takes yes/no/ask or a boolean", () => {
  const one = dirs(`[handoff]\nlauncher = "tmux"\nclose_old = true\n`);
  const a = resolve({ cwd: one.cwd, home: one.home, model: opus });
  assert.deepEqual(a.settings.launcher, ["tmux"]);
  assert.equal(a.settings.close_old, "yes");
  const list = dirs(`[handoff]\nlauncher = ["zellij", "./x.sh"]\nclose_old = "maybe"\n`);
  const b = resolve({ cwd: list.cwd, home: list.home, model: opus });
  assert.deepEqual(b.settings.launcher, ["zellij", "./x.sh"]);
  assert.equal(b.settings.close_old, "ask");
  assert.equal(b.errors.length, 1);
  const none = dirs();
  assert.deepEqual(resolve({ cwd: none.cwd, home: none.home }).settings.launcher, []);
});

// ─── launchers ───────────────────────────────────────────────────────────────

function script(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

test("the built-ins: active only where they fit; file never picked on its own", async () => {
  const names = known("/nowhere").map((l) => l.name);
  assert.deepEqual(names, ["file", "loop", "rex", "tmux", "zellij"]);
  const active = async (name: string, env: NodeJS.ProcessEnv) => (await run(join(BUILTIN_DIR, `${name}.sh`), ["active"], { PATH: process.env.PATH, ...env })).code;
  assert.equal(await active("loop", {}), 1);
  assert.equal(await active("loop", { LOOP_SESSION_ID: "3" }), 0);
  assert.equal(await active("tmux", {}), 1);
  assert.equal(await active("zellij", {}), 1);
  assert.equal(await active("rex", {}), 1);
  assert.equal(await active("file", {}), 0);
  assert.equal((await run(join(BUILTIN_DIR, "zellij.sh"), ["close"], {})).code, 3);
  assert.equal((await run(join(BUILTIN_DIR, "tmux.sh"), ["bogus"], {})).code, 2);
  assert.match((await pick({ specs: [], base: () => "/", env: { PATH: process.env.PATH }, home: "/nowhere" }) as any).problem, /no launcher fits/);
  assert.equal((await pick({ specs: [], base: () => "/", env: { PATH: process.env.PATH, LOOP_SESSION_ID: "3" }, home: "/nowhere" }) as any).launcher.name, "loop");
});

test("file.sh writes the prompt to .pi and says how to start it", async () => {
  const { cwd } = dirs();
  const prompt = join(cwd, "p.md");
  writeFileSync(prompt, "hello");
  const r = await run(join(BUILTIN_DIR, "file.sh"), ["start"], { PATH: process.env.PATH, ...launchEnv({ cwd, promptFile: prompt, model: "a/b", thinking: "high" }, {}) });
  assert.equal(r.code, 0);
  const out = /written to (\S+);/.exec(r.stdout)![1];
  assert.ok(out.startsWith(join(cwd, ".pi", "handoff-")));
  assert.equal(readFileSync(out, "utf8"), "hello");
  assert.match(r.stdout, /pi --model a\/b --thinking high @/);
});

test("finding launchers: yours over the built-ins, paths, ~ and ./", () => {
  const { home, cwd } = dirs();
  assert.equal(locate("tmux", cwd, home)!.path, join(BUILTIN_DIR, "tmux.sh"));
  script(join(userDir(home), "tmux"), "exit 0");
  script(join(userDir(home), "kitty.sh"), "exit 0");
  assert.equal(locate("tmux", cwd, home)!.path, join(userDir(home), "tmux"));
  assert.equal(locate("kitty", cwd, home)!.path, join(userDir(home), "kitty.sh"));
  assert.deepEqual(known(home).map((l) => [l.name, l.path.startsWith(BUILTIN_DIR)]), [["file", true], ["kitty", false], ["loop", true], ["rex", true], ["tmux", false], ["zellij", true]]);
  script(join(cwd, ".pi", "mine.sh"), "exit 0");
  assert.equal(locate("./mine.sh", join(cwd, ".pi"), home)!.path, join(cwd, ".pi", "mine.sh"));
  assert.equal(locate(join(cwd, ".pi", "mine.sh"), "/", home)!.name, join(cwd, ".pi", "mine.sh"));
  script(join(home, "bin", "l"), "exit 0");
  assert.equal(locate("~/bin/l", "/", home)!.path, join(home, "bin", "l"));
  assert.equal(locate("./missing.sh", cwd, home), undefined);
  assert.equal(locate("missing", cwd, home), undefined);
});

test("pick: configured ones in order; unset needs exactly one", async () => {
  const actives = new Set<string>();
  const fake: Run = async (path) => ({ code: actives.has(basename(path).replace(/\.sh$/, "")) ? 0 : 1, stdout: "", stderr: "" });
  const o = { base: () => "/", env: {}, home: "/nowhere", run: fake };
  actives.add("tmux").add("loop");
  assert.match((await pick({ ...o, specs: [] }) as any).problem, /more than one launcher fits this session \(loop, tmux\)/);
  assert.equal((await pick({ ...o, specs: ["zellij", "tmux", "loop"] }) as any).launcher.name, "tmux");
  assert.match((await pick({ ...o, specs: ["zellij", "nope"] }) as any).problem, /none of the launchers set \("zellij", "nope"\).*not found or not executable: nope/);
  actives.delete("tmux");
  assert.equal((await pick({ ...o, specs: [] }) as any).launcher.name, "loop");
});

test("the launch environment", () => {
  const h = { cwd: "/p", promptFile: "/t/it's.md", model: "bifrost/x/y", thinking: "high", oldSession: "id", oldSessionFile: "/s.jsonl" };
  assert.equal(piCommand(h), `pi --model 'bifrost/x/y' --thinking 'high' '@/t/it'\\''s.md'`);
  const e = launchEnv(h, { KEEP: "1" });
  assert.equal(e.KEEP, "1");
  assert.equal(e.HANDOFF_CWD, "/p");
  assert.equal(e.HANDOFF_PROMPT_FILE, "/t/it's.md");
  assert.equal(e.HANDOFF_OLD_SESSION, "id");
  assert.equal(e.HANDOFF_OLD_SESSION_FILE, "/s.jsonl");
  assert.equal(piCommand({ ...h, model: "", thinking: "" }), `pi '@/t/it'\\''s.md'`);
});

test("editor command", () => {
  assert.deepEqual(editorCommand({ EDITOR: "nvim" }, "darwin"), ["open", "-t"]);
  assert.deepEqual(editorCommand({ VISUAL: "code -w", EDITOR: "vim" }, "darwin"), ["code", "-w"]);
});

// ─── the extension ───────────────────────────────────────────────────────────

/**
 * started: the extension on a fake pi, with a launcher "fake" in your
 * launchers folder; ran has every call to it as [subcommand, env].
 */
async function started(global = "", local = "", o: { active?: boolean; startCode?: number; closeCode?: number } = {}) {
  const { home, cwd } = dirs(global, local);
  const f = fakePi(cwd);
  const spawned: string[][] = [];
  const ran: [string, NodeJS.ProcessEnv][] = [];
  const fakeRun: Run = async (path, args, env) => {
    ran.push([args[0], env]);
    const name = basename(path);
    if (name !== "fake") return { code: 1, stdout: "", stderr: "" }; // the built-ins don't fit here
    const code = args[0] === "active" ? (o.active === false ? 1 : 0) : args[0] === "start" ? (o.startCode ?? 0) : (o.closeCode ?? 0);
    return { code, stdout: args[0] === "start" && code === 0 ? "tab 7" : "", stderr: code ? "it broke" : "" };
  };
  script(join(userDir(home), "fake"), "exit 0");
  const promptDir = join(cwd, "..", "prompts");
  ext(f.pi, { home, env: { PATH: "/bin" }, spawn: (c, a) => spawned.push([c, ...a]), run: fakeRun, promptDir });
  await f.fire("session_start", { reason: "startup" });
  const starts = () => ran.filter(([sub]) => sub === "start");
  return { f, home, cwd, spawned, ran, starts };
}

test("threshold: asks once, the agent hands off, the launcher starts the next session when pi settles", async () => {
  const { f, starts, ran } = await started(`[handoff]\nenabled = true\nthreshold = 0.5\nclose_old = "no"\n`);
  f.state.usage = { tokens: 6000, contextWindow: 10000, percent: 60 };
  await f.fire("turn_end");
  await f.fire("turn_end");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].message.content, /context window is 60% full/);
  assert.equal(f.sent[0].options.deliverAs, "followUp");
  const r = await f.tool("handoff_ready", { instructions: "Finish the parser.", files: ["src/p.ts"] });
  assert.match(r.content[0].text, /Handoff ready/);
  assert.equal(r.terminate, true);
  assert.equal(f.userMessages.length, 0); // no queued /handoff go
  assert.equal(starts().length, 0);
  await f.fire("agent_settled");
  assert.equal(starts().length, 1);
  const env = starts()[0][1];
  assert.equal(env.HANDOFF_MODEL, "bifrost/anthropic/claude-opus-5-5");
  assert.equal(env.HANDOFF_THINKING, "high");
  assert.equal(env.HANDOFF_CWD, f.cwd ?? env.HANDOFF_CWD);
  assert.equal(env.HANDOFF_OLD_SESSION, "old-id");
  assert.equal(env.PATH, "/bin");
  const prompt = readFileSync(env.HANDOFF_PROMPT_FILE!, "utf8");
  assert.match(prompt, /^# Handoff from a previous session/);
  assert.match(prompt, /Finish the parser\./);
  assert.match(prompt, /- src\/p\.ts/);
  assert.match(f.notes.at(-1)!.msg, /Handed off with fake: tab 7/);
  assert.equal(f.statuses.handoff, "handoff: done");
  assert.ok(!ran.some(([sub]) => sub === "close"));
});

test("only one launch: a second handoff_ready, a second settle, /handoff go", async () => {
  const { f, starts } = await started(`[handoff]\nclose_old = "no"\n`);
  await f.tool("handoff_ready", { instructions: "First." });
  const again = await f.tool("handoff_ready", { instructions: "Second." });
  assert.match(again.content[0].text, /instructions updated/);
  // Two settles at once (the bug that started two sessions).
  await Promise.all([f.fire("agent_settled"), f.fire("agent_settled")]);
  assert.equal(starts().length, 1);
  assert.match(readFileSync(starts()[0][1].HANDOFF_PROMPT_FILE!, "utf8"), /Second\./);
  await f.fire("agent_settled");
  await f.command("handoff", "go");
  assert.equal(starts().length, 1);
  assert.match(f.notes.at(-1)!.msg, /already handed off/);
  const late = await f.tool("handoff_ready", { instructions: "Third." });
  assert.match(late.content[0].text, /already handed off/);
});

test("no launcher: you're told once, the agent isn't asked, pi compacts as usual", async () => {
  const { f, starts } = await started(`[handoff]\nenabled = true\nthreshold = 0.5\nturns = 1\n`, "", { active: false });
  f.state.usage = { percent: 60 };
  f.prompt("one");
  await f.fire("turn_end");
  await f.fire("agent_end");
  assert.equal(f.sent.length, 0);
  const warned = f.notes.filter((n) => /but no launcher fits this session/.test(n.msg));
  assert.equal(warned.length, 1);
  assert.match(warned[0].msg, /context window is 60% full/);
  assert.equal(f.statuses.handoff, "handoff: no launcher");
  assert.equal(await f.fire("session_before_compact", { reason: "threshold" }), undefined);
  assert.equal(f.notes.filter((n) => /no launcher fits/.test(n.msg)).length, 1);
  await f.command("handoff", "now");
  assert.match(f.notes.at(-1)!.msg, /Can't hand off: no launcher fits/);
  assert.equal(f.sent.length, 0);
  // After pi's compaction it may ask again (and tell you again).
  await f.fire("session_compact");
  await f.fire("turn_end");
  assert.equal(f.notes.filter((n) => /no launcher fits/.test(n.msg)).length, 3);
  assert.equal(starts().length, 0);
});

test("a configured launcher: ./ is relative to its config; one that isn't active is reported", async () => {
  const { f, cwd, starts } = await started("", `[handoff]\nlauncher = "./fake"\nclose_old = "no"\n`);
  script(join(cwd, ".pi", "fake"), "exit 0");
  await f.tool("handoff_ready", { instructions: "Here." });
  await f.fire("agent_settled");
  assert.equal(starts().length, 1);

  const g = await started(`[handoff]\nlauncher = ["tmux", "fake"]\n`, "", { active: false });
  await g.f.tool("handoff_ready", { instructions: "Nope." });
  await g.f.fire("agent_settled");
  assert.match(g.f.notes.at(-1)!.msg, /can't start the next session: none of the launchers set \("tmux", "fake"\)/);
  assert.equal(g.f.statuses.handoff, "handoff: ready");
});

test("a launcher that fails leaves it ready to try again", async () => {
  const { f, starts } = await started(`[handoff]\nclose_old = "no"\n`, "", { startCode: 1 });
  await f.tool("handoff_ready", { instructions: "Try." });
  await f.fire("agent_settled");
  assert.match(f.notes.at(-1)!.msg, /fake didn't start the next session: it broke/);
  assert.equal(f.statuses.handoff, "handoff: ready");
  await f.command("handoff", "go");
  assert.equal(starts().length, 2);
});

test("close_old: ask, yes, and quitting pi when the launcher can't close", async () => {
  const a = await started(); // the default is ask
  a.f.confirmAnswers.push(false);
  await a.f.tool("handoff_ready", { instructions: "x" });
  await a.f.fire("agent_settled");
  assert.equal(a.f.confirms.length, 1);
  assert.ok(!a.ran.some(([s]) => s === "close"));
  assert.equal(a.f.state.shutdowns, 0);

  const y = await started(`[handoff]\nclose_old = "yes"\n`);
  await y.f.tool("handoff_ready", { instructions: "x" });
  await y.f.fire("agent_settled");
  assert.equal(y.f.confirms.length, 0);
  assert.equal(y.ran.filter(([s]) => s === "close").length, 1);
  assert.equal(y.f.state.shutdowns, 0);

  const u = await started(`[handoff]\nclose_old = "yes"\n`, "", { closeCode: 3 });
  await u.f.tool("handoff_ready", { instructions: "x" });
  await u.f.fire("agent_settled");
  assert.equal(u.f.state.shutdowns, 1);
  assert.doesNotMatch(u.f.notes.at(-1)!.msg, /close failed/);

  const e = await started(`[handoff]\nclose_old = "ask"\n`, "", { closeCode: 1 });
  e.f.confirmAnswers.push(true);
  await e.f.tool("handoff_ready", { instructions: "x" });
  await e.f.fire("agent_settled");
  assert.match(e.f.notes.at(-1)!.msg, /fake close failed: it broke; quitting pi instead/);
  assert.equal(e.f.state.shutdowns, 1);
});

test("a session started by a handoff doesn't hand off again before your next prompt", async () => {
  const { f } = await started(`[handoff]\nenabled = true\nthreshold = 0.01\nturns = 1\n`);
  f.state.usage = { percent: 50 };
  f.branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text: "# Handoff from a previous session\n\n..." }] } });
  await f.fire("turn_end");
  await f.fire("agent_end");
  assert.equal(await f.fire("session_before_compact", { reason: "threshold" }), undefined);
  assert.equal(f.sent.length, 0);
  f.prompt("now something of mine");
  await f.fire("turn_end");
  assert.equal(f.sent.length, 1);
});

test("turns, disabled, and /handoff now", async () => {
  const { f } = await started(`[handoff]\nenabled = true\nthreshold = 0\nturns = 2\n`);
  f.prompt("one");
  await f.fire("agent_end");
  assert.equal(f.sent.length, 0);
  f.prompt("two");
  await f.fire("agent_end");
  assert.match(f.sent[0].message.content, /reached 2 prompts/);

  const g = await started(`[handoff]\nenabled = false\nturns = 1\nthreshold = 0.1\n`);
  g.f.state.usage = { percent: 99 };
  g.f.prompt("one");
  await g.f.fire("turn_end");
  await g.f.fire("agent_end");
  assert.equal(await g.f.fire("session_before_compact", { reason: "threshold" }), undefined);
  assert.equal(g.f.sent.length, 0);
  await g.f.command("handoff", "now focus on tests");
  assert.match(g.f.sent[0].message.content, /the user asked for it.*The user adds: focus on tests/s);
});

test("on_compact cancels pi's compaction, not yours; reminders, then giving up", async () => {
  const { f } = await started(`[handoff]\nenabled = true\nthreshold = 0\nremind_after = 1\n`);
  assert.equal(await f.fire("session_before_compact", { reason: "manual" }), undefined);
  assert.equal(await f.fire("session_before_compact", { reason: "overflow" }), undefined);
  assert.deepEqual(await f.fire("session_before_compact", { reason: "threshold" }), { cancel: true });
  assert.match(f.sent[0].message.content, /about to compact/);
  await f.fire("agent_end");
  assert.match(f.sent[1].message.content, /Reminder/);
  await f.fire("agent_end");
  assert.match(f.notes.at(-1)!.msg, /hasn't handed off/);
  assert.equal(await f.fire("session_before_compact", { reason: "threshold" }), undefined);
  await f.fire("session_compact");
  assert.deepEqual(await f.fire("session_before_compact", { reason: "threshold" }), { cancel: true });
});

test("ask mode shows the prompt; empty holds it", async () => {
  const { f, starts } = await started(`[handoff]\nmode = "ask"\nclose_old = "no"\n`);
  await f.tool("handoff_ready", { instructions: "Ship it." });
  f.editorAnswers.push("");
  await f.fire("agent_settled");
  assert.equal(starts().length, 0);
  assert.match(f.editorPrompts[0].prefill!, /Ship it\./);
  f.editorAnswers.push("Edited.");
  await f.command("handoff", "go");
  assert.equal(readFileSync(starts()[0][1].HANDOFF_PROMPT_FILE!, "utf8"), "Edited.");
});

test("/handoff go without the agent asks you for instructions", async () => {
  const { f, starts } = await started(`[handoff]\nclose_old = "no"\n`);
  f.editorAnswers.push("From me.");
  await f.command("handoff", "go");
  const text = readFileSync(starts()[0][1].HANDOFF_PROMPT_FILE!, "utf8");
  assert.match(text, /From me\./);
  assert.match(text, /the user asked for it/);
});

test("/handoff set, on/off, and save to a model-specific table", async () => {
  const { f, cwd } = await started(`[handoff]\nenabled = true\nthreshold = 0.8\n`, `# mine\n[nudge]\ndelay = "1m"\n`);
  await f.command("handoff", "set threshold 0.4");
  await f.command("handoff", "set launcher zellij fake");
  await f.command("handoff", "off");
  assert.match(f.notes.at(-1)!.msg, /off for this session/);
  await f.command("handoff", "");
  const shown = f.notes.at(-1)!.msg;
  assert.match(shown, /manual only/);
  assert.match(shown, /threshold\s+0\.4\s+session/);
  assert.match(shown, /launcher\s+\["zellij","fake"\]/);
  assert.match(shown, /launches\s+fake \(/);
  await f.command("handoff", "set launcher");
  await f.command("handoff", "save local");
  const text = readFileSync(join(cwd, ".pi", "piext.toml"), "utf8");
  assert.match(text, /^# mine\n\[nudge\]\ndelay = "1m"\n/);
  assert.match(text, /\[handoff\.models\.claude-opus-5-5\]\nname = "bifrost\/anthropic\/claude-opus-5-5"\nthreshold = 0\.4\nenabled = false\n/);
  // Saved: the session's overrides are gone, the file has them.
  await f.command("handoff", "");
  assert.match(f.notes.at(-1)!.msg, /threshold\s+0\.4\s+local \[models\.claude-opus-5-5\]/);
  await f.command("handoff", "set bogus 1");
  assert.match(f.notes.at(-1)!.msg, /^Keys:/);
});

test("off unless a config turns it on", async () => {
  const { f } = await started();
  f.state.usage = { percent: 99 };
  f.prompt("x");
  await f.fire("turn_end");
  await f.fire("agent_end");
  assert.equal(await f.fire("session_before_compact", { reason: "threshold" }), undefined);
  assert.equal(f.sent.length, 0);
  assert.equal(f.notes.length, 0);
});

test("the prompt file goes in the old session's piext folder", () => {
  const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
  const p = writePrompt("hi", "01abc", new Date(0), undefined, home);
  assert.ok(p.startsWith(join(home, ".local/state/piext/sessions/01abc/handoff/")), p);
  assert.equal(readFileSync(p, "utf8"), "hi");
  // No session id: the temp folder.
  assert.ok(writePrompt("x", "session", new Date(0), undefined, home).startsWith(join(tmpdir(), "piext-handoff")));
});
