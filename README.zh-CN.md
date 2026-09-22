# GitHub Text MCP Worker

[English](README.md) · [协议与限制](docs/public/protocol.md) · [安全说明](SECURITY.md)

这是一个可自行部署到 Cloudflare Workers 的 GitHub 文本 MCP 服务。客户端可以固定到完整 commit SHA 读取文件，按 UTF-8 安全边界分块续读，并检查返回的 Git blob 标识。配置写权限后，可以在一个提交中写入多个完整文件或删除路径，再检查读回回执。

每个入口固定绑定一个仓库，工具参数不能临时切换 owner/repository。支持两个入口，各自使用独立的连接器凭据、GitHub token 和限流绑定；只配置 primary 即可使用。

## 能做什么

- 按不可变提交读取文本、列目录和子树、查提交元数据、进行文件内字面搜索。
- 在文本回包中提供 blob SHA、字节数、续读位置与部署诊断；空文件也有明确回包。
- 可选的原子多文件写入/删除、分支创建和带检查的分支删除。
- 提供使用本地夹具与模拟 GitHub 响应的测试，不提供公共演示服务。

服务面向 GitHub.com 文本文件，不运行仓库代码，不解析 PDF，不下载 Git LFS 对象，也不提供 OAuth 服务或完整 Git 客户端功能。最初适配目标是 Perplexity。其他客户端需要支持 Streamable HTTP，并能配置 `Authorization: Bearer …` 请求头；没有实测的 Claude 或其他客户端不在兼容承诺内。不能手工配置 Bearer、只接受 OAuth 的宿主，需要额外的授权层，本项目未实现该部分。

## 快速开始

准备 Node.js 24 或更新版本、npm、Git、Cloudflare Workers 账户，以及目标 GitHub 仓库的访问权限。

### 1. 安装并设置仓库

```sh
git clone https://github.com/LyuPeng-star/github-text-mcp-worker.git
cd github-text-mcp-worker
npm ci
npx wrangler login
```

编辑 `wrangler.jsonc`：

- `name`：改为你账户下可用的 Worker 名称。
- `vars.PRIMARY_REPOSITORY`：填实际的 `owner/repository`。
- `vars.SECONDARY_REPOSITORY`：只需一个仓库时保留空字符串。
- 保留两个限流绑定与 `WORKER_VERSION_METADATA` 绑定。同一账户部署多个 Worker 实例时，每个入口的 limiter `namespace_id` 应在该账户内分别唯一，避免不同实例共享计数。

默认的 `example-owner/example-repository` 是不可用占位值。仓库未填、格式错误或仍是占位值时，对应入口返回不可用，不会退回另一个仓库。默认开启 `workers.dev`、明确关闭预览 URL，不需要私人域名。

### 2. 配置凭据

为正确的资源所有者创建 **fine-grained personal access token**，仓库范围选择 **Only select repositories**，仅选对应目标仓库：

| 用途 | Repository permissions |
|---|---|
| 只读文件及元数据 | Contents：Read-only；Metadata：Read-only |
| 写文件及管理分支 | Contents：Read and write；Metadata：Read-only |

设置到期日，在到期前更换已部署的 token。组织批准、仓库规则和保护分支仍可能限制操作。修改工作流文件可能需要额外权限，只有确有需求时才授予。代码索引搜索还取决于 GitHub 搜索 API 对该凭据和仓库的支持。参见 [GitHub PAT 官方说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)与[端点权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)。

另在密码管理器中生成一个足够长的随机 **connector token**。它供 MCP 客户端连接 Worker 使用，与 GitHub token 分开。

通过交互提示输入真实值：

```sh
npx wrangler secret put CONNECTOR_TOKEN_PRIMARY
npx wrangler secret put GITHUB_TOKEN_PRIMARY
```

不要将真实凭据写入配置、源码、截图或命令参数。[Cloudflare secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)说明了这些值的管理方式。

如果需要只读部署，使用 Contents 只读的 GitHub token。服务仍会列出写工具，写入由上游权限阻止；本项目没有单独的写入开关或按工具划分的用户角色。

### 3. 检查和部署

```sh
npm run check
npm test
npm run test:acceptance
npx wrangler deploy --dry-run
```

使用 Git 工作树时，先提交不含秘密的配置，再运行部署保护脚本：

```sh
git add wrangler.jsonc
git commit -m "Configure repository binding"
npm run deploy
```

`npm run deploy` 要求受跟踪文件与未跟踪文件均干净，读取真实的完整 `HEAD`，注入 `SOURCE_COMMIT` 和来源标签。支持 fork、其他分支名或 detached HEAD，不要求连接本项目的上游 remote。

