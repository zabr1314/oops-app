"""Offline release packaging checks; no SSH, systemd, credentials or service changes."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent.parent
DEPENDENCIES = {'scripts/action_sources.py', 'scripts/task_board.py'}


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), ROOT / 'deploy' / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class SourceReleaseDependenciesTest(unittest.TestCase):
    def test_all_upgraders_shipping_backend_include_new_import_dependencies(self):
        for name in ('review-queue-upgrade', 'live-speed-upgrade', 'speaker-attribution-upgrade', 'p0-upgrade', 'voiceprint-sources-upgrade'):
            with self.subTest(name=name): self.assertTrue(DEPENDENCIES <= set(load(name).FILES))

    def build(self, module, folder, missing=DEPENDENCIES):
        def git(args):
            name = args[-1] if 'ls-tree' in args else args[-1].split(':', 1)[1]
            if 'ls-tree' in args: return b'' if name in missing else name.encode()
            if name in missing: raise subprocess.CalledProcessError(128, args)
            return ('verified old baseline: ' + name).encode()
        with patch.object(module.subprocess, 'check_output', side_effect=git), contextlib.redirect_stdout(io.StringIO()):
            module.build(folder, 'verified-old-baseline')
        return json.loads((Path(folder) / 'manifest.json').read_text())

    def test_new_dependencies_have_explicit_absent_baseline_and_verified_payloads(self):
        for name in ('review-queue-upgrade', 'live-speed-upgrade'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                module = load(name); manifest = self.build(module, folder)
                self.assertEqual(set(module.FILES), set(manifest['baseline']))
                for source in module.FILES:
                    self.assertEqual(hashlib.sha256((Path(folder) / source).read_bytes()).hexdigest(), manifest['files'][source])
                    self.assertEqual(None if source in DEPENDENCIES else hashlib.sha256(('verified old baseline: ' + source).encode()).hexdigest(), manifest['baseline'][source])

    def test_existing_dependencies_still_require_their_exact_baseline_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = self.build(load('review-queue-upgrade'), folder, missing=set())
            for source in DEPENDENCIES: self.assertEqual(hashlib.sha256(('verified old baseline: ' + source).encode()).hexdigest(), manifest['baseline'][source])

    def test_absent_legacy_module_is_not_silently_treated_as_new_dependency(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(subprocess.CalledProcessError):
                self.build(load('review-queue-upgrade'), folder, missing={'scripts/meeting_features.py'})

    def test_unexpected_existing_new_dependency_blocks_preflight_before_service_calls(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); release, app = root / 'release', root / 'app'
            module = load('review-queue-upgrade'); manifest = self.build(module, release)
            for source in module.FILES:
                target = app / source; target.parent.mkdir(parents=True, exist_ok=True)
                if source not in DEPENDENCIES: target.write_text('verified old baseline: ' + source)
            (app / 'scripts/action_sources.py').write_text('unexpected existing source')
            with patch.object(module, 'APP', app), patch.object(module.os, 'geteuid', return_value=0), \
                    patch.object(module.sys, 'argv', ['upgrade', str(release)]), \
                    patch.object(module.subprocess, 'check_output', side_effect=AssertionError('no service calls allowed')):
                with self.assertRaisesRegex(AssertionError, 'Expected absent dependency'):
                    module.main()


if __name__ == '__main__': unittest.main()
