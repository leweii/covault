# Covault 技术文档

> Covault 是一个 Obsidian 插件:让完全不懂 git 的团队成员,通过静默同步的共享文件夹来共享和消费团队知识。本文梳理它用了哪些技术、为什么这么选、各层如何协作。产品定位与决策史见 [DESIGN.md](../DESIGN.md)。

## 总览

```
┌─────────────────────── Obsidian (Electron, desktop-only) ───────────────────────┐
│  Covault 插件 (TypeScript 5 strict / ES2022, esbuild 打包为单文件 main.js)        │
│                                                                                  │
│  UI 层        CovaultPanel · 设置页(声明式 API) · ConflictModal · FileHistory   │
│  同步层       SyncController(定时静默轮询 · per-repo 锁 · watchdog · 续轮)      │
│  git 引擎     GitEngine(isomorphic-git 封装 · LFS clean/smudge · 冲突管道)      │
│  智能层       pi sdk(冲突合并 · Ask 问答 · commit message)                      │
│  授权层       AppAuth(GitHub App session / PAT 双模)                            │
└────────┬──────────────────────┬───────────────────────────┬─────────────────────┘
         │ git smart-HTTP        │ HTTPS                      │ HTTPS
         ▼                       ▼                            ▼
   GitHub repos + LFS      zhiyu-sync 后端                LLM providers
   (ct-kb org / 个人库)     (AWS Lambda, 铸短时 token)     (Anthropic/OpenAI/…)
```

三个外部依赖:**GitHub** 是唯一的数据后端(仓库 + LFS 对象存储),**zhiyu-sync** 只管授权(不经手任何笔记内容),**LLM provider** 只在冲突合并和问答时被调用。

## 客户端形态

- **Obsidian 插件**,desktop-only。放弃移动端换来的红利:直接使用 Node 的 `fs`/`crypto`/`http(s)`/`child_process`,不需要 vault adapter 桥接层。
- **TypeScript 5(strict)+ ES2022**,esbuild 打包 + minify,产物是单个 `main.js`(约 2MB)。
- 设置页使用 Obsidian 1.13 的**声明式设置 API**(`getSettingDefinitions`,支持设置搜索)。
- 凭证(GitHub session、LLM key)存在 **vault 之外**的 OS 用户配置目录(`~/Library/Application Support/covault/`,按 vault 路径哈希分文件)——vault 常被 iCloud/Obsidian Sync 多机同步,机密绝不能跟着走。诊断日志同理放 vault 外。

## Git 层:isomorphic-git

**为什么不是 simple-git / 系统 git**:不能要求非工程用户安装 git。isomorphic-git 是纯 JS 实现,随插件打包,零外部依赖。

- **传输**:自研 `nodeHttp`(`src/git/nodeHttp.ts`),基于 Node http/https 的流式客户端。核心是**空闲 watchdog 而非墙钟超时**——限制的是"多久没有字节流动",不是"总共花了多久":
  - 响应侧:仅在有 read 挂起时计时,响应结束即解除(否则 keep-alive 空闲会误杀已完成的响应);
  - 请求侧:大 body(push 的 packfile、LFS 上传)按 256KB 分块、drain 事件步进重置 watchdog;`write()`/`end()` 返回只代表 OS 收下字节,内核缓冲可囤数 MB 不可观测,所以等待窗口按剩余体量放宽(50KB/s 保底速率,10 分钟封顶)。
