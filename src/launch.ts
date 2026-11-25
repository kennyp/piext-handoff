// Starting the next session through a launcher: a small executable that
// answers `active` (usable from this session?), `start` (open the new
// session) and `close` (close this one). The built-ins are in launchers/;
// yours go in ~/.config/piext/handoff/launchers/ ($XDG_CONFIG_HOME), or anywhere by path.
import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, dirs } from "../vendor/piext-config/index.ts";

export const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "launchers");
/** Never picked on their own: they don't open a session. */
export const EXPLICIT_ONLY = new Set(["file"]);
/** close: exit status for "this launcher can't close the old session". */
export const CLOSE_UNSUPPORTED = 3;

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
export type Run = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<Result>;

export const run: Run = (cmd, args, env) =>
  new Promise((resolve) =>
    execFile(cmd, args, { env, timeout: 150_000 }, (err: any, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: String(stdout).trim(), stderr: String(stderr || (err && typeof err.code !== "number" ? err.message : "")).trim() }),
    ),
  );

export interface Launcher {
  /** As written in the config, or the file's name for one found. */
  name: string;
  path: string;
}

export const userDir = (home = homedir()) => join(configDir({ home }), "handoff", "launchers");

const executable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * locate finds a launcher: "/abs" and "~/x" as they are, "./x" and "../x"
 * from base (the folder of the config that named it), and a bare name in
 * your launchers folder, then the built-ins (with or without ".sh").
 */
export function locate(spec: string, base: string, home = homedir()): Launcher | undefined {
  const name = spec;
  if (spec.startsWith("~/")) spec = join(home, spec.slice(2));
  if (isAbsolute(spec) || spec.startsWith("./") || spec.startsWith("../")) {
    const path = resolvePath(base, spec);
    return executable(path) ? { name, path } : undefined;
  }
  for (const dir of [userDir(home), BUILTIN_DIR])
    for (const file of [spec, `${spec}.sh`]) {
      const path = join(dir, file);
      if (executable(path)) return { name, path };
    }
  return undefined;
}

/** known: every launcher by name, yours over the built-ins. */
export function known(home = homedir()): Launcher[] {
  const byName = new Map<string, Launcher>();
  for (const dir of [BUILTIN_DIR, userDir(home)]) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files.sort()) {
      const path = join(dir, f);
      if (!f.startsWith(".") && executable(path)) byName.set(f.replace(/\.sh$/, ""), { name: f.replace(/\.sh$/, ""), path });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export type Pick = { launcher: Launcher } | { problem: string };

/**
 * pick chooses the launcher. Configured ones are tried in order: the first
 * that's active. Without any, every known one is asked, and exactly one
 * must be active: more than one (tmux in a Loop tab, say) is for you to
 * settle in the config.
 */
export async function pick(o: { specs: string[]; base: (spec: string) => string; env: NodeJS.ProcessEnv; home?: string; run?: Run }): Promise<Pick> {
  const exec = o.run ?? run;
  const active = async (l: Launcher) => (await exec(l.path, ["active"], o.env)).code === 0;
  if (o.specs.length) {
    const missing: string[] = [];
    for (const spec of o.specs) {
      const l = locate(spec, o.base(spec), o.home);
      if (!l) missing.push(spec);
      else if (await active(l)) return { launcher: l };
    }
    const tried = o.specs.map((s) => JSON.stringify(s)).join(", ");
    return { problem: `none of the launchers set (${tried}) can start a session from here${missing.length ? `; not found or not executable: ${missing.join(", ")}` : ""}` };
  }
  const found: Launcher[] = [];
  for (const l of known(o.home)) if (!EXPLICIT_ONLY.has(l.name) && (await active(l))) found.push(l);
  if (found.length === 1) return { launcher: found[0] };
  if (found.length > 1) return { problem: `more than one launcher fits this session (${found.map((l) => l.name).join(", ")}); set handoff.launcher to say which, in order` };
  return { problem: "no launcher fits this session; set handoff.launcher to a script that starts one" };
}

export interface Handoff {
  cwd: string;
  promptFile: string;
  /** "provider/id"; "" when there's no model. */
  model: string;
  thinking: string;
  oldSession?: string;
  oldSessionFile?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** piCommand: the shell command that starts pi for the handoff. */
export const piCommand = (h: Handoff) => ["pi", ...(h.model ? ["--model", q(h.model)] : []), ...(h.thinking ? ["--thinking", q(h.thinking)] : []), q(`@${h.promptFile}`)].join(" ");

/** launchEnv: what a launcher gets, on top of pi's own environment. */
export function launchEnv(h: Handoff, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    HANDOFF_CWD: h.cwd,
    HANDOFF_PROMPT_FILE: h.promptFile,
    HANDOFF_MODEL: h.model,
    HANDOFF_THINKING: h.thinking,
    HANDOFF_PI_CMD: piCommand(h),
    HANDOFF_OLD_SESSION: h.oldSession ?? "",
    HANDOFF_OLD_SESSION_FILE: h.oldSessionFile ?? "",
  };
}

/**
 * writePrompt writes the prompt where launchers can read it, and returns the
 * path: by default in the old session's own folder (piext-config's session
 * dir), else the temp folder.
 */
export function writePrompt(prompt: string, id = "session", now = new Date(), dir?: string, home = homedir()): string {
  dir ??= /^[a-z0-9][a-z0-9._-]*$/.test(id) && id !== "session" ? dirs("handoff", { home, sessionId: id }).session! : join(tmpdir(), "piext-handoff");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${now.toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(path, prompt);
  return path;
}

// Terminal editors can't open while pi has the terminal.
const TERMINAL = /^(vi|vim|nvim|nano|pico|emacs|hx|helix|micro|kak|joe|ne|mg)$/;

/**
 * editorCommand: how to open a file outside pi: $VISUAL or $EDITOR when
 * it's a windowed editor, else the system's default for text.
 */
export function editorCommand(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  for (const v of [env.VISUAL, env.EDITOR]) {
    const parts = v?.trim().split(/\s+/);
    if (parts?.length && !TERMINAL.test(parts[0].split("/").pop()!)) return parts;
  }
  return platform === "darwin" ? ["open", "-t"] : ["xdg-open"];
}

export type Spawn = (cmd: string, args: string[]) => void;

// Detached: an editor that waits (code -w) mustn't hold pi up.
export const spawnDetached: Spawn = (cmd, args) => {
  const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
  p.on("error", () => {});
  p.unref();
};

export function openInEditor(path: string, start: Spawn = spawnDetached, env: NodeJS.ProcessEnv = process.env): string {
  const [cmd, ...args] = editorCommand(env);
  start(cmd, [...args, path]);
  return [cmd, ...args].join(" ");
}
