# INSTALL — 一条命令装，一条命令卸

前提：Node ≥ 20、`dsh` 在 `PATH` 里、至少启动过一次目标 profile（默认 `web`，即 `~/.dsh/profiles/web/`）。

## 从 npm 装（不 clone）

包名 `dsh-task-settle-notify`，已发布在 npm registry。

```bash
dsh plugin --profile web add dsh-task-settle-notify
```

然后把 `"dsh-task-settle-notify"` 加进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组（首次安装时该数组可能不存在，连同 `dsh.profile` 一起建）。`dsh plugin add` 只是把参数转发给 profile 目录里的 pnpm，**不会**自动改 bundle 列表。

想回滚：`dsh plugin --profile web remove dsh-task-settle-notify`，并把它从 `dsh.profile.bundles` 里删掉。

## 从源码装（带备份与回执）

```bash
node scripts/install.mjs
```

指定 profile / DSH 目录：

```bash
node scripts/install.mjs --profile web --dsh-home ~/.dsh
```

脚本做的事：

1. 把将被修改的文件快照到 `<repo>/.backup/<时间戳>/`（保留目录结构）：
   - `~/.dsh/profiles/web/package.json`
   - `~/.dsh/profiles/web/pnpm-lock.yaml`
   - `~/.dsh/profiles/web/pnpm-workspace.yaml`
   - `~/.dsh/profiles/web/cordis.patch.yml`
   - `~/.dsh/profiles/web/cordis.yml`
   - `~/.dsh/settings.yaml`、`~/.dsh/settings.json`（如果存在）
2. 在 profile 目录执行 `dsh plugin --profile web add link:<repo>`（pnpm link 安装本地 checkout）；
3. 把 `dsh-task-settle-notify` 追加到 profile `package.json` 的 `dsh.profile.bundles`；
4. 写安装回执 `~/.dsh/dsh-task-settle-notify/install.json`；
5. 打印备份路径与（必要时）重启命令。

脚本**不碰** DSH 源码、看板包和账本。

## 加载 / 重启

profile 的 `dsh.profile.patchReload` 为 `live` 时（本机 `web` profile 即是），
`dsh-hmr` 会监听 profile `package.json` 的 bundle 列表并自动热挂载，**通常无需重启**。
看到状态接口返回 `extensionActive: true` 即成功。

若状态接口持续 404，说明该 profile 没开 live reload，重启 web 宿主：

```bash
# 先停掉当前 dsh web（Ctrl-C），再
dsh web
```

## 验证安装

```bash
curl -s http://127.0.0.1:3080/api/task-settle-notify/status
```

正常应看到 `"extensionActive": true`，并带 `startRevision`、`pending`、`delivered` 等字段。

日志：

```bash
tail -f ~/.dsh/dsh-task-settle-notify/trace.log
tail -f ~/.dsh/dsh-task-settle-notify/error.log
```

## 卸载

```bash
node scripts/uninstall.mjs
```

默认是**外科式卸载**：

1. `dsh plugin --profile web remove dsh-task-settle-notify`；
2. 从 `dsh.profile.bundles` 移除包名；
3. 对安装时备份过的文件：仅当文件当前字节仍等于“安装后”的字节时才还原，安装后被别人改过的文件一律保留并打印 `kept (changed after install)`；
4. 回执改名为 `install.json.removed-<ts>`，`error.log` / `trace.log` 保留。

强制整份还原（会覆盖安装后别人对 profile 的修改，慎用）：

```bash
node scripts/uninstall.mjs --restore
```

卸载后同样由 HMR 热卸载；未生效时重启 `dsh web`。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `profile not found` | 先运行一次 `dsh --profile web`，或改 `--profile` |
| `dsh: command not found` | 把 `dsh` 加进 `PATH`，或用 `DSH_BIN=/abs/path/dsh node scripts/install.mjs` |
| 状态里 `extensionActive: false` | 确认任务看板已启用、版本 ≥ 0.4.8；看 `error.log` 的 `board-unavailable` / `watcher-start` |
| 装完没有设置卡 | 刷新页面；设置卡在「设置 → 任务结算通知」，仍未出现则重启 web |
| 想改配置但不进 UI | 编辑 `~/.dsh/profiles/web/task-settle-notify/settings.json` 后刷新/重启 |

## 手工安装（不想用脚本）

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add link:/Users/chy/projects/taskboard_plugins/dsh-task-settle-notify
# 编辑 package.json，把 "dsh-task-settle-notify" 加进 dsh.profile.bundles
# 重启 dsh web
```

手工安装同样建议先备份 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml`。
