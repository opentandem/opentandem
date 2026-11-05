# OpenTandem 插件 SDK

为 [OpenTandem](https://opentandem.org) 开发应用。应用可以读取空间里的对话（含各对话的用量）、项目、电脑和定时任务，也可以往对话里发消息；可以从你自己的服务器调用，也可以在 OpenTandem 控制台里放一个页面，或者两者都用。

English: [README.md](README.md)

| 部分 | 是什么 | 运行在哪 |
|---|---|---|
| 应用 | 你的身份：应用 ID、密钥和申请的权限。在「设置 → 开发者」里创建，由空间管理员授权到他的空间。 | — |
| 插件 | 可选，每个应用最多一个，是应用的页面：控制台左侧栏的一个入口加主区域的一页。内容是你上传的一个静态文件夹。 | 控制台里的沙箱 iframe |
| API（页面） | `@opentandem/plugin`：在插件页面里经控制台调用能力。 | 浏览器 |
| 服务端 | `@opentandem/plugin/server`：用应用 ID 和密钥换令牌，经 HTTPS 调用同样的能力。 | 你的服务器 |

两边调用的是同一套[能力](#能力)，参数相同，返回的 JSON 也相同。

## 权限模型

- 每个能力本身就是一项权限。应用申请一组，空间管理员可以全部或部分授权。
- **从页面调用**时，以打开页面的成员身份执行：只能看到该成员在网页上看得到的内容，再与空间授权的权限取交集。写操作（`messages.send`）每次都先弹窗请成员确认。
- **从服务器调用**时，以授权该应用的管理员当前的身份执行。他离开空间或不再是管理员时，调用返回 `grant_inactive`，直到有管理员重新授权。
- 应用拿到的永远不会超过它所代表的人在网页上能打开的内容。撤销授权在下一次调用时生效。

## 开始

1. 在 OpenTandem 打开「设置 → 开发者 → 创建应用」，填名称、勾选权限。密钥只显示一次，请立即保存。
2. 复制「授权链接」发给空间管理员，管理员核对权限后点「允许」。
3. 从你的服务器调用能力（见下文），或者上传一个插件，让应用有自己的页面。

## 框架：插件文件夹

```
my-plugin/
  manifest.json        必需
  index.html           入口页面（或 manifest.entry 指定的文件）
  app.js、style.css、图片、字体……
  opentandem/          不用打包工具时，把本包的 src/ 目录复制进来
```

`manifest.json`（[结构定义](manifest.schema.json)）：

```json
{
  "name": "Usage",
  "title": { "zh": "用量", "en": "Usage" },
  "scopes": ["projects.list", "sessions.list", "messages.send"],
  "entry": "index.html"
}
```

`name` 和 `scopes` 只在别人用「设置 → 应用授权 → 导入插件文件夹」安装这个文件夹时才会读取，让它能一步装好。你自己在「设置 → 开发者」里给自己的应用上传时，应用名称和权限以那里设置的为准。

`title` 可以是一个字符串，也可以按语言各写一个（`zh`、`en`，每个最多 20 个字符）。侧栏和页面标题显示查看者的语言，没有就退到英文，再退到中文。页面自己的语言从 `ot.context` 取。

| 规则 | 值 |
|---|---|
| 大小 | 最多 100 个文件、总共 5MB，单张图片不超过 2MB |
| 文件类型 | html、js、mjs、css、json、map、txt、svg、png、jpg、gif、webp、ico、woff、woff2；其他文件（如 README.md）会被跳过 |
| 路径 | 字母、数字、`.`、`_`、`-` 和 `/`；以点开头的文件会被跳过 |
| 引用 | 用相对路径（`./app.js`）。绝对路径（`/app.js`）指向文件夹之外，加载不到 |
| 上传 | 「设置 → 开发者 → 上传插件文件夹」。每次上传都是新版本，已授权的空间重新打开页面即用上 |
| 安装别人的插件 | 空间管理员在「设置 → 应用授权 → 导入插件文件夹」里选这个文件夹，再确认 `scopes` 里的权限。管理员成为这个应用的所有者，导入的是一份拷贝：原作者之后的修改不会同步，要更新就重新导入。想持续收到作者的更新，就改用作者自己应用的应用 ID 去授权 |

### 沙箱

页面运行在带沙箱的 iframe 里，有自己独立的匿名来源：拿不到 OpenTandem 的 cookie，也读不到、改不了控制台。页面的内容安全策略：

| 项目 | 允许 |
|---|---|
| 脚本、样式 | 你自己的文件和内联 |
| 图片 | 你的文件、`data:`、`blob:` 和任何 `https:` 地址 |
| 网络请求（`fetch`、WebSocket） | 任何 `https:` 地址，例如你自己的后端 |
| 弹出窗口 | 允许，在沙箱外打开 |
| `localStorage`、cookie | 不可用（匿名来源），状态放在内存或你的服务器上 |

## API：在页面里调用

```html
<script type="module">
  import { createClient } from './opentandem/client/index.js' // 用打包工具时写 '@opentandem/plugin'
  const ot = createClient()
  const { locale } = await ot.context          // 'zh' 或 'en'，即控制台语言
  const { sessions } = await ot.sessions.list({ days: 7 })
  document.body.textContent = `${sessions.length} 个对话`
</script>
```

| 成员 | 含义 |
|---|---|
| `ot.context` | 一个 Promise，值为 `{ locale, app: { id, name } }` |
| `ot.<组>.<动作>(params)` | 调用能力，例如 `ot.sessions.list({ limit: 20 })`，返回 JSON 结果 |
| `ot.call(name, params)` | 同上，按名字调用 |
| 出错 | 抛出 `OpenTandemError`（`code`、`message`）。成员拒绝写操作时为 `user_denied`；30 秒无响应为 `timeout`（等待确认的写操作为 10 分钟） |

context 里永远不包含成员是谁。页面展示成员的数据，不展示成员的身份。

## 服务端：从你的后台调用

```js
import { createServerClient } from '@opentandem/plugin/server'

const ot = createServerClient({
  baseUrl: 'https://opentandem.org',
  appId: process.env.OPENTANDEM_APP_ID,
  secret: process.env.OPENTANDEM_APP_SECRET,
})
const { spaces } = await ot.spaces()                       // 授权了这个应用的空间
const { sessions } = await ot.sessions.list({ days: 7 }, { space: spaces[0].id })
```

SDK 会缓存令牌，并在到期前 5 分钟自动换新。不用 SDK 时直接调 HTTP：

| 请求 | 返回 |
|---|---|
| `POST /api/open/token`，正文 `{ "app_id", "secret" }` | `{ access_token, token_type: "Bearer", expires_at }`，2 小时有效；重置密钥后此前的令牌全部失效 |
| `GET /api/open/spaces?offset=0`，带 `Authorization: Bearer <令牌>` | `{ spaces: [{ id, name, scopes, granted_at }], has_more, next_offset }` |
| `GET` 或 `POST /api/open/<组>/<动作>`，带令牌；参数放查询串（GET）或 JSON 正文（POST），另带 `space` | 该能力的 JSON 结果；写操作必须用 POST |

## 能力

| 名称 | 写 | 参数 | 返回 |
|---|---|---|---|
| `projects.list` |  | `limit`（≤20）、`offset` | `projects[]`（`id`、`name`、`access`、`machine_id`、`created_at`）、`has_more`、`next_offset` |
| `sessions.list` |  | `limit`（≤20）、`offset`、`project`（项目 id，或 `none`）、`archived`、可选时间范围（`from`、`to` 或 `days`） | `total`（符合条件的全部条数）、`sessions[]`（`id`、`title`、`agent`、`model`、`machine_id`、`machine_name`、`project_id`、`project_name`、`archived`、`created_at`、`updated_at`、`last_message_at`、`usage`｛`runs`、`input_tokens`、`output_tokens`｝）、`has_more`、`next_offset`。给了时间范围时 `usage` 只算范围内，否则算该对话的整个生命周期；要合计自己把各行加起来 |
| `sessions.info` |  | `session_id` | `session`：列表里的字段，另加 `messages`｛`total`、`user`、`assistant`｝、`usage`（整个生命周期）和 `last_run` |
| `messages.list` | | `session_id`、`limit`（≤20）、`before_seq` | `messages[]`（`id`、`seq`、`role`、`content`、`created_at`、`via_app`）、`has_more`、`next_before_seq` |
| `messages.send` | ✓ | `session_id`、`content`（≤20,000 字） | `message_id`、`run_id`、`session_id` |
| `machines.list` | | `limit`（≤20）、`offset` | `machines[]`（`id`、`name`、`os`、`online`、`runner_version`、`disconnected`、`last_seen_at`、`agents[]`）、`has_more`、`next_offset` |
| `machines.info` |  | `machine_id` | `machine`：列表里的字段，另加 `skills`｛`reported`、`total`、`by_source`、`scanned_at`｝ |
| `schedules.list` | | `limit`（≤20）、`offset`、`filter`（`all`、`active`、`paused`、`completed`） | `schedules[]`（不含指令原文）、`has_more`、`next_offset` |
| `schedules.info` |  | `schedule_id` | 完整的 `schedule`，含 `prompt` 和执行设置。授权范围与 `schedules.list` 分开 |

说明：

- 时间默认是 UTC 字符串 `YYYY-MM-DD HH:MM:SS`，参数里另有说明的除外。
- 部分执行工具不上报 token 数：它们的轮次照常计数，token 记为 0。
- 消息不带发送人身份，也不带工具输出。应用发出的消息在对话里显示应用名。
- 列表每页最多 20 条。

机器可读的能力清单在 [`src/capabilities/`](src/capabilities/index.js)。

## 限额

按应用和空间计：读每分钟 120 次、每天 20,000 次；写每分钟 20 次、每天 1,000 次；换令牌每个应用每分钟 30 次。超出时返回 `429 rate_limited`，`Retry-After` 给出需要等待的秒数。

## 错误

错误格式为 JSON `{ "error": "<错误码>", "message"?: "…" }`。

| 错误码 | HTTP | 含义 |
|---|---|---|
| `invalid_credentials` | 401 | 应用 ID 或密钥不对 |
| `invalid_token` | 401 | 令牌是伪造的、已过期，或是在重置密钥之前签发的 |
| `space_not_granted` | 403 | 该空间没有授权这个应用（或空间不存在） |
| `grant_inactive` | 403 | 授权该应用的管理员已不再是该空间的管理员 |
| `scope_not_granted` | 403 | 空间没有授权这项能力 |
| `unknown_capability` | 404 | 没有这个能力 |
| `session_not_found` | 404 | 对话不存在，或执行身份看不到它 |
| `invalid_param` | 400 | 参数缺失或格式不对，`message` 会说明是哪个 |
| `machine_offline`、`machine_disconnected` | 400、409 | `messages.send`：对话绑定的电脑现在接不了任务 |
| `rate_limited` | 429 | 见[限额](#限额) |
| `user_denied` | — | 仅页面：成员拒绝了写操作 |

## 许可证

AGPL-3.0-only，与本仓库其余部分一致。
