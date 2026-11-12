import type { Readable } from 'node:stream';

type StartupInputOptions = {
  onEof(): void;
  onOverflow(): void;
  maximumBytes?: number;
};

/**
 * Consume startup input so EOF can cancel Chrome before the MCP CLI is loaded.
 * Only the bounded initialization request is expected before the handshake.
 * Replay preserves its bytes for the installed CLI's own stdio transport.
 */
export function bufferBrowserPeerInput(input: Readable, options: StartupInputOptions) {
  const maximumBytes = options.maximumBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new Error('The Chrome startup input limit is invalid.');
  let phase: 'capturing' | 'replayed' | 'handed-off' | 'finished' | 'disposed' = 'capturing';
  let bytes = 0;
  const chunks: Buffer[] = [];

  const removeListeners = () => {
    input.off('data', capture);
    input.off('end', eof);
    input.off('close', eof);
  };
  const clear = () => {
    chunks.length = 0;
    bytes = 0;
  };
  const finish = (callback: () => void) => {
    if (phase !== 'capturing') return;
    phase = 'finished';
    input.pause();
    removeListeners();
    clear();
    callback();
  };
  function eof() {
    finish(options.onEof);
  }
  function capture(chunk: Buffer | string) {
    if (phase !== 'capturing') return;
    const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (size > maximumBytes - bytes) {
      finish(options.onOverflow);
      return;
    }
    // Keep a private copy: a producer may reuse its backing buffer after write.
    chunks.push(Buffer.from(chunk));
    bytes += size;
  }

  input.on('end', eof);
  input.on('close', eof);
  input.on('data', capture);
  if (input.readableEnded || input.destroyed) eof();
  else input.resume();

  return {
    /** Pause, then put captured bytes back before importing the installed CLI. */
    replay(): void {
      if (phase === 'replayed' || phase === 'handed-off') return;
      if (phase !== 'capturing')
        throw new Error('Chrome startup input closed before the MCP handshake.');
      phase = 'replayed';
      input.pause();
      removeListeners();
      for (let index = chunks.length - 1; index >= 0; --index) input.unshift(chunks[index]);
      clear();
    },
    /** Call only after the CLI has installed its data listener. */
    resume(): void {
      if (phase !== 'replayed') return;
      phase = 'handed-off';
      input.resume();
    },
    dispose(): void {
      if (phase === 'capturing') input.pause();
      phase = 'disposed';
      removeListeners();
      clear();
    },
  };
}
