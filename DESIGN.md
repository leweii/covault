# Covault — 设计文档

> 企业知识库管理的 Obsidian 客户端插件。让非工程人员在完全不理解 git 的情况下，
> 参与公司知识的生产、共享、消费和迭代。
>
> 背景与理念见《企业内部对知识文档的集中式管理》（jakobhe/myknowledge）。
> 本文档记录 2026-08-13 与 Jakob 确认的全部架构决策。

## 1. 产品定位

- **一句话**：本地自由生产 → 标记共享 → 静默同步至 GitHub org → 他人自动拉取消费 → 修改自动走直推/PR 迭代。
- **目标用户**：公司全员，以非工程人员为主。UI 中禁止出现 git 概念
  （commit / branch / PR / conflict 一律翻译成「共享 / 更新 / 提交修改 / 内容出入」等知识库语言）。
- **MVP 范围**：纯插件（原文 Option 2），无云端知识加工 Agent。架构为未来云端 Agent 留接口。

## 2. 已确认的架构决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 插件名 | **Covault**（id: `covault`） | co-(协作) + vault；已验证在官方商店 6609 个插件中名称与 ID 唯一 |
| 分发 | Obsidian 官方市场 | 上架流程已自动化；对非工程用户安装门槛最低 |
| Repo 结构 | **manifest + 虚拟 submodule** | 见 §3；不用真 submodule（isomorphic-git 不支持、对非工程用户不友好） |
| Git 引擎 | **isomorphic-git**（纯 JS） | 用户零依赖——要求非工程人员装 git 与产品定位矛盾。不用 simple-git |
| 智能层 | **pi sdk**（`@earendil-works/pi-ai` + `pi-agent-core`，MIT） | agent 接管全部 git 语义：冲突解决、commit message、PR 描述、异常状态恢复 |
| LLM Provider | 跟随 pi sdk 全量支持 | 设置页用 `getProviders()` / `getModels()` 动态渲染；支持自定义 OpenAI 兼容 baseURL |
| GitHub 授权 | GitHub App + 自建后端（移植 agentic-git-sync 方案） | 新注册 Covault App；后端 zhiyu-online 扩展多 App 支持；PAT 作高级兜底 |
| 提交策略 | **权限驱动**：能直推 main 的库静默直推，否则静默建分支 + PR | 「自己的库」由 GitHub 分支保护 bypass 名单定义，插件零配置，见 §5 |

## 3. Repo 模型：manifest + 虚拟 submodule

```
vault/                        ← 主 repo（个人知识库，可选同步到个人 repo）
├── .covault/manifest.json    ← 子库清单：路径 → { url, branch }
├── .gitignore                ← 自动维护：排除所有子库路径
├── 我的笔记/...               ← 个人内容
├── teams/platform-kb/        ← 嵌套独立 repo（团队知识库 A）
│   └── .git/
└── teams/data-kb/            ← 嵌套独立 repo（团队知识库 B）
    └── .git/
```

- 每个团队知识库是 org 下**完全独立的 repo**，clone 在 vault 的子文件夹里；
  主 repo 通过 `.gitignore` 排除这些路径（插件自动维护，并校验 index 中无 160000 gitlink 残留）。
- 主 repo 与子库完全解耦：各自独立 fetch/merge/push，一个库出错不影响其他。
- **manifest 参与同步**：主 repo pull 到新的 manifest 条目 → 插件自动 clone 新团队库；
  团队给全组挂新库，成员无感知获得。
- 子库跟踪分支（不 pin SHA）——这是活的协作库，不是 vendored 依赖。
- 先例：Google repo / meta(Node) / west / tsrc / vdm。真 submodule、git subtree、git-subrepo 均已调研排除。

### manifest.json 草案

```json
{
  "version": 1,
  "repos": [
    { "path": "teams/platform-kb", "url": "https://github.com/chancetop/platform-kb.git", "branch": "main" }
  ]
}
```

## 4. Git 引擎：isomorphic-git

- 版本参考 v1.41+（2026-08 仍活跃发版）。HTTPS smart protocol only（无 SSH，我们用 token 走 HTTPS 正好）。
- **HTTP 层**：自定义 http client 走 Obsidian `requestUrl`（绕 CORS、无需代理）；
  注意 obsidian-git 的先例：强制 `Accept-Encoding: identity` 并手动处理 gzip，避免 packfile 损坏。
