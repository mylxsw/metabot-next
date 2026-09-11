# 生产部署

个人版支持的生产部署路径是带签名校验的 GitHub Release 安装器。它会安装两个本地
服务：

| 服务 | 默认端口 | 作用 |
|---|---:|---|
| Core Console | `9200` | Web UI、Chat、Agents、Memory、Skills、T5T、Teams、CLI API |
| Bridge | `9100` | IM 渠道、引擎执行、调度、语音与 peer 路由 |

MetaMemory 已属于 Core，不再存在 `8100` 端口的独立服务。

## 安装与验证

```bash
curl -fsSL https://github.com/xvirobotics/metabot/releases/latest/download/install.sh | bash

metabot status
metabot doctor
curl -fsS http://localhost:9200/health
```

安装器会验证 `SHA256SUMS`、校验个人版 Manifest，并启动它管理的 PM2 应用。两个
服务健康后再启用开机启动：

```bash
pm2 save
pm2 startup
```

执行 `pm2 startup` 打印的命令，然后再次运行 `pm2 save`。

## 聊天渠道不需要入站端口

- 飞书/Lark 使用出站长连接 WebSocket。
- Telegram 使用出站 long polling。
- 本地 Web 通过 loopback 访问。

只有明确需要远程浏览器访问时才发布 Core。除非需要独立的鉴权 API，否则 Bridge
应保持在 loopback 或私有网络。

## HTTPS 反向代理

移动端麦克风和远程浏览器访问需要安全上下文。最小 Caddy 配置只代理统一 Core
Console：

```caddy
metabot.example.com {
    reverse_proxy 127.0.0.1:9200
}
```

然后配置远程 CLI：

```bash
export METABOT_CORE_URL=https://metabot.example.com
export METABOT_CORE_TOKEN="<personal-token>"
metabot memory health
```

不需要公网访问时优先使用 Tailscale、WireGuard 等私有网络。不要把 Token 写入 URL、
Shell 历史或共享配置。

## Bridge 远程访问

大多数用户不需要此能力。`metabot bots`、`schedule`、`teams`、`peers` 和 `voice`
使用 Bridge API。确实需要远程访问时：

1. 设置强 `API_SECRET`；
2. 通过独立的鉴权 HTTPS 域名或私有网络代理 `127.0.0.1:9100`；
3. 在客户端设置 `METABOT_URL`。

不要复用 Core Token 作为 Bridge Secret。

## 重启安全

请使用 `metabot restart`，不要直接运行 `pm2 restart metabot`。CLI 会在整个 Bridge
进程重启前协调所有存在活跃任务的 Bot 会话、持久化交接状态，并在新 Bridge 开始监听
后续接被中断的用户任务。直接调用 PM2 会绕过这份协议，导致所有 Bot 未经准备就被
中断，也不会发送完成卡片。

首次升级到支持该协议的版本时，仍在运行的旧 Bridge 会对准备接口返回 404；
`metabot update` 只为这次过渡允许兼容降级。之后的更新必须先成功完成协调准备。
该功能不需要数据库迁移。

## 更新与回退

```bash
metabot update                                  # 最新已校验 Release
metabot update --package --version 1.3.1        # 已知不可变 Release
metabot doctor
```

Package 覆盖会保留 `.env`、`bots.json`、`data/`、`logs/`，以及
`~/.metabot/`、`~/.metabot-core/` 中的用户/Core 状态。如果新版本 smoke 失败，
应显式重装上一已知版本，不要直接修改已安装包文件。

回滚不需要改动 `sessions.db`。重新安装上一版本后，只有在确认当前没有重启进行中时，
才清理残留的 `~/.metabot/controlled-restart.json`；旧版本本来也会忽略该文件。

## 源码部署

源码 checkout 使用显式路径：

```bash
git pull --ff-only
npm ci --include=dev
npm test
npm run build
metabot update --git
```

Package 管理和源码管理的安装应保持分离。Web 请求路径详见
[Core Console 架构](../features/web-ui.md#architecture)。
