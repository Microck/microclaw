import type { ModelSelection } from './providers/types.js';
import type { MessageInRow } from './db/messages-in.js';
import { commandText, slashCommandName } from './slash-command.generated.js';

export interface AvailableModel {
  id: string;
  model: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
}

export function resolveModelSelection(
  request: string,
  models: AvailableModel[],
): Pick<ModelSelection, 'model' | 'effort'> {
  const [name, effort = 'low', ...extra] = request.trim().toLowerCase().split(/\s+/);
  if (!name || extra.length) throw new Error('Use /model <name> [thinking], for example /model sol medium.');
  let selected = models.find((entry) => entry.model.toLowerCase() === name || entry.id.toLowerCase() === name);
  if (!selected && ['sol', 'luna', 'astra'].includes(name)) {
    const family = new RegExp(`^gpt-\\d+(?:\\.\\d+)*-${name}$`);
    selected = models
      .filter((entry) => family.test(entry.model))
      .sort((a, b) => b.model.localeCompare(a.model, 'en', { numeric: true }))[0];
  }
  if (!selected) throw new Error(`Model "${name}" is unavailable. Use /model to see available models.`);
  const supported = selected.supportedReasoningEfforts.map((entry) => entry.reasoningEffort);
  if (!supported.includes(effort))
    throw new Error(`${selected.model} does not support "${effort}" thinking. Choose: ${supported.join(', ')}.`);
  return { model: selected.model, effort };
}

/** Only an opening user instruction can select inference, never embedded content. */
export function openingModelRequest(messages: MessageInRow[]): string | undefined {
  const first = messages.find(
    (message) =>
      (message.kind === 'chat' || message.kind === 'chat-sdk') &&
      message.trigger !== 0 &&
      message.channel_type !== 'session-echo',
  );
  if (!first) return;
  const text = commandText(first.content)
    .replace(/[‘’]/g, "'")
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`]*`|https?:\/\/\S+|^\s*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, ' ');
  if (/^\s*(?:how (?:do|does|to)|what (?:is|are|does)|why (?:do|does|is)|i(?:'m| am) (?:using|working))\b/i.test(text))
    return;
  const model = '(?:sol|luna|astra|gpt-reserve|gpt-\\d+(?:\\.\\d+)*-(?:sol|luna|astra))';
  const pattern = new RegExp(
    `\\b(?:with|using|use|switch\\s+to)\\s+(?:(?:the\\s+)?latest\\s+)?(${model})\\b(?:\\s+(none|minimal|low|medium|high|xhigh|max|ultra)\\b)?`,
    'gi',
  );
  for (const match of text.matchAll(pattern)) {
    const preceding =
      text
        .slice(0, match.index)
        .split(/[.!?;\n]/)
        .at(-1) ?? '';
    if (/\b(?:do not|don't|dont|never|not)\b/i.test(preceding)) continue;
    const clause = preceding + text.slice(match.index).split(/[.!?;\n]/)[0];
    if (/\b(?:compar\w*|difference|versus|vs)\b/i.test(clause)) continue;
    return `${match[1].toLowerCase()} ${match[2]?.toLowerCase() ?? 'low'}`;
  }
}

export function isModelCommand(message: MessageInRow): boolean {
  return (
    (message.kind === 'chat' || message.kind === 'chat-sdk') &&
    message.channel_type !== 'session-echo' &&
    slashCommandName(commandText(message.content)) === '/model'
  );
}

export function describeModelSelection(selection: ModelSelection, changed: boolean): string {
  const current = `${changed ? 'Model set for this conversation' : 'Current model'}: ${selection.model}, ${selection.effort} thinking.`;
  return changed
    ? current
    : `${current}\n\nAvailable models:\n${selection.available.map((entry) => `- ${entry.model}: ${entry.efforts.join(', ')}`).join('\n')}\n\nUse /model sol or /model sol medium. Changes affect only this conversation.`;
}
