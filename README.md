# Codex Auto Workflow

把一份实施文档交给 Codex，让它在隔离的 Git worktree 中自动规划、逐项实现、运行固定测试、提交通过的任务，并在中断后从原进度继续。

它适合“需求已经写清楚、仓库已有可靠测试、希望长时间无人值守执行”的开发任务。它不是部署系统：不会自动 push、合并、发布、访问生产数据或删除 worktree。

## 它提供什么

- **自动拆解**：Planner 阅读实施文档和现有代码，生成有依赖关系、文件数量上限和验收条件的任务队列。
- **分级执行**：普通任务按 Luna → Luna → Terra → Sol 逐级重试；迁移、并发、鉴权、secret、公共契约等高风险任务直接使用 Sol。
- **确定性验收**：Codex 只能选择 `backend`、`frontend`、`full`、`docs` 四种验证档位；真正执行的命令由用户本地的 `config.json` 固定，模型不能临时拼测试命令。
- **通过才提交**：Controller 检查命令退出码，验证通过后才创建 Git checkpoint commit；失败日志会成为下一次修复的上下文。
- **阶段与最终审查**：默认每完成 3 项运行一次阶段门禁，最后再运行完整门禁和独立审查。
- **可恢复运行**：计划、状态、测试证据和日志持续写入 `.runs/<run-id>/`，断电或预算耗尽后可继续。
- **进程隔离**：每次执行位于独立产品 worktree；后台 supervisor 使用 tmux 和 systemd cgroup 管理整个进程树，默认内存上限为主机的 60%，异常时最多自动恢复 3 次。

简化流程：

```text
实施文档
   ↓
Planner ──→ 带依赖的任务计划
              ↓
Worker 修改代码 → Controller 运行固定门禁 → Git 提交
              ↑                ↓
              └── 失败重试 ────┘
                               ↓
                   阶段检查 → 最终门禁 → 独立审查
```

## 适用范围

推荐使用：

- Linux 开发机或可信的 Linux VM；
- 已有 Git 仓库、自动化测试和明确验收标准的项目；
- 可以拆成多个小任务、允许在独立分支上持续提交的开发工作；
- 数小时到一晚的无人值守执行。

暂不适合：

- 模糊的产品想法或需要频繁人工决策的工作；
- 直接操作生产环境、生产凭据或生产数据；
- 没有测试门禁、无法判断“完成”的项目；
- macOS、Windows，或没有 systemd user service 的 Linux 环境；
- 不准备修改当前 Node.js 前后端适配器的其他项目结构。

## 5 分钟上手

### 1. 准备环境

当前版本需要：

- Linux 与可用的 systemd user service；
- Node.js 24；
- tmux；
- 已安装并登录的 Codex CLI；
- 一个干净、已提交的产品 Git 仓库；
- 产品仓库中已经安装好的 `backend/node_modules` 和 `frontend/node_modules`。

先检查：

```bash
node --version
codex --version
codex login
codex login status
tmux -V
systemctl --user status
```

