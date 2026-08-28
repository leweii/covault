# Covault GitHub App 注册清单

> 首次上线时的 App 注册记录。完整的安装配置文档（GitHub 侧 + 后端 + 本地）见 [SETUP.md](SETUP.md)。

Connect 流程的代码（插件 + zhiyu-sync 后端）已全部就绪，只差真实的 App 凭证。
按下面步骤操作后填入两处配置即可上线。

## 1. 注册 GitHub App

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**
（建议注册在 chancetop org 名下，也可先挂个人账号后转移）：

| 字段 | 值 |
|---|---|
| GitHub App name | `Covault` |
| Homepage URL | 插件仓库地址 |
| **Callback URL** | `https://sync.zhiyu-online.com/auth/covault/callback` |
| Request user authorization (OAuth) during installation | ✅ 勾选 |
| Webhook | ❌ 取消勾选（不需要） |
| **Repository permissions** | Contents: **Read and write**；Pull requests: **Read and write**；Administration: **Read and write**（「共享文件夹为新库」要在 org 下建 repo）；Metadata: Read-only（自动） |
| Where can this app be installed? | Any account |
| Optional features → User-to-server token expiration | 保持默认（开启）即可 — 线上 serverless 后端（EasySyncBackend-prod）存 KMS 加密的 refresh token 并自动轮换 |

创建后记下：**App ID**、**Client ID**；生成并下载 **Client secret** 和 **Private key**（.pem）。

> App slug 必须是 `covault`（由 App name 自动生成，创建后在 URL 里确认：
> `github.com/apps/covault`）。如被占用需换名，同步修改插件 `src/auth/constants.ts`
> 的 `APP_SLUG` 和后端 apps.json 的 key。

## 2. 后端配置（zhiyu-sync）

`apps.json`（参考 `apps.example.json`）加入：

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

部署环境需要：`COVAULT_CLIENT_SECRET` 环境变量、`keys/covault.pem` 私钥文件。
重启后 `GET /healthz` 应返回 `"apps": ["agentic-git-sync", "covault"]`。

> 后端已改为 node:sqlite（Node ≥ 22.5），不再依赖 better-sqlite3 原生编译。

## 3. 插件配置（covault）

`src/auth/constants.ts` 填入一行：

```ts
export const CLIENT_ID = "<Client ID>";
```

Client ID 是公开信息（出现在授权 URL 里），可安全入库。

## 4. 验证

1. 测试 vault 装上插件 → 设置页点 **Connect** → 浏览器完成授权 → 自动跳回 Obsidian，
   设置页显示 `Connected as @<login>`。
2. 在 org 上安装 App（首次授权时会引导，或访问 `github.com/apps/covault/installations/new`），
   设置页点 **Refresh** 后应列出 org。
3. 添加一个该 org 下的共享库（无需 PAT），确认静默同步工作。

## org 侧惯例（提交策略的前提）

- org 内所有成员对知识库 repo 授予 write（能推分支，PR 无需 fork）；
- 每个库的默认分支开分支保护，本团队的 GitHub Team 加入 bypass 名单；
- 插件据此自动判断：能直推的库静默直推，其余静默建分支 + PR（M4 实现 PR 侧）。
