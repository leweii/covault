# Covault 安装配置指南

> 从零把 Covault 跑起来所需的全部配置,分三层:
> **GitHub 侧**(org 管理员做一次)→ **授权后端**(平台负责人做一次)→ **本地**(每个成员各做一次)。
> 附录 B 是「把现在跑在个人基础设施上的这套东西变成公司资产」的迁移清单。

## 0. 总览

```
Obsidian 桌面版 + Covault 插件            ← 每个人的机器
   ├─ 笔记内容 ────────────→ 公司 GitHub org 的知识库 repo(附件走 Git LFS)
   ├─ 短时 installation token ← 授权后端(只存 KMS 加密的 refresh token)
   └─ 冲突片段 / Ask 提问 ──→ 成员各自配置的 LLM provider
```

**必须有的东西**

| 层 | 依赖 | 谁准备 |
|---|---|---|
| GitHub | 一个 org(Team/Enterprise 计划,已绑支付方式) | org 管理员 |
| GitHub | 一个 GitHub App(注册在该 org 名下) | org 管理员 |
| 后端 | 授权服务 zhiyu-sync 的一个部署 + 域名 + 证书 | 平台负责人 |
| 本地 | Obsidian 桌面版 ≥ **1.13.0**,Covault ≥ **0.2.8** | 每个成员 |
| 本地 | 一个 LLM provider 的 API key(可选,但冲突合并/Ask 依赖它) | 每个成员或公司统一发放 |

**不需要的东西**:本机不用装 git、不用装 git-lfs、不用装 Node。git 引擎是纯 JS 的
isomorphic-git,LFS 的 clean/smudge 由插件自己做,附件在 GitHub 上与 CLI 用户看到的完全一致。

**改动影响面**:第 1、2、3 节的任何常量变更(App、域名、client id)都要求发一个新版本插件并让**全员重新连接一次**。第 4 节起是每个人自己的事,互不影响。

---

## 1. GitHub 侧(org 管理员,一次性)

### 1.1 org 与 LFS 计费

- org 计划为 **Team 或 Enterprise**:GitHub LFS 免费额度 250 GiB 存储 + 250 GiB/月带宽。
- org **必须绑定支付方式并设置 LFS budget**。这不是可选项:没有支付方式时,LFS 额度超出会**直接锁死仓库读写**,所有人同时失去同步能力。
- 知识库以 markdown 为主,真正吃额度的是图片/PDF 附件;初期按每人每月几十 MB 估。

### 1.2 注册 GitHub App

GitHub → org Settings → Developer settings → **GitHub Apps → New GitHub App**:

| 字段 | 值 |
|---|---|
| GitHub App name | `Covault`(占用则换名,见下方 slug 说明) |
| Homepage URL | 插件仓库地址 |
| **Callback URL** | `https://<后端域名>/auth/covault/callback` |
| Request user authorization (OAuth) during installation | ✅ 勾选 |
| Webhook | ❌ 取消勾选(不需要) |
| Where can this app be installed? | Any account |
| Optional features → User-to-server token expiration | 保持默认(开启)——后端存 KMS 加密的 refresh token 并自动轮换 |

**Repository permissions**

| 权限 | 级别 | 为什么 |
|---|---|---|
| Contents | Read and write | 读写笔记 |
| Pull requests | Read and write | 没有直推权限时静默建分支 + PR |
| Administration | Read and write | 「共享文件夹为新库」要在 org 下建 repo |
| Metadata | Read-only(自动) | — |

创建后记下 **App ID**、**Client ID**,生成并下载 **Client secret** 和 **Private key(.pem)**。

> **slug 一致性**:App 的 slug 由 name 自动生成,在 `github.com/apps/<slug>` 里确认。
> 它必须与插件 `src/auth/constants.ts` 的 `APP_SLUG` 一致(安装/管理链接用它),
> 而后端的内部 key 和 callback 路径是独立的另一个名字(见 §3 的对应关系表)。

### 1.3 权限惯例(提交策略的全部来源)

插件在这里是零配置的:它每个库问一次 GitHub「我能否直推默认分支」,能就静默直推,不能就静默建分支 + 开 PR。所以「哪些库是我自己的」这件事完全由 org 侧的设置定义:

- org **base permission 设为 write**:所有成员对知识库 repo 有写权限(能推分支,建 PR 不需要 fork)。
- 每个知识库 repo 的**默认分支开分支保护**。
- 把**该库所属的 GitHub Team 加入分支保护的 bypass 名单** → 这个团队的人静默直推,其他人自动走 PR。

