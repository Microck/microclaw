import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AnchoredDir } from '../anchored-dir.js';
import { GROUPS_DIR } from '../config.js';

export type KnowledgeKind = 'skills' | 'memory';
const PAGE_SIZE = 1400;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function segments(target: string): string[] {
  const names = target.split('/');
  if (target.length > 180 || names.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)))
    throw new Error('Use a file or skill name from the list.');
  return names;
}
function open(folder: string, kind: KnowledgeKind, names: string[] = []): AnchoredDir {
  const dir = AnchoredDir.open(GROUPS_DIR, [folder, kind, ...names]);
  if (!dir) throw new Error(`No saved ${kind} here.`);
  return dir;
}
function read(dir: AnchoredDir, name: string): Buffer {
  const fd = dir.openReadFd(name);
  try {
    if (fs.fstatSync(fd).size > MAX_FILE_BYTES) throw new Error('File is too large for Discord inspection.');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function memoryTarget(target: string): string[] {
  const names = segments(target);
  if (!target.endsWith('.md') || names[0] === 'system' || names.at(-1) === 'index.md')
    throw new Error('Memory indexes and system rules are protected. Choose a saved memory document.');
  return names;
}
function listMemory(dir: AnchoredDir, prefix = '', depth = 0, budget = { entries: 0 }): string[] {
  if (depth > 8) throw new Error('Memory directory nesting is too deep.');
  const files: string[] = [];
  for (const name of dir.entries().sort()) {
    if (++budget.entries > 2000) throw new Error('Too many memory entries for Discord inspection.');
    if (name === 'system' || name === 'index.md') continue;
    const stat = dir.lstat(name);
    if (stat.isDirectory()) {
      const child = dir.openDir(name)!;
      try {
        files.push(...listMemory(child, prefix + name + '/', depth + 1, budget));
      } finally {
        child.close();
      }
    } else if (stat.isFile() && name.endsWith('.md')) files.push(prefix + name);
  }
  return files;
}

export function knowledgeList(folder: string, kind: KnowledgeKind): string[] {
  const dir = AnchoredDir.open(GROUPS_DIR, [folder, kind]);
  if (!dir) return [];
  try {
    if (kind === 'memory') return listMemory(dir);
    return dir
      .entries()
      .sort()
      .filter((name) => {
        if (!dir.lstat(name).isDirectory()) return false;
        const child = dir.openDir(name)!;
        try {
          return child.entries().includes('SKILL.md') && child.lstat('SKILL.md').isFile();
        } finally {
          child.close();
        }
      });
  } finally {
    dir.close();
  }
}

export function knowledgeRead(folder: string, kind: KnowledgeKind, target: string): string {
  const names = kind === 'memory' ? memoryTarget(target) : segments(target);
  if (kind === 'skills' && names.length !== 1) throw new Error('Choose one skill name from the list.');
  const dir = open(folder, kind, kind === 'skills' ? names : names.slice(0, -1));
  try {
    return read(dir, kind === 'skills' ? 'SKILL.md' : names.at(-1)!).toString('utf8');
  } finally {
    dir.close();
  }
}

/** Hash every supporting file as well as SKILL.md. Descriptor-pinned traversal
 * cannot follow links planted by an agent into host or borrowed folders. */
function hashSkill(
  dir: AnchoredDir,
  hash: ReturnType<typeof createHash>,
  budget: { bytes: number; entries: number },
  prefix = '',
  depth = 0,
): void {
  if (depth > 8) throw new Error('Skill directory nesting is too deep.');
  for (const name of dir.entries().sort()) {
    if (++budget.entries > 2000) throw new Error('Too many skill entries for Discord removal.');
    const stat = dir.lstat(name);
    const relative = prefix + name;
    hash.update(JSON.stringify(relative));
    if (stat.isDirectory()) {
      hash.update('directory');
      const child = dir.openDir(name)!;
      try {
        hashSkill(child, hash, budget, relative + '/', depth + 1);
      } finally {
        child.close();
      }
    } else {
      const content = read(dir, name);
      budget.bytes += content.length;
      if (budget.bytes > 16 * 1024 * 1024) throw new Error('Skill is too large for Discord removal.');
      hash.update('file').update(String(content.length)).update(':').update(content);
    }
  }
}
export function knowledgeFingerprint(folder: string, kind: KnowledgeKind, target: string): string {
  if (kind === 'memory')
    return createHash('sha256')
      .update(knowledgeRead(folder, kind, target))
      .digest('hex');
  const names = segments(target);
  if (names.length !== 1) throw new Error('Choose one skill name from the list.');
  const dir = open(folder, kind, names);
  try {
    const hash = createHash('sha256');
    hashSkill(dir, hash, { bytes: 0, entries: 0 });
    return hash.digest('hex');
  } finally {
    dir.close();
  }
}
function removeSkill(dir: AnchoredDir): void {
  for (const name of dir.entries()) {
    if (dir.lstat(name).isDirectory()) {
      const child = dir.openDir(name)!;
      try {
        removeSkill(child);
      } finally {
        child.close();
      }
      dir.rmdir(name);
    } else dir.unlink(name);
  }
}

export function knowledgeRemove(folder: string, kind: KnowledgeKind, target: string, fingerprint: string): void {
  if (knowledgeFingerprint(folder, kind, target) !== fingerprint)
    throw new Error('Content changed. Review it and request removal again.');
  const names = kind === 'memory' ? memoryTarget(target) : segments(target);
  const parent = open(folder, kind, names.slice(0, -1));
  try {
    const leaf = names.at(-1)!;
    if (kind === 'skills') {
      const child = parent.openDir(leaf)!;
      try {
        removeSkill(child);
      } finally {
        child.close();
      }
      parent.rmdir(leaf);
    } else {
      parent.unlink(leaf);
      // Keep the nearest memory index free of a dangling link without deleting
      // other facts that might share that line. Historical copies remain intact.
      if (parent.entries().includes('index.md')) {
        const index = read(parent, 'index.md').toString('utf8');
        const escaped = leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const updated = index.replace(new RegExp(`\\[([^\\]]+)\\]\\((?:\\./)?${escaped}\\)`, 'g'), '$1 (forgotten)');
        if (updated !== index) parent.replaceFile('index.md', updated);
      }
    }
  } finally {
    parent.close();
  }
}

export function knowledgePage(title: string, body: string, page = 1): string {
  const safe = body.replace(/```/g, "'''");
  const pages = Math.max(1, Math.ceil(safe.length / PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) throw new Error(`Choose a page from 1 to ${pages}.`);
  return `${title} · page ${page}/${pages}\n\`\`\`\n${safe.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) || '(empty)'}\n\`\`\``;
}
