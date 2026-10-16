import { describe, expect, it } from 'bun:test';
import { codexToolProgress, toolPreview } from './tool-progress.js';

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