### 1.4 仓库归属与命名约定

- 团队知识库:`<团队>-kb`,建在 org 下,所属 Team 进 bypass 名单。
- 个人知识库:`personal-kb-<github-login>`(插件默认就按这个名字建),**同样建在 org 下**,建库后把本人加为 admin。不要放在个人账号下——离职回收、备份、计费都应归公司。
- 团队库的 `.covault/covault.json`(库清单)随仓库同步:团队给全组挂新库,成员下次同步自动获得,无需通知。

### 1.5 管理员检查清单

- [ ] org 计划 = Team/Enterprise,已绑卡,LFS budget 已设
- [ ] App 注册在 org 名下,四项权限齐全,callback URL 与后端域名一致
- [ ] base permission = write
- [ ] 每个知识库默认分支已开保护,所属 Team 在 bypass 名单里
- [ ] App 已安装到 org(`github.com/apps/<slug>/installations/new`),owner 已审批
- [ ] 没有历史遗留的误建/改名残留仓库

---

## 2. 授权后端(平台负责人,一次性)

后端(`zhiyu-sync`)只做一件事:保管 KMS 加密的 refresh token,给插件铸造短时效、按仓库收窄的 installation token。它**不经手任何笔记内容**,但它是全员登录的单点。

### 2.1 部署组成

API Gateway HTTP API + Lambda × 5 + DynamoDB(sessions 表,90 天 TTL)+ Secrets Manager + KMS key。
后端跑在 Node ≥ 22.5(用 `node:sqlite`,无原生编译依赖)。

### 2.2 应用配置

`apps.json`(参考 `apps.example.json`)加入一项:

```json
"covault": {
  "appName": "Covault",
  "appId": <App ID>,
  "clientId": "<Client ID>",
  "clientSecretEnv": "COVAULT_CLIENT_SECRET",
  "privateKeyFile": "./keys/covault.pem",
  "protocolAction": "covault"
}
```

部署环境需要:`COVAULT_CLIENT_SECRET` 环境变量、`keys/covault.pem` 私钥文件。

### 2.3 域名与证书

- 申请公司域名(如 `covault-auth.<company>.com`)+ ACM 证书 + DNS 记录。
- **域名要与 GitHub App 的 Callback URL、插件的 `BACKEND_BASE` 三处严格一致**,任一处不一致表现为「浏览器授权完成但没跳回 Obsidian」。

### 2.4 验证

`GET https://<后端域名>/healthz` 返回的 `apps` 数组里应包含 `"covault"`。

### 2.5 运维基线

- [ ] CloudWatch 告警:4xx/5xx 率、Lambda 错误率
- [ ] 日志保留期、IAM 最小权限
- [ ] DynamoDB PITR 备份
- [ ] 指定 owner / on-call
- [ ] **已知缺陷待修**:refresh token rotation 有竞态——并发 mint 会触发重验证,表现为偶发 `session_invalid`(用户被踢下线要重连)。上量前给重验证加锁/重试。

---

## 3. 插件常量(发版前对齐)

`src/auth/constants.ts` 里四个常量,分别对应上面三层的哪一处:

| 常量 | 现值 | 必须等于 |
|---|---|---|
| `BACKEND_BASE` | `https://sync.zhiyu-online.com` | §2.3 的后端域名 |
| `APP_SLUG` | `covault-ct` | §1.2 里 `github.com/apps/<slug>` 的 slug |
| `CLIENT_ID` | `Iv23li7tzv2hyf7tLjuC`(App ID 4577134) | §1.2 记下的 Client ID |
| `PROTOCOL_ACTION` | `covault` | 后端 `apps.json` 的 `protocolAction` 与 callback 路径 |

Client ID 是公开信息(出现在授权 URL 里),可以安全入库。

改动这些常量必须:**同一个发版里一次改完** → 发布 → 公告「请点一次 Connect 重新连接」。KMS key 或 App 换了以后旧 session 解不开,也不该迁移。

---

## 4. 本地安装配置(每个成员)

### 4.1 安装插件

- **推荐**:Obsidian → 设置 → 第三方插件 → 浏览社区插件 → 搜 "Covault" → 安装 → 启用。之后自动更新。
- **手动/内部分发**:把 `main.js`、`manifest.json`、`styles.css` 放进
  `<vault>/.obsidian/plugins/covault/`,重启 Obsidian 后启用。
- 插件是 `isDesktopOnly`,只在桌面版工作;要求 Obsidian ≥ 1.13.0。
- **版本基线 ≥ 0.2.8**,这是硬要求:0.2.5 之前的客户端不认识 LFS 指针,会把图片显示成 130 字节的文本。

