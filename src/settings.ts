// piext-handoff's settings: the [handoff] table of the shared piext
// settings (piext-config), with [handoff.models.<x>] tables for particular
// models. General keys from every level apply first, then the one model
// table that fits the current model best, from every level.
import { load, sessionTable, specificity, type Loaded, type Scope } from "../vendor/piext-config/index.ts";

export const NS = "handoff";

export type Mode = "auto" | "ask";
export type Launcher = "replace" | "loop-tab" | "file";
export const MODES: Mode[] = ["auto", "ask"];
export const LAUNCHERS: Launcher[] = ["replace", "loop-tab", "file"];

/** The keys a general or model table can set. */
export interface Settings {
  /** false: only /handoff starts one. */
  enabled: boolean;
  /** Share of the context window (0–1) that triggers it; 0: off. */
  threshold: number;
  /** Prompts in the session that trigger it; 0: off. */
  turns: number;
  /** Cancel pi's automatic compaction and hand off instead. */
  on_compact: boolean;
  /** auto: go when the agent's ready; ask: show you the prompt first. */
  mode: Mode;
  /** replace: a new session in this pi; loop-tab: a new Loop tab; file: write the prompt down. */
  launcher: Launcher;
  /** loop-tab: close this Loop session after the new one starts. */
  close_old: boolean;
  /** Prompts to wait for handoff_ready before reminding the agent (once). */
  remind_after: number;
}

export const KEYS = ["enabled", "threshold", "turns", "on_compact", "mode", "launcher", "close_old", "remind_after"] as const satisfies readonly (keyof Settings)[];

export const defaults = (): Settings => ({
  enabled: false,
  threshold: 0.75,
  turns: 0,
  on_compact: true,
  mode: "auto",
  launcher: "replace",
  close_old: false,
  remind_after: 3,
});

export type ModelTable = Partial<Settings> & { name?: string | string[] };
export interface Raw extends Partial<Settings> {
  models?: Record<string, ModelTable>;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export const modelName = (m: ModelRef) => `${m.provider}/${m.id}`;

/**
 * modelMatch: how well pattern fits the model, or -1. Patterns match
 * "provider/id" or just "id", regardless of case; * and ? match anything
 * (slashes too). A pattern without them matches anywhere in the name.
 */
export function modelMatch(pattern: string, m: ModelRef): number {
  const p = /[*?]/.test(pattern) ? pattern : `*${pattern}*`;
  const re = new RegExp(`^${p.replace(/[.+^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(modelName(m)) || re.test(m.id) ? specificity(pattern) : -1;
}

/** pickModel: the models table that fits m best (ties: the first). */
export function pickModel(models: Record<string, ModelTable> | undefined, m: ModelRef | undefined): string | undefined {
  if (!models || !m) return undefined;
  let best: string | undefined, score = -1;
  for (const [key, t] of Object.entries(models)) {
    const names = t.name === undefined ? [key] : Array.isArray(t.name) ? t.name : [t.name];
    const s = Math.max(...names.map((n) => modelMatch(String(n), m)));
    if (s > score) [best, score] = [key, s];
  }
  return best;
}

export type Source = Scope | "default";

export interface Effective {
  settings: Settings;
  /** The models table in use, if one fits. */
  model?: string;
  /** Where each setting came from: "global", "local", "session" or "default", and the table. */
  sources: Record<keyof Settings, { scope: Source; table?: string }>;
  errors: string[];
  loaded: Loaded<Raw>;
}

function check(s: Settings, where: string, errors: string[]): Settings {
  const d = defaults();
  const fix = <K extends keyof Settings>(k: K, ok: boolean, what: string) => {
    if (!ok) {
      errors.push(`${where}${k} should be ${what}; using ${JSON.stringify(d[k])}`);
      s[k] = d[k];
    }
  };
  fix("enabled", typeof s.enabled === "boolean", "true or false");
  fix("threshold", typeof s.threshold === "number" && s.threshold >= 0 && s.threshold <= 1, "a number from 0 to 1");
  fix("turns", Number.isInteger(s.turns) && s.turns >= 0, "a whole number (0: off)");
  fix("on_compact", typeof s.on_compact === "boolean", "true or false");
  fix("mode", MODES.includes(s.mode), MODES.join(" or "));
  fix("launcher", LAUNCHERS.includes(s.launcher), LAUNCHERS.join(", "));
  fix("close_old", typeof s.close_old === "boolean", "true or false");
  fix("remind_after", Number.isInteger(s.remind_after) && s.remind_after >= 0, "a whole number");
  return s;
}

export interface ResolveOptions {
  cwd: string;
  home?: string;
  entries?: readonly unknown[];
  model?: ModelRef;
}

/** resolve works out the settings in effect for this folder, session and model. */
export function resolve(o: ResolveOptions): Effective {
  const loaded = load<Raw>(NS, { cwd: o.cwd, home: o.home, entries: o.entries, defaults: defaults() as Raw });
  const errors = [...loaded.errors];
  const raw = loaded.value;
  const general = {} as Settings;
  for (const k of KEYS) (general as any)[k] = raw[k];
  check(general, "", errors);
  const sources = {} as Effective["sources"];
  for (const k of KEYS) sources[k] = { scope: loaded.sources[k] ?? "default" };
  const model = pickModel(raw.models, o.model);
  let settings = general;
  if (model) {
    const t = raw.models![model];
    const over = { ...general } as Settings;
    for (const k of KEYS) if (t[k] !== undefined) (over as any)[k] = t[k];
    settings = check(over, `models.${model}.`, errors);
    for (const k of KEYS) if (t[k] !== undefined) sources[k] = { scope: findSource(loaded, model, k), table: `models.${model}` };
  }
  return { settings, model, sources, errors, loaded };
}

// Sources keys are dotted; a model key with dots in it still matches here.
function findSource(l: Loaded<Raw>, model: string, k: string): Source {
  return l.sources[`models.${model}.${k}`] ?? "default";
}

/** The session's own overrides (for /handoff save). */
export const sessionOverrides = (entries: readonly unknown[]): Raw | undefined => sessionTable(NS, entries) as Raw | undefined;

/** saveKey: a [handoff.models.<key>] name for a model: its id's last part. */
export const saveKey = (m: ModelRef) => (m.id.split("/").pop() || m.id).replace(/[^A-Za-z0-9_.-]/g, "-");

/** parseValue reads a /handoff set value: true/false, numbers, else the text. */
export function parseValue(s: string): unknown {
  if (s === "true" || s === "on") return true;
  if (s === "false" || s === "off") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}
