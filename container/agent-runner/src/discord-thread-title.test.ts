import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateThreadTitle, nameNewDiscordThread } from './discord-thread-title.js';

const roots: string[] = [];
const originalHome = process.env.HOME;
afterEach(() => { process.env.HOME = originalHome; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function executable(result: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-process-test-')); roots.push(root);
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex/auth.json'), '{"auth_mode":"test-synthetic"}');
  process.env.HOME = root;
  const binary = path.join(root, 'title-process');
  fs.writeFileSync(binary, `#!/bin/sh
model=; sandbox=; effort=; output=
while [ "$#" -gt 0 ]; do
 case "$1" in
 --model) shift; model="$1";;
 -s) shift; sandbox="$1";;
 --config) shift; effort="$1";;
 --output-last-message) shift; output="$1";;
 esac
 shift
done
[ "$model" = gpt-6-luna ] && [ "$sandbox" = read-only ] && [ "$effort" = 'model_reasoning_effort="low"' ] || exit 12
[ "$CODEX_HOME" != "$HOME/.codex" ] || exit 13
[ -f "$CODEX_HOME/auth.json" ] || exit 14
cat >/dev/null
printf '%s' '${result}' > "$output"
`, { mode: 0o700 });
  return binary;
}
describe('ephemeral low-reasoning title request', () => {
  it('uses the requested model, read-only execution and isolated provider home', async () => {
    expect(await generateThreadTitle('Track recent tweets', undefined, executable('{"title":"Track recent tweets"}'))).toBe('Track recent tweets');
  });
  it('rejects invalid structured output rather than sending an unusable title', async () => {
    await expect(generateThreadTitle('Track tweets', undefined, executable('{"title":""}'))).rejects.toThrow('Discord limits');
  });
  it('does not generate titles for ordinary follow-ups without an initial-thread request', async () => {
    await expect(nameNewDiscordThread([])).resolves.toBeUndefined();
  });
});
