// piext-handoff: before a session runs out of room, the agent writes
// instructions for a fresh one, and the fresh one starts with them: in this
// pi (a new session, same folder and model), in a new Loop tab, or as a
// prompt file. When is up to the [handoff] settings (piext-config), per
// model if you like; /handoff works any time.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";
import { clearSession, set as setConfig, setSession } from "./vendor/piext-config/index.ts";
import { KEYS, modelName, NS, parseValue, resolve, saveKey, sessionOverrides, type Effective, type ModelRef, type Settings } from "./src/settings.ts";
import { buildPrompt, MAX_INSTRUCTIONS, prepareText, reasonText, remindText, type Reason, type Task } from "./src/prompt.ts";
import { loopTab, openInEditor, promptFile, run as defaultRun, spawnDetached, type Run, type Spawn } from "./src/launch.ts";

export const NAME = "piext-handoff";
export const VERSION = "0.1.0";
const STATE = "piext-handoff";
// The replacement session's instance sets the model from this (it's the
// same process; a new extension instance, maybe a new module).
const MAIL = Symbol.for("piext-handoff:mail");
type Mail = { model?: ModelRef; thinking?: string };

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: Run;
  spawn?: Spawn;
}

type Phase = "idle" | "asked" | "ready" | "gaveup" | "done";
interface State {
  phase: Phase;
  reason?: string;
  /** Agent runs since we asked. */
  runs: number;
  reminded: boolean;
  /** The next session's first message, once the agent (or you) wrote it. */
  prompt?: string;
  /** This session began with a handoff prompt. */
  fromHandoff?: boolean;
}

const fresh = (): State => ({ phase: "idle", runs: 0, reminded: false });

