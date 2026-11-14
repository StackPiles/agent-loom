import type { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { ServerEvent, Snapshot } from '../shared/types.js';
import { recordMemoryDiagnostic } from './memory-diagnostics.js';

export const EVENT_STREAM_PENDING_BYTES = 4 * 1024 * 1024;
export const EVENT_STREAM_CHUNK_BYTES = 64 * 1024;
export const EVENT_STREAM_STALL_MS = 15_000;

interface Limits {
  pendingBytes: number;
  chunkBytes: number;
  stallMs: number;
}
interface Client {
  response: ServerResponse;
  authorized: () => boolean;
  protocol: 1 | 2;
  sender: BoundedSender;
  needsSnapshot: boolean;
}

/** One in-progress frame plus a finite queue; Node's socket only receives small chunks. */
class BoundedSender {
  private current?: { frame: Buffer; offset: number };
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private blocked = false;
  private closed = false;
  private stallTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly response: ServerResponse,
    private readonly authorized: () => boolean,
    private readonly limits: Limits,
    private readonly onIdle: () => void,
    private readonly onClose: () => void,
  ) {
    response.on('drain', this.drain);
    response.on('close', this.cleanup);
    response.on('error', this.cleanup);
  }

  get idle() {
    return !this.closed && !this.blocked && !this.current && this.pending.length === 0;
  }

  get metrics() {
    return {
      pendingBytes: this.pendingBytes,
      inFlightBytes: this.current?.frame.length ?? 0,
      socketBytes: this.response.writableLength,
    };
  }

  send(frame: Buffer) {
    if (this.closed) return;
    if (!this.authorized()) return this.close();
    if (this.idle) {
      this.current = { frame, offset: 0 };
    } else {
      // The initial full-state frame is allowed to be larger than the queue.
      // Only that one frame is retained; subsequent events cannot grow without
      // bound while a browser is stalled. Reconnection starts from fresh state.
      if (this.pendingBytes + frame.length > this.limits.pendingBytes) {
        recordMemoryDiagnostic('sse.backlog_limit', this.metrics);
        return this.close(true);
      }
      this.pending.push(frame);
      this.pendingBytes += frame.length;
    }
    this.pump();
  }

  close(force = false) {
    if (this.closed) return;
    const buffered = !this.idle || this.response.writableLength > 0;
    this.cleanup();
    // Revocation/shutdown must not finish sending queued private events.
    if (force || buffered) this.response.destroy();
    else this.response.end();
  }

  private pump() {
    if (this.closed || this.blocked) return;
    if (!this.authorized()) return this.close();
    while (!this.blocked && !this.closed) {
      if (!this.current) {
        const frame = this.pending.shift();
        if (!frame) break;
        this.pendingBytes -= frame.length;
        this.current = { frame, offset: 0 };
      }
      const { frame, offset } = this.current;
      const end = Math.min(frame.length, offset + this.limits.chunkBytes);
      const chunk = frame.subarray(offset, end);
      this.current.offset = end;
      if (end === frame.length) this.current = undefined;
      try {
        this.blocked = !this.response.write(chunk);
      } catch {
        this.close(true);
        return;
      }
      if (this.blocked) {
        this.stallTimer = setTimeout(() => {
          recordMemoryDiagnostic('sse.stall_timeout', this.metrics);
          this.close(true);
        }, this.limits.stallMs);
        this.stallTimer.unref();
      }
    }
    if (this.idle) this.onIdle();
  }

  private drain = () => {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.blocked = false;
    this.pump();
  };

  private cleanup = () => {
    if (this.closed) return;
    this.closed = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
    this.current = undefined;
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.response.off('drain', this.drain);
    this.response.off('close', this.cleanup);
    this.response.off('error', this.cleanup);
    this.onClose();
  };
}

interface StreamHost {
  events: EventEmitter;
  getSnapshot(): Snapshot;
}

/** Shared fan-out serializes each broadcast once, independent of tab count. */
export class EventStreams {
  private readonly clients = new Set<Client>();
  private eventId = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly limits: Limits;
  private readonly forwards = new Map<string, (data: ServerEvent['data']) => void>();

