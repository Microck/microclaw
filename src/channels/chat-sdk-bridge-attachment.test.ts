import { describe, expect, it } from 'vitest';
import { readAttachmentBytes } from './chat-sdk-bridge.js';

describe('Discord attachment byte budget', () => {
  it('preserves downloaded bytes within the budget', async () => {
    const bytes = Buffer.from('attachment fixture');
    expect(await readAttachmentBytes(new Response(bytes), bytes.length)).toEqual(bytes);
  });

  it('cancels an oversized stream even without Content-Length', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readAttachmentBytes(new Response(body), 6)).rejects.toThrow('message limit');
    expect(cancelled).toBe(true);
  });
});
