/**
 * Coverage for TaskScheduler — one-time tasks, retry logic, and stale-task
 * handling on restore. These complement task-scheduler-recurring.test.ts which
 * covers recurring/cron-based tasks.
 *
 * The PERSIST_FILE path is resolved once at module-import time from
 * SESSION_STORE_DIR (or ~/.metabot). We point SESSION_STORE_DIR at a
 * private temp dir BEFORE importing the scheduler so these tests never
 * race a live bridge process writing the real ~/.metabot file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

process.env.SESSION_STORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'task-scheduler-one-time-'));

const { TaskScheduler } = await import('../src/scheduler/task-scheduler.js');
import type { BotRegistry } from '../src/api/bot-registry.js';
import type { Logger } from '../src/utils/logger.js';

// Mock cron-utils so recurring helper doesn't blow up when scheduler initializes
vi.mock('../src/scheduler/cron-utils.js', () => ({
  isValidCron: (expr: string) => {
    const invalid = ['invalid', '', '0 8 * *', '60 8 * * *'];
    return !invalid.includes(expr);
  },
  nextCronOccurrence: vi.fn(() => Date.now() + 60_000),
  getDefaultTimezone: () => 'Asia/Shanghai',
}));

const PERSIST_DIR = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.metabot');
const PERSIST_FILE = path.join(PERSIST_DIR, 'scheduled-tasks.json');
const MAX_SETTIMEOUT_MS = 2_147_483_647;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

interface MockBridgeOpts {
  botExists?: boolean;
  isBusy?: boolean;
  executeSuccess?: boolean;
}

function createMockRegistry(opts: MockBridgeOpts = {}): BotRegistry {
  const { botExists = true, isBusy = false, executeSuccess = true } = opts;
  const mockBridge = {
    isBusy: vi.fn().mockReturnValue(isBusy),
    executeApiTask: vi.fn().mockResolvedValue({ success: executeSuccess }),
  };
  const mockSender = {
    sendTextNotice: vi.fn().mockResolvedValue(undefined),
  };
  const mockBot = {
    bridge: mockBridge,
    sender: mockSender,
    config: { claude: { defaultWorkingDirectory: '/tmp' } },
  };
  return {
    get: vi.fn().mockReturnValue(botExists ? mockBot : undefined),
    list: vi.fn().mockReturnValue([]),
    register: vi.fn(),
    deregister: vi.fn(),
  } as unknown as BotRegistry;
}

let savedPersist: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  // Save and wipe persist file so each test starts clean
  try {
    savedPersist = fs.readFileSync(PERSIST_FILE, 'utf-8');
  } catch {
    savedPersist = undefined;
  }
  try { fs.unlinkSync(PERSIST_FILE); } catch { /* ignore */ }
});

afterEach(() => {
  vi.useRealTimers();
  // Restore original persist file
  try { fs.unlinkSync(PERSIST_FILE); } catch { /* ignore */ }
  if (savedPersist !== undefined) {
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(PERSIST_FILE, savedPersist);
  }
});

// =====================================================================
// scheduleTask — creation
// =====================================================================

describe('TaskScheduler one-time tasks — creation', () => {
  it('creates a task with correct fields', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const now = Date.now();
    const task = scheduler.scheduleTask({
      botName: 'mybot',
      chatId: 'chat1',
      prompt: 'Do something',
      delaySeconds: 120,
      label: 'My label',
      sendCards: false,
    });

    expect(task.id).toBeTruthy();
    expect(task.botName).toBe('mybot');
    expect(task.chatId).toBe('chat1');
    expect(task.prompt).toBe('Do something');
    expect(task.label).toBe('My label');
    expect(task.sendCards).toBe(false);
    expect(task.status).toBe('pending');
    expect(task.retryCount).toBe(0);
    expect(task.executeAt).toBeGreaterThanOrEqual(now + 120_000 - 50);
    expect(task.executeAt).toBeLessThanOrEqual(now + 120_000 + 50);

    scheduler.destroy();
  });

  it('defaults sendCards to true when not specified', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const task = scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p', delaySeconds: 60 });
    expect(task.sendCards).toBe(true);
    scheduler.destroy();
  });

  it('appears in listTasks() as pending', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p1', delaySeconds: 60 });
    scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p2', delaySeconds: 120 });
    expect(scheduler.listTasks()).toHaveLength(2);
    expect(scheduler.taskCount()).toBe(2);
    scheduler.destroy();
  });

  it('deduplicates system-created tasks by dedupeKey', () => {
    const firstScheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const first = firstScheduler.scheduleTask({
      botName: 'b', chatId: 'c', prompt: 'resume once', delaySeconds: 60, dedupeKey: 'restart:one',
    });
    firstScheduler.destroy();

    // Simulate another process booting after a crash between scheduling the
    // continuation and marking its restart participant recovered.
    const recoveredScheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const duplicate = recoveredScheduler.scheduleTask({
      botName: 'b', chatId: 'c', prompt: 'resume twice', delaySeconds: 120, dedupeKey: 'restart:one',
    });
    expect(duplicate.id).toBe(first.id);
    expect(recoveredScheduler.listTasks()).toHaveLength(1);
    expect(recoveredScheduler.listTasks()[0]?.prompt).toBe('resume once');
    recoveredScheduler.destroy();
  });
});

