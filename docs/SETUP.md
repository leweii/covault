# Covault 安装配置指南

> 从零把 Covault 跑起来所需的全部配置,分三层:
> **GitHub 侧**(org 管理员做一次)→ **授权后端**(平台负责人做一次)→ **本地**(每个成员各做一次)。
> 附录 B 是「把现在跑在个人基础设施上的这套东西变成公司资产」的迁移清单。

## 0. 总览

```
Obsidian 桌面版 + Covault 插件            ← 每个人的机器
   ├─ 笔记内容 ────────────→ 公司 GitHub org 的知识库 repo(附件走 Git LFS)
   ├─ 短时 installation token ← 授权后端(只存 KMS 加密的 refresh token)
   └─ 冲突片段 / 自动化 ───→ 成员各自配置的 LLM provider
```

**必须有的东西**

| 层 | 依赖 | 谁准备 |
|---|---|---|
| GitHub | 一个 org(Team/Enterprise 计划,已绑支付方式) | org 管理员 |
| GitHub | 一个 GitHub App(注册在该 org 名下) | org 管理员 |
| 后端 | 授权服务 zhiyu-sync 的一个部署 + 域名 + 证书 | 平台负责人 |
| 本地 | Obsidian 桌面版 ≥ **1.13.0**,Covault ≥ **0.2.8** | 每个成员 |
| 本地 | 一个 LLM provider 的 API key(可选,但 AI 冲突合并依赖它) | 每个成员或公司统一发放 |

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

- 设置页 **Shared libraries → Add a library…**,或工作台目录树标题旁的「+」。
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
- 需要自建/网关端点时,Provider 选 custom,填 **Endpoint**(OpenAI 兼容 baseURL)+ **Model name**。
- **Let AI assistants discover your libraries**:默认开。把库地图写成一个标准 skill 放进 `.claude/skills/team-knowledge/SKILL.md`、`.pi/skills/team-knowledge/SKILL.md` 与 `.codex/skills/team-knowledge/SKILL.md`——Claude Code、pi 这些在 vault 里干活的 agent 读 skill 时于是自己就知道哪个库答哪类问题。这几个 skill 文件是**派生数据**(每台机器各自重建、随同步排除),你自己放在同目录下的 skill 不受影响,照常同步。关掉则删干净。

  早先的版本还会在 vault 根目录的 AGENTS.md / CLAUDE.md 里维护一个托管块指向这个 skill。这部分已经去掉:插件不再写 vault 根目录的文件,升级后首次加载(以及之后每轮同步)会把旧的托管块清掉,块外你自己写的内容原样保留;文件里除了托管块什么都没有时,该文件一并删除。
- 没配 AI 也能用:同步照常,只是冲突不会自动合并,全部浮到人工界面。

### 4.8 同步

- **Keep shared knowledge up to date automatically**:默认开。
- **Check every**:默认 10 分钟。
- 想立刻同步:工作台右上角的 **Sync now**(跑完后下一次自动同步的倒计时重新开始),或点状态栏。
- **同步历史**:每轮同步——成功、失败、停在冲突——都记一条。文本版在 `<OS 用户配置目录>/covault/logs/<vault 哈希>/sync-history.log`,结构化版在同目录的 `sync-history.jsonl`(最近 500 条)。工作台的 **Sync log** 标签页分页查看,每条可展开看本机推上去的(↑)和同事带来的(↓,带作者),失败的那条有 **Fix with Claudian**。工作台见附录 A。

### 4.8.1 自动化(Automations)

工作台页脚 ⋯ 菜单里的 **Automations**(或 Jobs 标签页底部的链接)打开主区域的 **Automations** 标签页:左边是已设置的自动化,右边是对话框。

- **用对话设置**:直接说要做什么、多久做一次,比如「每天早上 9 点把团队库昨天的改动汇总到 Daily/团队日报.md」。AI 会先给出计划(名称、时间、给执行 agent 的说明),你同意后才创建;也能用对话修改、暂停、删除、试跑。
- **时间**:只支持「每隔 N 小时」(1–168)和「每天 HH:MM」(本机时间)。
- **执行**:到点由 pi agent 无人值守执行,可搜索、阅读、新建、编辑 vault 里**任意笔记**(包括团队库,改动随下一轮同步推给同事;git 历史可回退)。每次最多 30 步、10 分钟。用的是 AI engine 里配置的模型和 key。
- **只在 Obsidian 开着时运行**;关着(或电脑睡眠)时错过的那次**直接跳过**,日志里记一条「已跳过」。
- **日志**:点开某个自动化可看说明和运行日志;每次运行可展开看 AI 的报告、改了哪些笔记(可点开)、执行了哪些步骤。
- **在工作台里改**:工作台的 **Jobs** 标签页列出所有自动化(状态、下次运行倒计时、试跑、运行日志),每条的铅笔按钮可就地改名称、时间(每 N 小时 / 每天几点)、启用状态和说明;改时间或恢复启用后从当下重新计时。新建仍在 Automations 的对话里做。
- **存储**:自动化定义和日志都在 `<OS 用户配置目录>/covault/automations/`,按 vault 区分,**不进 vault、不同步**——否则每台设备都会各跑一遍。

