import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

it('waits for an existing writer before initializing a new MCP mailbox connection', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mailbox-lock-'));
  const blocker = new Database(path.join(directory, 'outbound.db'));
  blocker.exec(`CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO session_state VALUES ('marker','isolated','2026-01-01T00:00:00.000Z'); BEGIN EXCLUSIVE`);
  const script = `
    const {getOutboundDb,closeSessionDb}=await import(${JSON.stringify(new URL('./connection.ts', import.meta.url).href)});
    console.log('ready');
    await Bun.stdin.text();
    try { console.log(getOutboundDb().prepare("SELECT value FROM session_state WHERE key='marker'").get().value); }
    finally { closeSessionDb(); }
  `;
  const child = Bun.spawn([process.execPath, '--eval', script], {
    env: { ...process.env, NANOCLAW_SESSION_DIR: directory },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = child.stdout.getReader();
    expect(new TextDecoder().decode((await output.read()).value).trim()).toBe('ready');
    child.stdin.end('read\n');
    release = setTimeout(() => blocker.exec('COMMIT'), 300);
    let stdout = '';
    for (;;) {
      const chunk = await output.read();
      if (chunk.done) break;
      stdout += new TextDecoder().decode(chunk.value);
    }
    output.releaseLock();
    const stderr = await new Response(child.stderr).text();
    expect({ code: await child.exited, stderr }).toEqual({ code: 0, stderr: '' });
    expect(stdout.trim()).toBe('isolated');
  } finally {
    if (release) clearTimeout(release);
    child.kill();
    await child.exited;
    if (blocker.inTransaction) blocker.exec('ROLLBACK');
    blocker.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
