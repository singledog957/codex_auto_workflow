#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: ./auto-workflow/resume.sh <run-directory> [--max-hours HOURS] [--max-codex-calls CALLS]"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 64
fi

run_directory=${1%/}
shift
budget_args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-hours|--max-codex-calls)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for $1" >&2
        exit 64
      fi
      budget_args+=("$1" "$2")
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 64
      ;;
  esac
done

if [[ $run_directory = /* ]]; then
  echo "Use a repository-relative run directory, not an absolute path." >&2
  exit 64
fi

script_dir=$(dirname "${BASH_SOURCE[0]}")
script_dir=$(cd "$script_dir" && pwd)
supervisor_path="$script_dir/supervisor.mjs"
if [[ ! -f $supervisor_path ]]; then
  echo "Supervisor not found: $supervisor_path" >&2
  exit 66
fi
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

if [[ ! -d $run_directory ]]; then
  echo "Run directory not found: $run_directory" >&2
  exit 66
fi

run_path=$(realpath "$run_directory")
case "$run_path" in
  "$repo_root"/*) ;;
  *)
    echo "Run directory must be inside the repository: $run_directory" >&2
    exit 64
    ;;
esac
run_directory=${run_path#"$repo_root"/}

for required_file in state.json config.snapshot.json; do
  if [[ ! -f $run_path/$required_file ]]; then
    echo "Missing $run_directory/$required_file" >&2
    exit 66
  fi
done

if ! command -v tmux >/dev/null; then
  echo "tmux is required for detached workflow sessions." >&2
  exit 69
fi
for command in systemd-run systemctl; do
  if ! command -v "$command" >/dev/null; then
    echo "$command is required for resource-contained workflow sessions." >&2
    exit 69
  fi
done

run_id=$(basename "$run_path")
safe_run_id=${run_id//[^[:alnum:]_-]/-}
session_name="auto-workflow-$safe_run_id"
if tmux has-session -t "=$session_name" 2>/dev/null; then
  echo "Workflow session is already running: $session_name"
  echo "Attach with:"
  echo "  tmux attach-session -t '$session_name'"
  exit 0
fi

operator_log="$run_path/operator.log"
node_path=$(command -v node)
printf -v runner_command 'exec %q %q %q %q' \
  "$node_path" "$supervisor_path" resume "$run_directory"
for argument in "${budget_args[@]}"; do
  printf -v quoted_argument ' %q' "$argument"
  runner_command+="$quoted_argument"
done
printf -v quoted_log '%q' "$operator_log"
runner_command+=" >>$quoted_log 2>&1"

tmux new-session -d -s "$session_name" -c "$repo_root" "$runner_command"
echo "$session_name" > "$run_path/tmux-session"

echo "Session:  $session_name"
echo "Log:      $operator_log"
echo "Attach with:"
echo "  tmux attach-session -t '$session_name'"
echo "Check status with:"
echo "  node auto-workflow/runner.mjs status '$run_directory'"