export default function (pi: ExtensionAPI, opts: Options = {}) {
  const env = opts.env ?? process.env;
  const exec = opts.run ?? defaultRun;
  const start = opts.spawn ?? spawnDetached;
  let state = fresh();
  let tasks: Task[] = [];
  let cwd = "";

  const entries = (ctx: ExtensionContext) => ctx.sessionManager.getBranch() as unknown[];
  const modelOf = (ctx: ExtensionContext): ModelRef | undefined => (ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
  const eff = (ctx: ExtensionContext): Effective => resolve({ cwd: ctx.cwd, home: opts.home, entries: entries(ctx), model: modelOf(ctx) });
  const save = (next: Partial<State>) => {
    state = { ...state, ...next };
    pi.appendEntry(STATE, state);
    pi.events.emit("handoff:changed", { cwd, state: { ...state } });
  };
  const status = (ctx: ExtensionContext) => {
    const text = { idle: undefined, asked: "handoff: waiting for the agent", ready: "handoff: ready", gaveup: undefined, done: "handoff: done" }[state.phase];
    try {
      ctx.ui.setStatus("handoff", text);
    } catch {
      // no UI
    }
  };
  const userTurns = (ctx: ExtensionContext) => entries(ctx).filter((e: any) => e?.type === "message" && e.message?.role === "user").length;
  // A session that began with a handoff waits for a prompt of yours before
  // handing off by itself: its first prompt alone may be past the threshold,
  // and it would hand off again and again.
  const automatic = (ctx: ExtensionContext, s: Settings) => s.enabled && !(state.fromHandoff && userTurns(ctx) < 2);

  /** ask tells the agent to get ready. */
  const ask = (ctx: ExtensionContext, why: Reason, detail = "", note?: string) => {
    const reason = reasonText(why, detail);
    save({ phase: "asked", reason, runs: 0, reminded: false, prompt: undefined });
    status(ctx);
    pi.events.emit("handoff:requested", { cwd, reason });
    pi.sendMessage({ customType: STATE, content: prepareText(reason, note), display: true }, { deliverAs: "followUp", triggerTurn: true });
  };

  pi.on("session_start", async (event: any, ctx) => {
    cwd = ctx.cwd;
    state = fresh();
    for (const e of entries(ctx) as any[]) if (e?.type === "custom" && e.customType === STATE && e.data) state = { ...fresh(), ...e.data };
    // A replacement session from a handoff: the same model as before.
    const mail = (globalThis as any)[MAIL] as Mail | undefined;
    if (mail && event?.reason === "new") {
      delete (globalThis as any)[MAIL];
      const want = mail.model && ctx.modelRegistry.find(mail.model.provider, mail.model.id);
      if (want && (ctx.model?.provider !== want.provider || ctx.model?.id !== want.id)) await pi.setModel(want);
      if (mail.thinking) pi.setThinkingLevel(mail.thinking as any);
      save({ ...fresh(), fromHandoff: true });
    }
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
    if (automatic(ctx, s) && s.threshold > 0 && u?.percent != null && u.percent / 100 >= s.threshold) ask(ctx, "threshold", `${Math.round(u.percent)}%`);
  });

  pi.on("agent_end", async (_e, ctx) => {
    const s = eff(ctx).settings;
    if (state.phase === "idle") {
      const n = userTurns(ctx);
      if (automatic(ctx, s) && s.turns > 0 && n >= s.turns) ask(ctx, "turns", String(n));
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

  pi.on("session_before_compact", async (event: any, ctx) => {
    // Only pi's own compaction: /compact is yours, and an overflow can't wait.
    if (event?.reason !== "threshold") return;
    const s = eff(ctx).settings;
    if (!automatic(ctx, s) || !s.on_compact || state.phase === "gaveup" || state.phase === "done") return;
    if (state.phase === "idle") ask(ctx, "compact");
    return { cancel: true };
  });
  pi.on("session_compact", async (_e, ctx) => {
    if (state.phase === "gaveup") {
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
      const instructions = String(p.instructions ?? "").trim();
      if (!instructions) return { content: [{ type: "text", text: "handoff_ready needs instructions." }], details: {}, isError: true };
      if (instructions.length > MAX_INSTRUCTIONS) return { content: [{ type: "text", text: `Instructions are ${instructions.length} characters; keep them under ${MAX_INSTRUCTIONS} and point to files for the rest.` }], details: {}, isError: true };
      const prompt = promptFor(ctx, { ...p, instructions });
      save({ phase: "ready", prompt });
      status(ctx);
      pi.events.emit("handoff:ready", { cwd, prompt });
      pi.sendUserMessage("/handoff go", { deliverAs: "followUp", expandPromptTemplates: true });
      const s = eff(ctx).settings;
      return {
        content: [{ type: "text", text: `Handoff ready. The next session starts when this turn ends${s.mode === "ask" ? ", once the user has reviewed the instructions" : ""}. Stop here.` }],
        details: { prompt },
      };
    },
  });

  const go = async (ctx: ExtensionCommandContext) => {
    await ctx.waitForIdle();
    const e = eff(ctx);
    const s = e.settings;
    let prompt = state.prompt;
    if (!prompt) {
      const instructions = await ctx.ui.editor("Instructions for the next session (empty to cancel)", "");
      if (!instructions?.trim()) return ctx.ui.notify("Handoff cancelled.", "info");
      if (!state.reason) state.reason = reasonText("manual");
      prompt = promptFor(ctx, { instructions });
    }
    if (s.mode === "ask") {
      const edited = await ctx.ui.editor("The next session's first message (empty to cancel)", prompt);
      if (!edited?.trim()) {
        save({ phase: state.phase === "ready" ? "asked" : state.phase });
        status(ctx);
        return ctx.ui.notify("Handoff cancelled; /handoff go when you're ready.", "info");
      }
      prompt = edited;
    }
    const model = modelOf(ctx);
    let launcher = s.launcher;
    if (launcher === "loop-tab" && !env.LOOP_SESSION_ID) {
      ctx.ui.notify("piext-handoff: not in a Loop session; writing the prompt to a file instead.", "warning");
      launcher = "file";
    }
    pi.events.emit("handoff:launched", { cwd, launcher, model: model && modelName(model) });
    if (launcher === "file") {
      const path = promptFile(ctx.cwd, prompt);
      save({ phase: "done", prompt });
      status(ctx);
      return ctx.ui.notify(`Handoff written to ${path}\nStart it with: pi${model ? ` --model ${modelName(model)}` : ""} @${path}`, "info");
    }
    if (launcher === "loop-tab") {
      try {
        const id = await loopTab({ cwd: ctx.cwd, model: model ? modelName(model) : "", prompt, closeId: s.close_old ? env.LOOP_SESSION_ID : undefined }, exec);
        save({ phase: "done", prompt });
        status(ctx);
        return ctx.ui.notify(`Handed off to Loop session ${id}.`, "info");
      } catch (err) {
        return ctx.ui.notify(`piext-handoff: Loop didn't open the new session: ${(err as Error).message}. /handoff go to try again.`, "error");
      }
    }
    save({ phase: "done", prompt });
    (globalThis as any)[MAIL] = { model, thinking: pi.getThinkingLevel() } satisfies Mail;
    const parentSession = ctx.sessionManager.getSessionFile?.();
    const first = prompt;
    const r = await ctx.newSession({
      parentSession,
      withSession: async (next) => {
        await next.sendUserMessage(first);
      },
    });
    if (r.cancelled) {
      delete (globalThis as any)[MAIL];
      ctx.ui.notify("piext-handoff: another extension cancelled the new session.", "warning");
    }
  };

  const describe = (ctx: ExtensionContext): string => {
    const e = eff(ctx);
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
          return say(describe(ctx));
        case "now":
          if (state.phase === "asked" || state.phase === "ready") return say("A handoff is already under way (/handoff cancel to drop it).", "warning");
          ask(ctx, "manual", "", rest.join(" ") || undefined);
          return say("Asked the agent to get ready to hand off.");
        case "go":
          return go(ctx);
        case "cancel":
          save({ ...fresh(), fromHandoff: state.fromHandoff });
          status(ctx);
          return say("Handoff cancelled.");
        case "on":
        case "off":
          setSession(pi, NS, entries(ctx), { enabled: sub === "on" });
          return say(`Automatic handoff ${sub} for this session.`);
        case "set": {
          const [k, ...v] = rest;
          if (!(KEYS as readonly string[]).includes(k)) return say(`Keys: ${KEYS.join(", ")}`, "warning");
          setSession(pi, NS, entries(ctx), { [k]: v.length ? parseValue(v.join(" ")) : null });
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
