// piext-handoff: before a session runs out of room, the agent writes
// instructions for a fresh one, and a launcher starts it (a new Loop tab,
// tmux window, zellij pane, Rex tab, or your own script) with them as its
// first message. When is up to the [handoff] settings (piext-config), per
// model if you like; /handoff works any time.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearSession, set as setConfig, setSession } from "./vendor/piext-config/index.ts";
import { KEYS, modelName, NS, parseValue, resolve, saveKey, sessionOverrides, type Effective, type ModelRef, type Settings } from "./src/settings.ts";
import { buildPrompt, MAX_INSTRUCTIONS, prepareText, reasonText, remindText, type Reason, type Task } from "./src/prompt.ts";
import { CLOSE_UNSUPPORTED, launchEnv, openInEditor, pick, run as defaultRun, spawnDetached, writePrompt, type Launcher, type Pick, type Run, type Spawn } from "./src/launch.ts";

export const NAME = "piext-handoff";
export const VERSION = "0.2.0";
const STATE = "piext-handoff";
/** How every handoff prompt starts (src/prompt.ts); a session that begins with it came from one. */
const MARK = "# Handoff from a previous session";

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: Run;
  spawn?: Spawn;
  /** Where prompt files go (tests). */
  promptDir?: string;
}

// nolauncher: a trigger fired, but nothing here can start a session.
type Phase = "idle" | "asked" | "ready" | "gaveup" | "nolauncher" | "done";
interface State {
  phase: Phase;
  reason?: string;
  /** Agent runs since we asked. */
  runs: number;
  reminded: boolean;
  /** The next session's first message, once the agent (or you) wrote it. */
  prompt?: string;
}

const fresh = (): State => ({ phase: "idle", runs: 0, reminded: false });

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : "";

