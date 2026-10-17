# world/roles · 角色契约 + 干净 launcher

来源 spec：`docs/plans/2026-10-18-desktop-world-agent-system.md`
当前 ticket：`.scratch/desktop-world-agent-system/issues/01-role-contract-clean-glm-launcher.md`

## 干什么

为 ds / jev / glm 三个角色提供**角色身份**与**干净启动**两件事：

- `world:roles init` → 把全局契约与三张角色卡从仓内模板落到运行根目录。
- `world:roles launch glm --task <brief>` → 在空 config dir、独立 worktree、独立 session 里执行一次 glm 任务并写回执。

## 运行根目录布局

默认 `~/.desktop-world/roles/`，可用 `WORLD_ROLES_DIR` 环境变量覆盖（单测与便携场景**必须**覆盖，避免写脏用户家）。

```
<ROLES_DIR>/
├── contract.md            # 全局契约（init 生成）
├── cards/
│   ├── ds.md
│   ├── jev.md
│   └── glm.md             # 三张角色卡；用户可手改，init 不会覆盖
└── runs/
    └── <runId>/
        ├── config-dir/
        │   ├── system-prompt.md         # contract + card + brief 拼装结果
        │   └── prompt.manifest.json     # 三段 sha256 与拼装顺序 — 漂移检查的证据
        ├── worktree/                    # git worktree（分支 role-run/<runId>）
        ├── session/                     # agent 会话产物（与 config dir 分离）
        ├── brief.md                     # 本次任务的简报副本（审计快照）
        └── receipt.json                 # 角色 / 模型 / worktree / 变更清单 / 耗时
```

## 测试入口

```bash
node --test test/world-roles-init.test.js \
            test/world-roles-prompt.test.js \
            test/world-roles-launch.test.js
```

## 不属于本 ticket 的事

- ds / jev 的 launcher：ticket 02。
- `world:roles check`（漂移检查）：依赖本 ticket 的 manifest，但是后续 ticket。
- 真 glm 模型调用：fixture runner 占住接口位，真接入由后续 ticket 决定。
