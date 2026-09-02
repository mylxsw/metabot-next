# 聊天命令

在飞书或 Telegram 中发送给 MetaBot 的命令。

## 可用命令

| 命令 | 说明 |
|------|------|
| `/reset` | 清除会话 — 开始全新对话 |
| `/stop` | 中止当前任务 |
| `/status` | 查看会话信息（会话 ID、工作目录） |
| `/goal <条件>` | 设置目标，Agent 跨多轮持续推进直到达成。`/goal clear` 停止。 |
| `/memory list` | 浏览 MetaMemory 知识库目录 |
| `/memory search 关键词` | 搜索 MetaMemory 知识库 |
| `/sync` | 触发 MetaMemory → 飞书知识库同步 |
| `/sync status` | 查看知识库同步统计 |
| `@Bot /group-reply mention\|all\|status` | 查看或修改飞书群中当前 Bot 的回复模式 |
| `/group_reply@Bot mention\|all\|status` | 查看或修改 Telegram 群中当前 Bot 的回复模式 |
| `/help` | 显示可用命令 |
| `/metaskill ...` | 生成 Agent 团队、Agent 或 Skill |
| `/metabot` | 加载 Agent 总线文档（调度、Bot 管理、跨实例对话） |
| `/任意命令` | 非内置命令自动转发给 Claude Code 作为 skill |

## 说明

- **私聊**中，Bot 回复所有消息
- `/memory` 和 `/sync` 等命令直接快速响应，无需启动 Claude
- `/metaskill` 和 `/metabot` 是按需加载到 Claude 上下文的 skill

## 飞书群聊行为

### 回复模式与 @提及路由 {#group-reply-modes}

每个飞书 Bot 默认按以下规则回复：

| 场景 | 默认模式 | 说明 |
|------|---------|------|
| **私聊** | 回复全部消息 | 群回复模式不适用 |
| **两人群**（你 + Bot） | `all` | 自动识别为类私聊，无需 @ |
| **多人群聊** | `mention` | 只有准确 @ 当前 Bot 的消息才会触发回复 |

群主可以单独覆盖某个 Bot 在某个群中的默认模式：

```text
@MetaBot /group-reply mention  # 只有 @ 当前 Bot 时才回复
@MetaBot /group-reply all      # 回复群里的所有消息
@MetaBot /group-reply status   # 查看当前模式及其来源
```

中文别名支持相同操作：`@MetaBot /群回复 仅@`、`@MetaBot /群回复 全部`、
`@MetaBot /群回复 状态`。

群内路由是精确的：命令必须 @ 当前 Bot。裸发 `/group-reply ...`，或只 @
了其他 Bot 的命令，当前 Bot 都会忽略，避免同一群里的多个 MetaBot Agent
被一条命令同时改写。普通消息按选定模式处理；在 `mention` 模式下，@
其他用户或其他 Bot 不算 @ 当前 Bot。

只有飞书群主可以执行 `mention` 或 `all` 修改模式，所有群成员都可以执行
`status`。MetaBot 通过公开的 Lark 群信息 API 校验群主身份，并采用失败关闭
策略：查询失败或应用权限不足时不会修改模式。请确保应用已开通
`im:chat:readonly` 权限。

设置按 **Bot + 群聊** 保存到本地，重启后仍然有效。群内显式设置优先于
Bot 的 `groupNoMention` 配置和“两人群视为私聊”的默认规则。例如，
`mention` 会让两人群也必须 @Bot；`all` 会让多人群无需 @ 当前 Bot。

!!! tip "推荐：建两人群"
    建一个只有你和 Bot 的两人群聊。无需 @Bot 即可对话，还能享受群聊功能（置顶、分类管理等）。

## Telegram 群聊行为

### 原生命令菜单

Telegram Bot 每次启动时会自动通过 `setMyCommands` 同步命令菜单，无需手动在
BotFather 配置 `/setcommands`，也无需额外环境变量。客户端输入 `/` 即可查看
命令建议；默认私聊菜单按钮也使用这份命令列表。提供中文说明和英文兜底。

公共菜单包含 `help`、`reset`、`stop`、`status`、`model`、`effort`、`resume`、
`memory`；群聊菜单额外包含 `group_reply`。带参数的操作仍需输入参数，例如
`/model list`、`/effort high`；群回复模式使用 `/group_reply@Bot all|mention|status`。

启动会覆盖默认、所有私聊、所有群聊这三个作用域的默认语言和中文命令列表；
单独聊天、管理员或其他语言的自定义列表不变，可能优先于这些全局列表。
不会修改已有 Mini App 菜单按钮。菜单不是权限控制，用户白名单和群管理员校验仍然生效。
同步失败只记录警告，不阻塞聊天；重启可重试。若列表未刷新，请重新进入对话，
并检查日志中的 `Telegram command menu registered` 或注册失败警告。

### 消息回复规则

- 两人群默认使用 `all`，无需 @Bot；成员数量缓存 5 分钟。
- 多人群默认使用 `mention`；群管理员可用 `/group_reply@Bot all|mention|status` 覆盖。
- `bots.json` 的 `groupNoMention: true` 可让多人群默认回复全部消息。
- `allowedUserIds` 会在文字、图片、文件、视频、音频和语音进入 Agent 前统一校验。
- 若 Bot 不是群管理员，请在 BotFather 使用 `/setprivacy` 关闭隐私模式，否则 Telegram 不会投递未 @ 的消息。

### 在群聊中发送文件和图片

在 `mention` 模式下，飞书上传文件/图片时无法同时 @Bot（尤其是手机端）。
MetaBot 支持 **先传后 @**：

1. 先在群里上传文件或图片（不用 @ 任何人）
2. **5 分钟**内 @Bot 说「分析一下」或任何指令
3. Bot 自动把你之前上传的文件附上一起处理

```
[上传 report.pdf]          ← 先传文件
[上传 screenshot.png]      ← 可以传多个
@MetaBot 帮我分析这些文件   ← 再 @Bot，文件自动附上
```

在 `all` 模式下，未 @ 的文件和图片会立即处理；在 `mention` 模式下，
它们会缓存到下一条 @Bot 指令。私聊也会直接处理；两人群默认直接处理，
但如果显式切换为 `mention`，则同样需要先传后 @。

### 智能合并

连续发送多个文件或图片（2 秒内），会自动合并为一次请求。所有聊天类型均支持。
