// What the agent is told, and what the next session starts with.

export type Reason = "threshold" | "turns" | "compact" | "manual";

export function reasonText(r: Reason, detail = ""): string {
  switch (r) {
    case "threshold":
      return `the context window is ${detail} full`;
    case "turns":
      return `the session has reached ${detail} prompts`;
    case "compact":
      return "pi was about to compact the conversation";
    case "manual":
      return "the user asked for it";
  }
}

/** prepareText asks the agent to get ready. */
export function prepareText(reason: string, note?: string): string {
  return [
    `[piext-handoff] This session will hand off to a fresh one: ${reason}.`,
    "Finish or park the step you're on (don't start anything new), then call handoff_ready with instructions for the next session:",
    "the goal, what's done, what's next, decisions made and why, and anything to watch out for.",
    "Write them for someone who hasn't seen this conversation; list the files that matter.",
    ...(note ? [`The user adds: ${note}`] : []),
  ].join(" ");
}

export const remindText = () =>
  "[piext-handoff] Reminder: when you're at a stopping point, call handoff_ready with instructions for the next session. If you can't hand off yet, say why.";

export interface Task {
  id: number;
  subject: string;
  status: string;
}

export interface PromptParts {
  instructions: string;
  summary?: string;
  files?: string[];
  tasks?: Task[];
  cwd: string;
  branch?: string;
  previousSession?: string;
  reason?: string;
}

/** buildPrompt is the new session's first message. */
export function buildPrompt(p: PromptParts): string {
  const out = ["# Handoff from a previous session", ""];
  out.push(`You're picking up work a previous pi session started in this folder${p.reason ? `; it handed off because ${p.reason}` : ""}.`, "");
  out.push("## Instructions", "", p.instructions.trim(), "");
  if (p.summary?.trim()) out.push("## Summary", "", p.summary.trim(), "");
  if (p.files?.length) out.push("## Files", "", ...p.files.map((f) => `- ${f}`), "");
  const open = (p.tasks ?? []).filter((t) => t.status !== "completed");
  if (open.length) out.push("## Open tasks", "", ...open.map((t) => `- #${t.id} [${t.status}] ${t.subject}`), "");
  out.push("## Context", "", `- Folder: ${p.cwd}`);
  if (p.branch) out.push(`- Branch: ${p.branch}`);
  if (p.previousSession) out.push(`- Previous session: ${p.previousSession} (read it only if the instructions leave something out)`);
  return out.join("\n") + "\n";
}

/** The most a prompt may be; the rest belongs in files. */
export const MAX_INSTRUCTIONS = 24_000;
