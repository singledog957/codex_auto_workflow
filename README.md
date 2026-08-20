# 无人值守开发工作流

这套脚本把一个实施文档转换为可恢复的任务队列，并用不同价位的 Codex 模型逐项完成。它没有图形界面，不会自动 push、merge、部署、访问生产数据或删除 worktree。

## 它如何工作

1. `gpt-5.6-sol/high` 只读检查实施文档和现有代码，生成小型、带依赖的 JSON 任务；每项显式区分为 `implementation` 或 `checkpoint`，并带有 1–20 个文件的硬预算。规划器仍优先把普通任务控制在 5 个文件内，只在不可安全拆分的内聚修复中使用更高上限。
2. 普通任务依次使用 Luna、Luna、Terra、Sol；迁移、并发、授权、secret、公共契约等高风险任务直接使用 Sol，最多两次。
3. Agent 只能选择 `backend`、`frontend`、`full`、`docs` 验证档位，不能生成要执行的测试命令。真实命令固定在 `config.json`。
4. Controller 亲自运行验证并检查退出码。验证通过才创建 Git checkpoint；失败则把真实日志交给下一次尝试。
5. 每三项运行一次 checkpoint 门禁；全部任务结束后运行完整门禁和独立 Sol 审查。
6. 每一步保存到 `.runs/<run-id>/state.json`，中断后可以继续。
7. tmux 中的轻量 supervisor 把每次 controller 执行放进独立的 systemd user service cgroup。该 cgroup
   默认最多使用主机 60% 的内存，controller 退出时会清理它启动的全部子孙进程；OOM 或异常退出且持久状态仍为
   `RUNNING` 时，supervisor 最多自动恢复三次。

Phase checkpoint 是只读验收任务，不再复用可写 implementation worker。它只检查验收条件和 controller
证据：通过则记录完成；发现实质缺口则生成最多五个独立、带文件预算的修复任务，把这些任务插入 checkpoint
之前，修复完成后再验收。默认最多允许两轮这种重排，仍有缺口就进入 `BLOCKED`，避免在一个 checkpoint
里持续扩张。即使 VM 配置使用 `danger-full-access`，controller 也会比较审查前后的 Git 工作树；checkpoint
发生任何写入都会阻塞且不会提交。

## 第一次使用

要求：

- 已安装并登录 Codex CLI：`codex --version`、`codex login status`。
- Node.js 24、tmux、systemd user service、项目依赖和测试环境已经就绪。
- 先把本目录提交到 Git；`start.sh` 只从干净的提交创建隔离 worktree。
- 电脑整夜保持通电，并关闭自动睡眠。锁屏没有问题，系统挂起会停止进程。

先验证脚本本身：

```bash
npm --prefix auto-workflow test
node auto-workflow/runner.mjs run doc/addr/20260815_redesign/implement.md --dry-run
```

`--dry-run` 不调用 Codex，也不修改源码，只在 `auto-workflow/.runs/` 生成配置和任务预览。

## 一条命令开始夜间任务

```bash
./auto-workflow/start.sh doc/addr/20260815_redesign/implement.md
```

默认行为：

- 从当前 `HEAD` 创建 `auto/overnight-<时间>` 分支；
- 在仓库同级目录创建独立 worktree；
- 复用主工作区已经安装的前后端 `node_modules`（只创建被 Git 忽略的符号链接）；
- 在命名的 tmux session 中后台启动 supervisor，然后立即返回；SSH 断开不会终止任务；
- 打印 worktree、tmux session、日志和状态命令。

希望在终端前台观察时：

```bash
./auto-workflow/start.sh doc/addr/20260815_redesign/implement.md --foreground
```

## 早上查看

`start.sh` 会打印准确路径。进入那个 worktree 后运行：

```bash
tmux has-session -t "=$(cat auto-workflow/.runs/<run-id>/tmux-session)"
node auto-workflow/runner.mjs status auto-workflow/.runs/<run-id>
```

`status` 除持久任务状态外还显示 `Controller: ONLINE/OFFLINE`。如果任务状态仍是 `RUNNING`、但 controller
为 `OFFLINE`，说明监督进程已经停止，应先读 `operator.log` 和 `supervisor.json`，再运行 `resume.sh`；不要把
这种状态当作仍在执行。

需要查看实时终端时运行 `tmux attach-session -t "$(cat auto-workflow/.runs/<run-id>/tmux-session)"`；按
`Ctrl-b d` 只会退出观察，不会停止任务。

也可以直接阅读：

- `REPORT.md`：给人看的完成/阻塞/剩余摘要；
- `state.json`：可恢复状态、每项尝试、模型和验证证据；
- `plan.json`：Sol 生成的任务分解；
- `logs/`：Codex JSONL 和 controller 真实测试输出；
- `operator.log`：后台 supervisor、controller 和 Codex 的控制台输出；
- `tmux-session`：承载当前任务的 tmux session 名称。
- `supervisor.json`：当前 systemd service、自动恢复次数和最后一次退出原因。