  constructor(
    private readonly host: StreamHost,
    limits: Partial<Limits> = {},
  ) {
    this.limits = {
      pendingBytes: EVENT_STREAM_PENDING_BYTES,
      chunkBytes: EVENT_STREAM_CHUNK_BYTES,
      stallMs: EVENT_STREAM_STALL_MS,
      ...limits,
    };
  }

  add(response: ServerResponse, authorized: () => boolean, protocol: 1 | 2) {
    const client = { response, authorized, protocol, needsSnapshot: false } as Client;
    client.sender = new BoundedSender(
      response,
      authorized,
      this.limits,
      () => {
        if (client.needsSnapshot) {
          client.needsSnapshot = false;
          this.sendSnapshot(client);
        }
      },
      () => {
        this.clients.delete(client);
        this.updateSubscriptions();
      },
    );
    this.clients.add(client);
    this.updateSubscriptions();
    this.sendSnapshot(client);
  }

  closeUnauthorized() {
    for (const client of this.clients) if (!client.authorized()) client.sender.close();
  }

  close() {
    for (const client of this.clients) client.sender.close();
  }

  diagnostics() {
    let pendingBytes = 0;
    let inFlightBytes = 0;
    let socketBytes = 0;
    for (const client of this.clients) {
      const metrics = client.sender.metrics;
      pendingBytes += metrics.pendingBytes;
      inFlightBytes += metrics.inFlightBytes;
      socketBytes += metrics.socketBytes;
    }
    return { clientCount: this.clients.size, pendingBytes, inFlightBytes, socketBytes };
  }

  private encode(type: ServerEvent['type'], data: ServerEvent['data']) {
    const id = ++this.eventId;
    const frame = Buffer.from(`id: ${id}\ndata: ${JSON.stringify({ id, type, data })}\n\n`);
    if (type === 'snapshot')
      recordMemoryDiagnostic('sse.snapshot', {
        snapshotBytes: frame.length,
        clientCount: this.clients.size,
      });
    return frame;
  }

  private sendSnapshot(client: Client) {
    if (!client.authorized()) return client.sender.close();
    client.sender.send(this.encode('snapshot', this.host.getSnapshot()));
  }

  private broadcast = (type: ServerEvent['type'], data: ServerEvent['data']) => {
    const clients = [...this.clients].filter((client) => {
      if (!client.authorized()) {
        client.sender.close();
        return false;
      }
      if (type === 'state_patch' && client.protocol !== 2) return false;
      // Heartbeats are dispensable and must not consume a stalled queue.
      return type !== 'heartbeat' || client.sender.idle;
    });
    if (!clients.length) return;
    const frame = this.encode(type, data);
    for (const client of clients) client.sender.send(frame);
  };

  private legacySnapshot = () => {
    this.closeUnauthorized();
    const ready: Client[] = [];
    for (const client of this.clients) {
      if (client.protocol !== 1) continue;
      if (client.sender.idle) ready.push(client);
      else client.needsSnapshot = true;
    }
    // A blocked legacy subscriber records just an invalidation, not repeated
    // full JSON copies. When it catches up it receives one current snapshot.
    if (!ready.length) return;
    const frame = this.encode('snapshot', this.host.getSnapshot());
    for (const client of ready) client.sender.send(frame);
  };

  private updateSubscriptions() {
    const any = this.clients.size > 0;
    const legacy = [...this.clients].some((client) => client.protocol === 1);
    const patches = [...this.clients].some((client) => client.protocol === 2);
    for (const type of [
      'message_delta',
      'message_reasoning_delta',
      'message_updated',
      'state_patch',
    ] as const) {
      const wanted = type === 'state_patch' ? patches : any;
      const existing = this.forwards.get(type);
      if (wanted && !existing) {
        const forward = (data: ServerEvent['data']) => this.broadcast(type, data);
        this.forwards.set(type, forward);
        this.host.events.on(type, forward);
      } else if (!wanted && existing) {
        this.host.events.off(type, existing);
        this.forwards.delete(type);
      }
    }
    this.host.events.off('snapshot_invalidated', this.legacySnapshot);
    if (legacy) this.host.events.on('snapshot_invalidated', this.legacySnapshot);
    if (any && !this.heartbeat) {
      this.heartbeat = setInterval(() => this.broadcast('heartbeat', null), 15_000);
      this.heartbeat.unref();
    } else if (!any && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}