// =====================================================================
// updateTask
// =====================================================================

describe('TaskScheduler one-time tasks — updateTask', () => {
  it('updates prompt, label, sendCards', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const task = scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'old', delaySeconds: 60 });

    const updated = scheduler.updateTask(task.id, {
      prompt: 'new prompt',
      label: 'new label',
      sendCards: false,
    });
    expect(updated?.prompt).toBe('new prompt');
    expect(updated?.label).toBe('new label');
    expect(updated?.sendCards).toBe(false);
    scheduler.destroy();
  });

  it('updates delaySeconds (shifts executeAt)', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const task = scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p', delaySeconds: 60 });
    const originalExecuteAt = task.executeAt;

    const updated = scheduler.updateTask(task.id, { delaySeconds: 300 });
    expect(updated?.executeAt).toBeGreaterThan(originalExecuteAt);
    scheduler.destroy();
  });

  it('returns null for non-existent task id', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    expect(scheduler.updateTask('no-such-id', { prompt: 'x' })).toBeNull();
    scheduler.destroy();
  });

  it('returns null for a cancelled task', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const task = scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p', delaySeconds: 60 });
    scheduler.cancelTask(task.id);
    expect(scheduler.updateTask(task.id, { prompt: 'x' })).toBeNull();
    scheduler.destroy();
  });
});

// =====================================================================
// cancelTask
// =====================================================================

describe('TaskScheduler one-time tasks — cancelTask', () => {
  it('cancels a pending task and removes it from the list', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const task = scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p', delaySeconds: 60 });

    expect(scheduler.cancelTask(task.id)).toBe(true);
    expect(scheduler.listTasks()).toHaveLength(0);
    expect(scheduler.taskCount()).toBe(0);
    scheduler.destroy();
  });

  it('returns false when cancelling a non-existent task', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    expect(scheduler.cancelTask('no-such-id')).toBe(false);
    scheduler.destroy();
  });

  it('returns false when cancelling an already-cancelled task', () => {
    const scheduler = new TaskScheduler(createMockRegistry(), createMockLogger());
    const task = scheduler.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p', delaySeconds: 60 });
    scheduler.cancelTask(task.id);
    expect(scheduler.cancelTask(task.id)).toBe(false);
    scheduler.destroy();
  });
});

// =====================================================================
// Persistence — one-time tasks
// =====================================================================

describe('TaskScheduler one-time tasks — persistence', () => {
  it('persists pending tasks and restores them in a new instance', () => {
    const registry = createMockRegistry();
    const logger = createMockLogger();

    const s1 = new TaskScheduler(registry, logger);
    const task = s1.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'restore me', delaySeconds: 3600 });
    s1.destroy();

    const s2 = new TaskScheduler(registry, logger);
    const tasks = s2.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(task.id);
    expect(tasks[0].prompt).toBe('restore me');
    s2.destroy();
  });

  it('does not restore cancelled tasks', () => {
    const registry = createMockRegistry();
    const logger = createMockLogger();

    const s1 = new TaskScheduler(registry, logger);
    const task = s1.scheduleTask({ botName: 'b', chatId: 'c', prompt: 'p', delaySeconds: 3600 });
    s1.cancelTask(task.id);
    s1.destroy();

    const s2 = new TaskScheduler(registry, logger);
    expect(s2.listTasks()).toHaveLength(0);
    s2.destroy();
  });

  it('skips stale tasks (>24h overdue) on restore', () => {
    const logger = createMockLogger();

    // Write a persist file with a stale task (25h ago) and a fresh task
    const staleTask = {
      id: 'stale-task-1',
      botName: 'b',
      chatId: 'c',
      prompt: 'stale',
      executeAt: Date.now() - 25 * 60 * 60 * 1000,
      sendCards: true,
      status: 'pending',
      createdAt: Date.now() - 26 * 60 * 60 * 1000,
      retryCount: 0,
    };
    const freshTask = {
      id: 'fresh-task-1',
      botName: 'b',
      chatId: 'c',
      prompt: 'fresh',
      executeAt: Date.now() + 3600_000,
      sendCards: true,
      status: 'pending',
      createdAt: Date.now(),
      retryCount: 0,
    };
    fs.mkdirSync(PERSIST_DIR, { recursive: true });
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({ tasks: [staleTask, freshTask], recurringTasks: [] }));

    const s = new TaskScheduler(createMockRegistry(), logger);
    const tasks = s.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('fresh-task-1');
    s.destroy();
  });
});

