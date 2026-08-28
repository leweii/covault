# Covault 公司化迁移清单

> 目标:把当前跑在个人基础设施上的整套系统(GitHub App、授权云端、仓库、运维)迁移为公司资产,达到可以全员推广的状态。
> 现状盘点:GitHub App **Covault-CT** 注册在个人名下;授权后端跑在个人 AWS 账号(`EasySyncBackend-prod`,域名 `sync.zhiyu-online.com`,与 agentic-git-sync 共用);团队库在 `ct-kb` org;个人知识库示例在个人账号下。

## 1. GitHub 侧(需要 org admin)

- [ ] **GitHub App 归属**:二选一——
  - 把 Covault-CT **transfer 给公司 org**(GitHub 支持 App 所有权转移,App ID/凭证不变,风险最小);
  - 或在 org 下**新注册**一个 App(新 client id/secret/pem → 后端 Secrets Manager 更新 + 插件 `constants.ts` 改 CLIENT_ID + 发版;所有用户需重连)。
- [ ] **确认 org 计划与 LFS 计费**:Team/Enterprise(LFS 免费额度 250GiB 存储 + 250GiB/月带宽);org 绑支付方式并设 LFS budget(**无支付方式时超额会直接锁死读写**)。
- [ ] **org 权限惯例落地**:成员对知识库 repo 默认 write(base permission);每个库的默认分支开分支保护,库的所属团队进直推 bypass 名单——这是"自己的库静默直推、别人的库走 PR"语义的全部来源,插件端零配置。
- [ ] **个人知识库归属策略**:统一建在 org 下(`personal-kb-<login>`,App 建库后加本人 admin,他人只读靠 base permission),不要像现在的示例一样放个人账号——离职回收、备份、计费都应归公司。
- [ ] **存量清理**:删除历史事故遗留的 repo(全量误推的 `personal-kb-leweii`、`cb-business-kb`;改名残留的 `team-wonderlocal-kb`);各团队库检查远端是否有旧版 `.covault/manifest.json` 残留。

## 2. 授权云端迁移(重点;需要公司 AWS 账号)

后端只做一件事:保管 KMS 加密的 refresh token、给插件铸短时 installation token。它**不经手任何笔记内容**,但它是全员登录的单点,必须公司化。

- [ ] 公司 AWS 账号内部署 zhiyu-sync 栈(API Gateway HTTP API + Lambda × 5 + DynamoDB sessions 表 90 天 TTL + Secrets Manager + KMS key)。源码现在 `/Users/jakobhe/github/zhiyu-sync`——先把它迁入公司代码托管,补 IaC 化部署文档。
- [ ] **公司域名 + 证书**:如 `covault-auth.<company>.com`(ACM + DNS);GitHub App 的 callback URL 同步改。
- [ ] 插件 `BACKEND_BASE` 常量指向新域名 → 发版。
- [ ] **会话不迁移**:KMS key 换了,旧 session 解不开也不该迁——计划一次"全员重连"(一次点击),提前通知。
- [ ] 与 agentic-git-sync **解耦**:个人插件继续用旧栈,公司栈只放 covault 的 App 凭证(`apps.covault`),互不影响。
- [ ] **修已知缺陷**:refresh token rotation 竞态(并发 mint 触发重验证 → 偶发 session_invalid 全员登出体验差)。给重验证加锁/重试后再上量。
- [ ] 运维基线:CloudWatch 告警(4xx/5xx 率、Lambda 错误)、日志保留期、IAM 最小权限、DynamoDB 备份(PITR)、指定 owner/on-call。

## 3. 插件分发与版本管理

- [ ] 版本基线:**全员 ≥ 0.2.8**。这是硬要求——0.2.5 之前的客户端不认识 LFS 指针,会把图片显示成 130 字节的文本(版本偏差问题)。
- [ ] 分发渠道:官方市场(已收录,自动更新)为主;若公司要控版本,评估 BRAT/内部分发 + 固定版本号。
- [ ] `constants.ts` 中 APP_SLUG / CLIENT_ID / BACKEND_BASE 若有变更,统一在一个发版里完成,配迁移公告。

## 4. 数据与附件

- [ ] 全员升级完成后,对每个团队库跑一次 **"Move existing attachments to Git LFS"**(存量原始二进制转指针;只改 tip 不重写历史)。
- [ ] 明确**不做历史重写**(force push 会打断所有克隆;历史里的旧 blob 只是占存储,不再增长)。若某库历史体积不可接受,单独评估、单独公告。
- [ ] 抽查验收:GitHub 上附件显示 "Stored with Git LFS"、`.gitattributes` 就位、org 的 LFS 用量面板数字符合预期。

## 5. LLM 层(需要公司决策)

- [ ] **数据出境评估**:冲突合并会把冲突 hunk ± 上下文发给所配置的 LLM;Ask 会发问题和检索到的笔记片段。公司需要指定允许的 provider、签数据处理/零留存协议,或走公司代理端点。
- [ ] key 管理:公司统一 key(经代理分发)还是成员各自配 key?当前设计是本机各配、存 vault 外。
- [ ] 用 `settings.llm.conflictInstructions` 下发团队合并规则(如术语表、"事实矛盾必须人工"等,已支持)。
- [ ] 评估 Ask 的 MCP / run_command 能力是否默认关闭(合规口径)。

## 6. 安全与合规审阅

- [ ] 数据流文档给安全团队:笔记 → 公司 GitHub;冲突片段 → 指定 LLM;凭证 → 仅 OS 用户目录(vault 外),后端只存加密 refresh token。
- [ ] token 收窄机制(按 repositoryIds)、设备绑定(deviceId)、session TTL 现状评审。
- [ ] 插件发布链完整性:GitHub Actions release + build provenance attestation(已有),可给安全团队做供应链说明。

## 7. 推广与支持

- [ ] 非工程用户的 onboarding 文档(截图版):安装 → Connect → 选 base org → 建/加库;附件、冲突、历史各一屏说明。
- [ ] 支持渠道 + 诊断路径:出问题让用户跑 "Copy the diagnostic log" 命令贴日志(已有此命令)。
- [ ] 试点:选 1–2 个团队跑两周,验收清单——连接、加库、右键分享文件夹、双端冲突 AI 合并、附件 LFS 往返、迁移命令、双机同步一致性。全绿再全员。

## 建议顺序

1. §2 云端迁移 + §1 App 归属(基础设施,一次发版切换,全员重连一次);
2. §3 版本基线 + §5 LLM 决策(推广前置条件);
3. §7 试点 → §4 存量附件迁移 → 全员推广;
4. §6 合规文档随时并行。