Codex CLI 的安装、认证和沙箱选项请以官方文档为准：[CLI](https://learn.chatgpt.com/docs/codex/cli)、[认证](https://learn.chatgpt.com/docs/auth)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

### 2. 作为独立仓库安装

在产品仓库根目录执行：

```bash
printf '\nauto-workflow/\n' >> .gitignore
git add .gitignore
git commit -m "chore: ignore standalone auto-workflow"
git clone git@github.com:singledog957/codex_auto_workflow.git auto-workflow
cp auto-workflow/config.json.example auto-workflow/config.json
npm --prefix auto-workflow test
```

`auto-workflow/` 是被产品仓库忽略的独立 Git checkout，不是产品仓库的一部分。这样 workflow 可以独立升级，也不会把运行状态混入产品提交。

仓库只提供可复制的 `config.json.example`，不提供会直接生效的默认 `config.json`。你创建的 `config.json` 已被 workflow 自己的 `.gitignore` 忽略，不会意外提交到公共仓库。

### 3. 配置产品的验证命令

编辑刚复制出的 `auto-workflow/config.json`。example 中的命令只演示一个具有 `backend/`、`frontend/` 和根目录 npm scripts 的项目；必须把它们替换成当前产品仓库真实可用的命令。

一个 profile 是“一组按顺序执行的验证命令”。Planner 只选择 profile 名称，Controller 才会从本地配置读取并执行对应命令；任一命令返回非零状态后，该组验证立即失败。

四个 profile 名称是当前计划 schema 的固定接口，用户配置必须全部提供：

| Profile | 什么时候选用 | 用户应填写什么 |
| --- | --- | --- |
| `backend` | 只改后端 | 后端 lint、类型检查和测试 |
| `frontend` | 只改前端 | 前端测试、类型检查或构建 |
| `full` | 跨模块、公共接口或高影响修改 | 产品最有代表性的跨模块门禁 |
| `docs` | 只改文档 | Markdown 检查或 `git diff --check` |

例如，用户可以这样填写自己的 profile：

```json
{
  "verification": {
    "profiles": {
      "backend": [
        "npm --prefix backend run lint",
        "npm --prefix backend run typecheck",
        "npm --prefix backend test"
      ],
      "frontend": [
        "npm --prefix frontend run lint",
        "npm --prefix frontend test",
        "npm --prefix frontend run build"
      ],
      "full": [
        "npm run lint",
        "npm run build",
        "npm test"
      ],
      "docs": [
        "git diff --check"
      ]
    },
    "checkpoint": [
      "npm run lint",
      "npm test"
    ],
    "final": [
      "npm run lint",
      "npm run build",
      "npm test",
      "git diff --check"
    ]
  }
}
```

编写规则：

- 必须保留 `backend`、`frontend`、`full`、`docs` 四个名称，暂不支持增加其他名称；
- 每个值必须是非空字符串数组，每条字符串是一条从隔离产品 worktree 根目录执行的 Bash 命令；
- 命令应无交互、可重复执行，并使用隔离的测试数据库或测试服务；
- `checkpoint` 是每批任务后的阶段门禁，`final` 是完成前的全量门禁，两者也必须是非空数组；
- 不要把 token、密码或生产连接串写入配置；需要的测试环境变量应由启动进程安全提供。

`config.json` 不需要也不应提交。启动时，`start.sh` 会把它以 `0600` 权限复制到本次隔离 workflow，并在 run 目录保存配置快照，确保恢复时仍使用同一配置。

### 4. 写实施文档

文档必须位于产品仓库内，并使用相对路径传给启动命令。建议至少写清：

```markdown
# 目标
用户最终能获得什么。

## 当前状态
相关模块、已有行为和已知问题。

## 范围
这次要改什么；明确不改什么。

## 约束
兼容性、安全、数据迁移和接口限制。

## 验收标准
- 可观察、可验证的完成条件。
- 必须通过的测试和构建命令。
```

例如保存为 `doc/implementation.md`，并先提交它和所有预期的起始改动。产品仓库与 workflow 仓库都必须干净。

### 5. 预演并启动

```bash
node auto-workflow/runner.mjs run doc/implementation.md --dry-run
./auto-workflow/start.sh doc/implementation.md
```

`--dry-run` 不调用 Codex，也不修改产品源码，只在 `auto-workflow/.runs/` 中生成配置和任务预览。

`start.sh` 会立即打印：

- 新分支：`auto/overnight-<UTC 时间>`；
- `auto-workflow/.worktrees/<run-id>/` 中的隔离产品 worktree；
- 固定到当前 workflow commit 的独立 workflow clone；
- tmux session、运行目录、日志和状态查询命令。

电脑必须保持通电且不能休眠。锁屏和 SSH 断开不会终止后台任务。

## 日常命令

以下命令中的 `<run-id>` 和 worktree 路径以 `start.sh` 实际输出为准。

| 操作 | 命令 |
| --- | --- |
| 测试 workflow | `npm --prefix auto-workflow test` |
| 仅生成预览 | `node auto-workflow/runner.mjs run doc/implementation.md --dry-run` |
| 后台启动 | `./auto-workflow/start.sh doc/implementation.md` |
| 前台启动 | `./auto-workflow/start.sh doc/implementation.md --foreground` |
| 查看状态 | `node auto-workflow/runner.mjs status auto-workflow/.runs/<run-id>` |
| 查看实时终端 | `tmux attach-session -t "$(cat auto-workflow/.runs/<run-id>/tmux-session)"` |
| 退出实时观察 | 在 tmux 中按 `Ctrl-b d` |
| 停止本次运行 | `tmux send-keys -t "$(cat auto-workflow/.runs/<run-id>/tmux-session)" C-c` |
| 继续原运行 | `./auto-workflow/resume.sh auto-workflow/.runs/<run-id>` |
| 追加继续预算 | `./auto-workflow/resume.sh auto-workflow/.runs/<run-id> --max-hours 12 --max-codex-calls 100` |
| 更新 workflow | `git -C auto-workflow pull --ff-only` |

`resume` 必须在原来的隔离 worktree 和原分支中执行。不要删除 run 目录，也不要在该 worktree 中混入手工修改；失败尝试留下的未提交内容会作为下一次修复的上下文。

## 怎么看结果

每次运行的资料位于隔离 worktree 的 `auto-workflow/.runs/<run-id>/`：

| 文件 | 内容 |
| --- | --- |
| `REPORT.md` | 给人阅读的完成、阻塞和剩余工作摘要 |
| `state.json` | 可恢复状态、任务尝试、模型、预算和验证证据 |
| `plan.json` | Planner 生成并经 Controller 校验的任务计划 |
| `logs/` | Codex JSONL 输出与真实测试日志 |
| `operator.log` | supervisor、Controller 和 Codex 的后台控制台输出 |
| `tmux-session` | 承载当前运行的 tmux session 名称 |
| `supervisor.json` | systemd service、自动恢复次数和最后退出原因 |

终态含义：

- `COMPLETE`：所有任务、最终门禁和独立审查都通过；
- `BLOCKED`：重试耗尽、依赖死锁、最终门禁或审查未通过；
- `BUDGET_EXHAUSTED`：时间或 Codex 调用预算用完，进度已保存，可以 resume。

`status` 还会显示 Controller 是否 `ONLINE`。若任务仍显示 `RUNNING`，但 Controller 为 `OFFLINE`，应先查看 `operator.log` 和 `supervisor.json`，再决定是否 resume。

## 把结果接回主分支

workflow 只在 `auto/overnight-...` 分支提交，不会替你合并。先在产品仓库检查运行结果：

```bash
git log --oneline main..auto/overnight-<run-id>
git diff --stat main...auto/overnight-<run-id>
git diff main...auto/overnight-<run-id>
```

确认后可按团队正常流程创建集成分支并合并：

```bash
git switch main
git switch -c integrate/auto-<run-id>
git merge --no-ff auto/overnight-<run-id>
# 再运行产品仓库自己的完整门禁，然后 review / push / PR
```

如果主分支在自动运行期间已经前进，应先按团队规则处理冲突，不要把 `COMPLETE` 当作免审查或可直接发布的证明。

## 配置参考

主要设置都在用户本地的 `config.json`；完整结构见 `config.json.example`：

| 配置 | 作用 |
| --- | --- |
| `models.planner` | 规划任务的模型与 reasoning effort |
| `models.attempts` | 普通任务的有界重试顺序 |
| `models.highRiskAttempts` | 高风险任务的重试顺序 |
| `models.reviewer` | 最终独立审查模型 |
| `execution.maxHours` | 单次运行的时间预算 |
| `execution.maxCodexCalls` | 单次运行的 Codex 调用预算 |
| `execution.codexTimeoutMinutes` | 单次模型调用超时 |
| `execution.verificationTimeoutMinutes` | 单次验证门禁超时 |
| `execution.checkpointEvery` | 每完成多少项运行阶段门禁 |
| `execution.maxCheckpointReplans` | 阶段检查发现缺口后最多追加几轮修复任务 |
| `verification.profiles` | 单项任务可选的固定验证命令 |
| `verification.checkpoint` | 阶段门禁命令 |
| `verification.final` | 最终完整门禁命令 |

资源隔离可用环境变量临时覆盖：

- `AUTO_WORKFLOW_MEMORY_MAX`：systemd 的 `MemoryMax` 和 `MemorySwapMax`，默认 `60%`；
- `AUTO_WORKFLOW_MAX_RESTARTS`：Controller 异常后的最大自动恢复次数，默认 `3`；
- `AUTO_WORKFLOW_RESTART_DELAY_MS`：恢复前等待时间，默认 `5000` 毫秒。

## 安全边界

example 配置使用 `workspace-write`。Planner、阶段检查和最终审查在可行时使用只读检查；每次任务还受独立 worktree、文件数量预算、结构化输出 schema、固定验证命令和 Git 状态检查约束。

只有在可信的一次性环境确实无法使用沙箱时，才同时设置：

```json
{
  "execution": {
    "sandbox": "danger-full-access",
    "allowDangerFullAccess": true
  }
}
```

该模式允许模型生成的命令越过 OS 沙箱。不要在包含生产凭据、生产数据或其他高价值资产的机器上启用。

## 当前限制

- `start.sh` 当前固定检查并复用 `backend/node_modules` 与 `frontend/node_modules`；其他目录结构需要修改启动适配器。
- 四个验证 profile 名称由计划 schema 固定为 `backend`、`frontend`、`full`、`docs`；可以改各自命令，但不能只在 `config.json` 中另起名称。
- PostgreSQL 等外部服务需要提前提供隔离的测试环境；workflow 不会连接或准备生产资源。
- 阶段检查发现缺口时，每轮最多生成 5 个有文件预算的修复任务；超过配置轮数后进入 `BLOCKED`，不会无限扩张任务。
- 自动恢复只处理 Controller 异常退出；连续失败达到上限后需要人工查看日志。
- `COMPLETE` 只表示自动化证据通过，不代表已完成安全审计、人工验收或生产发布。
