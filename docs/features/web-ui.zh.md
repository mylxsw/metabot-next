# 统一 Core Console

MetaBot 个人版只提供一个浏览器前端：Core Console。

**访问地址**：`http://localhost:9200`

安装器生成的 Bearer Token 保存在 `~/.metabot-core/token`。首次打开控制台时粘贴该 Token，即可在同一套导航中使用 Chat、Agents、Memory、Skills、T5T、Teams 和 CLI Access。

## Chat

Core Console Chat 把实时执行与 Core 的持久 Conversation、Run 和多 Agent 数据模型
放在同一页面：

- 流式展示 Agent 回复和当前运行状态
- 展示 Codex、Kimi Code 和 Claude 兼容引擎的工具活动
- 渲染 Markdown、代码块、表格和链接
- 在页面内回答 Agent 的交互问题
- 停止正在执行的 Run
- 展示 Agent 生成的输出文件元数据
- 使用浏览器 Speech Recognition；不可用时通过 Bridge STT 转写
- 创建 Agent 私聊或带 `@Agent` 路由的群聊
- 为每个会话选择引擎和模型

控制台可使用同一 Bearer Token 订阅
`GET /api/chat/conversations/<id>/stream`。连接先发送 `snapshot`，随后推送
`message.created`、`run.updated`、`run.event` 和 `file.created` 事件。订阅按会话参与者
授权；非参与者返回 `403`，空闲连接会定期收到注释心跳，避免代理关闭连接。

## 架构 {#architecture}

```text
浏览器 :9200
  └─ packages/web-ui/（唯一 React SPA）
       └─ packages/server/（Token 鉴权、Conversation、Run、Memory、Skills、T5T）
            └─ Agent Bus Inbox
                 └─ Bridge :9100（Codex / Kimi Code / Claude 执行）
                      └─ Run 状态、工具、问题和文件事件回传 Core
```

源码位于 `packages/web-ui/`，Vite 构建产物写入 `packages/server/static/`。Bridge
负责执行 Agent 并回传实时状态，不再提供另一套浏览器前端。

## 开发

```bash
npm run dev -w @xvirobotics/metabot-core-web-ui
npm run build -w @xvirobotics/metabot-core-web-ui
npm run build:bridge
```

Vite 开发服务器默认使用 `5173`，并把 `/api`、`/admin` 和 `/health` 代理到本地 Core `9200`。