终态只有：

- `COMPLETE`：任务、完整门禁和独立审查全部通过；
- `BLOCKED`：重试耗尽、依赖死锁、最终门禁或审查不通过；
- `BUDGET_EXHAUSTED`：本晚 8 小时或 30 次 Codex 调用用完，进度已保存。

## 第二天继续

在原 worktree 和原分支中运行：

```bash
./auto-workflow/resume.sh auto-workflow/.runs/<run-id> \
  --max-hours 12 \
  --max-codex-calls 100
```

`resume.sh` 默认在原 worktree 中创建同名 tmux session；如果该 session 仍存活，它只报告当前 session，不会重复启动 runner。
每次 resume 都获得一个新预算窗口。省略预算参数时继续使用该 run 的 `config.snapshot.json`；`--max-hours` 接受正数，
`--max-codex-calls` 接受正整数。覆盖只影响这次 resume session，并记录到 `state.json` 的 session 历史，不会改写原始配置快照。
不要在这个 worktree 中混入手工修改；失败尝试留下的未提交代码会作为下一次修复的上下文继续使用。

如果最初的 Planner 在生成任务队列前失败，报告会显示 `T000 Planning bootstrap`。`resume` 会识别这个合成任务并重新运行 Planner，不需要删除 run 目录或重新创建 worktree。

## 停止

向 tmux pane 发送 `Ctrl-C`，让 supervisor 停止当前 service cgroup（包括 runner、Codex 及测试子进程）：

```bash
tmux send-keys -t "$(cat auto-workflow/.runs/<run-id>/tmux-session)" C-c
```

不要删除 state 或 worktree。下次 `resume` 会把中断的 `running` attempt 还原为 `pending`，并保留日志证据。

## 费用和速度

默认普通任务最多四次：Luna 两次、Terra 一次、Sol 一次。清楚、重复的工作优先交给 Luna；Sol 只负责规划、高风险任务、最终兜底和独立审查。没有启用 Fast mode，因为目标是节约额度，而不是提高瞬时速度。

可在 `config.json` 修改：

- `maxHours`：单晚时间预算；
- `maxCodexCalls`：单晚模型调用预算；
- `checkpointEvery`：完整 checkpoint 的频率；
- `maxCheckpointReplans`：显式 Phase checkpoint 最多允许的缺口拆单轮数，默认 2；
- 模型和 reasoning effort；
- 仓库固定的验证命令。

资源隔离默认值可用环境变量临时覆盖：`AUTO_WORKFLOW_MEMORY_MAX`（systemd 内存值，默认 `60%`）、
`AUTO_WORKFLOW_MAX_RESTARTS`（默认 3）和 `AUTO_WORKFLOW_RESTART_DELAY_MS`（默认 5000）。内存上限同时应用于
`MemoryMax` 和 `MemorySwapMax`。选择 systemd service 而不是只杀 Codex PID，是因为模型执行的测试会再启动
Node、PostgreSQL 等孙进程；service 的 `KillMode=control-group` 能在正常退出、超时和 OOM 后统一回收整个进程树。
调用环境通过 service stdin 传入，不会作为 systemd 命令参数或持久文件暴露；因此 PATH、代理和临时测试变量与启动
`start.sh`/`resume.sh` 时保持一致。

当前仓库配置显式启用了 `danger-full-access`，因为这台 VM 的 Codex `read-only`/`workspace-write` 沙箱执行 shell 时会报 `bwrap: loopback: Failed RTM_NEWADDR`。它必须同时设置 `allowDangerFullAccess: true`，避免无意中开启。runner 仍使用隔离 worktree、固定验证命令、禁止审批和 git 不变量检查，但模型生成的 shell 命令不再受 OS 沙箱限制；只应在一次性或可信开发机上运行。换到支持 Codex 沙箱的机器后，应恢复 `workspace-write` 并删除该确认开关。

默认聚合门禁使用 `npm run lint`/`npm run build`，避免后台非登录 shell 找不到由 Corepack 提供的 `pnpm`；它们仍然调用仓库根 `package.json` 中相同的前后端脚本。

## 当前边界

- `COMPLETE` 代表自动化证据全部通过，不等同于生产发布；此工作流永远不会部署。
- 一个大型实施文档不保证一夜完成；预算耗尽后按原状态继续。
- 最终审查拒绝时，第一版会报告 blockers，不会擅自修改验收标准或无限循环。
- PostgreSQL 专项测试需要你预先提供隔离的测试数据库配置；默认门禁使用仓库的 SQLite 测试入口。
- 自动恢复只处理 controller 异常退出；连续三次恢复后仍是 `RUNNING` 会停止并在 `supervisor.json` 中要求人工诊断，
  以避免永久重启循环。
