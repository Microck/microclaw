#!/usr/bin/env node
// A real executable fixture for process/protocol tests. It has no model or mail access.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  if (input.startsWith('HANG ')) {
    const marker = input.slice(5);
    spawn(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => {}); setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "orphan"), 3500)',
        marker,
      ],
      { stdio: 'ignore' },
    );
    setInterval(() => {}, 1000);
    return;
  }
  if (input === 'TOOL' || input === 'MODEL_ERROR') {
    console.log(
      JSON.stringify({ type: 'item.started', item: { type: input === 'TOOL' ? 'command_execution' : 'error' } }),
    );
    setInterval(() => {}, 1000);
    return;
  }
  if (input === 'OVERFLOW') {
    process.stdout.write('x'.repeat(2 * 1024 * 1024));
    setInterval(() => {}, 1000);
    return;
  }
  const directory = process.env.CODEX_HOME;
  const config = fs.readFileSync(`${directory}/config.toml`, 'utf8');
  if (!config.includes('model_instructions_file = ')) process.exit(2);
  if (
    process.env.HOME !== path.dirname(directory ?? '') ||
    !config.includes('shell_tool = false') ||
    !config.includes('[agents]\nenabled = false') ||
    !config.includes('multi_agent_v2 = false') ||
    process.env.TEST_SECRET
  )
    process.exit(2);
  const output = process.argv[process.argv.indexOf('--output-last-message') + 1];
  const decision = {
    action: 'investigate',
    reason: 'Calendar conflict',
    evidence: ['Two appointments overlap'],
    followUpAfterSeconds: null,
  };
  fs.writeFileSync(output, JSON.stringify(decision));
  console.log(
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(decision) } }),
  );
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 123, output_tokens: 45 } }));
});
