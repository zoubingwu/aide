const DEFAULT_CODEX_EXEC_FLAGS = [
  "--json",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox"
];

export function defaultCodexResumeArgs(): string[] {
  return ["exec", "resume", "--last", ...DEFAULT_CODEX_EXEC_FLAGS];
}

export function defaultCodexFreshArgs(): string[] {
  return ["exec", ...DEFAULT_CODEX_EXEC_FLAGS];
}
