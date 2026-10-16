#!/usr/bin/env python3
"""Publish committed code from a private install without publishing its history."""

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


EXCLUDED = 'docs/hermes-migration.md'
PUBLIC_LINKS = {'AGENTS.md': 'CLAUDE.md', '.agents/skills': '../.claude/skills'}
IDENTITY = {'JJ_USER': 'Microck', 'JJ_EMAIL': 'contact@micr.dev'}


def run(cwd, *args, input=None):
    return subprocess.run(
        args, cwd=cwd, input=input, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=True,
        env={**os.environ, **IDENTITY},
    ).stdout


def jj(cwd, *args):
    return run(cwd, 'jj', *args).decode().strip()


def source_marker(checkout):
    message = run(checkout, 'git', 'log', 'refs/remotes/origin/main',
                  '--first-parent', '-1', '--format=%B',
                  '--grep=^Microclaw-Source: ').decode()
    marker = re.search(r'^Microclaw-Source: ([0-9a-f]{40})$', message, re.M)
    if not marker:
        raise ValueError('Public main has no audited source baseline; initialize explicitly.')
    return marker[1]


def apply_source_delta(source, checkout, previous, current):
    # Only the delta is exported. Replacing the tree would erase upstream updates.
    patch = run(source, 'git', 'diff', '--binary', previous, current, '--',
                '.', f':(exclude){EXCLUDED}')
    if patch:
        run(checkout, 'git', 'apply', '--3way', input=patch)
    jj(checkout, 'status')


def stable_release(checkout):
    tags = run(checkout, 'git', 'ls-remote', '--tags', 'upstream').decode()
    releases = []
    for line in tags.splitlines():
        sha, ref = line.split()
        match = re.fullmatch(r'refs/tags/v(\d+)\.(\d+)\.(\d+)(\^\{\})?', ref)
        if match:
            releases.append((tuple(map(int, match.group(1, 2, 3))),
                             bool(match[4]), sha))
    if not releases:
        raise ValueError('Upstream has no stable version tags.')
    return max(releases)[2]


def assert_no_conflicts(checkout):
    conflicts = jj(checkout, 'log', '-r', 'ancestors(@) & conflicts()',
                   '--no-graph', '-T', 'commit_id ++ "\n"')
    if conflicts:
        raise ValueError('Publication stopped: resolve source/upstream conflicts explicitly.')


def validate(checkout, location):
    # Export only tracked files: ignored runtime state never reaches the scanner
    # or the remote. Scan the actual candidate, not the private source history.
    revision = jj(checkout, 'log', '-r', '@', '--no-graph', '-T', 'commit_id')
    paths = run(checkout, 'git', 'ls-tree', '-r', '--name-only', revision).decode().splitlines()
    for name in paths:
        if name in PUBLIC_LINKS:
            mode = run(checkout, 'git', 'ls-tree', revision, '--', name).decode().split()[0]
            target = run(checkout, 'git', 'show', f'{revision}:{name}').decode()
            if mode != '120000' or target != PUBLIC_LINKS[name]:
                raise ValueError(f'Public instruction link changed: {name}')
            continue
        parts = Path(name).parts
        if parts[0] in {'data', 'store', 'logs', 'groups', '.nanoclaw', '.agents', '.codex', '.hermes'} or (parts[0].startswith('.env') and name != '.env.example') or name.endswith('.keys.json') or name in {'AGENTS.md', EXCLUDED}:
            raise ValueError(f'Private installation path cannot be published: {name}')
    with tempfile.TemporaryDirectory(prefix='microclaw-scan-') as directory:
        archive = run(checkout, 'git', 'archive', revision)
        run(directory, 'tar', '-x', input=archive)
        run(checkout, 'gitleaks', 'dir', directory, '--redact', '--no-banner',
            '--config', str(checkout / '.gitleaks.toml'))
    # The daily-driver host is memory constrained. Validate in a disposable
    # Raft workspace, uploading audited code only, never host credentials.
    log = checkout.parent / 'validation.log'
    verification = """set -eu
mkdir /workspace/microclaw
tar -xf /tmp/microclaw.tar -C /workspace/microclaw
useradd --groups docker --create-home --shell /bin/bash verifier
chown -R verifier:verifier /workspace/microclaw
uid=$(id -u verifier)
loginctl enable-linger verifier
systemctl start "user@$uid.service"
runuser -u verifier -- env "PATH=$PATH" "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" bash -c '
set -eu
cd /workspace/microclaw
git init -b main
git config user.name Microck
git config user.email contact@micr.dev
git add .
git commit -qm "Audited validation snapshot"
pnpm install --frozen-lockfile
(cd container/agent-runner && bun install --frozen-lockfile)
pnpm run typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
pnpm run format:check
pnpm run lint
pnpm exec vitest run --maxWorkers 1 --no-file-parallelism
(cd container/agent-runner && bun run test)
'
"""
    run(checkout, sys.executable, 'scripts/test-publish-microclaw.py')
    with log.open('w') as output, tempfile.TemporaryDirectory(prefix='microclaw-check-') as directory:
        subprocess.run(('raft', 'doctor'), stdout=output, stderr=subprocess.STDOUT, check=False)
        run(checkout, 'raft', 'limits', '--location', location, '--json')
        run(checkout, 'raft', 'list', '--location', location)
        box = run(checkout, 'raft', 'new', '--location', location, '--ttl', '3600',
                  '--memory', '4GiB', '--cpu', '1', '--disposable').decode().strip()
        try:
            bundle = Path(directory) / 'microclaw.tar'
            bundle.write_bytes(archive)
            run(checkout, 'raft', 'upload', box, str(bundle), '/tmp/microclaw.tar')
            print('Checking audited candidate in disposable Raft workspace.', flush=True)
            subprocess.run(('raft', 'exec', box, '--', 'timeout', '2400',
                            'bash', '-lc', verification), stdout=output,
                           stderr=subprocess.STDOUT, check=True, timeout=2700)
        finally:
            run(checkout, 'raft', 'destroy', box)
    if jj(checkout, 'log', '-r', '@', '--no-graph', '-T', 'commit_id') != revision:
        raise ValueError('Validation changed tracked files; refusing to publish an unscanned revision.')
    print('Candidate checks passed.', flush=True)


