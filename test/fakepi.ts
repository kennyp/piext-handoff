// A stand-in for pi's ExtensionAPI: enough to drive piext-handoff's events,
// tool and command, and see what it sends.
import { EventEmitter } from "node:events";

export function fakePi(cwd: string) {
  const handlers = new Map<string, ((ev: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const bus = new EventEmitter();
  const seen: { channel: string; data: any }[] = [];
  const notes: { msg: string; level: string }[] = [];
  const sent: { message: any; options: any }[] = [];
  const userMessages: { text: string; options: any }[] = [];
  const statuses: Record<string, string | undefined> = {};
  const branch: any[] = [];
  const editorAnswers: (string | undefined)[] = [];
  const editorPrompts: { title: string; prefill?: string }[] = [];
  const newSessions: any[] = [];
  const state = {
    model: { provider: "bifrost", id: "anthropic/claude-opus-5-5" } as any,
    thinking: "high",
    usage: { tokens: 1000, contextWindow: 10000, percent: 10 } as any,
    sessionFile: "/sessions/old.jsonl",
    setModelCalls: [] as any[],
    /** The model a new session starts on (pi's default), if not this one. */
    newSessionModel: undefined as any,
  };
  const events = {
    emit: (channel: string, data: unknown) => {
      seen.push({ channel, data });
      bus.emit(channel, data);
    },
    on: (channel: string, h: (data: unknown) => void) => {
      bus.on(channel, h);
      return () => bus.off(channel, h);
    },
  };
  const ctx = (): any => ({
    cwd,
    hasUI: true,
    get model() {
      return state.model;
    },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    getContextUsage: () => state.usage,
    sessionManager: { getBranch: () => branch, getSessionFile: () => state.sessionFile },
    ui: {
      notify: (msg: string, level = "info") => notes.push({ msg, level }),
      setStatus: (k: string, v: string | undefined) => (statuses[k] = v),
      editor: async (title: string, prefill?: string) => {
        editorPrompts.push({ title, prefill });
        return editorAnswers.shift();
      },
    },
    waitForIdle: async () => {},
    newSession: async (o: any) => {
      newSessions.push(o);
      if (state.newSessionModel) state.model = state.newSessionModel;
      branch.length = 0;
      state.thinking = "off";
      await fire("session_start", { reason: "new" });
      const next = { sendUserMessage: async (t: string) => userMessages.push({ text: t, options: { replacement: true } }) };
      await o.withSession?.(next);
      return { cancelled: false };
    },
  });
  const fire = async (name: string, ev: unknown = {}) => {
    let out: unknown;
    for (const h of handlers.get(name) ?? []) out = (await h(ev, ctx())) ?? out;
    return out;
  };
  const pi = {
    events,
    on: (name: string, h: (ev: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: (name: string, c: any) => commands.set(name, c),
    appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
    sendMessage: (message: any, options: any) => sent.push({ message, options }),
    sendUserMessage: (text: string, options: any) => userMessages.push({ text, options }),
    setModel: async (m: any) => {
      state.setModelCalls.push(m);
      state.model = m;
      return true;
    },
    getThinkingLevel: () => state.thinking,
    setThinkingLevel: (l: string) => (state.thinking = l),
  };
  return {
    pi: pi as any,
    state,
    seen,
    notes,
    sent,
    userMessages,
    statuses,
    branch,
    editorAnswers,
    editorPrompts,
    newSessions,
    fire,
    of: (channel: string) => seen.filter((e) => e.channel === channel).map((e) => e.data),
    prompt: (text: string) => branch.push({ type: "message", message: { role: "user", content: text } }),
    tool: (name: string, params: any) => tools.get(name).execute("call-1", params, undefined, undefined, ctx()),
    command: (name: string, args: string) => commands.get(name).handler(args, ctx()),
  };
}