### 4.2 连接 GitHub

设置 → Covault → GitHub:

1. **Sign in with** 选 `GitHub App`(默认)。
2. 若 org 还没装过 App,先点 **Install on GitHub**(可能需要 owner 审批)。
3. 点 **Connect** → 浏览器里授权 → 自动跳回 Obsidian,设置页显示 `Connected as @<login>`,下面一行列出可访问的组织。
4. 组织列表不对时点 🔄 **Refresh organizations**;要换账号点 **Disconnect** 再连。

> **PAT 兜底(高级)**:Sign in with 切到 `Personal Access Token`,粘一个有 repo 权限的
> `ghp_…` / `github_pat_…`。PAT 模式下加库要手工粘仓库地址,没有组织下拉。仅在 App 不可用时用。

### 4.3 提交身份

**Name** / **Email**:同事在历史里看到的作者信息。留空则从 GitHub login 推导。

### 4.4 加入团队知识库

- 设置页 **Shared libraries → Add a library…**,或命令面板 `Covault: Add a shared library`。
- 三步:**选组织**(每次都要手动选,没有默认组织)→ 选仓库(或「Create a new library」)→ 选它在 vault 里的位置。
- 组织下拉里的 **Other… (paste a link)** 用于列表里没有的库:选它以后只需粘一个 GitHub 链接(如 `https://github.com/ct-kb/platform-kb`),组织和库名从链接里解析。

### 4.5 分享文件夹

右键任意文件夹 → **Share…**,弹窗里两个目的地:

- **My knowledge base**(默认):这个文件夹开始同步到你自己的个人知识库,同事拿不到。个人知识库还没建的话,这里直接引导你去建。
- **A new team library**:在 org 下建一个新库并上传这个文件夹。**组织必须手动选**,再填库名(默认 private)。

单个笔记右键只有 **Share to my knowledge base**(一个笔记成不了一个库)。

### 4.6 个人知识库(可选,默认不开)

设置 → Personal knowledge base → **Set up…**:

- **Use existing**:选 org 里已有的 `personal-kb-<你>`,远端内容为准拉下来,本地重名笔记留成 `(local copy <时间>)`。
- **Create**:新建一个,你标记过的笔记成为首个提交。
- **What to back up** 两种口径:
  - `Only notes I mark`(默认):**什么都不上传**,直到你右键笔记/文件夹选 **Share to my knowledge base**。已标记的清单在 **Manage…** 里管理。
  - `Everything in this vault`:整个 vault 备份到个人 repo。

### 4.7 AI 引擎

设置 → AI engine:

- **Provider** → **Model** → **API key**(20+ provider 可选)。key 存在本机 OS 用户目录,**不在 vault 里**。
- 需要自建/网关端点时,Provider 选 custom,填 **Endpoint**(OpenAI 兼容 baseURL)+ **Model name**,模型能读图就勾 **This model can read images**。
- **Connected services (MCP)**:可选,JSON 配置外部服务(同 Claude Desktop 的 `mcpServers` 结构);**Service status** 里 Check / Sign in 验证连通。
  - `url` 型远端服务点 **Sign in** 走 OAuth;`command` 型本地服务(`npx`、`uvx`)由插件用你登录 shell 的 PATH 启动,所以终端里能跑的命令这里也能跑,无需写绝对路径。真找不到时报错会告诉你用 `which <命令>` 填绝对路径。
  - `uvx pkg@latest` 首次运行要下载包,Check 可能要等一会儿;想省这一步就先在终端里跑一次同样的命令做缓存。
- **Skills**:Ask 直接复用本机 coding agent 的 Agent Skills,三家的目录都读,项目级优先:

  | | 项目级(本 vault) | 用户级(本机) |
  |---|---|---|
  | Claude Code | `.claude/skills` | `~/.claude/skills` |
  | pi | `.pi/skills` | `~/.pi/agent/skills`(认 `PI_CODING_AGENT_DIR`) |
  | Codex | `.codex/skills` | `~/.codex/skills`(认 `CODEX_HOME`) |

  标准 `SKILL.md` 格式,无需为 Covault 改写;同名以项目级为准。system prompt 只带 name + description,模型判断用得上时再用 `load_skill` 取正文(以及 skill 目录里被引用的附件)。每次提问重新扫盘,所以中途新写的 skill 下一问就生效。Codex 预装在 `~/.codex/skills/.system` 下的内置 skill 会跳过(它们依赖 Codex 自己的工具)。