def publish(config):
    source = Path(config['source']).resolve()
    checkout = Path(config['checkout']).resolve()
    if checkout == source or source in checkout.parents:
        raise ValueError('Publication checkout must be separate from the running installation.')
    # Lock beside the checkout, surviving failures without stale-lock recovery.
    with (checkout.parent / 'publish.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        jj(source, 'status')
        current = jj(source, 'log', '-r', config['source_revision'], '--no-graph', '-T', 'commit_id')
        jj(checkout, 'git', 'fetch', '--remote', 'origin', '--branch', 'main')
        previous = source_marker(checkout)
        upstream = stable_release(checkout)
        run(checkout, 'git', 'fetch', '--no-tags', 'upstream', upstream)
        contained = subprocess.run(
            ('git', 'merge-base', '--is-ancestor', upstream, 'refs/remotes/origin/main'),
            cwd=checkout, check=False,
        ).returncode
        if contained not in (0, 1):
            raise ValueError('Cannot inspect upstream ancestry.')
        if previous == current and contained == 0:
            print('Public main is current; nothing to publish.', flush=True)
            return
        # Raw local objects stay private. Only the sanitized candidate bookmark
        # is ever pushed; source commits are never parents of public commits.
        jj(checkout, 'git', 'fetch', '--remote', 'source')
        jj(checkout, 'new', 'main@origin')
        apply_source_delta(source, checkout, previous, current)
        assert_no_conflicts(checkout)
        if contained == 1:
            jj(checkout, 'describe', '-m', 'Apply committed MicroClaw source changes')
            jj(checkout, 'new', '@', upstream)
        assert_no_conflicts(checkout)
        jj(checkout, 'describe', '-m',
           f'Update MicroClaw code and checked upstream release\n\nMicroclaw-Source: {current}')
        validate(checkout, config['validation_location'])
        jj(checkout, 'bookmark', 'set', 'main', '-r', '@')
        jj(checkout, 'git', 'push', '--remote', 'origin', '--bookmark', 'main')
        print('Published checked MicroClaw update.', flush=True)


if __name__ == '__main__':
    try:
        publish(json.loads(Path(sys.argv[1]).read_text()))
    except (subprocess.CalledProcessError, ValueError, BlockingIOError, subprocess.TimeoutExpired) as error:
        # Command stderr can contain sensitive diagnostics; retain it only in
        # the private local journal and never include raw scanner values.
        print(f'Publication stopped: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode(errors='replace'), file=sys.stderr)
        sys.exit(1)
