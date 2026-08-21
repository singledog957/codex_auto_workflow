# Review: Headless Overnight Workflow

## Verdict

Approve for repository-local use in an isolated worktree. It does not authorize production deployment.

## Five-axis review

- Correctness: unit tests cover routing, recovery, dependency scheduling, timeouts, Git invariants, and terminal states. A fake-Codex integration test proves planning, editing, fixed gates, checkpoint commit, and final review end to end.
- Readability: orchestration is separated from configuration, state, process, Git, prompt, and report helpers. The runner remains the largest file because it owns the explicit lifecycle.
- Architecture: model output is structured data. It selects only a verification profile; checked-in configuration owns executable commands.
- Security: danger-full-access requires an explicit compatibility acknowledgement for VMs where bwrap cannot execute; user config is ignored; approval policy is explicit; paths controlled by the runner are confined to the repository and canonicalized; model-created commits/branch changes fail closed; logs/state use owner-only permissions; time and call budgets are bounded.
- Performance: one writer avoids conflicts. Quick task profiles run before the more expensive every-three-task checkpoint and final gates.

## Known boundaries

- A sleeping or powered-off computer stops local execution.
- Failed model edits remain uncommitted in the isolated worktree so a later attempt can repair them.
- The first final review freezes material blockers in a stable finding ledger. Later closure reviews verify those findings and the repair diff instead of re-auditing the whole branch; only repair regressions or reproducible new Critical issues may expand the blocking set.
- The existing frontend build emits third-party `lottie-web` eval and bundle-size warnings; this workflow neither introduces nor suppresses them.
