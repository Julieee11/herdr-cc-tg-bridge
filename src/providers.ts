// Provider-specific launch options. Missing kind on an old binding means Claude.
export type AgentKind = "claude" | "codex";

export function agentKind(value: unknown): AgentKind | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

export function reportedKind(a: { agent_kind?: string; kind?: string; agent?: string; agent_session?: { source?: string } }): AgentKind | undefined {
  return agentKind(a.agent_kind) ?? agentKind(a.kind) ?? agentKind(a.agent)
    ?? agentKind(a.agent_session?.source?.replace(/^herdr:/, ""));
}

export function launchArgs(kind: AgentKind, resume: string | undefined, extra: string[], claudePrompt: string): string[] {
  if (kind === "codex") return [...(resume ? ["resume", resume] : []), ...extra];
  return [...(resume ? ["--resume", resume] : []), "--append-system-prompt", claudePrompt, ...extra];
}

export function newSessionSpec(args: string[], fallback: AgentKind = "claude") {
  const explicit = agentKind(args[0]);
  return { kind: explicit ?? fallback, name: (explicit ? args.slice(1) : args).join(" ") };
}
