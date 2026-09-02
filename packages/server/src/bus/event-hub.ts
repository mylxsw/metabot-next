import type * as http from 'node:http';

export interface BusEvent {
  type: string;
  roomId?: string;
  agentRef?: string;
  messageId?: string;
  runId?: string;
  correlationId?: string;
  payload?: Record<string, unknown>;
}

type Listener = (event: BusEvent) => void;

/** In-process event fan-out used by the personal Core server. */
export class BusEventHub {
  private readonly listeners = new Set<Listener>();

  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listeners must not break writes */
      }
    }
  }

  subscribe(req: http.IncomingMessage, res: http.ServerResponse, filter: (event: BusEvent) => boolean): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const listener = (event: BusEvent) => {
      if (filter(event)) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    this.listeners.add(listener);
    const close = () => this.listeners.delete(listener);
    req.on('close', close);
    res.on('close', close);
  }
}
