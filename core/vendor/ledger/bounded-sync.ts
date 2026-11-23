/** OrbitDB core Sync wire-compatible adapter；所有 remote head 在 Entry.decode 前先過 raw admission。 */
import { Entry } from '@orbitdb/core';

/** 單一 encoded remote head 在 decode 前允許的 byte 上限。 */
export const LEDGER_SYNC_HEAD_MAX_BYTES = 262_144;
/** Per-peer 與 global transport budget 的固定窗口長度。 */
export const LEDGER_SYNC_PEER_WINDOW_MS = 60_000;
/** 單一 authenticated peer 每窗口可提交的 raw bytes 上限。 */
export const LEDGER_SYNC_PEER_MAX_BYTES_PER_WINDOW = 1_048_576;
/** 單一 authenticated peer 每窗口可提交的訊息數上限。 */
export const LEDGER_SYNC_PEER_MAX_MESSAGES_PER_WINDOW = 256;
/** Raw admission 同時追蹤的 peer budget 數上限。 */
export const LEDGER_SYNC_PEER_STATES_MAX = 4096;
/** 所有來源每窗口可提交的 aggregate raw bytes 上限。 */
export const LEDGER_SYNC_GLOBAL_MAX_BYTES_PER_WINDOW = 16 * 1024 * 1024;
/** 所有來源每窗口可提交的 aggregate 訊息數上限。 */
export const LEDGER_SYNC_GLOBAL_MAX_MESSAGES_PER_WINDOW = 4096;
/** 等待處理的 sync 工作可保留 raw bytes 上限。 */
export const LEDGER_SYNC_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
/** 等待處理的 sync 訊息數上限。 */
export const LEDGER_SYNC_QUEUE_MAX_MESSAGES = 64;
/** 同時處理 remote heads 的工作數上限。 */
export const LEDGER_SYNC_HEAD_STREAM_MAX = 16;
/** 同時 fetch remote entries 的工作數上限。 */
export const LEDGER_SYNC_ENTRY_FETCH_STREAM_MAX = 32;
/** 單一 sync stream 在 transport 層允許的最長時間。 */
export const LEDGER_SYNC_STREAM_TIMEOUT_MS = 30_000;

interface PeerBudget {
  bytes: number;
  messages: number;
  windowStart: number;
  lastSeen: number;
}

/** decode 前的 per-authenticated-libp2p-peer raw byte admission。 */
export class SyncRawAdmission {
  /** Authenticated peer id 至目前窗口 budget。 */
  private readonly peers = new Map<string, PeerBudget>();
  /** 目前 global 窗口已接受的 raw bytes。 */
  private globalBytes = 0;
  /** 目前 global 窗口已接受的訊息數。 */
  private globalMessages = 0;
  /** 目前 global 固定窗口的起始本地時間。 */
  private globalWindowStart = 0;

  /**
   * @param now 本機牆鐘（僅 transport DoS 防護，不參與 ledger 共識）。
   * @param maxHeadBytes 單一 encoded Orbit entry 上限。
   * @param windowMs per-peer 固定窗口。
   * @param maxBytesPerWindow 每 peer 每窗口 raw bytes 上限。
   * @param maxMessagesPerWindow 每 peer 每窗口訊息數上限，避免極小畸形包放大 decode CPU。
   * @param maxPeers 同時追蹤 peer 上限。
   * @param globalMaxBytesPerWindow 全來源 aggregate raw bytes 上限。
   * @param globalMaxMessagesPerWindow 全來源 aggregate 訊息數上限。
   */
  constructor(
    /** Transport DoS budget 使用的本地牆鐘。 */
    private readonly now: () => number = Date.now,
    /** 單一 head decode 前 byte 上限。 */
    private readonly maxHeadBytes = LEDGER_SYNC_HEAD_MAX_BYTES,
    /** Per-peer 與 global budget 窗口長度。 */
    private readonly windowMs = LEDGER_SYNC_PEER_WINDOW_MS,
    /** 每 peer 每窗口 raw bytes 上限。 */
    private readonly maxBytesPerWindow = LEDGER_SYNC_PEER_MAX_BYTES_PER_WINDOW,
    /** 每 peer 每窗口訊息數上限。 */
    private readonly maxMessagesPerWindow = LEDGER_SYNC_PEER_MAX_MESSAGES_PER_WINDOW,
    /** 同時保留的 peer budget 數上限。 */
    private readonly maxPeers = LEDGER_SYNC_PEER_STATES_MAX,
    /** 全來源每窗口 raw bytes 上限。 */
    private readonly globalMaxBytesPerWindow = LEDGER_SYNC_GLOBAL_MAX_BYTES_PER_WINDOW,
    /** 全來源每窗口訊息數上限。 */
    private readonly globalMaxMessagesPerWindow = LEDGER_SYNC_GLOBAL_MAX_MESSAGES_PER_WINDOW,
  ) {
    this.globalWindowStart = now();
  }