export default function (pi: ExtensionAPI, opts: Options = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const exec = opts.run ?? defaultRun;
  const start = opts.spawn ?? spawnDetached;
  let state = fresh();
  let tasks: Task[] = [];
  let cwd = "";
  // Set before the first await of a launch, so a second one can't start.
  let launching = false;

  const entries = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown[];
  const modelOf = (ctx: ExtensionContext): ModelRef | undefined => (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
  const eff = (ctx: ExtensionContext): Effective => resolve({ cwd: ctx.cwd, home: opts.home, entries: entries(ctx), model: modelOf(ctx) });
  const save = (next: Partial<State>) => {
    state = { ...state, ...next };
    pi.appendEntry(STATE, state);
    pi.events.emit("handoff:changed", { cwd, state: { ...state } });
  };
  const status = (ctx: ExtensionContext) => {
    const text = { idle: undefined, asked: "handoff: waiting for the agent", ready: "handoff: ready", gaveup: undefined, nolauncher: "handoff: no launcher", done: "handoff: done" }[state.phase];
    try {
      ctx.ui.setStatus("handoff", text);
    } catch {
      // no UI
    }
  };
  const userMessages = (ctx: ExtensionContext) => entries(ctx).filter((e: any) => e?.type === "message" && e.message?.role === "user") as any[];
  const userTurns = (ctx: ExtensionContext) => userMessages(ctx).length;
  const fromHandoff = (ctx: ExtensionContext) => textOf(userMessages(ctx)[0]?.message?.content).includes(MARK);
  // A session that began with a handoff waits for a prompt of yours before
  // handing off by itself: its first prompt alone may be past the threshold,
  // and it would hand off again and again.
  const automatic = (ctx: ExtensionContext, s: Settings) => s.enabled && !(fromHandoff(ctx) && userTurns(ctx) < 2);

  /** choose: the launcher for this session, or why there's none. */
  const choose = (ctx: ExtensionContext): Promise<Pick> => {
    const e = eff(ctx);
    // "./x" is relative to the config that set it.
    const scope = e.sources.launcher.scope;
    const base = scope === "global" ? join(home, ".config", "piext") : scope === "local" ? join(ctx.cwd, ".pi") : ctx.cwd;
    return pick({ specs: e.settings.launcher, base: () => base, env, home, run: exec });
  };

  /** ask tells the agent to get ready. */
  const ask = (ctx: ExtensionContext, reason: string, note?: string) => {
    save({ phase: "asked", reason, runs: 0, reminded: false, prompt: undefined });
    status(ctx);
    pi.events.emit("handoff:requested", { cwd, reason });
    pi.sendMessage({ customType: STATE, content: prepareText(reason, note), display: true }, { deliverAs: "followUp", triggerTurn: true });
  };

  /**
   * trigger: a trigger fired. With a launcher the agent is asked; without
   * one, there's nothing it could do, so only you hear about it (once).
   */
  const trigger = async (ctx: ExtensionContext, why: Reason, detail = ""): Promise<boolean> => {
    const reason = reasonText(why, detail);
    const p = await choose(ctx);
    if ("problem" in p) {
      if (state.phase !== "nolauncher") {
        save({ phase: "nolauncher", reason });
        status(ctx);
        ctx.ui.notify(`piext-handoff: ${reason}, but ${p.problem}. Pi compacts as usual.`, "warning");
      }
      return false;
    }
    ask(ctx, reason);
    return true;
  };

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    state = fresh();
    for (const e of entries(ctx) as any[]) if (e?.type === "custom" && e.customType === STATE && e.data) state = { ...fresh(), ...e.data };
    // Older versions kept this; it's worked out from the first prompt now.
    delete (state as any).fromHandoff;
    status(ctx);
    pi.events.emit("piext:hello", { name: NAME, version: VERSION, provides: ["handoff"] });
    pi.events.emit("tasks:get", {});
    const e = eff(ctx);
    for (const err of e.errors) ctx.ui.notify(`piext-handoff: ${err}`, "warning");
  });
  pi.on("session_shutdown", async () => {
    pi.events.emit("piext:bye", { name: NAME });
  });
  pi.events.on("piext:who", () => pi.events.emit("piext:hello", { name: NAME, version: VERSION, provides: ["handoff"] }));
  pi.events.on("tasks:changed", (d: any) => {
    if (d && (!d.cwd || d.cwd === cwd) && Array.isArray(d.tasks)) tasks = d.tasks;
  });

  pi.on("turn_end", async (_e, ctx) => {
    if (state.phase !== "idle") return;
    const s = eff(ctx).settings;
    const u = ctx.getContextUsage();
    if (automatic(ctx, s) && s.threshold > 0 && u?.percent != null && u.percent / 100 >= s.threshold) await trigger(ctx, "threshold", `${Math.round(u.percent)}%`);
  });

  pi.on("agent_end", async (_e, ctx) => {
    const s = eff(ctx).settings;
    if (state.phase === "idle") {
      const n = userTurns(ctx);
      if (automatic(ctx, s) && s.turns > 0 && n >= s.turns) await trigger(ctx, "turns", String(n));
      return;
    }
    if (state.phase !== "asked") return;
    const runs = state.runs + 1;
    if (s.remind_after > 0 && runs >= s.remind_after && !state.reminded) {
      save({ runs, reminded: true });
      pi.sendMessage({ customType: STATE, content: remindText(), display: true }, { deliverAs: "followUp", triggerTurn: false });
    } else if (state.reminded && runs >= 2 * Math.max(1, s.remind_after)) {
      save({ phase: "gaveup", runs });
      status(ctx);
      ctx.ui.notify("piext-handoff: the agent hasn't handed off; pi compacts as usual now. /handoff now to ask again.", "warning");
    } else save({ runs });
  });

  // Pi won't run again by itself: the agent's done, so start the next session.
  pi.on("agent_settled", async (_e, ctx) => {
    if (state.phase === "ready") await launch(ctx);
  });

  pi.on("session_before_compact", async (event: any, ctx) => {
    // Only pi's own compaction: /compact is yours, and an overflow can't wait.
    if (event?.reason !== "threshold") return;
    const s = eff(ctx).settings;
    if (!automatic(ctx, s) || !s.on_compact) return;
    if (state.phase === "idle") return (await trigger(ctx, "compact")) ? { cancel: true } : undefined;
    if (state.phase === "asked" || state.phase === "ready") return { cancel: true };
  });
  pi.on("session_compact", async (_e, ctx) => {
    if (state.phase === "gaveup" || state.phase === "nolauncher") {
      save(fresh());
      status(ctx);
    }
  });

  const branch = (dir: string) => {
    try {
      return execFileSync("git", ["branch", "--show-current"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const promptFor = (ctx: ExtensionContext, p: { instructions: string; summary?: string; files?: string[]; include_tasks?: boolean }) =>
    buildPrompt({
      instructions: p.instructions,
      summary: p.summary,
      files: p.files,
      tasks: p.include_tasks === false ? [] : tasks,
      cwd: ctx.cwd,
      branch: branch(ctx.cwd),
      previousSession: ctx.sessionManager.getSessionFile?.(),
      reason: state.reason,
    });

  pi.registerTool({
    name: "handoff_ready",
    label: "Handoff Ready",
    description:
      "Hand this work off to a fresh session: give instructions for it (the goal, what's done, what's next, decisions and why, pitfalls, the files that matter). The new session starts with them in this folder, on this model, when this turn ends.",
    promptSnippet: "Hand off to a fresh session with instructions",
    promptGuidelines: [
      "Call handoff_ready when piext-handoff asks you to (or the user wants a fresh session), once you're at a stopping point.",
      "Write the instructions for someone who hasn't seen this conversation. Stop working after calling it.",
    ],
    parameters: Type.Object({
      instructions: Type.String({ description: "What the next session needs to know and do" }),
      summary: Type.Optional(Type.String({ description: "What happened in this session, briefly" })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Files the next session should look at" })),
      include_tasks: Type.Optional(Type.Boolean({ description: "Include the open tasks (piext-tasks); default true" })),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx) {
      if (state.phase === "done" || launching) return { content: [{ type: "text", text: "This session has already handed off. Stop here." }], details: {}, terminate: true };
      const instructions = String(p.instructions ?? "").trim();
      if (!instructions) return { content: [{ type: "text", text: "handoff_ready needs instructions." }], details: {}, isError: true };
      if (instructions.length > MAX_INSTRUCTIONS) return { content: [{ type: "text", text: `Instructions are ${instructions.length} characters; keep them under ${MAX_INSTRUCTIONS} and point to files for the rest.` }], details: {}, isError: true };
      const again = state.phase === "ready";
      const prompt = promptFor(ctx, { ...p, instructions });
      // Called again before the launch: the newer instructions win.
      save({ phase: "ready", prompt });
      status(ctx);
      pi.events.emit("handoff:ready", { cwd, prompt });
      const s = eff(ctx).settings;
      return {
        content: [{ type: "text", text: `Handoff ${again ? "instructions updated" : "ready"}. The next session starts when this turn ends${s.mode === "ask" ? ", once the user has reviewed the instructions" : ""}. Stop here.` }],
        details: { prompt },
        terminate: true,
      };
    },
  });

  /** closeOld: what happens to this session once the next one runs. */
  const closeOld = async (ctx: ExtensionContext, l: Launcher, launchVars: NodeJS.ProcessEnv) => {
    const how = eff(ctx).settings.close_old;
    if (how === "no") return;
    if (how === "ask" && !(ctx.hasUI && (await ctx.ui.confirm("Close this session?", `The next session is running (${l.name}).`)))) return;
    const r = await exec(l.path, ["close"], launchVars);
    if (r.code === 0) return;
    // It can't (or didn't) close the tab or pane: this pi can still quit.
    if (r.code !== CLOSE_UNSUPPORTED) ctx.ui.notify(`piext-handoff: ${l.name} close failed${r.stderr ? `: ${r.stderr}` : ""}; quitting pi instead.`, "warning");
    ctx.shutdown();
  };

  /** launch starts the next session with the prompt; once per session. */
  const launch = async (ctx: ExtensionContext) => {
    if (launching || state.phase === "done" || !state.prompt) return;
    launching = true;
    try {
      const s = eff(ctx).settings;
      const p = await choose(ctx);
      if ("problem" in p) return ctx.ui.notify(`piext-handoff: can't start the next session: ${p.problem}. /handoff go once that's fixed.`, "error");
      let prompt = state.prompt;
      if (s.mode === "ask") {
        const edited = await ctx.ui.editor("The next session's first message (empty to cancel)", prompt);
        if (!edited?.trim()) {
          status(ctx);
          return ctx.ui.notify("Handoff held; /handoff go when you're ready, /handoff cancel to drop it.", "info");
        }
        prompt = edited;
      }
      const model = modelOf(ctx);
      const vars = launchEnv(
        {
          cwd: ctx.cwd,
          promptFile: writePrompt(prompt, ctx.sessionManager.getSessionId?.() ?? "session", new Date(), opts.promptDir),
          model: model ? modelName(model) : "",
          thinking: String(pi.getThinkingLevel() ?? ""),
          oldSession: ctx.sessionManager.getSessionId?.(),
          oldSessionFile: ctx.sessionManager.getSessionFile?.(),
        },
        env,
      );
      pi.events.emit("handoff:launched", { cwd, launcher: p.launcher.name, model: vars.HANDOFF_MODEL || undefined });
      const r = await exec(p.launcher.path, ["start"], vars);
      if (r.code !== 0) return ctx.ui.notify(`piext-handoff: ${p.launcher.name} didn't start the next session${r.stderr ? `: ${r.stderr}` : ` (exit ${r.code})`}. /handoff go to try again.`, "error");
      save({ phase: "done", prompt });
      status(ctx);
      ctx.ui.notify(`Handed off with ${p.launcher.name}${r.stdout ? `: ${r.stdout}` : "."}`, "info");
      await closeOld(ctx, p.launcher, vars);
    } finally {
      launching = false;
    }
  };

  const go = async (ctx: ExtensionCommandContext) => {
    await ctx.waitForIdle();
    if (state.phase === "done") return ctx.ui.notify("This session has already handed off (/handoff cancel, then /handoff go, to do it again).", "warning");
    if (!state.prompt) {
      const instructions = await ctx.ui.editor("Instructions for the next session (empty to cancel)", "");
      if (!instructions?.trim()) return ctx.ui.notify("Handoff cancelled.", "info");
      if (!state.reason) state.reason = reasonText("manual");
      save({ phase: "ready", prompt: promptFor(ctx, { instructions }) });
    }
    await launch(ctx);
  };

  const describe = async (ctx: ExtensionContext): Promise<string> => {
    const e = eff(ctx);
    const p = await choose(ctx);
    const s = e.settings;
    const u = ctx.getContextUsage();
    const m = modelOf(ctx);
    const src = (k: keyof Settings) => {
      const x = e.sources[k];
      return x.scope === "default" ? "default" : `${x.scope}${x.table ? ` [${x.table}]` : ""}`;
    };
    const lines = [
      `Handoff: ${s.enabled ? "automatic" : "manual only (/handoff now)"}${m ? ` · model ${modelName(m)}${e.model ? ` → [handoff.models.${e.model}]` : ""}` : ""}`,
      ...KEYS.map((k) => `  ${k.padEnd(12)} ${JSON.stringify(s[k]).padEnd(10)} ${src(k)}`),
      `  context      ${u?.percent != null ? `${Math.round(u.percent)}%` : "?"}${s.threshold > 0 ? ` of ${Math.round(s.threshold * 100)}%` : ""}`,
      `  prompts      ${userTurns(ctx)}${s.turns > 0 ? ` of ${s.turns}` : ""}`,
      `  launches     ${"launcher" in p ? `${p.launcher.name} (${p.launcher.path})` : `nothing: ${p.problem}`}`,
      `  state        ${state.phase}${state.reason ? ` (${state.reason})` : ""}`,
      ...e.errors.map((x) => `  ! ${x}`),
    ];
    return lines.join("\n");
  };

  const saveTo = (ctx: ExtensionContext, scope: "local" | "global") => {
    const m = modelOf(ctx);
    if (!m) return ctx.ui.notify("No model selected; nothing to save for.", "warning");
    const over = sessionOverrides(entries(ctx)) ?? {};
    const { models, ...general } = over;
    // Nothing set for this session: save what's in effect.
    const values: Record<string, unknown> = Object.keys(general).length ? general : { ...eff(ctx).settings };
    const key = saveKey(m);
    const path = setConfig(NS, scope, { models: { ...(models ?? {}), [key]: { name: modelName(m), ...values } } }, { cwd: ctx.cwd, home: opts.home });
    clearSession(pi, NS);
    let opened = "";
    try {
      opened = openInEditor(path, start, env);
    } catch {
      // the notice still says where it is
    }
    ctx.ui.notify(`Saved to [handoff.models.${key}] in ${path}${opened ? ` (opened with ${opened})` : ""}. Widen its name to cover more models.`, "info");
  };

  pi.registerCommand("handoff", {
    description: "Hand off to a fresh session: now [note] | go | on | off | set <key> <value> | save local|global | cancel",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/);
      const say = (m: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(m, level);
      switch (sub) {
        case "":
          return say(await describe(ctx));
        case "now":
          if (state.phase === "asked" || state.phase === "ready") return say("A handoff is already under way (/handoff cancel to drop it).", "warning");
          {
            const p = await choose(ctx);
            if ("problem" in p) return say(`Can't hand off: ${p.problem}.`, "warning");
          }
          ask(ctx, reasonText("manual"), rest.join(" ") || undefined);
          return say("Asked the agent to get ready to hand off.");
        case "go":
          return go(ctx);
        case "cancel":
          save(fresh());
          status(ctx);
          return say("Handoff cancelled.");
        case "on":
        case "off":
          setSession(pi, NS, entries(ctx), { enabled: sub === "on" });
          return say(`Automatic handoff ${sub} for this session.`);
        case "set": {
          const [k, ...v] = rest;
          if (!(KEYS as readonly string[]).includes(k)) return say(`Keys: ${KEYS.join(", ")}`, "warning");
          // launcher takes several: /handoff set launcher zellij tmux
          const value = !v.length ? null : k === "launcher" ? v : parseValue(v.join(" "));
          setSession(pi, NS, entries(ctx), { [k]: value });
          const e = eff(ctx);
          return say(`${k} = ${JSON.stringify(e.settings[k as keyof Settings])} for this session.${e.errors.length ? "\n" + e.errors.join("\n") : ""}`);
        }
        case "save":
          if (rest[0] !== "local" && rest[0] !== "global") return say("/handoff save local|global", "warning");
          return saveTo(ctx, rest[0]);
        default:
          return say("/handoff [now [note] | go | cancel | on | off | set <key> <value> | save local|global]", "warning");
      }
    },
  });
}
