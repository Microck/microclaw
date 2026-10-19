import { describe, expect, it } from 'bun:test';
import { codexToolProgress, codexToolObservation, toolPreview, commandPreview } from './tool-progress.js';

describe('Codex tool activity', () => {
  it('uses actual command and MCP item data without exposing outputs or arbitrary arguments', () => {
    expect(
      codexToolProgress({ type: 'commandExecution', command: 'cat notes.md', aggregatedOutput: 'private output' }),
    ).toEqual({ type: 'tool', name: 'terminal', preview: 'cat notes.md' });
    expect(
      codexToolProgress({
        type: 'mcpToolCall',
        server: 'kagi',
        tool: 'search',
        arguments: { query: 'NanoClaw', api_key: 'secret' },
      }),
    ).toEqual({ type: 'tool', name: 'kagi.search', preview: 'NanoClaw' });
    expect(codexToolProgress({ type: 'reasoning', text: 'private thoughts' })).toBeUndefined();
  });
  it('redacts credentials before truncating previews and neutralizes mentions', () => {
    const preview = toolPreview(
      'TOKEN="very private token" curl -H "Authorization: Bearer supersecret" https://user:password@example.com @everyone',
    );
    expect(preview).not.toContain('very private');
    expect(preview).not.toContain('supersecret');
    expect(preview).not.toContain('user:password');
    expect(preview).not.toContain('@everyone');
    expect(toolPreview(`python -c 'x={"token":"private-value"}'`)).not.toContain('private-value');
    expect(toolPreview('curl -A "OpenAI File Downloader, XaiImageApiFetch/1.0" example.com')).toContain('[user agent]');
    expect(toolPreview('x'.repeat(1000))).toHaveLength(220);
  });
  it('shows search actions from the Codex app-server protocol without search results', () => {
    // Shapes from `codex app-server generate-json-schema`: WebSearchAction.
    expect(
      codexToolProgress({
        type: 'webSearch',
        query: '',
        action: {
          type: 'search',
          query: 'first',
          queries: ['first', 'second'],
        },
        results: [{ text: 'private result' }],
      }),
    ).toEqual({ type: 'tool', name: 'web search', preview: 'first | second' });
    expect(
      codexToolProgress({
        type: 'webSearch',
        query: '',
        action: {
          type: 'search',
          query: 'single query',
          queries: null,
        },
      })?.preview,
    ).toBe('single query');
    expect(codexToolProgress({ type: 'webSearch', query: 'standalone query', action: null })?.preview).toBe(
      'standalone query',
    );
    expect(
      codexToolProgress({
        type: 'webSearch',
        query: '',
        action: {
          type: 'openPage',
          url: 'https://example.com',
        },
      }),
    ).toEqual({ type: 'tool', name: 'opening page', preview: 'https://example.com' });
    expect(
      codexToolProgress({
        type: 'webSearch',
        query: '',
        action: {
          type: 'findInPage',
          url: 'https://example.com',
          pattern: 'status',
        },
      }),
    ).toEqual({ type: 'tool', name: 'searching page', preview: 'status | https://example.com' });
  });
  it('labels actual skill read actions, without mistaking mentions or writes for loads', () => {
    const command = 'cat /workspace/agent/skills/raft-cli/SKILL.md';
    expect(
      codexToolProgress({
        type: 'commandExecution',
        command,
        commandActions: [
          { type: 'read', command, name: 'SKILL.md', path: '/workspace/agent/skills/raft-cli/SKILL.md' },
        ],
      }),
    ).toEqual({ type: 'tool', name: 'loading skill: raft-cli', preview: command });
    expect(
      codexToolProgress({
        type: 'commandExecution',
        command: 'echo raft-cli/SKILL.md',
        commandActions: [{ type: 'unknown', command: 'echo raft-cli/SKILL.md' }],
      })?.name,
    ).toBe('terminal');
    expect(
      codexToolProgress({
        type: 'commandExecution',
        command: 'rg SKILL.md skills/',
        commandActions: [{ type: 'search', path: 'skills/', query: 'SKILL.md' }],
      })?.name,
    ).toBe('terminal');
  });
});

it('records bounded completed tool results and drops images, reasoning and credentials', () => {
  const command = codexToolObservation({
    type: 'commandExecution',
    command: 'pnpm build',
    status: 'completed',
    exitCode: 1,
    aggregatedOutput: 'build failed. API_KEY=private-value',
  });
  expect(command?.result).toContain('build failed');
  expect(command?.result).not.toContain('private-value');
  expect(command?.result).toContain('exitCode');
  expect(codexToolObservation({ type: 'reasoning', text: 'private thoughts' })).toBeUndefined();
  const mcp = codexToolObservation({
    type: 'mcpToolCall',
    server: 'web',
    tool: 'fetch',
    result: {
      content: [
        { type: 'image', data: 'PRIVATE_IMAGE' },
        { type: 'text', text: 'Relevant result' },
      ],
    },
  });
  expect(mcp?.result).toContain('Relevant result');
  expect(mcp?.result).not.toContain('PRIVATE_IMAGE');
  expect(
    codexToolObservation({ type: 'commandExecution', command: 'x', aggregatedOutput: 'x'.repeat(100000) })!.result
      .length,
  ).toBeLessThanOrEqual(8000);
});

it('unwraps quoted shell previews before truncation without evaluating them', () => {
  expect(commandPreview("/bin/bash -lc 'git status --short'")).toBe('git status --short');
  expect(commandPreview('/bin/sh -lc "echo $(touch /tmp/never-executed)"')).toBe('echo $(touch /tmp/never-executed)');
  expect(commandPreview("/bin/bash -lc '" + 'x'.repeat(300) + "'")).toBe('x'.repeat(220));
  expect(commandPreview('bash --unknown something')).toBe('bash --unknown something');
});

it('shows subagent lifecycle without child prompts or results', () => {
  expect(
    codexToolProgress({
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'completed',
      receiverThreadIds: ['child'],
      prompt: 'private prompt',
      agentsStates: { child: { status: 'completed', message: 'private result' } },
    }),
  ).toEqual({ type: 'tool', name: 'subagent: spawnAgent', preview: '1 agent · completed' });
});
