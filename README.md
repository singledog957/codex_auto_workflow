# 无人值守开发工作流

这套脚本把一个实施文档转换为可恢复的任务队列，并用不同价位的 Codex 模型逐项完成。它没有图形界面，不会自动 push、merge、部署、访问生产数据或删除 worktree。

## 它如何工作

1. `gpt-5.6-sol/high` 只读检查实施文档和现有代码，生成小型、带依赖的 JSON 任务。
2. 普通任务依次使用 Luna、Luna、Terra、Sol；迁移、并发、授权、secret、公共契约等高风险任务直接使用 Sol，最多两次。
3. Agent 只能选择 `backend`、`frontend`、`full`、`docs` 验证档位，不能生成要执行的测试命令。真实命令固定在 `config.json`。
4. Controller 亲自运行验证并检查退出码。验证通过才创建 Git checkpoint；失败则把真实日志交给下一次尝试。
5. 每三项运行一次 checkpoint 门禁；全部任务结束后运行完整门禁和独立 Sol 审查。
6. 每一步保存到 `.runs/<run-id>/state.json`，中断后可以继续。

## 第一次使用

要求：

- 已安装并登录 Codex CLI：`codex --version`、`codex login status`。
- Node.js 24、项目依赖和测试环境已经就绪。
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
- 后台启动 runner，然后立即返回；
- 打印 worktree、PID、日志和状态命令。

希望在终端前台观察时：

```bash
./auto-workflow/start.sh doc/addr/20260815_redesign/implement.md --foreground
```

## 早上查看

`start.sh` 会打印准确路径。进入那个 worktree 后运行：

```bash
node auto-workflow/runner.mjs status auto-workflow/.runs/<run-id>
```

也可以直接阅读：

- `REPORT.md`：给人看的完成/阻塞/剩余摘要；
- `state.json`：可恢复状态、每项尝试、模型和验证证据；
- `plan.json`：Sol 生成的任务分解；
- `logs/`：Codex JSONL 和 controller 真实测试输出；
- `operator.log`：后台 runner 的控制台输出。

终态只有：

- `COMPLETE`：任务、完整门禁和独立审查全部通过；
- `BLOCKED`：重试耗尽、依赖死锁、最终门禁或审查不通过；
- `BUDGET_EXHAUSTED`：本晚 8 小时或 30 次 Codex 调用用完，进度已保存。

## 第二天继续

在原 worktree 和原分支中运行：

```bash
node auto-workflow/runner.mjs resume auto-workflow/.runs/<run-id>
```

每次 resume 都获得新的 8 小时/30 次调用窗口。不要在这个 worktree 中混入手工修改；失败尝试留下的未提交代码会作为下一次修复的上下文继续使用。

如果最初的 Planner 在生成任务队列前失败，报告会显示 `T000 Planning bootstrap`。`resume` 会识别这个合成任务并重新运行 Planner，不需要删除 run 目录或重新创建 worktree。

## 停止

读取 `.runs/<run-id>/pid`，先发送普通终止信号：

```bash
kill "$(cat auto-workflow/.runs/<run-id>/pid)"
```

不要删除 state 或 worktree。下次 `resume` 会把中断的 `running` attempt 还原为 `pending`，并保留日志证据。

## 费用和速度

默认普通任务最多四次：Luna 两次、Terra 一次、Sol 一次。清楚、重复的工作优先交给 Luna；Sol 只负责规划、高风险任务、最终兜底和独立审查。没有启用 Fast mode，因为目标是节约额度，而不是提高瞬时速度。

可在 `config.json` 修改：

- `maxHours`：单晚时间预算；
- `maxCodexCalls`：单晚模型调用预算；
- `checkpointEvery`：完整 checkpoint 的频率；
- 模型和 reasoning effort；
- 仓库固定的验证命令。

当前仓库配置显式启用了 `danger-full-access`，因为这台 VM 的 Codex `read-only`/`workspace-write` 沙箱执行 shell 时会报 `bwrap: loopback: Failed RTM_NEWADDR`。它必须同时设置 `allowDangerFullAccess: true`，避免无意中开启。runner 仍使用隔离 worktree、固定验证命令、禁止审批和 git 不变量检查，但模型生成的 shell 命令不再受 OS 沙箱限制；只应在一次性或可信开发机上运行。换到支持 Codex 沙箱的机器后，应恢复 `workspace-write` 并删除该确认开关。

默认聚合门禁使用 `npm run lint`/`npm run build`，避免后台非登录 shell 找不到由 Corepack 提供的 `pnpm`；它们仍然调用仓库根 `package.json` 中相同的前后端脚本。

## 当前边界

- `COMPLETE` 代表自动化证据全部通过，不等同于生产发布；此工作流永远不会部署。
- 一个大型实施文档不保证一夜完成；预算耗尽后按原状态继续。
- 最终审查拒绝时，第一版会报告 blockers，不会擅自修改验收标准或无限循环。
- PostgreSQL 专项测试需要你预先提供隔离的测试数据库配置；默认门禁使用仓库的 SQLite 测试入口。