若下载的是没有 `.git` 的源码压缩包，可直接使用 `npx wrangler deploy`。此时没有真实来源标识时，回包中的 `source_commit` 为 `unavailable`；不要编造提交 SHA。账户相关选项见 [Wrangler 配置文档](https://developers.cloudflare.com/workers/wrangler/configuration/)。

### 4. 连接客户端

以 Wrangler 输出的域名为准，入口为：

```text
https://<worker-name>.<account-subdomain>.workers.dev/primary/mcp
```

配置请求头：

```text
Authorization: Bearer <你的-primary-connector-token>
```

客户端询问传输方式时选择 Streamable HTTP。请求使用 `POST` 和 `Content-Type: application/json`。没有单独的旧式 `/sse` 入口、OAuth 发现流程或持久服务器推送流。

如果宿主带 `Origin`，默认仅允许 `https://perplexity.ai` 和 `https://www.perplexity.ai`。其他来源可设置可选变量 `ALLOWED_ORIGINS`，用逗号分隔完整 origin 后重新部署；该列表会替换默认值。它不等于浏览器 CORS 支持，也不证明宿主已兼容。无 `Origin` 的服务器间请求仍须通过认证与其他检查。

先调用 `resolve_ref` 获取完整 `commit_sha`，再调用 `stat_file` 与 `get_file_text`。同一文件全部分块固定使用该 SHA，按回包的 `next_byte_offset` 续读；详见[读取协议](docs/public/protocol.md#reading-a-file)。

### 可选第二个仓库

填入 `SECONDARY_REPOSITORY`，另建只对应该仓库的 GitHub token 和独立 connector token：

```sh
npx wrangler secret put CONNECTOR_TOKEN_SECONDARY
npx wrangler secret put GITHUB_TOKEN_SECONDARY
```

提交更新后的配置并重新部署。第二入口是 `/secondary/mcp`，使用 `MCP_RATE_LIMITER_SECONDARY`。两入口不共用或回退凭据。只用 primary 时不需要两项 secondary secrets。

## 工具一览

全部工具受入口绑定仓库限制，具体参数以 `tools/list` 返回的 schema 为准。

| 工具 | 用途 |
|---|---|
| `resolve_ref` | 将支持的分支/标签名解析为完整 commit SHA。 |
| `stat_file` | 检查普通文件的 blob SHA、大小、文本形态与编码。 |
| `get_file_text` | 按提交读取 UTF-8，可选行/字节范围并续读。 |
| `search_in_file` | 在固定版本文件中进行区分大小写的字面搜索。 |
| `search_repo_index` | 查 GitHub 默认分支代码索引；结果需在指定提交重新核对。 |
| `list_directory` | 列出提交中的一层目录。 |
| `list_tree` | 受限的递归目录，不遍历符号链接与子模块。 |
| `get_commit_metadata` | 获取父提交、日期和变更文件元数据，不含 patch 或提交消息。 |
| `put_file_text` | 提交一个完整 UTF-8 文件。 |
| `put_files_text` | 在一个提交中写入多个完整文件和/或删除路径。 |
| `verify_write` | 在固定提交比较预期与实际 blob SHA。 |
| `create_branch` | 从完整提交创建新分支，不覆盖已有分支。 |
| `delete_branch` | 核对预期 HEAD 与已合入默认分支后，删除非默认分支。 |

文件读取必须使用 **40 位十六进制不可变 commit SHA**。分支名、标签、短 SHA 和 revision 表达式不能直接替代。`resolve_ref` 和写入默认分支名是 `main`，不是自动探测的默认分支；仓库使用其他名称时请明确传入。

## 使用边界

- 单文件上限 **1,310,720 字节**，每次文本默认 **65,536 字节**；大文件应续读。
- 每次写入/删除合计 **1–20 条路径**，新内容合计不超过 **262,144 UTF-8 字节**。写入参数是完整文件，不是 patch。
- 原子写通过一次非 force 引用更新发布一个提交。提交成功与读回核验成功是两个状态；检查 `committed`、`commit_sha` 与各项 `verified`，不要盲目重试未知结果。
- GitHub 删除引用 API 没有原子预期 SHA 条件，最后一次检查到实际删除之间仍存在并发窗口，不能宣称分支删除绝无竞态。
- 每个入口的 Cloudflare 限流配置为 **60 请求/60 秒**，不保证跨所有节点精确计数，也不替代 GitHub 自身额度。
- 代码索引搜索不固定到提交，空结果不能证明指定版本不存在内容；过大的目录列表会明确失败，不伪装成完整列表。

更多参数、字节边界、回执与错误见[协议文档](docs/public/protocol.md)。测试验证实现与夹具行为，不构成线上可用率或任意客户端兼容保证。

开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全边界见 [SECURITY.md](SECURITY.md)。采用 [MIT License](LICENSE)。

直接调用 Wrangler 时，如需关闭 CLI 可选遥测，可在当前 shell 设置 `WRANGLER_SEND_METRICS=false`；例如 POSIX shell 下使用 `WRANGLER_SEND_METRICS=false npx wrangler deploy`。本项目的 `npm run deploy` 和 CI 已设置该变量。这不关闭 Cloudflare 服务日志。