### 4.8.2 推荐插件

工作台页脚 ⋯ 菜单和设置页顶部的 **Recommended plugins** 列出与 Covault 搭配的社区插件(目前是 Claudian、Knowlery),一键跳到 Obsidian 插件市场安装,装好后可直接启用。清单在 `src/covault/recommendedPlugins.ts`,追加一项即可。

### 4.9 凭证与文件落在哪

| 内容 | 位置 |
|---|---|
| 后端 session、deviceId、PAT、LLM key | `<OS 用户配置目录>/covault/vault-<vault 路径哈希>.json` |
| 非敏感的机器状态 | `<vault>/.obsidian/plugins/covault/data.json` |
| 库清单 / 个人库范围 | `<vault>/.covault/covault.json`(随 vault 同步) |
| 同步历史(文本 + JSONL)、诊断日志 | `<OS 用户配置目录>/covault/logs/<vault 哈希>/` |
| 自动化定义与运行日志 | `<OS 用户配置目录>/covault/automations/` |

OS 用户配置目录:macOS `~/Library/Application Support/`、Windows `%APPDATA%`、Linux `$XDG_CONFIG_HOME`(默认 `~/.config`)。**一个 vault 一个密钥文件,永不进 vault、永不同步。**

### 4.10 配置第二台机器 / 帮同事配

设置 → **Export / import configuration**:

- 老机器点 **Copy to clipboard**(工作台页脚 ⋯ 菜单里的 Export configuration 也行),把 JSON 发给自己/同事。
- 新机器点 **Import…**,确认要写入的字段。
- 导出的:AI provider/model、同步设置、文档状态列表(§4.11)、库清单、个人库范围。
- **不导出/不导入的**:API key、PAT、后端 session、deviceId、提交身份(name/email)、别人的个人库地址、登录方式、组织(每个库自己选)。

所以新机器上仍需自己做的三件事:**Connect 一次、填 API key、填 name/email**。

### 4.11 文档状态(Document statuses)

和 Covault 自动算出的同步状态(✓ ● ↑ ↓ !)不同,文档状态是**人设的**:默认 Draft / In review / Approved / Outdated,在 设置 → Covault → **Document statuses** 里增删、改名、改颜色,并随配置导出导入(§4.10),所以团队用同一套。

- 在工作台详情栏点一下即可设置或清除。它写进笔记 frontmatter 的三个字段:`status`(名称)、`status_by`、`status_at`(ISO 时间);Obsidian 自带的属性面板看到和修改的是同一个 `status`。
- 改状态等于一次普通编辑:笔记先变 ●,下次同步后变 ✓ 并到达同事那里。
- 目录树里按状态筛选、看彩色标签;名字不在团队列表里的状态显示为灰色。改名一个状态不会改已有笔记里的旧名字,它们会显示为灰色直到重新设置。

---

## 5. 附件(Git LFS)

**团队库里粘贴的附件放哪**:设置 → Covault → Attachments → **Attachment folder in libraries**(默认 `attachments`)。在任何团队库的笔记里粘贴或拖入文件,都会存到**该库根目录**下的这个文件夹,例如 `teams/team-cookbook-kb/attachments/`,于是附件随库同步给同事。库外的笔记仍按 Obsidian 自己的「新附件默认位置」。留空则完全交还 Obsidian 的设置。只影响新粘贴的附件,已有的不会移动。

新装的客户端开箱即用:附件按扩展名自动转成 LFS 指针,字节走 LFS 存储,`.gitattributes` 由插件维护。

