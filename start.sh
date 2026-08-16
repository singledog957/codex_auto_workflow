#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: ./auto-workflow/start.sh <document> [--foreground]"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 64
fi

source_document=$1
mode=detach
if [[ ${2:-} == "--foreground" ]]; then
  mode=foreground
elif [[ $# -gt 1 ]]; then
  usage
  exit 64
fi

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ $source_document = /* ]]; then
  echo "Use a repository-relative document path, not an absolute path." >&2
  exit 64
fi

if [[ ! -f "$source_document" ]]; then
  echo "Document not found: $source_document" >&2
  exit 66
fi

if [[ -n $(git status --porcelain=v1) ]]; then
  echo "The repository must be clean before creating an automation worktree." >&2
  echo "Commit the auto-workflow setup and any intended source changes first." >&2
  exit 65
fi

codex --version >/dev/null
codex login status >/dev/null
if ! command -v tmux >/dev/null; then
  echo "tmux is required for detached workflow sessions." >&2
  exit 69
fi

for dependency_directory in backend/node_modules frontend/node_modules; do
  if [[ ! -d "$repo_root/$dependency_directory" ]]; then
    echo "Missing $dependency_directory. Install the project dependencies before starting." >&2
    exit 69
  fi
done

run_id=$(date -u +%Y%m%dT%H%M%SZ)
repo_name=$(basename "$repo_root")
worktree_path="$(dirname "$repo_root")/${repo_name}-auto-${run_id}"
branch_name="auto/overnight-${run_id}"
run_directory="auto-workflow/.runs/${run_id}"

git worktree add -b "$branch_name" "$worktree_path" HEAD
mkdir -p "$worktree_path/$run_directory"
ln -s "$repo_root/backend/node_modules" "$worktree_path/backend/node_modules"
ln -s "$repo_root/frontend/node_modules" "$worktree_path/frontend/node_modules"

echo "Branch:   $branch_name"
echo "Worktree: $worktree_path"
echo "Run data: $worktree_path/$run_directory"

if [[ $mode == foreground ]]; then
  cd "$worktree_path"
  exec node auto-workflow/runner.mjs run "$source_document" --run-id "$run_id" --run-dir "$run_directory"
fi

operator_log="$worktree_path/$run_directory/operator.log"
session_name="auto-workflow-$run_id"
node_path=$(command -v node)
printf -v runner_command 'exec %q %q %q %q %q %q %q %q >%q 2>&1' \
  "$node_path" auto-workflow/runner.mjs run "$source_document" \
  --run-id "$run_id" --run-dir "$run_directory" "$operator_log"
cd "$worktree_path"
tmux new-session -d -s "$session_name" -c "$worktree_path" "$runner_command"
echo "$session_name" > "$worktree_path/$run_directory/tmux-session"

echo "Session:  $session_name"
echo "Log:      $operator_log"
echo
echo "The run is detached in tmux. The computer must remain powered on and must not suspend."
echo "Attach with:"
echo "  tmux attach-session -t '$session_name'"
echo "Check status later with:"
echo "  cd '$worktree_path' && node auto-workflow/runner.mjs status '$run_directory'"