- **Let AI assistants discover your libraries**:默认开。把库地图写成一个标准 skill 放进 `.claude/skills/team-knowledge/SKILL.md`、`.pi/skills/team-knowledge/SKILL.md` 与 `.codex/skills/team-knowledge/SKILL.md`,并在 AGENTS.md / CLAUDE.md 的托管块里指向它——Claude Code、pi 这些在 vault 里干活的 agent 于是自己就知道哪个库答哪类问题。这几个 skill 文件是**派生数据**(每台机器各自重建、随同步排除),你自己放在同目录下的 skill 不受影响,照常同步。关掉则连块带文件一起删干净;插件自己的 Ask 不受影响(它的地图在内存里现算)。
- **Ask before the agent acts**:默认开。关掉等于放开审批——命令、外部服务、笔记编辑都不再询问。合规口径上建议保持开启。
- 没配 AI 也能用:同步照常,只是冲突不会自动合并,全部浮到人工界面。

### 4.8 同步

- **Keep shared knowledge up to date automatically**:默认开。
- **Check every**:默认 10 分钟。
- 想立刻同步:命令面板 `Covault: Sync shared libraries now`。

### 4.9 凭证与文件落在哪

| 内容 | 位置 |
|---|---|
| 后端 session、deviceId、PAT、LLM key | `<OS 用户配置目录>/covault/vault-<vault 路径哈希>.json` |
| 非敏感的机器状态 | `<vault>/.obsidian/plugins/covault/data.json` |
| 库清单 / 个人库范围 | `<vault>/.covault/covault.json`(随 vault 同步) |

OS 用户配置目录:macOS `~/Library/Application Support/`、Windows `%APPDATA%`、Linux `$XDG_CONFIG_HOME`(默认 `~/.config`)。**一个 vault 一个密钥文件,永不进 vault、永不同步。**

### 4.10 配置第二台机器 / 帮同事配

设置 → **Export / import configuration**:

- 老机器点 **Copy to clipboard**(命令面板同名命令也行),把 JSON 发给自己/同事。
- 新机器点 **Import…**,确认要写入的字段。
- 导出的:AI provider/model、同步设置、Ask 设置、库清单、个人库范围。
- **不导出/不导入的**:API key、PAT、后端 session、deviceId、提交身份(name/email)、别人的个人库地址、登录方式、组织(每个库自己选)。MCP 配置里的 env 值会被打码,打码过的不会被导入。

所以新机器上仍需自己做的三件事:**Connect 一次、填 API key、填 name/email**。

---

## 5. 附件(Git LFS)

新装的客户端开箱即用:附件按扩展名自动转成 LFS 指针,字节走 LFS 存储,`.gitattributes` 由插件维护。

**存量库要跑一次迁移**:全员升级到 ≥ 0.2.8 之后,命令面板 → `Covault: Move existing attachments to Git LFS`。它把仓库当前版本里的原始二进制换成指针,**只改 tip,不重写历史**。

- 明确**不做历史重写**:force push 会打断所有人的克隆。历史里的旧 blob 只是占存储,不再增长。个别库体积不可接受再单独评估、单独公告。
- 验收:GitHub 上打开附件显示 "Stored with Git LFS";`.gitattributes` 就位;org 的 LFS 用量面板数字符合预期。

---

## 6. 端到端验证清单

装完照着走一遍,全绿再推广:

- [ ] 设置页显示 `Connected as @<login>`,组织列表包含公司 org
- [ ] Add a library 能列出 org 仓库,加一个库能 clone 下来
- [ ] 改一个笔记 → 等一轮同步 → GitHub 上看到提交(自己的库直推 / 别人的库出现 PR)
- [ ] 右键文件夹 Share… → 默认「My knowledge base」能分享成功;切到「A new team library」选 org 后,org 下出现新 repo,内容完整
- [ ] 两台机器同时改同一段 → 冲突被 AI 合并,或浮出三栏界面能选/能改
- [ ] 贴一张图片 → 推上去 → 另一台机器同步后能正常显示(GitHub 上显示 Stored with Git LFS)
- [ ] 存量库跑过 Move existing attachments to Git LFS
- [ ] 右键笔记 View history 能看到改动记录
- [ ] 双机同步后两边内容一致

---