**存量附件**:LFS 支持之前就已提交的原始二进制不会被批量迁移;某个附件下次被修改时,会在正常同步里自动转成指针。

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
| 某个库一直同步失败 | 工作台顶部的红色告警:**Retry**;仍不行就 **Open in Claudian**,让 Claude Code 在终端语境里把这个库的 commit / pull / push 做完(不会改写历史) |
| 其他任何问题 | 工作台页脚 ⋯ 菜单里的「Copy the diagnostic log」,把日志贴给支持 |

---

## 附录 A:工作台一览

命令面板(Cmd/Ctrl+P)只有一条 `Covault: Open workbench`(可在 设置 → 快捷键 里给它绑快捷键);左侧图标栏的书架图标也打开它。工作台是主区域里的一个全页标签页:

| 区域 | 内容 |
|---|---|
| 顶部 | 计数卡——同步失败的库、需要处理、未分享、同事新更新、Jobs——点击即筛选目录树或切到 Jobs;右侧是到下一次自动同步的倒计时环和 **Sync now**。同步进行中数字变转圈,卡片和告警都不消失 |
| Libraries | 收起是一行名称胶囊(有问题的排最前),展开是每库一张卡:状态、上次同步、笔记数、单库同步按钮 |
| 同步失败告警 | 失败几次、上次成功时间、报错(Details 展开);**Retry** 只重试这个库;**Open in Claudian** 打开 Claudian 新对话并把修复请求填好(不自动发送;Claudian 没装时复制到剪贴板并提示安装) |
| 需要处理的笔记 | 每篇冲突笔记一行,写明和谁冲突;**Resolve** 打开解决器并停在那篇;Resolve all |
| Sync log / Jobs | 同步轮次分页(每页 25),可展开看 ↑↓ 文件和作者;Jobs 列出自动化、下次运行倒计时、试跑、运行日志,铅笔按钮就地编辑(§4.8.1) |
| 目录树(左) | 每个库和个人库的文件夹树:文件带同步标记(✓ ● ↑ ↓ !)和文档状态标签,附件带回形针,文件夹带汇总徽标;两行筛选(同步状态 / 文档状态)+ 搜索,有筛选时全部展开、Collapse 置灰;双击或右键进 Time Machine;右键还有分享 / 停止分享 / 移除库 |
| 详情栏(右) | 点文件打开:编辑→保存→上传→同事 的进度轨道、文档状态选择(§4.11)、最后修改人、GitHub 上的版本、版本数、最近三次修改;Open note / Time machine / Resolve / Share now |
| Time Machine | 一篇笔记的全部版本按天分组;选中版本以文档形式显示并标出改动;勾选多个连续版本看合并改动,每行新增内容标注作者;**Restore** 把旧版本作为一次新修改写回,下次同步分享;浅克隆的库可 **Load older history** |
| 页脚 | 右下角状态("Everything is shared",或具体问题,同步中为 "Syncing…");左下角 ⋯ 菜单:Automations、Recommended plugins、Export configuration、Copy sync-history file path、Copy / Clear the diagnostic log |

左右两栏和 Time Machine 的时间轴都可拖边调宽(双击复原,宽度按设备记住)。另有:状态栏点击 = 有冲突时打开冲突界面、否则立刻同步;笔记/文件夹右键菜单里的分享、View history(进 Time Machine)。

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
- **数据出境评估**:冲突合并会把冲突 hunk ± 上下文发给所配置的 LLM;自动化会把它读到的笔记内容发给模型。需要指定允许的 provider、签数据处理/零留存协议,或走公司代理端点。
- key 管理:公司统一 key(经代理分发)还是成员各自配?当前设计是本机各配、存 vault 外。
- 注意:**当前没有团队级合并规则下发机制**(`settings.llm` 只有 provider/model)。若合规要求下发术语表、「事实矛盾必须人工」这类规则,需要新增需求。

**B.6 安全与合规审阅**——数据流文档(笔记 → 公司 GitHub;冲突片段 → 指定 LLM;凭证 → 仅 OS 用户目录,后端只存加密 refresh token);token 按 repositoryIds 收窄、设备绑定、session TTL 的现状评审;发布链完整性(GitHub Actions release + build provenance attestation,已有)。

**B.7 推广**——非工程用户的截图版 onboarding(§4 的简化版)、支持渠道 + 让用户贴诊断日志的路径、选 1–2 个团队试点两周(按 §6 验收),全绿再全员。

**建议顺序**:B.2 + B.1(基础设施,一次发版切换,全员重连一次)→ B.4 + B.5(推广前置)→
B.7 试点 → §5 存量附件迁移 → 全员推广;B.6 全程并行。
