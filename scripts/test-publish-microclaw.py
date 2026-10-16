"""Integration checks using real Git/Jujutsu repositories, without network access."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-microclaw.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / 'source'
        self.public = self.root / 'public'
        self.source.mkdir()
        publisher.run(self.source, 'git', 'init', '-b', 'main')
        publisher.run(self.source, 'git', 'config', 'user.name', 'Microck')
        publisher.run(self.source, 'git', 'config', 'user.email', 'contact@micr.dev')
        (self.source / 'code.txt').write_text('original\n')
        (self.source / 'upstream.txt').write_text('original\n')
        self.before = self.commit('baseline')
        publisher.run(self.root, 'git', 'clone', str(self.source), str(self.public))
        publisher.jj(self.public, 'git', 'init', '--colocate')
        publisher.jj(self.public, 'new', 'main@origin')

    def commit(self, message):
        publisher.run(self.source, 'git', 'add', '.')
        publisher.run(self.source, 'git', 'commit', '-m', message)
        return publisher.run(self.source, 'git', 'rev-parse', 'HEAD').decode().strip()

    def import_source(self):
        publisher.run(self.public, 'git', 'fetch', str(self.source), 'main')

    def test_delta_preserves_upstream_and_excludes_operator_notes(self):
        (self.public / 'upstream.txt').write_text('upstream update\n')
        publisher.jj(self.public, 'describe', '-m', 'upstream update')
        publisher.jj(self.public, 'new')
        (self.source / 'code.txt').write_text('local update\n')
        (self.source / 'docs').mkdir()
        (self.source / publisher.EXCLUDED).write_text('PRIVATE OPERATOR NOTES\n')
        current = self.commit('private local change')
        self.import_source()
        publisher.apply_source_delta(self.source, self.public, self.before, current)
        publisher.assert_no_conflicts(self.public)
        self.assertEqual((self.public / 'code.txt').read_text(), 'local update\n')
        self.assertEqual((self.public / 'upstream.txt').read_text(), 'upstream update\n')
        self.assertFalse((self.public / publisher.EXCLUDED).exists())
        # The private source commit is not an ancestor of the exported revision.
        candidate = publisher.jj(self.public, 'log', '-r', '@', '--no-graph', '-T', 'commit_id')
        verdict = subprocess.run(('git', 'merge-base', '--is-ancestor', current, candidate), cwd=self.public)
        self.assertEqual(verdict.returncode, 1)

    def test_conflicting_delta_stops_instead_of_overwriting_upstream(self):
        (self.public / 'code.txt').write_text('upstream change\n')
        publisher.jj(self.public, 'describe', '-m', 'upstream change')
        publisher.jj(self.public, 'new')
        (self.source / 'code.txt').write_text('local change\n')
        current = self.commit('conflicting change')
        self.import_source()
        with self.assertRaises(subprocess.CalledProcessError):
            publisher.apply_source_delta(self.source, self.public, self.before, current)

    def test_marker_survives_later_upstream_commits(self):
        publisher.jj(self.public, 'describe', '-m', f'Export\n\nMicroclaw-Source: {self.before}')
        publisher.jj(self.public, 'new')
        publisher.jj(self.public, 'describe', '-m', 'later upstream update')
        head = publisher.jj(self.public, 'log', '-r', '@', '--no-graph', '-T', 'commit_id')
        publisher.run(self.public, 'git', 'update-ref', 'refs/remotes/origin/main', head)
        self.assertEqual(publisher.source_marker(self.public), self.before)

    def test_stable_release_ignores_prereleases_and_peels_annotated_tags(self):
        publisher.run(self.source, 'git', 'tag', 'v2026.9.9')
        publisher.run(self.source, 'git', 'tag', '-a', 'v2026.10.0', '-m', 'stable')
        publisher.run(self.source, 'git', 'tag', 'v2026.11.0-rc.1')
        publisher.run(self.public, 'git', 'remote', 'add', 'upstream', str(self.source))
        self.assertEqual(publisher.stable_release(self.public), self.before)

    def test_missing_marker_requires_explicit_baseline(self):
        with self.assertRaisesRegex(ValueError, 'audited source baseline'):
            publisher.source_marker(self.public)


if __name__ == '__main__':
    unittest.main()
