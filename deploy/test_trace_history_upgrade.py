"""Installer transaction tests use temporary files and fake service/health only."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('trace_history_upgrade', Path(__file__).with_name('trace-history-upgrade.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stage, self.live = self.root / 'stage', self.root / 'live'
        self.stage.mkdir()
        self.live.mkdir()
        self.original = {}
        manifest = {}
        for name in upgrade.FILES:
            raw = b'VERSION = 2\n'
            (self.stage / name).write_bytes(raw)
            if name in ('local_backend.py', 'meeting_features.py'):
                before = b'VERSION = 1\n'
                (self.live / name).write_bytes(before)
                self.original[name] = before
                manifest[name] = dict(before_sha256=upgrade.sha(before), after_sha256=upgrade.sha(raw))
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_text(json.dumps(manifest))
        for name in ('backend.env', 'jev.env', 'people.json', 'voiceprints.json'):
            (self.root / name).write_bytes(b'protected synthetic configuration\n')
        self.args = SimpleNamespace(stage_dir=str(self.stage), live_dir=str(self.live), backup_dir=str(self.root / 'backup'),
            manifest=str(self.manifest), state_dir=str(self.root), env_file=str(self.root / 'backend.env'),
            jev_env_file=str(self.root / 'jev.env'), service='oops-backend', health_url='http://127.0.0.1:8787/healthz', apply=True)
        self.commands = []

    def tearDown(self):
        self.temp.cleanup()

    def command(self, *parts):
        self.commands.append(parts)
        return 'active' if parts[1] == 'is-active' else ''

    def installer(self, **kw):
        return upgrade.Upgrade(self.args, command=self.command, health=lambda token: dict(status='ok', jev=True, meetings=True),
                               token=lambda: 'synthetic-token-never-output', tests=lambda: None, **kw)

    def test_exact_files_installed_permissions_and_protected_hashes_preserved(self):
        result = self.installer().install()
        self.assertEqual('installed_verified', result['status'])
        self.assertEqual(4, result['files'])
        self.assertTrue(result['protected_files_unchanged'])
        self.assertEqual([('systemctl', 'is-active', 'oops-backend'), ('systemctl', 'stop', 'oops-backend'),
            ('systemctl', 'start', 'oops-backend'), ('systemctl', 'is-active', 'oops-backend')], self.commands)
        for name in upgrade.FILES:
            self.assertEqual(b'VERSION = 2\n', (self.live / name).read_bytes())
        report = (self.root / 'backup/manifest.json').read_text()
        self.assertNotIn('protected synthetic', report)
        self.assertNotIn('synthetic-token', report)
        self.assertEqual(0o600, (self.root / 'backup/manifest.json').stat().st_mode & 0o777)

    def test_changed_production_hash_and_bad_compile_stop_before_service(self):
        (self.live / 'local_backend.py').write_bytes(b'concurrent change\n')
        with self.assertRaises(RuntimeError):
            self.installer().install()
        self.assertEqual([], self.commands)
        (self.live / 'local_backend.py').write_bytes(self.original['local_backend.py'])
        (self.stage / 'processing_trace.py').write_bytes(b'invalid(\n')
        with self.assertRaises(SyntaxError):
            self.installer().install()
        self.assertEqual([], self.commands)

    def test_health_failure_rolls_back_only_four_files_then_recovers_original(self):
        installer = self.installer()
        attempts = []
        def wait(token, baseline):
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError('synthetic health failure')
            return baseline
        installer.wait_health = wait
        with self.assertRaisesRegex(RuntimeError, 'failed_rolled_back'):
            installer.install()
        for name, raw in self.original.items():
            self.assertEqual(raw, (self.live / name).read_bytes())
        self.assertFalse((self.live / 'processing_trace.py').exists())
        self.assertFalse((self.live / 'replay_history.py').exists())
        self.assertEqual('rolled_back', json.loads((self.root / 'backup/manifest.json').read_text())['status'])

    def test_dry_run_never_stops_or_writes_production(self):
        self.args.apply = False
        self.assertEqual('dry_run_verified', self.installer().install()['status'])
        self.assertFalse(any(parts[1] in ('stop', 'start') for parts in self.commands))
        for name, raw in self.original.items():
            self.assertEqual(raw, (self.live / name).read_bytes())
        self.assertFalse((self.live / 'processing_trace.py').exists())

    def test_unexpected_existing_new_module_requires_explicit_before_hash(self):
        (self.live / 'processing_trace.py').write_bytes(b'original unrelated module\n')
        with self.assertRaisesRegex(RuntimeError, 'production_source_hash_changed'):
            self.installer().install()
        self.assertEqual([], self.commands)


if __name__ == '__main__':
    unittest.main()
