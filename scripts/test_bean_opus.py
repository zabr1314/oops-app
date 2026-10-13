#!/usr/bin/env python3
"""The bean's headerless Opus stream: Ogg wrapping is valid and a WAV survives the round trip (needs ffmpeg)."""
import os
import shutil
import struct
import tempfile
import unittest
import wave

import bean_opus


class BeanOpusTest(unittest.TestCase):
    def test_ogg_pages_checksum_and_carry_every_packet(self):
        packets = [bytes([i]) * 160 for i in range(120)]
        data = bean_opus.wrap_ogg(packets)
        self.assertEqual(packets, bean_opus.read_ogg_packets(data))
        page = bytearray(data[:data.index(b"OggS", 4)])
        crc = struct.unpack("<I", page[22:26])[0]
        page[22:26] = b"\0\0\0\0"
        self.assertEqual(crc, bean_opus.ogg_crc(page))

    def test_raw_stream_must_be_whole_packets(self):
        with self.assertRaises(ValueError):
            bean_opus.split_raw(b"x" * 161)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_wav_round_trip_keeps_duration(self):
        with tempfile.TemporaryDirectory() as d:
            src, raw, out = (os.path.join(d, n) for n in ("in.wav", "x.opusraw", "out.wav"))
            with wave.open(src, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
                w.writeframes(b"".join(struct.pack("<h", (i * 37) % 2000 - 1000) for i in range(16000 * 2)))
            self.assertAlmostEqual(2.0, bean_opus.encode(src, raw), delta=0.05)
            self.assertEqual(0, os.path.getsize(raw) % 160)
            bean_opus.decode(raw, out)
            with wave.open(out) as w:
                self.assertEqual((1, 16000), (w.getnchannels(), w.getframerate()))
                self.assertAlmostEqual(2.0, w.getnframes() / 16000, delta=0.05)


if __name__ == "__main__":
    unittest.main()
