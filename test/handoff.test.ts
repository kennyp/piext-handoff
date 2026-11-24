import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ext from "../index.ts";
import { modelMatch, pickModel, resolve, saveKey } from "../src/settings.ts";
import { buildPrompt } from "../src/prompt.ts";
import { editorCommand, loopTab } from "../src/launch.ts";
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

test("launchers", async () => {
  let got: string[] = [];
  const id = await loopTab({ cwd: "/p", model: "a/b", prompt: "hi \"there\"", closeId: "5" }, async (cmd, args) => ((got = [cmd, ...args]), "7"));
  assert.equal(id, "7");
  assert.deepEqual(got.slice(3), ["/p", "/model a/b", "hi \"there\"", "5"]);
  assert.deepEqual(editorCommand({ EDITOR: "nvim" }, "darwin"), ["open", "-t"]);
  assert.deepEqual(editorCommand({ VISUAL: "code -w", EDITOR: "vim" }, "darwin"), ["code", "-w"]);
});

// ─── the extension ───────────────────────────────────────────────────────────

async function started(global = "", local = "") {
  const { home, cwd } = dirs(global, local);
  const f = fakePi(cwd);
  const spawned: string[][] = [];
  const ran: string[][] = [];
  ext(f.pi, { home, env: {}, spawn: (c, a) => spawned.push([c, ...a]), run: async (c, a) => (ran.push([c, ...a]), "9") });
  await f.fire("session_start", { reason: "startup" });
  return { f, home, cwd, spawned, ran };
}

test("threshold: asks once, the agent hands off, a new session starts on the same model", async () => {
  const { f } = await started(`[handoff]\nenabled = true\nthreshold = 0.5\n`);
  f.state.usage = { tokens: 6000, contextWindow: 10000, percent: 60 };
  await f.fire("turn_end");
  await f.fire("turn_end");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].message.content, /context window is 60% full/);
  assert.equal(f.sent[0].options.deliverAs, "followUp");
  const r = await f.tool("handoff_ready", { instructions: "Finish the parser.", files: ["src/p.ts"] });
  assert.match(r.content[0].text, /Handoff ready/);
  assert.deepEqual(f.userMessages[0], { text: "/handoff go", options: { deliverAs: "followUp", expandPromptTemplates: true } });
  // pi starts the new session on its default model: it gets this one back.
  f.state.newSessionModel = { provider: "x", id: "y" };
  await f.command("handoff", "go");
  assert.equal(f.newSessions.length, 1);
  assert.equal(f.newSessions[0].parentSession, "/sessions/old.jsonl");
  assert.deepEqual(f.state.setModelCalls, [opus]);
  assert.equal(f.state.thinking, "high");
  const first = f.userMessages.at(-1)!;
  assert.equal(first.options.replacement, true);
  assert.match(first.text, /Finish the parser\./);
  assert.match(first.text, /- src\/p\.ts/);
});

test("no model change when the new session already has it", async () => {
  const { f } = await started();
  await f.tool("handoff_ready", { instructions: "Go on." });
  await f.command("handoff", "go");
  assert.equal(f.state.setModelCalls.length, 0);
  assert.equal(f.state.thinking, "high");
  assert.equal(f.statuses.handoff, "handoff: done");
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

test("ask mode shows the prompt; empty cancels", async () => {
  const { f } = await started(`[handoff]\nmode = "ask"\n`);
  await f.tool("handoff_ready", { instructions: "Ship it." });
  f.editorAnswers.push("");
  await f.command("handoff", "go");
  assert.equal(f.newSessions.length, 0);
  assert.match(f.editorPrompts[0].prefill!, /Ship it\./);
  f.editorAnswers.push("Edited.");
  await f.command("handoff", "go");
  assert.equal(f.userMessages.at(-1)!.text, "Edited.");
});

test("/handoff go without the agent asks you for instructions", async () => {
  const { f } = await started();
  f.editorAnswers.push("From me.");
  await f.command("handoff", "go");
  assert.match(f.userMessages.at(-1)!.text, /From me\./);
  assert.match(f.userMessages.at(-1)!.text, /the user asked for it/);
});

test("file and loop-tab launchers", async () => {
  const { f, cwd } = await started(`[handoff]\nlauncher = "file"\n`);
  await f.tool("handoff_ready", { instructions: "Later." });
  await f.command("handoff", "go");
  const m = /written to (\S+)/.exec(f.notes.at(-1)!.msg)!;
  assert.ok(m[1].startsWith(join(cwd, ".pi")));
  assert.match(readFileSync(m[1], "utf8"), /Later\./);
  assert.match(f.notes.at(-1)!.msg, /pi --model bifrost\/anthropic\/claude-opus-5-5 @/);

  // Outside Loop, loop-tab falls back to a file.
  const g = await started(`[handoff]\nlauncher = "loop-tab"\nclose_old = true\n`);
  await g.f.tool("handoff_ready", { instructions: "Tab." });
  await g.f.command("handoff", "go");
  assert.match(g.f.notes.at(-2)!.msg, /not in a Loop session/);
  assert.equal(g.ran.length, 0);
});

test("/handoff set, on/off, and save to a model-specific table", async () => {
  const { f, cwd } = await started(`[handoff]\nenabled = true\nthreshold = 0.8\n`, `# mine\n[nudge]\ndelay = "1m"\n`);
  await f.command("handoff", "set threshold 0.4");
  await f.command("handoff", "off");
  assert.match(f.notes.at(-1)!.msg, /off for this session/);
  await f.command("handoff", "");
  assert.match(f.notes.at(-1)!.msg, /manual only/);
  assert.match(f.notes.at(-1)!.msg, /threshold\s+0\.4\s+session/);
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
});
