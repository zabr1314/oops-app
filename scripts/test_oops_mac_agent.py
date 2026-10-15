"""No Claude or network: generation output must outlive transport failures."""
import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch

import oops_mac_agent as agent


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.work = patch.object(agent, 'WORK', self.tmp.name); self.work.start(); self.addCleanup(self.work.stop)
        self.job = dict(id='a' * 32, kind='ppt', payload=dict(title='原成果'), attempts=1)
        self.generations, self.renders, self.results, self.fail = 0, 0, [], True

    def generate(self, job, folder):
        self.generations += 1
        with open(os.path.join(folder, 'result.md'), 'w') as out: out.write('original body')

    def render(self, folder):
        self.renders += 1
        path = os.path.join(folder, 'slides.pptx')
        with open(path, 'wb') as out: out.write(b'original ppt')
        return path

    def call(self, server, token, path, body, timeout=30):
        if path.endswith('/chunk'):
            if self.fail: raise OSError('lost upload reply')
            return dict(received=12)
        self.results.append(body)
        if body.get('ok'):
            return dict(status='done', generation_status='ready')
        return dict(status='awaiting_upload')

    def test_transfer_resume_preserves_same_body_and_ppt_without_model(self):
        with patch.object(agent, 'run_claude', self.generate), patch.object(agent, 'render_slides', self.render), patch.object(agent, 'call', self.call):
            self.assertFalse(agent.do('https://example.test/backend', 'fake', self.job))
            self.assertEqual(self.results[-1]['phase'], 'transfer')
            self.fail = False
            agent.resume_pending('https://example.test/backend', 'fake')
            self.assertEqual(self.generations, 1); self.assertEqual(self.renders, 1)
            self.assertEqual(self.results[-1]['markdown'], 'original body')
            self.assertEqual(self.results[-1]['files'][0]['size'], 12)
            agent.resume_pending('https://example.test/backend', 'fake')
            self.assertEqual(self.generations, 1)

    def test_pending_output_not_sent_to_other_backend(self):
        with patch.object(agent, 'run_claude', self.generate), patch.object(agent, 'render_slides', self.render), patch.object(agent, 'call', self.call):
            agent.do('https://example.test/backend', 'fake', self.job)
            before = len(self.results)
            agent.resume_pending('https://other.test/backend', 'fake')
            self.assertEqual(len(self.results), before)

    def test_started_generation_without_receipt_is_not_rerun(self):
        def uncertain(job, folder):
            self.generations += 1
            raise TimeoutError('result unknown')
        with patch.object(agent, 'run_claude', uncertain), patch.object(agent, 'call', self.call):
            agent.do('https://example.test/backend', 'fake', self.job)
            agent.do('https://example.test/backend', 'fake', self.job)
        self.assertEqual(self.generations, 1)

    def test_cleanup_preserves_legacy_unknown_and_unacknowledged_outputs(self):
        now = time.time()
        for name, markers in [('old-timestamp-report', {}),
                              ('legacy-with-file', {'result.md': 'original output'}),
                              ('unknown-generation', {'generation-started.json': '{}'}),
                              ('unacknowledged', {'generated.json': '{"markdown":"paid output"}'}),
                              ('old-accepted-name-only', {'accepted.json': '{"status":"done","generation_status":"ready"}'})]:
            folder = os.path.join(self.tmp.name, name)
            os.makedirs(folder)
            for filename, content in markers.items():
                with open(os.path.join(folder, filename), 'w') as out: out.write(content)
            os.utime(folder, (now - 90 * 86400, now - 90 * 86400))
        agent.clean_old(now=now)
        self.assertEqual(len(os.listdir(self.tmp.name)), 5)
        for name in os.listdir(self.tmp.name): self.assertTrue(os.path.isdir(os.path.join(self.tmp.name, name)))

    def test_cleanup_requires_matching_managed_backend_acceptance(self):
        now = time.time()
        job_id, endpoint = 'a' * 32, 'e' * 64
        folder = os.path.join(self.tmp.name, endpoint[:12] + '-' + job_id)
        os.makedirs(folder)
        agent.checkpoint(folder, 'job.json', dict(id=job_id, endpoint_fingerprint=endpoint))
        agent.checkpoint(folder, 'accepted.json', dict(status='unknown', generation_status='ready'))
        os.utime(folder, (now - 90 * 86400, now - 90 * 86400))
        agent.clean_old(now=now)
        self.assertTrue(os.path.isdir(folder))
        agent.checkpoint(folder, 'accepted.json', dict(status='done', generation_status='ready'))
        os.utime(folder, (now - 90 * 86400, now - 90 * 86400))
        agent.clean_old(now=now)
        self.assertFalse(os.path.exists(folder))


if __name__ == '__main__': unittest.main()
