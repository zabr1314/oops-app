#!/usr/bin/env python3
"""The 录音豆's audio format on the Mac: headerless Opus, 16 kHz stereo, one 20 ms packet of 160 bytes after another.

    bean_opus.py encode in.wav bean.opusraw     # any audio → a stream shaped like the bean's (for tests and the simulator)
    bean_opus.py decode bean.opusraw out.wav    # a bean file (SDK save path / offline sync) → 16 kHz mono WAV

The SDK saves raw Opus packets without an Ogg header, so ffmpeg cannot read the file directly. `decode` wraps the
packets in a minimal Ogg Opus container and lets ffmpeg's libopus decode it; `encode` does the reverse with
constant-bitrate libopus, so every packet is exactly 160 bytes (64 kbit/s × 20 ms), as the SDK documents.
Needs ffmpeg with libopus.
"""
import argparse
import os
import struct
import subprocess
import sys
import tempfile

FRAME_BYTES = 160
FRAME_MS = 20
CHANNELS = 2
RATE = 16000


def _crc_table():
    table = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) if r & 0x80000000 else r << 1
        table.append(r & 0xFFFFFFFF)
    return table


CRC = _crc_table()


def ogg_crc(data):
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ CRC[((crc >> 24) & 0xFF) ^ b]
    return crc


def ogg_page(serial, sequence, granule, packets, flags=0):
    segments = []
    for p in packets:
        segments += [255] * (len(p) // 255) + [len(p) % 255]
    assert len(segments) <= 255
    header = struct.pack("<4sBBqIIIB", b"OggS", 0, flags, granule, serial, sequence, 0, len(segments)) + bytes(segments)
    page = bytearray(header + b"".join(packets))
    page[22:26] = struct.pack("<I", ogg_crc(page))
    return bytes(page)


def wrap_ogg(packets, channels=CHANNELS, rate=RATE):
    """Raw Opus packets → Ogg Opus bytes. Granule positions count 48 kHz samples, as the spec requires."""
    serial = 0x0B5E0001
    head = b"OpusHead" + struct.pack("<BBHIhB", 1, channels, 0, rate, 0, 0)
    tags = b"OpusTags" + struct.pack("<I", 4) + b"oops" + struct.pack("<I", 0)
    pages = [ogg_page(serial, 0, 0, [head], flags=2), ogg_page(serial, 1, 0, [tags])]
    per_page, step = 50, 48000 * FRAME_MS // 1000
    for n, start in enumerate(range(0, len(packets), per_page)):
        chunk = packets[start:start + per_page]
        last = start + per_page >= len(packets)
        pages.append(ogg_page(serial, 2 + n, (start + len(chunk)) * step, chunk, flags=4 if last else 0))
    return b"".join(pages)


def read_ogg_packets(data):
    """Ogg pages → packets, dropping the OpusHead/OpusTags header packets."""
    packets, partial, pos = [], b"", 0
    while pos < len(data):
        if data[pos:pos + 4] != b"OggS":
            raise ValueError("不是 Ogg 数据")
        count = data[pos + 26]
        lacing = data[pos + 27:pos + 27 + count]
        body = pos + 27 + count
        for size in lacing:
            partial += data[body:body + size]
            body += size
            if size < 255:
                packets.append(partial)
                partial = b""
        pos = body
    return [p for p in packets if not p.startswith((b"OpusHead", b"OpusTags"))]


def split_raw(data, frame=FRAME_BYTES):
    if len(data) % frame:
        raise ValueError(f"文件大小 {len(data)} 不是 {frame} 字节的整数倍；不是录音豆的 Opus 裸流？")
    return [data[i:i + frame] for i in range(0, len(data), frame)]


def decode(src, dst, frame=FRAME_BYTES):
    with open(src, "rb") as f:
        packets = split_raw(f.read(), frame)
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
        tmp.write(wrap_ogg(packets))
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp.name, "-ac", "1", "-ar", str(RATE), "-sample_fmt", "s16", dst],
                       check=True)
    finally:
        os.unlink(tmp.name)
    return len(packets) * FRAME_MS / 1000


def encode(src, dst):
    with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as tmp:
        name = tmp.name
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-ar", str(RATE), "-ac", str(CHANNELS), "-c:a", "libopus",
                        "-b:a", "64k", "-vbr", "off", "-frame_duration", str(FRAME_MS), "-application", "voip", name], check=True)
        with open(name, "rb") as f:
            packets = read_ogg_packets(f.read())
    finally:
        os.unlink(name)
    sizes = {len(p) for p in packets}
    if sizes != {FRAME_BYTES}:
        raise ValueError(f"libopus 没有输出固定 {FRAME_BYTES} 字节的包：{sorted(sizes)[:5]}")
    with open(dst, "wb") as f:
        f.write(b"".join(packets))
    return len(packets) * FRAME_MS / 1000


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("cmd", choices=("encode", "decode"))
    parser.add_argument("src")
    parser.add_argument("dst")
    args = parser.parse_args(argv)
    try:
        seconds = (encode if args.cmd == "encode" else decode)(args.src, args.dst)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("失败：" + str(error), file=sys.stderr)
        return 1
    print(f"{args.dst}：{seconds:.1f} 秒")
    return 0


if __name__ == "__main__":
    sys.exit(main())
