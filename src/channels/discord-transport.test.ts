import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each(['cancel', 'timeout'])('closes a pending Discord handshake safely after %s', async (mode) => {
  const adapterRequire = createRequire(import.meta.resolve('@chat-adapter/discord'));
  const discordRequire = createRequire(adapterRequire.resolve('discord.js'));
  const transportPath = discordRequire.resolve('@discordjs/ws');
  // A subprocess proves that no uncaught EventEmitter error can take down the
  // controller. This is the installed transport talking to a real local socket.
  const script = `
    const http = require('node:http');
    const {WebSocketShard} = require(${JSON.stringify(transportPath)});
    (async () => {
      const server = http.createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const shard = new WebSocketShard({
        options: {
          version: '10', encoding: 'json', compression: null,
          gatewayInformation: {url: 'ws://127.0.0.1:' + server.address().port},
          handshakeTimeout: 3000, helloTimeout: 50,
        },
        retrieveSessionInfo: async () => null,
        updateSessionInfo: async () => {},
      }, 0);
      shard.on('error', () => {});
      let connections = 0;
      server.on('upgrade', async (_request, socket) => {
        socket.on('end', () => socket.end());
        connections++;
        if (${JSON.stringify(mode)} === 'timeout' && connections === 1) return;
        await shard.destroy();
        socket.end();
        server.close(() => { console.log('cancelled handshake closed'); process.exit(0); });
      });
      void shard.internalConnect().catch(() => {});
      setTimeout(() => process.exit(2), 5000).unref();
    })().catch(error => { console.error(error); process.exit(1); });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--eval', script], { timeout: 7000 });
  expect(stdout.trim()).toBe('cancelled handshake closed');
});
