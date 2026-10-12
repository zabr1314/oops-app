#!/usr/bin/env python3
"""Enforce new per-session TTLs on a stopped server or mounted archive mirror; never age legacy assets."""
import argparse
import datetime as dt
import json
import os
import subprocess
from contextlib import contextmanager
from types import SimpleNamespace
from meeting_features import Meetings
from recordings import Recordings


@contextmanager
def mirror_lock(directory):
    """Serialize the mirror's minute sweep and its entire rsync; never use an expiring pid lock."""
    import fcntl
    if not os.path.isdir(directory):
        raise ValueError('镜像根目录必须已存在于本机')
    flags = os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
    fd = os.open(os.path.join(directory, '.oops-archive-cleanup.lock'), flags, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def pull_and_cleanup(directory, script):
    """Caller holds mirror_lock; a failed pull still cannot leave expired local assets behind."""
    before = cleanup(directory)
    try:
        subprocess.run(['/bin/sh', script, '--locked-pull'], check=True)
    finally:
        after = cleanup(directory)
    return dict(before=before, after=after)


def cleanup(directory, now=None):
    if not os.path.isdir(os.path.join(directory, 'meetings')) or not os.path.isdir(os.path.join(directory, 'recordings')):
        raise ValueError('目标必须是已有的归档根目录（包含meetings/及recordings/）')
    meetings = Meetings(os.path.join(directory, 'meetings'), retention_days=0)
    recordings = Recordings(os.path.join(directory, 'recordings'))
    result = dict(transcripts=meetings.cleanup(now), recording_files=recordings.cleanup(now))
    # The mirror normally contains only meetings/ and recordings/. A full backend also has helper inputs.
    if os.path.isfile(os.path.join(directory, 'feishu', 'state.json')):
        from feishu_actions import FeishuActions, State, Jobs
        holder = SimpleNamespace(state=State(os.path.join(directory, 'feishu')), jobs=Jobs(os.path.join(directory, 'agent-jobs')))
        for name in os.listdir(meetings.dir):
            if name.endswith('.json'):
                with open(os.path.join(meetings.dir, name), encoding='utf-8') as source:
                    if json.load(source).get('transcript_status') == 'expired':
                        FeishuActions.expire_meeting_sources(holder, name[:-5])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', required=True, help='服务器状态目录或已挂载镜像根目录')
    parser.add_argument('--mirror-pull-script', help='既有本机拉取脚本；持锁运行并在前后清理')
    args = parser.parse_args()
    with mirror_lock(args.state_dir):
        result = pull_and_cleanup(args.state_dir, args.mirror_pull_script) if args.mirror_pull_script else cleanup(args.state_dir)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
