import { Bot } from 'grammy';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { TelegramBotConfig, BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { shouldBypassProxy } from '../utils/http.js';
import type { IncomingMessage } from '../types.js';
import type { IMessageSender } from '../bridge/message-sender.interface.js';
import { TelegramSender } from './telegram-sender.js';
import { MessageBridge } from '../bridge/message-bridge.js';
import { TelegramGroupReplyModeStore } from './group-reply-mode-store.js';
import {
  TelegramMemberCountCache,
  isTelegramBotMentioned,
  isTelegramGroupReplyCommandAddressed,
  isTelegramUserAllowed,
  normalizeTelegramCommandSuffix,
  parseTelegramGroupReplyModeCommand,
  shouldProcessTelegramGroupMessage,
  stripTelegramBotMention,
  type TelegramMessageEntityLike,
} from './group-policy.js';

export interface TelegramBotHandle {
  name: string;
  bridge: MessageBridge;
  bot: Bot;
  config: BotConfigBase;
  sender: IMessageSender;
  destroy: () => void;
}

export async function startTelegramBot(config: TelegramBotConfig, logger: Logger): Promise<TelegramBotHandle> {
  const botLogger = logger.child({ bot: config.name });

  botLogger.info('Starting Telegram bot...');

  const proxyUrl =
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const useProxy = proxyUrl && !shouldBypassProxy('https://api.telegram.org');
  if (useProxy) {
    botLogger.info({ proxyUrl }, 'Using HTTPS proxy for Telegram API');
  }
  const botOptions = useProxy ? { client: { baseFetchConfig: { agent: new HttpsProxyAgent(proxyUrl) } } } : {};

  const bot = new Bot(config.telegram.botToken, botOptions);
  const sender = new TelegramSender(bot, botLogger);
  const bridge = new MessageBridge(config, botLogger, sender);
  const groupReplyModeStore = new TelegramGroupReplyModeStore(botLogger);
  const memberCountCache = new TelegramMemberCountCache();

  // Install grammY error handler before polling starts.
  bot.catch((err) => {
    botLogger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'grammY error');
  });

  // getMe is useful for logging and @mention handling, but Telegram API
  // timeouts during startup should not take down the whole service.
  let botUsername: string | undefined;
  try {
    const me = await bot.api.getMe();
    botUsername = me.username;
    botLogger.info(
      {
        botUsername: me.username,
        botId: me.id,
        canReadAllGroupMessages: me.can_read_all_group_messages,
      },
      'Telegram bot info fetched',
    );
    if (!me.can_read_all_group_messages) {
      botLogger.warn(
        'Telegram group privacy mode is enabled. Unmentioned group messages are delivered only when this Bot is a group administrator; otherwise disable privacy with BotFather /setprivacy.',
      );
    }
  } catch (err) {
    botLogger.warn({ err }, 'Failed to fetch Telegram bot info during startup; continuing without username metadata');
  }

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type; // 'private', 'group', 'supergroup'

    const rawText = ctx.message.text || '';
    if (!isAllowedSender(userId, chatId)) return;

    const isGroup = isTelegramGroupChat(chatType);
    const botMentioned = isTelegramBotMentioned(rawText, ctx.message.entities, botUsername);
    const groupCommandAddressed = botMentioned || isTelegramGroupReplyCommandAddressed(rawText, botUsername);
    const text = stripTelegramBotMention(normalizeTelegramCommandSuffix(rawText, botUsername), botUsername);

    if (isGroup) {
      const groupReplyCommand = parseTelegramGroupReplyModeCommand(text);
      if (groupReplyCommand) {
        if (!groupCommandAddressed) {
          botLogger.debug({ chatId, userId }, 'Ignoring Telegram group reply command not addressed to this Bot');
          return;
        }
        await handleTelegramGroupReplyCommand(chatId, userId, text);
        return;
      }

      if (!(await shouldHandleGroupMessage(chatId, botMentioned, text.startsWith('/')))) return;
    }

    if (!text) return;

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, msg }, 'Unhandled error in Telegram message bridge');
    });
  });

  // Handle photo messages
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    const text = await prepareIncomingMessage(
      chatId,
      chatType,
      userId,
      ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u5F20\u56FE\u7247',
      ctx.message.caption_entities,
    );
    if (text === undefined) return;

    // Get the largest photo (last in the array)
    const photos = ctx.message.photo;
    if (!photos || photos.length === 0) return;
    const largestPhoto = photos[photos.length - 1];
    botLogger.info({ chatId, userId, fileId: largestPhoto.file_id }, 'Received photo message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
      imageKey: largestPhoto.file_id,
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram photo message bridge');
    });
  });

  // Handle document messages
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    const text = await prepareIncomingMessage(
      chatId,
      chatType,
      userId,
      ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2A\u6587\u4EF6',
      ctx.message.caption_entities,
    );
    if (text === undefined) return;

    const doc = ctx.message.document;
    if (!doc) return;
    botLogger.info(
      { chatId, userId, fileName: doc.file_name, mimeType: doc.mime_type, fileSize: doc.file_size },
      'Received document message',
    );

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
      fileKey: doc.file_id,
      fileName: doc.file_name || 'document',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram document message bridge');
    });
  });

  // Handle video messages
  bot.on('message:video', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    const text = await prepareIncomingMessage(
      chatId,
      chatType,
      userId,
      ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2A\u89C6\u9891',
      ctx.message.caption_entities,
    );
    if (text === undefined) return;

    const video = ctx.message.video;
    if (!video) return;
    botLogger.info(
      { chatId, userId, fileName: video.file_name, mimeType: video.mime_type, duration: video.duration },
      'Received video message',
    );

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
      fileKey: video.file_id,
      fileName: video.file_name || 'video.mp4',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram video message bridge');
    });
  });

  // Handle audio messages
  bot.on('message:audio', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    const text = await prepareIncomingMessage(
      chatId,
      chatType,
      userId,
      ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2A\u97F3\u9891\u6587\u4EF6',
      ctx.message.caption_entities,
    );
    if (text === undefined) return;

    const audio = ctx.message.audio;
    if (!audio) return;
    botLogger.info(
      { chatId, userId, fileName: audio.file_name, mimeType: audio.mime_type, duration: audio.duration },
      'Received audio message',
    );

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
      fileKey: audio.file_id,
      fileName: audio.file_name || 'audio.mp3',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram audio message bridge');
    });
  });

  // Handle voice messages
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    const text = await prepareIncomingMessage(
      chatId,
      chatType,
      userId,
      '\u8BF7\u5206\u6790\u8FD9\u6761\u8BED\u97F3\u6D88\u606F',
    );
    if (text === undefined) return;

    const voice = ctx.message.voice;
    if (!voice) return;
    botLogger.info({ chatId, userId, duration: voice.duration }, 'Received voice message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
      fileKey: voice.file_id,
      fileName: 'voice.ogg',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram voice message bridge');
    });
  });

  // Handle animation (GIF) messages
  bot.on('message:animation', async (ctx) => {
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat.id.toString();
    const chatType = ctx.chat.type;
    const text = await prepareIncomingMessage(
      chatId,
      chatType,
      userId,
      ctx.message.caption || '\u8BF7\u5206\u6790\u8FD9\u4E2AGIF',
      ctx.message.caption_entities,
    );
    if (text === undefined) return;

    const animation = ctx.message.animation;
    if (!animation) return;
    botLogger.info({ chatId, userId, fileName: animation.file_name }, 'Received animation message');

    const msg: IncomingMessage = {
      messageId: ctx.message.message_id.toString(),
      chatId,
      chatType,
      userId,
      text,
      fileKey: animation.file_id,
      fileName: animation.file_name || 'animation.mp4',
    };

    bridge.handleMessage(msg).catch((err) => {
      botLogger.error({ err, chatId, userId }, 'Unhandled error in Telegram animation message bridge');
    });
  });

  // Start long polling (non-blocking)
  bot.start({
    onStart: () => {
      botLogger.info('Telegram bot is running (long polling)');
    },
  });

  botLogger.info(
    {
      defaultWorkingDirectory: config.claude.defaultWorkingDirectory,
      maxTurns: config.claude.maxTurns ?? 'unlimited',
      maxBudgetUsd: config.claude.maxBudgetUsd ?? 'unlimited',
      groupNoMention: config.groupNoMention ?? false,
      allowedUserCount: config.allowedUserIds?.length ?? 0,
    },
    'Configuration',
  );

  return {
    name: config.name,
    bridge,
    bot,
    config,
    sender,
    destroy: () => {
      sender.destroy();
      groupReplyModeStore.close();
    },
  };

  function isAllowedSender(userId: string, chatId: string): boolean {
    const allowed = isTelegramUserAllowed(config.allowedUserIds, userId);
    if (!allowed) {
      botLogger.warn({ userId, chatId }, 'Ignoring Telegram message from user outside allowedUserIds');
    }
    return allowed;
  }

  async function prepareIncomingMessage(
    chatId: string,
    chatType: string,
    userId: string,
    rawText: string,
    entities?: readonly TelegramMessageEntityLike[],
  ): Promise<string | undefined> {
    if (!isAllowedSender(userId, chatId)) return undefined;
    const botMentioned = isTelegramBotMentioned(rawText, entities, botUsername);
    const text = stripTelegramBotMention(normalizeTelegramCommandSuffix(rawText, botUsername), botUsername);
    if (
      isTelegramGroupChat(chatType) &&
      !(await shouldHandleGroupMessage(chatId, botMentioned, text.startsWith('/')))
    ) {
      return undefined;
    }
    return text;
  }

  async function shouldHandleGroupMessage(chatId: string, botMentioned: boolean, isCommand: boolean): Promise<boolean> {
    const storedMode = groupReplyModeStore.get(config.name, chatId);
    const privateLikeGroup = !storedMode && !config.groupNoMention ? await isTwoMemberGroup(chatId) : false;
    const process = shouldProcessTelegramGroupMessage({
      botMentioned,
      isCommand,
      storedMode,
      configGroupNoMention: config.groupNoMention,
      privateLikeGroup,
    });
    botLogger.debug(
      { chatId, botMentioned, isCommand, storedMode, privateLikeGroup, process },
      'Evaluated Telegram group reply policy',
    );
    return process;
  }

  async function isTwoMemberGroup(chatId: string): Promise<boolean> {
    try {
      return await memberCountCache.isTwoMemberGroup(chatId, () => bot.api.getChatMemberCount(Number(chatId)));
    } catch (err) {
      botLogger.warn({ err, chatId }, 'Failed to read Telegram group member count; falling back to mention-only');
      return false;
    }
  }

  async function handleTelegramGroupReplyCommand(chatId: string, userId: string, text: string): Promise<void> {
    const command = parseTelegramGroupReplyModeCommand(text);
    if (!command) return;
    const storedMode = groupReplyModeStore.get(config.name, chatId);
    const privateLikeGroup = !storedMode && !config.groupNoMention ? await isTwoMemberGroup(chatId) : false;
    const defaultMode = config.groupNoMention || privateLikeGroup ? 'all' : 'mention';
    const currentMode = storedMode ?? defaultMode;

    if (command.action === 'set' && command.mode) {
      const canChangeMode = await isTelegramGroupAdministrator(chatId, userId);
      if (!canChangeMode) {
        await sender.sendTextNotice(chatId, '无权限切换群回复模式', '只有 Telegram 群管理员可以修改回复模式。', 'red');
        return;
      }
      groupReplyModeStore.set(config.name, chatId, command.mode, userId);
      await sender.sendTextNotice(
        chatId,
        '群回复模式已更新',
        `当前群模式：${describeGroupReplyMode(command.mode)}\n\n命令：\`/group_reply@${botUsername} mention|all|status\``,
        'green',
      );
      return;
    }

    if (command.action === 'status') {
      await sender.sendTextNotice(
        chatId,
        '群回复模式',
        `当前群模式：${describeGroupReplyMode(currentMode)}\n模式来源：${storedMode ? '当前群显式设置' : privateLikeGroup ? '两人群自动规则' : config.groupNoMention ? 'Bot 配置' : '默认规则'}`,
        'blue',
      );
      return;
    }

    await sender.sendTextNotice(
      chatId,
      '群回复模式命令',
      `用法：\n- \`/group_reply@${botUsername} mention\` — 只有被 @ 时回复\n- \`/group_reply@${botUsername} all\` — 回复所有消息\n- \`/group_reply@${botUsername} status\` — 查看当前模式`,
      'orange',
    );
  }

  async function isTelegramGroupAdministrator(chatId: string, userId: string): Promise<boolean> {
    try {
      const member = await bot.api.getChatMember(Number(chatId), Number(userId));
      return member.status === 'creator' || member.status === 'administrator';
    } catch (err) {
      botLogger.warn({ err, chatId, userId }, 'Failed to verify Telegram group administrator');
      return false;
    }
  }
}

function isTelegramGroupChat(chatType: string): boolean {
  return chatType === 'group' || chatType === 'supergroup';
}

function describeGroupReplyMode(mode: 'mention' | 'all'): string {
  return mode === 'all' ? '回复群里的所有消息' : '只有被 @ 时才回复';
}
