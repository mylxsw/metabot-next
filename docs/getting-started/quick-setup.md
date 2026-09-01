# Quick Setup

## Telegram (30 seconds)

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy token
2. Add to `bots.json` → done (long polling, no webhooks)

```json
{
  "telegramBots": [{
    "name": "my-tg-bot",
    "telegramBotToken": "123456:ABC...",
    "allowedUserIds": ["your numeric Telegram user ID"],
    "defaultWorkingDirectory": "/home/user/project"
  }]
}
```

Two-member groups (you + the bot) reply without @mention by default; larger groups remain mention-only.
Always set `allowedUserIds` when the bot can operate on your computer. If the bot is not a group
administrator, disable group privacy with BotFather `/setprivacy` so Telegram delivers unmentioned messages.

## Feishu/Lark (4 steps)

1. Create app at [open.feishu.cn](https://open.feishu.cn/) → add Bot capability
2. Enable permissions: `im:message`, `im:message:readonly`, `im:resource`, `im:chat:readonly` (for group chat detection), `docx:document:readonly`, `wiki:wiki` (for doc reading & wiki sync)
3. Start MetaBot, then enable persistent connection + `im.message.receive_v1` event
4. Publish the app

```json
{
  "feishuBots": [{
    "name": "metabot",
    "feishuAppId": "cli_xxx",
    "feishuAppSecret": "...",
    "defaultWorkingDirectory": "/home/user/project"
  }]
}
```

!!! tip "No public IP needed"
    Feishu uses WebSocket (persistent connection), Telegram uses long polling. Both work behind NAT/firewalls.

For detailed Feishu configuration, see the [Feishu App Setup Guide](feishu-app-setup.md).