  /** @param peer authenticated libp2p source。 @param bytes decode 前 byteLength。 */
  shouldAccept(peer: string, bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.maxHeadBytes) return false;
    const at = this.now();
    if (at - this.globalWindowStart > this.windowMs) {
      this.globalBytes = 0;
      this.globalMessages = 0;
      this.globalWindowStart = at;
    }
    if (
      this.globalBytes + bytes > this.globalMaxBytesPerWindow ||
      this.globalMessages + 1 > this.globalMaxMessagesPerWindow
    )
      return false;
    let budget = this.peers.get(peer);
    if (budget === undefined || at - budget.windowStart > this.windowMs) {
      if (budget === undefined && this.peers.size >= this.maxPeers) this.evictOldest();
      budget = { bytes: 0, messages: 0, windowStart: at, lastSeen: at };
      this.peers.set(peer, budget);
    }
    budget.lastSeen = at;
    if (
      budget.bytes + bytes > this.maxBytesPerWindow ||
      budget.messages + 1 > this.maxMessagesPerWindow
    )
      return false;
    budget.bytes += bytes;
    budget.messages++;
    this.globalBytes += bytes;
    this.globalMessages++;
    return true;
  }

  /** 容量滿時移除最久未見的 peer budget。 */
  private evictOldest(): void {
    let oldest: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [peer, budget] of this.peers)
      if (budget.lastSeen < oldestAt) {
        oldest = peer;
        oldestAt = budget.lastSeen;
      }
    if (oldest !== undefined) this.peers.delete(oldest);
  }
}

class SyncQueueBudget {
  /** 目前已保留的 queue message 數。 */
  private messages = 0;
  /** 目前已保留的 queue raw bytes。 */
  private bytes = 0;

  constructor(
    /** Queue 可同時保留的訊息數上限。 */
    private readonly maxMessages: number,
    /** Queue 可同時保留的 raw bytes 上限。 */
    private readonly maxBytes: number,
  ) {}

  reserve(bytes: number): boolean {
    if (this.messages + 1 > this.maxMessages || this.bytes + bytes > this.maxBytes) return false;
    this.messages++;
    this.bytes += bytes;
    return true;
  }

  release(bytes: number): void {
    this.messages--;
    this.bytes -= bytes;
  }
}

class SyncTaskPool {
  /** 尚未 settled 的 bounded concurrent tasks。 */
  private readonly tasks = new Set<Promise<void>>();

  constructor(
    /** 限制可同時執行的同步工作數，避免遠端來源使本機資源飽和。 */ private readonly maximum: number,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new RangeError('sync task pool maximum must be positive');
  }

  tryRun(work: () => Promise<void>, onError: (error: unknown) => void): boolean {
    if (this.tasks.size >= this.maximum) return false;
    const task = Promise.resolve()
      .then(work)
      .catch(onError)
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
    return true;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }
}

interface SyncEvents {
  emit(name: string, ...args: unknown[]): unknown;
}

