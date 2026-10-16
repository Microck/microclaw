import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CUSTOMIZATIONS = '.claude/customizations';

export interface SkillCustomization {
  file: string;
  original: Buffer;
  base: Buffer;
}

/** Capture local payload edits before an installed-skill refresh replaces files. */
export function captureSkillCustomizations(root: string): SkillCustomization[] {
  const manifest = path.join(root, CUSTOMIZATIONS, 'files.json');
  if (!fs.existsSync(manifest)) return [];
  const files: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!Array.isArray(files) || !files.every((file) => typeof file === 'string')) {
    throw new Error('Customization manifest must be an array of repository file paths');
  }
  return files.map((file: string) => {
    if (path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === '..' || part === '')) {
      throw new Error(`Invalid customization path: ${file}`);
    }
    const source = path.join(root, file);
    const base = path.join(root, CUSTOMIZATIONS, 'base', file);
    if (fs.lstatSync(source).isSymbolicLink() || fs.lstatSync(base).isSymbolicLink()) {
      throw new Error(`Customization sources must be regular files: ${file}`);
    }
    return { file, original: fs.readFileSync(source), base: fs.readFileSync(base) };
  });
}

/** Three-way merge custom edits with refreshed payloads; never overwrite a conflict. */
export function restoreSkillCustomizations(root: string, snapshots: SkillCustomization[], refreshed: boolean): void {
  const restoreOriginals = (): void => {
    for (const snapshot of snapshots) fs.writeFileSync(path.join(root, snapshot.file), snapshot.original);
  };
  if (!refreshed) {
    restoreOriginals();
    return;
  }
  if (snapshots.length === 0) return;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-customizations-'));
  try {
    const merged: { snapshot: SkillCustomization; upstream: Buffer; content: Buffer }[] = [];
    for (const snapshot of snapshots) {
      const upstream = fs.readFileSync(path.join(root, snapshot.file));
      // An unrelated selected skill did not replace this file. Its upstream
      // baseline must stay unchanged, or a later refresh would lose the delta.
      if (upstream.equals(snapshot.original)) continue;
      const ours = path.join(scratch, 'ours');
      const base = path.join(scratch, 'base');
      const theirs = path.join(scratch, 'theirs');
      fs.writeFileSync(ours, snapshot.original);
      fs.writeFileSync(base, snapshot.base);
      fs.writeFileSync(theirs, upstream);
      const result = spawnSync('git', ['merge-file', '-p', ours, base, theirs], { maxBuffer: 16 * 1024 * 1024 });
      if (result.error || result.status !== 0) {
        throw new Error(`Customizations conflict with refreshed payload: ${snapshot.file}. Local edits restored; resolve in staging before updating.`);
      }
      merged.push({ snapshot, upstream, content: result.stdout });
    }
    // Compute every merge before writing any baseline. A conflict in the last
    // file cannot leave earlier files marked as successfully refreshed.
    for (const { snapshot, upstream, content } of merged) {
      fs.writeFileSync(path.join(root, snapshot.file), content);
      fs.writeFileSync(path.join(root, CUSTOMIZATIONS, 'base', snapshot.file), upstream);
    }
  } catch (error) {
    restoreOriginals();
    throw error;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}


/** Rebuild persistent group derivatives whenever the updater replaces the base image. */
export function rebuildGroupImages(root: string, run: (command: string, args: string[], cwd: string) => unknown): void {
  const groups = path.join(root, 'groups');
  if (!fs.existsSync(groups)) return;
  for (const entry of fs.readdirSync(groups, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dockerfile = path.join('groups', entry.name, 'Dockerfile');
    const configuration = path.join(groups, entry.name, 'container.json');
    if (!fs.existsSync(path.join(root, dockerfile)) || !fs.existsSync(configuration)) continue;
    const { imageTag } = JSON.parse(fs.readFileSync(configuration, 'utf8'));
    if (typeof imageTag !== 'string' || !imageTag) throw new Error(`Missing derived image tag for group ${entry.name}`);
    run('docker', ['build', '-f', dockerfile, '-t', imageTag, '.'], root);
  }
}
