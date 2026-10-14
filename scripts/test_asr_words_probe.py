"""Zero-fee protocol and lifecycle tests. Every WebSocket is a local in-memory fake."""
import contextlib
import io
import json
from pathlib import Path
import queue
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
import wave

import asr_words_probe as probe


def response(text=None, last=False):
    payload = b'' if text is None else json.dumps({'result': {'utterances': [dict(
        definite=True, start_time=0, end_time=200, text=text, words=[])]}}).encode()
    return probe.frame(9, payload, last=last)


def provider_error(code=45000081, text='Timed out waiting for next packet'):
    payload = json.dumps({'error': text}).encode()
    return bytes((0x11, 0xF0, 0x10, 0)) + struct.pack('>II', code, len(payload)) + payload


class FakeSocket:
    def __init__(self, outcome='ack'):
        self.sent, self.received = [], queue.Queue()
        self.outcome, self.closed = outcome, False
    def send_binary(self, data):
        self.sent.append(data)
        if data[1] >> 4 == 2 and data[1] & 2:
            # The last definite sentence arrives after the explicit EOS.
            self.received.put(response('最后一句。'))
            if self.outcome == 'ack':
                self.received.put(response(last=True))
            elif self.outcome == 'error':
                self.received.put(provider_error())
            elif self.outcome == 'closed':
                self.received.put(b'')
            elif self.outcome == 'reject':
                return False
        return len(data)
    def recv(self):
        return self.received.get(timeout=2)
    def close(self):
        self.closed = True
        self.received.put(b'')


class ProbeTests(unittest.TestCase):
    def run_probe(self, folder, outcome='ack'):
        path = folder / 'test.wav'
        with wave.open(str(path), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
            audio.writeframes(bytes(3217 * 2))  # Non-200ms tail, which must not be padded.
        original = path.read_bytes()
        socket, factory_calls = FakeSocket(outcome), []
        def create(*args, **kwargs):
            factory_calls.append(True)
            return socket
        args = types.SimpleNamespace(output=str(folder / 'output'), seconds=None, speed=100000,
                                     final_sequence=False, finish_timeout=.05)
        fake_module = types.SimpleNamespace(create_connection=create)
        credentials = dict(VOLC_API_KEY='test-only-key', VOLC_APP_ID='', VOLC_ACCESS_TOKEN='', VOLC_RESOURCE_ID='test-only-resource')
        with patch.dict(sys.modules, {'websocket': fake_module}), patch.object(probe, 'credentials', return_value=credentials), contextlib.redirect_stdout(io.StringIO()):
            report = probe.probe(path, args)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(len(factory_calls), 1)
        return report, socket, path, args

    def test_exact_audio_then_empty_eos_and_late_tail_are_acknowledged(self):
        with tempfile.TemporaryDirectory() as folder:
            report, socket, path, args = self.run_probe(Path(folder))
            self.assertTrue(report['complete'])
            self.assertTrue(report['eos_sent'])
            self.assertEqual(report['termination'], 'acknowledged')
            audio = [data for data in socket.sent if data[1] >> 4 == 2]
            self.assertEqual([struct.unpack_from('>I', data, 4)[0] for data in audio], [6400, 34, 0])
            self.assertEqual([bool(data[1] & 2) for data in audio], [False, False, True])
            finals = json.loads((Path(args.output) / path.stem / 'finals.json').read_text())
            self.assertEqual([final['text'] for final in finals], ['最后一句。'])
            self.assertTrue(socket.closed)

    def test_finishing_provider_error_keeps_tail_and_reports_incomplete(self):
        with tempfile.TemporaryDirectory() as folder:
            report, socket, _, _ = self.run_probe(Path(folder), 'error')
            self.assertFalse(report['complete'])
            self.assertFalse(report['server_last_received'])
            self.assertEqual(report['termination'], 'provider_error')
            self.assertEqual(report['final_count'], 1)
            self.assertIn('45000081', report['transport_errors'][0])

    def test_socket_close_without_ack_is_not_success(self):
        with tempfile.TemporaryDirectory() as folder:
            report, _, _, _ = self.run_probe(Path(folder), 'closed')
            self.assertFalse(report['complete'])
            self.assertEqual(report['termination'], 'closed_without_ack')

    def test_no_ack_times_out_without_reconnect_or_paid_audio_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            report, socket, _, _ = self.run_probe(Path(folder), 'timeout')
            self.assertFalse(report['complete'])
            self.assertEqual(report['termination'], 'finish_timeout')
            self.assertEqual(report['final_count'], 1)
            self.assertEqual(sum(bool(data[1] & 2) for data in socket.sent if data[1] >> 4 == 2), 1)

    def test_duplicate_finish_and_audio_after_finish_are_ignored(self):
        socket = FakeSocket()
        stream = probe.ProbeStream(socket)
        stream.finish(); stream.finish()
        self.assertFalse(stream.send_audio(bytes(3200)))
        self.assertEqual(len(socket.sent), 1)

    def test_failed_eos_attempt_is_not_resent_or_reported_sent(self):
        socket = FakeSocket('reject')
        stream = probe.ProbeStream(socket)
        with self.assertRaisesRegex(RuntimeError, 'EOS send failed'):
            stream.finish()
        stream.finish()
        self.assertTrue(stream.eos_attempted)
        self.assertFalse(stream.eos_sent)
        self.assertEqual(len(socket.sent), 1)

    def test_empty_terminal_payload_and_negative_sequence_are_decoded(self):
        self.assertEqual(probe.decode(probe.frame(9, b'', last=True)), ({}, True))
        self.assertEqual(probe.decode(probe.frame(9, b'', last=True, final_sequence=True)), ({}, True))

    def test_truncated_or_unsupported_frame_is_rejected(self):
        for data in (probe.frame(9, b'{}')[:-1], probe.frame(11, b'{}'), bytes((0x10, 0x92, 0, 0, 0, 0, 0, 0))):
            with self.subTest(data=data), self.assertRaises(ValueError):
                probe.decode(data)

    def test_premature_last_is_not_a_finish_ack_and_errors_are_redacted(self):
        stream = probe.ProbeStream(FakeSocket(), ['private-test-key'])
        stream.receive(response('尾句', last=True))
        self.assertEqual(stream.termination, 'premature_server_end')
        self.assertFalse(stream.eos_sent)
        another = probe.ProbeStream(FakeSocket(), ['private-test-key'])
        another.fail('provider echoed private-test-key', 'provider_error')
        self.assertEqual(another.errors, ['provider echoed [redacted]'])

    def test_existing_evidence_prevents_a_new_connection(self):
        with tempfile.TemporaryDirectory() as folder:
            _, _, path, args = self.run_probe(Path(folder))
            factory = patch.dict(sys.modules, {'websocket': types.SimpleNamespace(
                create_connection=lambda *a, **k: self.fail('must not connect'))})
            with factory, self.assertRaises(FileExistsError):
                probe.probe(path, args)


if __name__ == '__main__':
    unittest.main()