- **fs 层**：适配器桥接 Obsidian vault adapter（参考 obsidian-git `myAdapter.ts`）。
- **merge 策略**：fetch + fastForward 优先；有分歧时 `merge({ abortOnConflict: false })` 写入冲突标记，
  交给 pi agent 做语义合并（见 §6）。不依赖 rebase（isomorphic-git 不支持）。
- 大库风险缓解：知识库以 markdown 为主天然小；用 shallow clone（`depth`）+ 按需 fetch。
- 已知坑：statusMatrix 会把嵌套子库内文件报成 new（issue #761）——status 扫描必须按 manifest 排除子库路径；
  clone 指定 commit 有怪癖（#1160），我们跟踪分支所以不受影响。

### 4.1 附件：Git LFS（2026-08-28 定稿）

二进制附件不进 git 历史：仓库里只存 LFS 指针（130 字节文本），字节走 LFS batch API
存到远端的 LFS 存储（现为 GitHub LFS，协议开放、后端可换成自建）。格式采用标准
git-lfs 指针 + 托管 `.gitattributes` 块，CLI 上装了 git-lfs 的同事看到完全一致的行为。

isomorphic-git 没有 clean/smudge filter，转换在 GitEngine 的每个内容出入口手工完成
（`src/git/lfs.ts` 提供指针格式/哈希/batch 客户端）：

- **clean（入 index）**：`stage()` 对附件扩展名（extension-based，与 .gitattributes 可表达性对齐）
  算 sha256 → 字节存 `gitdir/lfs/objects/`（与 git-lfs 同布局）→ `writeBlob` 指针 + `updateIndex({oid})`。
- **smudge（出工作区）**：clone/adopt/fast-forward/merge/discard 之后 + 每轮同步开头的修复扫描,
  指针文件先查本地缓存、缺的走一次 batch 下载(sha256 校验)。
- **上传先于 push**：`push()` 先把分支 tip 引用的对象 batch 上传——仓库里永远不会出现
  无法解析的死指针。内容寻址天然去重，重复分享零上传。
- **status 静默**：物化后的附件与 HEAD 指针永远"不同"，localChanges 用指针等价
  （sha256 + mtime 缓存）过滤;checkout 类操作前先 `dematerialize()` 还原成指针避免
  CheckoutConflictError，事后再 smudge。
- **冲突**：附件冲突不进 LLM/手工管道，自动保留本地版本（对方版本在历史里），
  仅笔记冲突继续走原管道。
- 计费：org 为 Team/Enterprise 时 GitHub LFS 免费额度 250 GiB 存储 + 250 GiB/月带宽，
  org 需绑卡设 budget（无支付方式时超额直接锁读写）。

## 5. 同步与提交策略

后台定时循环（可配置间隔），对主 repo 和每个子库独立执行：

1. **本地无改动**：fetch + fast-forward，完全静默（消费者常态）。
2. **本地有改动、无冲突**：自动 commit（message 由 agent 生成）→ merge → 推送，静默。
3. **真冲突**：agent 拿冲突双方 + 上下文做语义合并；低置信度时才浮出 UI，
   用非 git 语言呈现（「这段内容你和 XX 的修改有出入」），用户选择或编辑。

**推送方向（权限驱动，插件零配置）**：

- org 惯例：所有成员对所有知识库 repo 有 write（能推分支，建 PR 无需 fork）；
  每个库的 `main` 开分支保护，本团队的 GitHub Team 进直推 bypass 名单。
- 插件每库问一次 API「我能否直推默认分支」：
  能 → 静默直推；不能 → agent 静默建分支 + 开 PR（标题/描述 agent 生成）。
- 「自己的库」= 团队管理员把你加进了直推名单，纯 org 侧管理动作。

## 6. 智能层：pi sdk

- 包：`@earendil-works/pi-ai`（统一 LLM API，20+ provider + 任意 OpenAI 兼容端点）、
  `@earendil-works/pi-agent-core`（Agent 类、TypeBox 工具 schema、事件流）。
  注意用 earendil-works scope（`@mariozechner/*` 已冻结）。
