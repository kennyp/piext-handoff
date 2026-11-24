// Starting the next session: a new Loop tab (AppleScript), a prompt file
// for a plain terminal, or (in index.ts) pi's own newSession.
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Run = (cmd: string, args: string[]) => Promise<string>;

export const run: Run = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 150_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim()))),
  );

// Arguments go in through argv, so nothing needs quoting for AppleScript.
export const LOOP_TAB_SCRIPT = `on run argv
  set dir to item 1 of argv
  set modelCmd to item 2 of argv
  set prompt to item 3 of argv
  set oldId to item 4 of argv
  tell application id "com.github.kennyp.loop"
    set s to open folder dir with new session
    if modelCmd is not "" then send message modelCmd to s
    send message prompt to s
    if oldId is not "" then close session (oldId as integer)
  end tell
  return s
end run`;

export interface LoopTab {
  cwd: string;
  /** "provider/id" for /model; "" to leave it. */
  model: string;
  prompt: string;
  /** This Loop session's id, to close it. */
  closeId?: string;
}

/** loopTab opens a new Loop session in cwd and returns its id. */
export async function loopTab(t: LoopTab, exec: Run = run): Promise<string> {
  return exec("osascript", ["-e", LOOP_TAB_SCRIPT, t.cwd, t.model ? `/model ${t.model}` : "", t.prompt, t.closeId ?? ""]);
}

/** promptFile writes the prompt to .pi/handoff-<time>.md and returns its path. */
export function promptFile(cwd: string, prompt: string, now = new Date()): string {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `handoff-${now.toISOString().replace(/[:.]/g, "-")}.md`);
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
