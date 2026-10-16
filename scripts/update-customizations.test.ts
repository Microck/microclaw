import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refreshInstalledSkills } from './update-skills.js';
import { captureSkillCustomizations, restoreSkillCustomizations, rebuildGroupImages } from './update-customizations.js';

const roots: string[] = [];
function fixture(files: Record<string, { base: string; local: string }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-preservation-test-'));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const base = path.join(root, '.claude/customizations/base', file);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(base, contents.base);
    fs.writeFileSync(path.join(root, file), contents.local);
  }
  fs.writeFileSync(path.join(root, '.claude/customizations/files.json'), JSON.stringify(Object.keys(files)));
  return root;
}
const read = (root: string, file: string): string => fs.readFileSync(path.join(root, file), 'utf8');
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('custom payload preservation', () => {
  it('keeps both upstream improvements and local behavior across successive updates', () => {
    const root = fixture({ 'src/adapter.ts': { base: 'a\nb\nc\nd\ne\nf\ng\n', local: 'CUSTOM\nb\nc\nd\ne\nf\ng\n' } });
    const first = captureSkillCustomizations(root);
    fs.writeFileSync(path.join(root, 'src/adapter.ts'), 'a\nb\nc\nd\ne\nf\nUPSTREAM\n');
    restoreSkillCustomizations(root, first, true);
    expect(read(root, 'src/adapter.ts')).toBe('CUSTOM\nb\nc\nd\ne\nf\nUPSTREAM\n');
    const second = captureSkillCustomizations(root);
    fs.writeFileSync(path.join(root, 'src/adapter.ts'), 'a\nb\nc\nd\ne\nf\nNEWER\n');
    restoreSkillCustomizations(root, second, true);
    expect(read(root, 'src/adapter.ts')).toBe('CUSTOM\nb\nc\nd\ne\nf\nNEWER\n');
  });
  it('restores every local file and leaves baselines unchanged when any merge conflicts', () => {
    const root = fixture({
      'src/first.ts': { base: 'a\nb\nc\nd\ne\nf\ng\n', local: 'CUSTOM\nb\nc\nd\ne\nf\ng\n' },
      'src/second.ts': { base: 'old\n', local: 'local\n' },
    });
    const snapshots = captureSkillCustomizations(root);
    fs.writeFileSync(path.join(root, 'src/first.ts'), 'a\nb\nc\nd\ne\nf\nnew\n');
    fs.writeFileSync(path.join(root, 'src/second.ts'), 'conflicting\n');
    expect(() => restoreSkillCustomizations(root, snapshots, true)).toThrow('conflict');
    expect(read(root, 'src/first.ts')).toBe('CUSTOM\nb\nc\nd\ne\nf\ng\n');
    expect(read(root, 'src/second.ts')).toBe('local\n');
    expect(read(root, '.claude/customizations/base/src/first.ts')).toBe('a\nb\nc\nd\ne\nf\ng\n');
  });
  it('does not erase a customization baseline when another skill is refreshed', () => {
    const root = fixture({ 'src/adapter.ts': { base: 'old\n', local: 'custom\n' } });
    restoreSkillCustomizations(root, captureSkillCustomizations(root), true);
    expect(read(root, '.claude/customizations/base/src/adapter.ts')).toBe('old\n');
  });
  it('restores local files if the underlying refresh fails', () => {
    const root = fixture({ 'src/adapter.ts': { base: 'old\n', local: 'custom\n' } });
    const snapshots = captureSkillCustomizations(root);
    fs.writeFileSync(path.join(root, 'src/adapter.ts'), 'partially-refreshed\n');
    restoreSkillCustomizations(root, snapshots, false);
    expect(read(root, 'src/adapter.ts')).toBe('custom\n');
  });
  it('rejects paths escaping the checkout before refreshing anything', () => {
    const root = fixture({ 'src/adapter.ts': { base: 'old\n', local: 'custom\n' } });
    fs.writeFileSync(path.join(root, '.claude/customizations/files.json'), JSON.stringify(['../private']));
    expect(() => captureSkillCustomizations(root)).toThrow('Invalid customization path');
  });
});


it('rebuilds the configured group image rather than discarding its SSH layer', () => {
  const root = fixture({ 'src/adapter.ts': { base: 'old', local: 'custom' } });
  fs.mkdirSync(path.join(root, 'groups/glados'), { recursive: true });
  fs.writeFileSync(path.join(root, 'groups/glados/Dockerfile'), 'FROM base\n');
  fs.writeFileSync(path.join(root, 'groups/glados/container.json'), JSON.stringify({ imageTag: 'personal:glados' }));
  const commands: unknown[] = [];
  rebuildGroupImages(root, (...args) => commands.push(args));
  expect(commands).toEqual([['docker', ['build', '-f', 'groups/glados/Dockerfile', '-t', 'personal:glados', '.'], root]]);
});


it('preserves local behavior through the real installed-skill refresh path', async () => {
  const base = 'a\nb\nc\nd\ne\nf\ng\n';
  const root = fixture({ 'src/gateway-providers/demo.ts': { base, local: base.replace('a\n', 'CUSTOM\n') } });
  const skill = path.join(root, '.claude/skills/add-demo/payload');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'demo.ts'), base.replace('g\n', 'UPSTREAM\n'));
  fs.writeFileSync(path.join(skill, '../SKILL.md'), '# Apply\n```nc:copy\npayload/demo.ts -> src/gateway-providers/demo.ts\n```\n');
  const report = await refreshInstalledSkills(root, ['add-demo'], {
    include: [{ name: 'demo', skillName: 'add-demo', kind: 'gateway' }],
  });
  expect(report.success).toBe(true);
  expect(read(root, 'src/gateway-providers/demo.ts')).toBe('CUSTOM\nb\nc\nd\ne\nf\nUPSTREAM\n');
});