interface SyncLog {
  id: string;
  heads(): Promise<{ hash: string }[]>;
  storage: { get(hash: string): Promise<Uint8Array | undefined> };
  encryption: {
    replication?: { decrypt?: unknown };
    data?: { decrypt?: unknown };
  };
}

interface SyncStream extends AsyncIterable<{ byteLength: number; subarray(): Uint8Array }> {
  send(bytes: Uint8Array): void | Promise<void>;
  close(): void | Promise<void>;
  abort?(error: Error): void;
}

interface Libp2pLike {
  dialProtocol(peer: unknown, protocol: string, options?: unknown): Promise<SyncStream>;
  handle(
    protocol: string,
    handler: (stream: SyncStream, connection: { remotePeer: unknown }) => void,
  ): Promise<void>;
  unhandle(protocol: string): Promise<void>;
  addEventListener(type: string, listener: (event: { detail: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { detail: unknown }) => void): void;
  services: {
    pubsub?: {
      subscribe(topic: string): void | Promise<void>;
      unsubscribe(topic: string): void | Promise<void>;
      publish(topic: string, bytes: Uint8Array): void | Promise<void>;
      addEventListener(type: string, listener: (event: { detail: unknown }) => void): void;
      removeEventListener(type: string, listener: (event: { detail: unknown }) => void): void;
    };
  };
}

interface BoundedSyncOptions {
  ipfs: { libp2p: Libp2pLike };
  log: SyncLog;
  events: SyncEvents;
  onSynced(entry: unknown, source: string, rawBytes: Uint8Array): Promise<void>;
  start?: boolean;
  queueMaxMessages?: number;
  queueMaxBytes?: number;
  admission?: SyncRawAdmission;
  /** 測試可注入窄 decoder port，避免 whole-module mock 污染；production 固定省略。 */
  decodeEntry?: (
    bytes: Uint8Array,
    replicationDecrypt?: unknown,
    dataDecrypt?: unknown,
  ) => Promise<unknown>;
  /** integration/diagnostic mode；production 預設 true。false 時只註冊 entry-fetch protocol。 */
  headsSync?: boolean;
  headStreamMax?: number;
  entryFetchMaxStreams?: number;
  streamTimeoutMs?: number;
  /** 瀏覽器組裝層注入的 PeerId parser；避免 ledger 核心載入 libp2p identity 實作。 */
  peerTargetFromString?: (peer: string) => unknown | Promise<unknown>;
}

function frameHeader(length: number): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, length, false);
  return header;
}

async function writeFrame(stream: SyncStream, bytes: Uint8Array): Promise<void> {
  await stream.send(frameHeader(bytes.byteLength));
  if (bytes.byteLength > 0) await stream.send(bytes);
}

/** byte-stream 上的多 frame decoder；正確處理 split header/payload 與 coalesced frames。 */
async function* readFrames(stream: SyncStream, maximum: number): AsyncIterable<Uint8Array> {
  const header = new Uint8Array(4);
  let headerOffset = 0;
  let payload: Uint8Array | undefined;
  let payloadOffset = 0;
  for await (const value of stream) {
    const chunk = value.subarray();
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (payload === undefined) {
        const count = Math.min(4 - headerOffset, chunk.byteLength - offset);
        header.set(chunk.subarray(offset, offset + count), headerOffset);
        headerOffset += count;
        offset += count;
        if (headerOffset < 4) continue;
        const length = new DataView(header.buffer).getUint32(0, false);
        if (length === 0 || length > maximum)
          throw new RangeError('ledger heads frame size invalid');
        payload = new Uint8Array(length);
        payloadOffset = 0;
      }
      const count = Math.min(payload.byteLength - payloadOffset, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + count), payloadOffset);
      payloadOffset += count;
      offset += count;
      if (payloadOffset === payload.byteLength) {
        yield payload;
        payload = undefined;
        headerOffset = 0;
      }
    }
  }
  if (headerOffset !== 0 || payload !== undefined) throw new Error('ledger heads frame truncated');
}

