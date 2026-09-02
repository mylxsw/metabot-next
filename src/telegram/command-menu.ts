import type { Api } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { Logger } from '../utils/logger.js';

type MenuScope = 'default' | 'all_private_chats' | 'all_group_chats';
type MenuLanguage = '' | 'zh';

// Only expose implemented bridge commands, not arbitrary engine-specific skills.
const COMMANDS = [
  { command: 'help', en: 'Show help and available commands', zh: '查看帮助和可用命令' },
  { command: 'reset', en: 'Clear the current session and start fresh', zh: '清除当前会话，开始新对话' },
  { command: 'stop', en: 'Stop the current task', zh: '中止当前任务' },
  { command: 'status', en: 'Show the current session status', zh: '查看当前会话状态' },
  { command: 'model', en: 'Show or change the engine and model', zh: '查看或切换引擎与模型' },
  { command: 'effort', en: 'Show or set Codex reasoning effort', zh: '查看或设置 Codex 推理强度' },
  { command: 'resume', en: 'List and resume previous sessions', zh: '查看并恢复历史会话' },
  { command: 'memory', en: 'Browse and search the memory library', zh: '浏览和搜索记忆库' },
  {
    command: 'group_reply',
    en: 'Show group reply mode; admins can change it',
    zh: '查看群回复模式；管理员可修改',
    groupOnly: true,
  },
] as const;

export function getTelegramCommands(scope: MenuScope, language: MenuLanguage): BotCommand[] {
  return COMMANDS.filter((entry) => !('groupOnly' in entry) || scope === 'all_group_chats').map((entry) => ({
    command: entry.command,
    description: language === 'zh' ? entry.zh : entry.en,
  }));
}

/** Best-effort, repeatable publication. Do not delete per-chat overrides or change Mini App buttons. */
export async function registerTelegramCommands(
  api: Pick<Api, 'setMyCommands'>,
  logger: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const scopes: MenuScope[] = ['default', 'all_private_chats', 'all_group_chats'];
  const languages: MenuLanguage[] = ['', 'zh'];
  for (const scope of scopes) {
    for (const language of languages) {
      try {
        const commands = getTelegramCommands(scope, language);
        await api.setMyCommands(
          commands,
          { scope: { type: scope }, ...(language ? { language_code: language } : {}) },
          // grammY types the Node signal with its older abort-controller shim;
          // the native signal supports the same runtime abort/listener contract.
          AbortSignal.timeout(10_000) as unknown as Parameters<Api['setMyCommands']>[2],
        );
        logger.info(
          { scope, language: language || 'default', commandCount: commands.length },
          'Telegram command menu registered',
        );
      } catch {
        // Transport errors may include a token-bearing URL; do not serialize them.
        logger.warn(
          { scope, language: language || 'default' },
          'Failed to register Telegram command menu; chat remains available. Restart to retry.',
        );
      }
    }
  }
}
