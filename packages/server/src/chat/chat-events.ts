import type * as http from 'node:http';
import type { ChatStore } from './chat-store.js';
import type { ChatLiveEvent } from './chat-types.js';

/** In-process SSE fan-out for the personal chat console. */
export class ChatEventHub {
  private readonly store: ChatStore;
  private readonly heartbeatMs: number;
  private readonly clients = new Map<string, number>();

  constructor(store: ChatStore, options: { heartbeatMs?: number } = {}) {
    this.store = store;
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
  }

  clientCount(conversationId: string): number {
    return this.clients.get(conversationId) ?? 0;
  }

  stream(req: http.IncomingMessage, res: http.ServerResponse, conversationId: string, userRef: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.store.events.off('chat', listener);
      const count = this.clientCount(conversationId) - 1;
      if (count > 0) this.clients.set(conversationId, count);
      else this.clients.delete(conversationId);
      try { res.end(); } catch { /* already closed */ }
    };
    const write = (event: string, data: unknown): void => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { cleanup(); }
    };
    const listener = (event: ChatLiveEvent): void => {
      if (event.conversationId !== conversationId) return;
      if (event.type === 'message.created') write('message.created', { message: event.message });
      else if (event.type === 'run.updated') write('run.updated', { run: event.run });
      else if (event.type === 'run.event') write('run.event', { runId: event.runId, event: event.event });
      else if (event.type === 'file.created') write('file.created', { file: event.file });
    };
    this.store.events.on('chat', listener);
    this.clients.set(conversationId, this.clientCount(conversationId) + 1);
    const heartbeat = setInterval(() => {
      try { res.write(': hb\n\n'); } catch { cleanup(); }
    }, this.heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    write('snapshot', {
      messages: this.store.listMessages(conversationId, userRef, { limit: 50 }),
      runs: this.store.listRuns(conversationId, userRef).filter((run) =>
        run.status === 'queued' || run.status === 'running' || run.status === 'waiting_user',
      ),
      files: this.store.listFiles(conversationId, userRef),
    });
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }
}
