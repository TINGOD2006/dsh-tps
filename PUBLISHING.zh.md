# 发布 / 收录流程（dsh-tps）

与 `dsh-scratch-vault` 的发布方式一致，共三步。第 1 步是必须的，第 2、3 步是可选/收录。

## 1. 发布到 GitHub（必须）

- 仓库：`https://github.com/TINGOD2006/dsh-tps`
- 安装：`dsh plugin add TINGOD2006/dsh-tps`

本机已经做过的事：

- `git init -b main`，提交全部源码（`lib/`、`cordis.patch.yml`、`package.json`，以及
  `README.md` / `README.zh.md` / `LICENSE`）。
- `gh repo create TINGOD2006/dsh-tps --public` 建库，然后以 token URL 推送 main。
- 给仓库加 `dsh-plugin` topic（`dsh plugin` 的市场索引会按它扫描）。

日常更新：

```sh
git add -A
git commit -m "feat: ..."
git push origin main
```

> 注意：沙箱里 `gh` 的 schannel 凭证读不到，`git push` 若报
> `SEC_E_NO_CREDENTIALS`，用 token URL 推送即可（不落盘）：
> `$t = gh auth token; git push "https://x-access-token:$t@github.com/TINGOD2006/dsh-tps.git" main`。

## 2. 发布到 npm（可选，推荐）

有 npm 包，市场才会显示下载量并优先展示预构建安装；没有 npm 包照样能装，只是没有下载数字。

- 首次发布需要在 npmjs.com 给包配置 **Trusted Publisher**：
  Owner `TINGOD2006`、Repo `dsh-tps`、Workflow `publish.yml`。
- 配置后，推 `v*` tag 即由 `.github/workflows/publish.yml` 用 OIDC 发布，仓库里不放任何 token：

```sh
git tag v2.1.0
git push origin v2.1.0
```

- `package.json` 的 `repository` 必须指回 GitHub 仓库，否则市场不会把包和条目关联起来。

## 3. 收录进 DSH 插件市场（awesome-dsh-plugin）

市场列表来自 [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，
每个插件一个 YAML 文件；**不要手工改 README**（由脚本生成）。

- 新建一个 PR，只加一个文件 `data/plugins/TINGOD2006__dsh-tps.yml`：

```yaml
url: https://github.com/TINGOD2006/dsh-tps
name: TINGOD2006/dsh-tps
category: usage
description:
  en: 'Live tokens-per-second readout for the current session, docked to the sidebar or draggable as a floating card.'
  zh: '当前会话的实时 tokens/s 读数，可停靠左侧栏或拖动的悬浮卡片。'
```

- 要求：仓库有 `dsh.bundle` manifest（本仓库已有）、代码真实可用、仓库**创建满 1 天**
  （CI 自动检查，刚建好的仓库当天提交必被挡下，隔天重提即可）、描述属实不带营销词。
- CI 依次检查：条目数 ≤3、`dsh.bundle`、仓库年龄、awesome-lint 与站点构建。

## 备注

- 插件是纯前端读数：无网络请求、无运行时依赖，数据全部来自本地会话事件。
- `lib/widget.js` 每次请求从磁盘读取，改完刷新页面即生效；页面还在跑旧版会显示 `⟳`。

## 当前进度（2026-10-21）

- ✅ GitHub：已建仓 `TINGOD2006/dsh-tps`（public），main 已推送，主题含 `dsh-plugin`、
  `deepseek-harness`、`dsh`、`tokens-per-second`。
- ⏳ 市场：fork `TINGOD2006/awesome-dsh-plugin` 已建，分支 `add-dsh-tps` 上已提交
  `data/plugins/TINGOD2006__dsh-tps.yml`（单文件、与 main 比对只有这一处改动）。
  **受「仓库创建满 1 天」的 CI 门槛约束**，需等 2026-10-22 之后再开 PR：

```sh
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head TINGOD2006:add-dsh-tps \
  --title "Add dsh-tps" \
  --body "Live tokens-per-second card for DeepSeek Harness sessions — docked to the sidebar or draggable as a floating card."
```

- ⬜ npm：`package.json`、`publish.yml` 已就绪；先在 npmjs.com 给包配置 Trusted Publisher
  （Owner `TINGOD2006` / Repo `dsh-tps` / Workflow `publish.yml`），再 `git push origin v2.1.0`。

