# Review: Headless Overnight Workflow

## Verdict

Approve for repository-local use in an isolated worktree. It does not authorize production deployment.

## Five-axis review

- Correctness: unit tests cover routing, recovery, dependency scheduling, timeouts, Git invariants, and terminal states. A fake-Codex integration test proves planning, editing, fixed gates, checkpoint commit, and final review end to end.
- Readability: orchestration is separated from configuration, state, process, Git, prompt, and report helpers. The runner remains the largest file because it owns the explicit lifecycle.
- Architecture: model output is structured data. It selects only a verification profile; checked-in configuration owns executable commands.
- Security: workspace-write is the only accepted sandbox; user config is ignored; approval policy is explicit; paths are confined to the repository and canonicalized; model-created commits/branch changes fail closed; logs/state use owner-only permissions; time and call budgets are bounded.
- Performance: one writer avoids conflicts. Quick task profiles run before the more expensive every-three-task checkpoint and final gates.

## Known boundaries

- A sleeping or powered-off computer stops local execution.
- Failed model edits remain uncommitted in the isolated worktree so a later attempt can repair them.
- A rejected final review reports blockers instead of entering an unbounded repair loop.
- The existing frontend build emits third-party `lottie-web` eval and bundle-size warnings; this workflow neither introduces nor suppresses them.