/** length header 先完成 admission，再配置 payload；0-length 表示 not-found。 */
async function readFrame(stream: SyncStream, maximum: number): Promise<Uint8Array | null> {
  const header = new Uint8Array(4);
  let headerOffset = 0;
  let payload: Uint8Array | null | undefined;
  let payloadOffset = 0;
  for await (const value of stream) {
    const chunk = value.subarray();
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (headerOffset < 4) {
        const count = Math.min(4 - headerOffset, chunk.byteLength - offset);
        header.set(chunk.subarray(offset, offset + count), headerOffset);
        headerOffset += count;
        offset += count;
        if (headerOffset === 4) {
          const length = new DataView(header.buffer).getUint32(0, false);
          if (length > maximum) throw new RangeError('ledger entry fetch frame too large');
          if (length === 0) payload = null;
          else payload = new Uint8Array(length);
        }
        continue;
      }
      if (payload === null) throw new Error('entry fetch frame has trailing bytes');
      if (payload === undefined) throw new Error('entry fetch frame missing header');
      const count = Math.min(payload.byteLength - payloadOffset, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + count), payloadOffset);
      payloadOffset += count;
      offset += count;
      if (payloadOffset === payload.byteLength) {
        if (offset !== chunk.byteLength) throw new Error('entry fetch frame has trailing bytes');
        return payload;
      }
    }
    if (payload === null) return null;
  }
  throw new Error('entry fetch frame truncated');
}