## 7. 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 授权完成但没跳回 Obsidian | Callback URL / `BACKEND_BASE` / 域名三处不一致(§2.3) |
| 提示 session 失效、要求重连 | session TTL 到期,或 refresh rotation 竞态(§2.5)。点一次 Connect |
| 组织列表为空 | App 没装到 org,或 owner 未审批 → Install on GitHub;装好后点 Refresh |
| 看不到某个仓库 | App 安装时的仓库范围没包含它 → Configure on GitHub 里加 |
| 图片显示成一段 130 字节文本 | 该客户端版本 < 0.2.5,升级到 ≥ 0.2.8 |
| 整个 org 突然推不上去 | LFS 额度超限 + org 没有支付方式(§1.1) |
| 其他任何问题 | 命令面板 → `Covault: Copy the diagnostic log`,把日志贴给支持 |

---

## 附录 A:命令面板一览

| 命令 | 用途 |
|---|---|
| Open panel | 侧边栏:分享了什么、拉了哪些库、同步状态 |
| Sync shared libraries now | 立刻同步 |
| Add a shared library | 加库向导 |
| Resolve conflicts | 打开待处理的内容出入 |
| Export configuration (copy to clipboard) | 导出配置(§4.10) |
| Ask your knowledge base | 基于知识库提问 |
| Write AI descriptions for libraries | 给库生成 AI 描述 |
| Update the AI knowledge skill | 刷新 AGENTS.md/CLAUDE.md 块与 team-knowledge skill(§4.7) |
| Move existing attachments to Git LFS | 存量附件迁移(§5) |
| Copy the diagnostic log / Clear the diagnostic log | 诊断日志 |

---

## 附录 B:从个人基础设施迁移到公司资产

现状盘点:GitHub App **Covault-CT** 注册在个人名下;授权后端跑在个人 AWS 账号
(`EasySyncBackend-prod`,域名 `sync.zhiyu-online.com`,与 agentic-git-sync 共用);
团队库在 `ct-kb` org;个人知识库示例在个人账号下。要变成可全员推广的公司资产,还差:

**B.1 App 归属**——二选一:
- 把 Covault-CT **transfer 给公司 org**(GitHub 支持 App 所有权转移,App ID/凭证不变,风险最小);
- 或在 org 下**新注册**(新 client id/secret/pem → 后端 Secrets Manager 更新 + 插件常量改 + 发版;全员重连)。

**B.2 后端迁移**——按 §2 在公司 AWS 账号部署一套。源码现在 `/Users/jakobhe/github/zhiyu-sync`,
先迁入公司代码托管并补 IaC 化部署文档。与 agentic-git-sync **解耦**:个人插件继续用旧栈,公司栈只放 covault 的凭证(`apps.covault`)。**会话不迁移**,计划一次全员重连并提前通知。

**B.3 存量清理**——删除历史事故遗留的 repo(全量误推的 `personal-kb-leweii`、`cb-business-kb`;
改名残留的 `team-wonderlocal-kb`);各团队库检查远端有无旧版 `.covault/manifest.json` 残留;
个人知识库统一迁到 org 下。

**B.4 分发与版本管理**——官方市场(已收录,自动更新)为主;若公司要控版本,评估 BRAT/内部分发 + 固定版本号。版本基线全员 ≥ 0.2.8。

**B.5 LLM 层决策**——
- **数据出境评估**:冲突合并会把冲突 hunk ± 上下文发给所配置的 LLM;Ask 会发问题和检索到的笔记片段。需要指定允许的 provider、签数据处理/零留存协议,或走公司代理端点。
- key 管理:公司统一 key(经代理分发)还是成员各自配?当前设计是本机各配、存 vault 外。
- Ask 的 MCP / 命令执行能力是否要求默认关审批(§4.7)。
- 注意:**当前没有团队级合并规则下发机制**(`settings.llm` 只有 provider/model)。若合规要求下发术语表、「事实矛盾必须人工」这类规则,需要新增需求。

**B.6 安全与合规审阅**——数据流文档(笔记 → 公司 GitHub;冲突片段 → 指定 LLM;凭证 → 仅 OS 用户目录,后端只存加密 refresh token);token 按 repositoryIds 收窄、设备绑定、session TTL 的现状评审;发布链完整性(GitHub Actions release + build provenance attestation,已有)。

**B.7 推广**——非工程用户的截图版 onboarding(§4 的简化版)、支持渠道 + 让用户贴诊断日志的路径、选 1–2 个团队试点两周(按 §6 验收),全绿再全员。

**建议顺序**:B.2 + B.1(基础设施,一次发版切换,全员重连一次)→ B.4 + B.5(推广前置)→
B.7 试点 → §5 存量附件迁移 → 全员推广;B.6 全程并行。