// =====================================================================
// Task execution — happy path
// =====================================================================

describe('TaskScheduler one-time tasks — execution', () => {
  it.each([
    MAX_SETTIMEOUT_MS - 1,
    MAX_SETTIMEOUT_MS,
    MAX_SETTIMEOUT_MS + 1,
    THIRTY_DAYS_MS,
    2 * MAX_SETTIMEOUT_MS + 1000,
  ])('waits until the deadline and fires once for a %i ms delay', async (delay) => {
    const registry = createMockRegistry();
    const scheduler = new TaskScheduler(registry, createMockLogger());
    const task = scheduler.scheduleTask({
      botName: 'testbot',
      chatId: 'c',
      prompt: 'p',
      delaySeconds: delay / 1000,
    });

    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(registry.get).not.toHaveBeenCalled();
    expect(task.status).toBe('pending');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(task.status).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
    scheduler.destroy();
  });

  it.each([
    [60_000, THIRTY_DAYS_MS],
    [THIRTY_DAYS_MS, 60_000],
  ])('reschedules a %i ms delay to %i ms without leaving an old timer', async (originalDelay, newDelay) => {
    const registry = createMockRegistry();
    const scheduler = new TaskScheduler(registry, createMockLogger());
    const task = scheduler.scheduleTask({
      botName: 'testbot',
      chatId: 'c',
      prompt: 'p',
      delaySeconds: originalDelay / 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    scheduler.updateTask(task.id, { delaySeconds: newDelay / 1000 });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(newDelay - 1);
    expect(registry.get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(task.status).toBe('completed');

    await vi.advanceTimersByTimeAsync(originalDelay);
    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    scheduler.destroy();
  });

  it('cancels a long-delay task after its timer has been rearmed', async () => {
    const registry = createMockRegistry();
    const scheduler = new TaskScheduler(registry, createMockLogger());
    const task = scheduler.scheduleTask({
      botName: 'testbot',
      chatId: 'c',
      prompt: 'p',
      delaySeconds: THIRTY_DAYS_MS / 1000,
    });

    await vi.advanceTimersByTimeAsync(MAX_SETTIMEOUT_MS);
    expect(registry.get).not.toHaveBeenCalled();
    expect(scheduler.cancelTask(task.id)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(THIRTY_DAYS_MS);
    expect(registry.get).not.toHaveBeenCalled();
    expect(task.status).toBe('cancelled');
    scheduler.destroy();
  });

  it('restores a long-delay task with its original deadline', async () => {
    const registry = createMockRegistry();
    const logger = createMockLogger();
    const first = new TaskScheduler(registry, logger);
    const task = first.scheduleTask({
      botName: 'testbot',
      chatId: 'c',
      prompt: 'p',
      delaySeconds: THIRTY_DAYS_MS / 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    first.destroy();
    expect(vi.getTimerCount()).toBe(0);

    const restored = new TaskScheduler(registry, logger);
    expect(restored.listTasks()[0].executeAt).toBe(task.executeAt);
    await vi.advanceTimersByTimeAsync(THIRTY_DAYS_MS - 1001);
    expect(registry.get).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(registry.get).toHaveBeenCalledTimes(1);
    expect(restored.listTasks()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    restored.destroy();
  });

  it('fires task after delay and calls executeApiTask', async () => {
    const registry = createMockRegistry({ executeSuccess: true });
    const scheduler = new TaskScheduler(registry, createMockLogger());

    scheduler.scheduleTask({
      botName: 'testbot',
      chatId: 'chat1',
      prompt: 'Do work',
      delaySeconds: 0,
    });

    await vi.advanceTimersByTimeAsync(100);

    const bot = (registry.get as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(bot?.bridge.executeApiTask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Do work',
        chatId: 'chat1',
        userId: 'scheduler',
      }),
    );
    scheduler.destroy();
  });

  it('marks task failed when bot is not found', async () => {
    const registry = createMockRegistry({ botExists: false });
    const logger = createMockLogger();
    const scheduler = new TaskScheduler(registry, logger);

    scheduler.scheduleTask({ botName: 'ghost-bot', chatId: 'c', prompt: 'p', delaySeconds: 0 });
    await vi.advanceTimersByTimeAsync(100);

    expect(logger.error).toHaveBeenCalled();
    scheduler.destroy();
  });

  it('does not execute a cancelled task even if the timer fires', async () => {
    const registry = createMockRegistry();
    const scheduler = new TaskScheduler(registry, createMockLogger());

    const task = scheduler.scheduleTask({ botName: 'testbot', chatId: 'c', prompt: 'p', delaySeconds: 0 });
    scheduler.cancelTask(task.id);

    const callsBefore = (registry.get as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    const callsAfter = (registry.get as ReturnType<typeof vi.fn>).mock.calls.length;
    // registry.get should not be called for a cancelled task
    expect(callsAfter).toBe(callsBefore);
    scheduler.destroy();
  });
});

// =====================================================================
// Retry behavior — chat busy
// =====================================================================

describe('TaskScheduler one-time tasks — retry when chat busy', () => {
  it('marks task failed and sends notification after max retries with busy chat', async () => {
    const mockBridge = {
      isBusy: vi.fn().mockReturnValue(true), // always busy
      executeApiTask: vi.fn(),
    };
    const mockSender = { sendTextNotice: vi.fn().mockResolvedValue(undefined) };
    const mockBot = {
      bridge: mockBridge,
      sender: mockSender,
      config: {},
    };
    const registry = {
      get: vi.fn().mockReturnValue(mockBot),
      list: vi.fn().mockReturnValue([]),
    } as unknown as BotRegistry;

    const scheduler = new TaskScheduler(registry, createMockLogger());

    scheduler.scheduleTask({
      botName: 'testbot',
      chatId: 'always-busy',
      prompt: 'Never runs',
      label: 'Stuck task',
      delaySeconds: 0,
    });

    // Initial fire + 5 retries (MAX_RETRIES = 5), each 30s apart
    await vi.advanceTimersByTimeAsync(5 * 30_100 + 200);

    expect(mockSender.sendTextNotice).toHaveBeenCalledWith(
      'always-busy',
      'Scheduled Task Failed',
      expect.stringContaining('Stuck task'),
      'red',
    );
    expect(mockBridge.executeApiTask).not.toHaveBeenCalled();

    scheduler.destroy();
  });

  it('retries correctly up to the limit (retryCount increments)', async () => {
    // Intercept the task state when executeApiTask is never called
    const mockBridge = {
      isBusy: vi.fn().mockReturnValue(true),
      executeApiTask: vi.fn(),
    };
    const mockSender = { sendTextNotice: vi.fn().mockResolvedValue(undefined) };
    const registry = {
      get: vi.fn().mockReturnValue({ bridge: mockBridge, sender: mockSender, config: {} }),
      list: vi.fn().mockReturnValue([]),
    } as unknown as BotRegistry;

    const scheduler = new TaskScheduler(registry, createMockLogger());
    const task = scheduler.scheduleTask({
      botName: 'b',
      chatId: 'c',
      prompt: 'retry test',
      delaySeconds: 0,
    });

    // After 3 retries
    await vi.advanceTimersByTimeAsync(3 * 30_100 + 200);

    // The task should still exist (not yet at max retries = 5)
    // registry.get should have been called 4 times (initial + 3 retries)
    expect(registry.get as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(4);

    scheduler.destroy();
  });
});

// =====================================================================
// destroy() — clears timers
// =====================================================================

describe('TaskScheduler destroy()', () => {
  it('clears one-time timers on destroy (task does not fire after destroy)', async () => {
    const registry = createMockRegistry();
    const scheduler = new TaskScheduler(registry, createMockLogger());
    scheduler.scheduleTask({ botName: 'testbot', chatId: 'c', prompt: 'p', delaySeconds: 1 });

    const callsBefore = (registry.get as ReturnType<typeof vi.fn>).mock.calls.length;
    scheduler.destroy();

    await vi.advanceTimersByTimeAsync(2000);
    const callsAfter = (registry.get as ReturnType<typeof vi.fn>).mock.calls.length;
    // No registry.get calls after destroy
    expect(callsAfter).toBe(callsBefore);
  });
});