/** 建立與 OrbitDB core topic/protocol 相容、但 decode 前有界的 sync instance。 */
export async function BoundedSync(options: BoundedSyncOptions) {
  const { log, events, onSynced } = options;
  const libp2p = options.ipfs.libp2p;
  const headsSync = options.headsSync ?? true;
  const pubsub = libp2p.services.pubsub;
  if (headsSync && pubsub === undefined) throw new Error('bounded sync requires pubsub service');
  const address = log.id;
  const headsSyncAddress = `/orbitdb/heads/${address}`.replace(/(?<=\/)\/+|^\.\//g, '');
  const entryFetchAddress = `/open4wd/orbit-entry-fetch/1/${address}`.replace(
    /(?<=\/)\/+|^\.\//g,
    '',
  );
  const peers = new Set<string>();
  const peerTargets = new Map<string, { target: unknown; lastSeen: number }>();
  const admission = options.admission ?? new SyncRawAdmission();
  const queueBudget = new SyncQueueBudget(
    options.queueMaxMessages ?? LEDGER_SYNC_QUEUE_MAX_MESSAGES,
    options.queueMaxBytes ?? LEDGER_SYNC_QUEUE_MAX_BYTES,
  );
  const decodeEntry = options.decodeEntry ?? Entry.decode;
  const operationPool = new SyncTaskPool(
    options.queueMaxMessages ?? LEDGER_SYNC_QUEUE_MAX_MESSAGES,
  );
  const headStreamPool = new SyncTaskPool(options.headStreamMax ?? LEDGER_SYNC_HEAD_STREAM_MAX);
  const entryFetchPool = new SyncTaskPool(
    options.entryFetchMaxStreams ?? LEDGER_SYNC_ENTRY_FETCH_STREAM_MAX,
  );
  const streamTimeoutMs = options.streamTimeoutMs ?? LEDGER_SYNC_STREAM_TIMEOUT_MS;
  const activeStreams = new Set<SyncStream>();
  let started = false;
  const resources = {
    disconnectListener: false,
    entryFetchHandler: false,
    headsHandler: false,
    messageListener: false,
    subscribed: false,
    subscriptionListener: false,
  };
  const forgetPeer = (peer: string): void => {
    peers.delete(peer);
    peerTargets.delete(peer);
  };
  const prunePeerTargets = (at: number): void => {
    for (const [peer, record] of peerTargets) {
      if (at - record.lastSeen <= LEDGER_SYNC_PEER_WINDOW_MS) continue;
      forgetPeer(peer);
    }
  };
  const rememberPeerTarget = (peer: string, target: unknown): void => {
    const at = Date.now();
    prunePeerTargets(at);
    peerTargets.delete(peer);
    peerTargets.set(peer, { target, lastSeen: at });
    while (peerTargets.size > LEDGER_SYNC_PEER_STATES_MAX) {
      const oldest = peerTargets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      forgetPeer(oldest);
    }
  };
  const reportError = (error: unknown): void => {
    events.emit('error', error);
  };
  const withStreamDeadline = async <T>(stream: SyncStream, work: () => Promise<T>): Promise<T> => {
    activeStreams.add(stream);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('ledger sync stream timed out');
        stream.abort?.(error);
        reject(error);
      }, streamTimeoutMs);
    });
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      activeStreams.delete(stream);
    }
  };

  const decodeAndApply = async (bytes: Uint8Array): Promise<unknown> => {
    const entry = await decodeEntry(
      bytes,
      log.encryption.replication?.decrypt,
      log.encryption.data?.decrypt,
    );
    return entry;
  };
  const sendHeads = async (stream: SyncStream): Promise<void> => {
    for (const { hash } of await log.heads()) {
      const bytes = await log.storage.get(hash);
      if (bytes !== undefined) await writeFrame(stream, bytes);
    }
  };
  const receiveHeads = async (peer: string, stream: SyncStream): Promise<void> => {
    for await (const value of readFrames(stream, LEDGER_SYNC_HEAD_MAX_BYTES)) {
      if (!admission.shouldAccept(peer, value.byteLength)) continue;
      if (!queueBudget.reserve(value.byteLength)) continue;
      try {
        await onSynced(await decodeAndApply(value), peer, value);
      } finally {
        queueBudget.release(value.byteLength);
      }
    }
    if (started) events.emit('join', peer, await log.heads());
  };
  const handleReceiveHeads = (stream: SyncStream, connection: { remotePeer: unknown }): void => {
    const peer = String(connection.remotePeer);
    peers.add(peer);
    rememberPeerTarget(peer, connection.remotePeer);
    const accepted = headStreamPool.tryRun(async () => {
      try {
        await withStreamDeadline(stream, () =>
          Promise.all([
            receiveHeads(peer, stream),
            sendHeads(stream).then(() => stream.close()),
          ]).then(() => undefined),
        );
      } catch (error) {
        forgetPeer(peer);
        throw error;
      }
    }, reportError);
    if (!accepted) {
      const error = new Error('ledger heads stream concurrency limit exceeded');
      stream.abort?.(error);
      forgetPeer(peer);
    }
  };
  const handleUpdateMessage = (event: { detail: unknown }): void => {
    const detail = event.detail as { topic?: unknown; data?: unknown; from?: unknown };
    if (
      detail.topic !== address ||
      !(detail.data instanceof Uint8Array) ||
      detail.from === undefined
    )
      return;
    const peer = String(detail.from);
    const bytes = detail.data;
    // admission 與 reservation 都在 listener 同步完成；拒收 raw 不得被 Promise closure 保留。
    if (!admission.shouldAccept(peer, bytes.byteLength)) return;
    rememberPeerTarget(peer, detail.from);
    if (!queueBudget.reserve(bytes.byteLength)) return;
    const accepted = operationPool.tryRun(async () => {
      try {
        await onSynced(await decodeAndApply(bytes), peer, bytes);
      } catch (cause) {
        forgetPeer(peer);
        throw cause;
      } finally {
        queueBudget.release(bytes.byteLength);
      }
    }, reportError);
    if (!accepted) queueBudget.release(bytes.byteLength);
  };
  const handleEntryFetch = (stream: SyncStream, connection: { remotePeer: unknown }): void => {
    const peer = String(connection.remotePeer);
    const accepted = entryFetchPool.tryRun(async () => {
      try {
        await withStreamDeadline(stream, async () => {
          const request = await readFrame(stream, 512);
          if (request === null) throw new Error('empty entry fetch request');
          if (!admission.shouldAccept(peer, request.byteLength)) {
            await writeFrame(stream, new Uint8Array());
            await stream.close();
            return;
          }
          const hash = new TextDecoder('utf-8', { fatal: true }).decode(request);
          const bytes = await log.storage.get(hash);
          if (bytes === undefined || !admission.shouldAccept(peer, bytes.byteLength))
            await writeFrame(stream, new Uint8Array());
          else await writeFrame(stream, bytes);
          await stream.close();
        });
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        stream.abort?.(error);
        throw error;
      }
    }, reportError);
    if (!accepted) stream.abort?.(new Error('ledger entry-fetch concurrency limit exceeded'));
  };
  const handlePeerSubscribed = (event: { detail: unknown }): void => {
    const detail = event.detail as {
      peerId?: unknown;
      subscriptions?: { topic: string; subscribe: boolean }[];
    };
    const peer = String(detail.peerId);
    const subscription = detail.subscriptions?.find((item) => item.topic === address);
    if (subscription === undefined) return;
    if (!subscription.subscribe) {
      forgetPeer(peer);
      events.emit('leave', peer);
      return;
    }
    if (peers.has(peer)) return;
    peers.add(peer);
    rememberPeerTarget(peer, detail.peerId);
    const accepted = headStreamPool.tryRun(async () => {
      try {
        const stream = await libp2p.dialProtocol(detail.peerId, headsSyncAddress, {
          signal: AbortSignal.timeout(streamTimeoutMs),
        });
        await withStreamDeadline(stream, () =>
          Promise.all([
            receiveHeads(peer, stream),
            sendHeads(stream).then(() => stream.close()),
          ]).then(() => undefined),
        );
      } catch (error) {
        forgetPeer(peer);
        throw error;
      }
    }, reportError);
    if (!accepted) {
      forgetPeer(peer);
    }
  };
  const handlePeerDisconnected = (event: { detail: unknown }): void => {
    const peer = String(event.detail);
    forgetPeer(peer);
  };

  const attemptCleanup = async (
    errors: unknown[],
    cleanup: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  };
  const cleanupRegistrations = async (errors: unknown[]): Promise<void> => {
    if (resources.disconnectListener) {
      resources.disconnectListener = false;
      await attemptCleanup(errors, () =>
        libp2p.removeEventListener('peer:disconnect', handlePeerDisconnected),
      );
    }
    if (resources.entryFetchHandler) {
      resources.entryFetchHandler = false;
      await attemptCleanup(errors, () => libp2p.unhandle(entryFetchAddress));
    }
    if (resources.headsHandler) {
      resources.headsHandler = false;
      await attemptCleanup(errors, () => libp2p.unhandle(headsSyncAddress));
    }
    if (resources.subscribed) {
      resources.subscribed = false;
      await attemptCleanup(errors, () => pubsub!.unsubscribe(address));
    }
    if (resources.messageListener) {
      resources.messageListener = false;
      await attemptCleanup(errors, () =>
        pubsub!.removeEventListener('message', handleUpdateMessage),
      );
    }
    if (resources.subscriptionListener) {
      resources.subscriptionListener = false;
      await attemptCleanup(errors, () =>
        pubsub!.removeEventListener('subscription-change', handlePeerSubscribed),
      );
    }
  };
  const cleanupRuntime = async (errors: unknown[]): Promise<void> => {
    const stopped = new Error('ledger sync stopped');
    const streams = [...activeStreams];
    activeStreams.clear();
    for (const stream of streams)
      await attemptCleanup(errors, () => {
        if (stream.abort !== undefined) stream.abort(stopped);
        else return stream.close();
      });
    const drains = await Promise.allSettled([
      operationPool.drain(),
      headStreamPool.drain(),
      entryFetchPool.drain(),
    ]);
    for (const result of drains) if (result.status === 'rejected') errors.push(result.reason);
    peers.clear();
    peerTargets.clear();
  };
  const cleanup = async (errors: unknown[]): Promise<void> => {
    await cleanupRegistrations(errors);
    await cleanupRuntime(errors);
  };

  const start = async (): Promise<void> => {
    if (started) return;
    try {
      if (headsSync) {
        resources.subscriptionListener = true;
        pubsub!.addEventListener('subscription-change', handlePeerSubscribed);
        resources.messageListener = true;
        pubsub!.addEventListener('message', handleUpdateMessage);
        resources.subscribed = true;
        await pubsub!.subscribe(address);
        resources.headsHandler = true;
        await libp2p.handle(headsSyncAddress, handleReceiveHeads);
      }
      resources.entryFetchHandler = true;
      await libp2p.handle(entryFetchAddress, handleEntryFetch);
      resources.disconnectListener = true;
      libp2p.addEventListener('peer:disconnect', handlePeerDisconnected);
      started = true;
    } catch (cause) {
      started = false;
      const rollbackErrors: unknown[] = [];
      await cleanup(rollbackErrors);
      if (rollbackErrors.length > 0)
        throw new AggregateError(
          [cause, ...rollbackErrors],
          'bounded sync start and rollback failed',
          { cause },
        );
      throw cause;
    }
  };
  const stop = async (): Promise<void> => {
    if (
      !started &&
      !Object.values(resources).some(Boolean) &&
      activeStreams.size === 0 &&
      peers.size === 0 &&
      peerTargets.size === 0
    )
      return;
    started = false;
    const errors: unknown[] = [];
    await cleanup(errors);
    if (errors.length > 0) throw new AggregateError(errors, 'bounded sync stop failed');
  };
  const add = async (entry: { hash?: string }): Promise<void> => {
    if (!started || !headsSync || !entry.hash) return;
    const bytes = await log.storage.get(entry.hash);
    if (bytes !== undefined) await pubsub!.publish(address, bytes);
  };
  const fetchEntry = async (hash: string, peer: string): Promise<Uint8Array> => {
    const record = peerTargets.get(peer);
    if (record !== undefined && Date.now() - record.lastSeen > LEDGER_SYNC_PEER_WINDOW_MS)
      forgetPeer(peer);
    let target = peerTargets.get(peer)?.target;
    if (target === undefined)
      target = options.peerTargetFromString ? await options.peerTargetFromString(peer) : peer; // test doubles；production 組裝層必須注入 PeerId parser
    let stream: SyncStream | undefined;
    let completed = false;
    try {
      const activeStream = await libp2p.dialProtocol(target, entryFetchAddress, {
        signal: AbortSignal.timeout(30_000),
      });
      stream = activeStream;
      await writeFrame(activeStream, new TextEncoder().encode(hash));
      const bytes = await withStreamDeadline(activeStream, () =>
        readFrame(activeStream, LEDGER_SYNC_HEAD_MAX_BYTES),
      );
      if (bytes === null || !admission.shouldAccept(peer, bytes.byteLength))
        throw new Error(`missing or rejected remote ledger entry: ${hash}`);
      const decoded = (await decodeEntry(bytes)) as { hash?: unknown };
      if (decoded.hash !== hash) throw new Error(`remote ledger entry CID mismatch: ${hash}`);
      completed = true;
      return bytes;
    } catch (cause) {
      forgetPeer(peer);
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (stream?.abort !== undefined) stream.abort(error);
      else if (stream !== undefined) {
        try {
          await stream.close();
        } catch {
          /* preserve the frame/admission failure */
        }
      }
      throw error;
    } finally {
      if (completed && stream !== undefined)
        try {
          await stream.close();
        } catch {
          /* response was already fully validated */
        }
    }
  };
  if (options.start !== false) await start();
  return { add, fetchEntry, start, stop, peers };
}