- 浏览器/Electron renderer 官方支持（显式传 apiKey）；Bedrock 与 OAuth 登录流 Node-only，desktop 无碍。
- **Agent 职责**：与 git 相关的一切——冲突语义合并、commit message、PR 标题/描述、
  仓库异常状态诊断与恢复。工具集 = 封装好的 isomorphic-git 操作 + 文件读写（限 vault 内）。
- **设置页**：provider 下拉（`getProviders()`）→ model 下拉（`getModels(provider)`）→
  apiKey（按 provider 存储）→ 可选自定义 baseURL。参考 agentic-git-sync 的 AIProviderSetupModal 交互。

## 7. GitHub 授权（移植 agentic-git-sync）

流程：Connect → 浏览器 GitHub OAuth（state = nonce + sha256(deviceId)，nonce 10min TTL）→
后端换 code、建设备绑定 session → `obsidian://covault` 深链回插件 → 校验 nonce、存 session →
按 repo owner 铸造短时效 installation token（缓存、到期前 5min 刷新、失效自动清理提示重连）。

- 新注册 GitHub App：slug `covault`，深链 action `covault`；后端扩展为多 App 配置。
- 移植模块：`auth/constants.ts`、`auth/BackendClient.ts`、`auth/TokenProvider.ts`、`auth/AppAuth.ts`
  （TokenProvider 抽象保留 PAT 模式作高级兜底）。
- token 消费点：isomorphic-git 的 `onAuth` 回调 + GitHub REST（repo 列表、权限探测、PR 创建）。

## 8. 用户旅程（MVP 验收基准）

1. **首次使用**：装插件 → 设置页 Connect GitHub（浏览器点一下授权）→ 配 LLM provider/key →
   从「有权限的 repo 下拉列表」挑团队知识库加入 vault（自动 clone 到指定文件夹）。
2. **消费**：什么都不做，知识库静默保持更新。
3. **贡献**：像编辑普通笔记一样修改/新增；插件按 §5 静默提交（直推或 PR）。
4. **共享新库**：标记某个文件夹 → 插件在 org 下建 repo、首推、写入团队 manifest。
5. 全程 UI 无 git 术语；冲突极少数情况下浮出，一句话 + 两个按钮解决。

## 9. 工程

- 语言/构建：TypeScript + esbuild（Obsidian 插件标准）；desktop 优先（`isDesktopOnly: true` 起步，
  isomorphic-git 为未来移动端留了可能性）。
- 结构参考 agentic-git-sync：`src/{auth,git,ai,ui,config,observability}`，vitest 单测 + obsidian stub。
- 发布：GitHub Actions release 流水线（参考现有 release.yml），上架官方市场。

## 10. 里程碑

- **M1 骨架**：插件脚手架、设置页（provider/key/model）、GitHub Connect 全流程打通。
- **M2 单库同步**：isomorphic-git 引擎（requestUrl http + vault fs）、clone/pull/push 单个团队库、
  定时静默同步、agent 生成 commit message。
- **M3 多库 + manifest**：虚拟 submodule 全流程（加库/建库/manifest 传播/gitignore 维护）。
- **M4 智能闭环**：冲突语义合并、权限探测 + 自动 PR、异常状态恢复。
- **M5 上架**：i18n（中/英）、文档、审核提交。

## 附录：调研档案（2026-08-13）

- isomorphic-git v1.41.3：无 submodule API；v1.36.0 起支持「在已 checkout 的 submodule 内跑命令」；
  gitlink 可手工 updateIndex(mode 0o160000)；statusMatrix 忽略 gitlink 但有 #761 坑。
- obsidian-git v2.39.0：桌面 simple-git / 移动 isomorphic-git 双后端；移动端自评 unstable；
  requestUrl http client + gunzip 处理是关键先例。
- 多 repo 组合：manifest 模式为业界共识（repo/meta/west/tsrc/vdm）；subtree/subrepo 历史纠缠且无 JS 实现。
- pi sdk：earendil-works/pi（88.7k stars，MIT），v0.84.1；浏览器官方支持；
  `AgentTool`（TypeBox schema）+ `new Agent({...})` 可嵌入。
- 备选引擎（已排除）：wasm-git（半成熟、HTTP 层难接 requestUrl）、es-git（原生模块无法随插件分发）。