- **repo 模型:manifest + 虚拟 submodule**。团队库是 vault 子文件夹里的**独立嵌套 repo**,主库通过托管的 `.gitignore` 块屏蔽它们(不用真 submodule/subtree——gitlink 对非工程用户是事故源)。清单是 `.covault/covault.json`(注意不叫 manifest.json,那个名字会触发 Obsidian 扫描器误报),随主库同步传播。
- **个人主库用分离 gitdir**:`<vault>/.covault/main.git`,工作区是 vault 根。这样与 vault 自身可能存在的 `.git`(其他工具)完全隔离,也保证从零 init 的库只包含 opt-in 内容。
- **opt-in 白名单在引擎层实现**(statusMatrix filter 的 include/exclude),不玩 .gitignore 取反。
- **首次下载 depth=1**:知识库在 head 上读写,历史按需(`fileLog`)加深;350MB 历史曾让首次设置直接失败。
- 已知坑的防御:statusMatrix 嵌套库误报(#761,按清单排除)、merge 成功后必须显式 checkout 落盘、origin 劫持守卫(`existingOrigin` + `sameRemote`)。

## 附件:Git LFS

二进制是 git 仓库变重的根源(每版一个完整 blob、历史只增不减、人人陪葬下载)。Covault 采用**标准 Git LFS**:仓库里只存 ~130 字节的文本指针,字节存 GitHub 的 LFS 存储,按需取。

isomorphic-git 没有 clean/smudge filter,转换在 GitEngine 的每个内容出入口手工完成(`src/git/lfs.ts` 提供指针格式、sha256、batch 客户端):

| 环节 | 做法 |
|---|---|
| 入库(clean) | `stage()`:按扩展名判定附件 → sha256 → 字节存 `gitdir/lfs/objects/`(与 git-lfs 同布局)→ `writeBlob` 指针 + `updateIndex({oid})` |
| 出库(smudge) | clone/adopt/fast-forward/merge/discard 之后 + 每轮同步开头的修复扫描;本地缓存优先,缺的走 batch 下载并校验 sha256 |
| 推送顺序 | **上传先于 push**:tip 引用的对象先 batch 上传,全部可解析后才推指针——仓库里永远不会出现死指针 |
| 上传节流 | 50 对象一批现取预签名 URL(GitHub 的 URL 15 分钟过期,一次性全取队尾必 403)、4 路并发、每轮 256MB 预算;预算耗尽则推迟 push,`SyncResult.lfsPending` 上报,控制器在 pending 递减时自动续轮 |
| status 静默 | 物化后的附件与指针字节永远不同,`localChanges` 用指针等价判断(sha256 + mtime 缓存)过滤;checkout 类操作前 `dematerialize()` 临时还原指针,避免 isomorphic-git 误判脏文件 |
| 冲突 | 像素没有"合并"可言:附件冲突自动保留本地版本(对方版本在历史里),不进 LLM 管道 |
| 互操作 | 指针格式 + 托管 `.gitattributes` 块都是标准 git-lfs,命令行 git + git-lfs 的用户看到完全一致的行为 |

实战教训(已固化进测试):GitHub 对**无 User-Agent 的请求一律 403**(`lfs.github.com` 的 verify 端点强制);S3 PUT 成功但 verify 未过的对象仍算"不存在",所以任何失败都可安全重试;存量原始 blob 由「Move existing attachments to Git LFS」命令一次性转换(只改 tip,不重写历史)。

## GitHub 集成与授权

- **GitHub App**(slug `covault-ct`)+ **zhiyu-sync 后端**。插件从不持有长期凭证:
  1. 用户点 Connect → 浏览器 OAuth → 后端回调 → 插件经 `obsidian://covault` 协议拿到 session;
  2. 后端把 **refresh token 用 KMS 加密**存 DynamoDB(90 天 TTL),每 10 分钟重验证;
  3. 同步时插件向后端换**短时 installation token**,默认按 session 缓存的 repositoryIds 收窄权限;建库场景用不收窄的 `scope:"installation"` token(解决空 org 鸡生蛋)。
- 后端是 **AWS 无服务器**:API Gateway HTTP API + 每路由一个 Lambda + DynamoDB + Secrets Manager(多 App 凭证按 `apps.<slug>` 存放,同时服务姊妹插件 agentic-git-sync)。
- git 传输与 REST API(建库、列库、加协作者)共用同一个 TokenProvider 抽象;PAT 模式作为高级用户的后备,与 App 模式可在设置页互斥切换。
- **推送策略是权限驱动的**:能直推默认分支就静默直推;org 侧用分支保护 + bypass 名单定义"谁的库"——插件端零配置。

## 智能层:pi sdk

- 基座:`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`。provider 是**精选列表**(Anthropic/OpenAI/DeepSeek/Groq/OpenRouter/xAI/Mistral 等十余家,刻意排除 Google/Vertex/Bedrock——它们的 SDK 会触发 Obsidian 扫描器的身份探测警告,还让 bundle 膨胀 2MB)。
- **冲突解决**(`src/llm/resolver.ts`):系统唯一内置 prompt。按 hunk 调用,返回 merged + confidence(0–5)+ reasoning;**全部 hunk ≥3 分才静默应用**,否则进 ConflictModal 三栏人工评审。内置启发式:事实矛盾且无证据时不许猜,保持本地版并说明需人工决策;团队可通过设置追加自定义规则。
- **Ask 问答**:面板内直接问知识库,带 MCP server 接入、本机 CLI 探测(agent 可 run_command)、路由 skill(自动维护各库的描述,告诉 agent 什么问题去哪个库找)。
- **transport 诊断**:给 pi-ai 注入自定义 fetch,把 provider SDK 吞掉的失败原因(代理拒绝 CONNECT、TLS 拦截、DNS、区域封锁)还原成人话,并写入诊断日志;CORS 吞掉状态码的场景用免 CORS 的二次探测补全。

## 同步引擎

`SyncController`(`src/sync/SyncController.ts`)拥有一切用户可见状态(状态栏、Notice、面板),GitEngine 只管 git:

- **定时静默轮询**(默认 10 分钟),一轮 sweep 顺序处理各库(并发只会互相拖慢共享连接);单库手动同步可与 sweep 并行,同一库自身靠 per-repo 锁互斥。
- 每轮的形状:修复扫描(smudge)→ 本地变更提交 → fetch → fast-forward / push / merge → 冲突进管道。
- **watchdog**:每轮 10 分钟上限,防的是"卡死的轮永远持锁";附件积压走**预算续轮**——每轮有界、上传持久、pending 必须递减,不减即真停滞报错。
- 冲突文件的兜底:带冲突标记的文件永远不会被当作"编辑"推送(重启丢失内存状态后会重新入管道)。

## UI

- **右侧面板**(`CovaultPanel`):My knowledge base / Team libraries 两区(行内增删、同步状态灯)+ 当前笔记的提交历史区(可拖拽调高、可折叠)。
- **ConflictModal**:本地/远端/AI 建议三栏 diff(`diff` 包渲染),置信度标点、手动编辑、汇总页。
- **FileHistoryModal**:文件右键看历史,commit 列表 + 范围 diff。
- 语言原则:**UI 零 git 术语**——share / update / resolve,不说 commit / branch / merge。

## 测试与发布

- **vitest**,250+ 测试。集成测试的关键基建在 `test/gitHttpServer.ts`:一个 Node HTTP 服务器,CGI 方式调系统 `git http-backend` 当真实远端,并附带**迷你 LFS 服务器**(batch 端点 + 对象存储 + 要求带认证的 verify 端点)——引擎的全部同步/LFS 行为都对着真 git 协议验证,不 mock。
- **`test/loadHarness.cjs` 冒烟测试**(并入 build):用 mock Obsidian 驱动真实构建产物走完 onload + 声明式设置索引——纯 require 测不出 onload 期崩溃,这个能。
- **发布**:tag 触发 GitHub Actions(`release.yml`),产出 `main.js`/`manifest.json`/`styles.css` 三资产 + build provenance attestation;已上架 Obsidian 官方市场(id `covault`)。

## 依赖清单(运行时)

| 依赖 | 用途 |
|---|---|
| `isomorphic-git` | 纯 JS git 实现 |
| `@earendil-works/pi-ai` / `pi-agent-core` | LLM 抽象与 agent 循环 |
| `@modelcontextprotocol/sdk` | Ask 的 MCP server 接入 |
| `diff` | 冲突/历史界面的 diff 渲染 |

其余全部来自 Node 内置模块与 Obsidian API。GitHub LFS、zhiyu-sync 后端、LLM API 是仅有的三个网络依赖。
