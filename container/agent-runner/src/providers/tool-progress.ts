import type { ProviderEvent } from './types.js';

/** Short, credential-redacted command/query previews; never include tool output. */
export function toolPreview(text: string, limit = 220): string {
  return text
    .replaceAll('OpenAI File Downloader, XaiImageApiFetch/1.0', '[user agent]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, '[REDACTED PRIVATE KEY]')
    .replace(
      /\b(?:sk-[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sm_[\w-]{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g,
      '[REDACTED]',
    )
    .replace(
      /(\b(?:[\w-]*(?:token|password|secret|api[_-]?key)[\w-]*)['"]?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(\b(?:Bearer|Basic)\s+)[\w+/=.-]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@')
    .replace(/[\r\n]+/g, ' ')
    .replace(/@/g, '@\u200b')
    .slice(0, limit);
}

/** Display-only unwrapping. Never evaluates or changes a command sent to the shell. */
export function commandPreview(command: string): string {
  const shell = /^(?:\/[^\s]+\/)?(?:bash|sh|zsh)\s+-(?:l?c|cl)\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  return toolPreview(shell ? shell[2] : command);
}

/** Only completed tool output, never reasoning or arbitrary app-server payloads. */
export function codexToolObservation(value: unknown): Extract<ProviderEvent, { type: 'observation' }> | undefined {
  const item = value as Record<string, unknown> | null;
  const progress = codexToolProgress(value);
  if (!item || !progress) return;
  const output = item.aggregatedOutput ?? item.result ?? item.error ?? item.changes ?? item.action ?? '';
  const content =
    typeof output === 'object' && output !== null && 'content' in output
      ? (output as { content: unknown }).content
      : undefined;
  const selected = Array.isArray(content)
    ? content
        .filter((part) => part?.type === 'text')
        .slice(0, 4)
        .map((part) => String(part.text).slice(0, 1500))
        .join('\n')
    : output;
  const text = typeof selected === 'string' ? selected : JSON.stringify(selected);
  return {
    type: 'observation',
    name: progress.name,
    result: toolPreview(
      JSON.stringify({
        request: typeof item.command === 'string' ? toolPreview(item.command, 6000) : progress.preview,
        status: item.status,
        exitCode: item.exitCode,
        output: text.slice(0, 6000),
      }),
      8000,
    ),
  };
}

/** Codex app-server items supply activity; search details may arrive at completion. */
export function codexToolProgress(value: unknown): Extract<ProviderEvent, { type: 'tool' }> | undefined {
  const item = value as Record<string, unknown> | null;
  if (!item) return;
  let name: string;
  let preview = '';
  switch (item.type) {
    case 'commandExecution': {
      name = 'terminal';
      preview = typeof item.command === 'string' ? commandPreview(item.command) : '';
      // Use Codex's parsed read actions, never a filename merely mentioned in
      // an echo, search, write command, or the model's prose.
      const actions = item.commandActions as Array<{ type: string; path?: string }> | undefined;
      const skills =
        actions?.flatMap((action) => {
          if (action.type !== 'read' || typeof action.path !== 'string') return [];
          const match = /(?:^|\/)([^/]+)\/SKILL\.md$/.exec(action.path);
          return match ? [match[1]] : [];
        }) ?? [];
      if (skills.length) name = `loading skill: ${[...new Set(skills)].join(', ')}`;
      break;
    }
    case 'collabAgentToolCall': {
      const operation = typeof item.tool === 'string' ? item.tool : 'activity';
      name = `subagent: ${operation}`;
      // Prompts, child results and reasoning are private; show lifecycle only.
      const count = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0;
      preview = `${count ? `${count} agent${count === 1 ? '' : 's'} · ` : ''}${String(item.status ?? '')}`;
      break;
    }
    case 'mcpToolCall': {
      name = `${item.server}.${item.tool}`;
      const args = item.arguments as Record<string, unknown> | undefined;
      const selected = args?.query ?? args?.q ?? args?.url ?? args?.path ?? '';
      preview = typeof selected === 'string' ? selected : '';
      break;
    }
    case 'webSearch': {
      name = 'web search';
      const action = item.action as
        | {
            type: string;
            query?: string;
            queries?: string[];
            url?: string;
            pattern?: string;
          }
        | null
        | undefined;
      switch (action?.type) {
        case 'search':
          preview = action.queries?.length ? action.queries.join(' | ') : (action.query ?? '');
          break;
        case 'openPage':
          name = 'opening page';
          preview = action.url ?? '';
          break;
        case 'findInPage':
          name = 'searching page';
          preview = [action.pattern, action.url].filter(Boolean).join(' | ');
          break;
      }
      if (!preview) preview = typeof item.query === 'string' ? item.query : '';
      break;
    }
    case 'fileChange':
      name = 'editing files';
      preview = Array.isArray(item.changes) ? item.changes.map((change) => change.path).join(', ') : '';
      break;
    default:
      return;
  }
  return { type: 'tool', name: name.slice(0, 100), preview: toolPreview(preview) };
}
