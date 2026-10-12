#!/bin/sh
# Nightly on the Mac (launchd local.oops.archive-pull, 03:30). Installed copy: ~/.local/share/oops-archive/pull.sh
# 1. Second copy of the team's raw meeting assets (audio, finals, raw ASR, timing, meeting text) from the HK server.
#    Mirrors deletions so a meeting deleted in the app is gone here too. New meeting TTLs are enforced
#    before and after pull, plus every minute by --install-cleanup (run after updating this repo).
# 2. The other direction: evaluation labels live only in the git-ignored evidence/ folder on this Mac, so push a
#    copy to the server. Never deletes there; a lost laptop must not cost the labelling work.
set -eu
DEST=${OOPS_ARCHIVE_DEST:-/Volumes/GPFS/Users/a1234/oops-archive}
REPO=${OOPS_ARCHIVE_REPO:-/Volumes/GPFS/Users/a1234/Desktop/Coding/oops}
HOST=${OOPS_ARCHIVE_HOST:-root@103.110.81.78}
PYTHON=$(command -v "${OOPS_ARCHIVE_PYTHON:-python3}")
SSH="/usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=20"
umask 077
if [ "${1:-}" != --install-cleanup ] && [ ! -d "$DEST" ]; then exit 0; fi
[ -f "$REPO/scripts/cleanup_archives.py" ] || { echo "missing current archive policy runtime: $REPO/scripts/cleanup_archives.py" >&2; exit 1; }
case ${1:-} in
  --install-cleanup)
    # Explicit installation only. Keep the existing nightly task; this adds a local-only minute sweep.
    "$PYTHON" - "$0" "$PYTHON" "$DEST" "$REPO" "$HOST" <<'PY'
import os, pathlib, plistlib, shutil, sys
source, python, dest, repo, host = sys.argv[1:]
home = pathlib.Path.home()
installed = home / '.local/share/oops-archive/pull.sh'
installed.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
if pathlib.Path(source).resolve() != installed.resolve(): shutil.copyfile(source, installed)
installed.chmod(0o700)
agents = home / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
config = dict(Label='local.oops.archive-cleanup', ProgramArguments=['/bin/sh', str(installed), '--cleanup-only'],
              StartInterval=60, RunAtLoad=True,
              EnvironmentVariables=dict(OOPS_ARCHIVE_DEST=dest, OOPS_ARCHIVE_REPO=repo,
                                        OOPS_ARCHIVE_HOST=host, OOPS_ARCHIVE_PYTHON=python),
              StandardOutPath=str(installed.parent / 'cleanup.log'), StandardErrorPath=str(installed.parent / 'cleanup.log'))
with open(agents / 'local.oops.archive-cleanup.plist', 'wb') as output: plistlib.dump(config, output)
os.chmod(agents / 'local.oops.archive-cleanup.plist', 0o600)
PY
    launchctl bootout "gui/$(id -u)/local.oops.archive-cleanup" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.oops.archive-cleanup.plist"
    echo "installed local.oops.archive-cleanup (60s); existing nightly pull retained"
    exit 0 ;;
  --cleanup-only)
    [ -d "$DEST/meetings" ] && [ -d "$DEST/recordings" ] || exit 0
    exec "$PYTHON" "$REPO/scripts/cleanup_archives.py" --state-dir "$DEST" ;;
  --locked-pull) ;; # Invoked only by cleanup_archives.py with the mirror lock held.
  '')
    [ -d "$DEST" ] || exit 0   # GPFS volume not mounted; minute cleanup also skips missing volumes.
    mkdir -p "$DEST/meetings" "$DEST/recordings"
    export OOPS_ARCHIVE_DEST="$DEST" OOPS_ARCHIVE_REPO="$REPO" OOPS_ARCHIVE_HOST="$HOST" OOPS_ARCHIVE_PYTHON="$PYTHON"
    exec "$PYTHON" "$REPO/scripts/cleanup_archives.py" --state-dir "$DEST" --mirror-pull-script "$0" ;;
  *) echo "usage: $0 [--cleanup-only|--install-cleanup]" >&2; exit 2 ;;
esac
for part in recordings meetings; do
  /usr/bin/rsync -a --delete -e "$SSH" "$HOST:/var/lib/oops/backend/$part/" "$DEST/$part/"
done
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/last-pull.txt"

# Labels and meeting texts are small; failures here are reported but must not hide that the mirror succeeded.
push_labels() {
  [ -d "$REPO/evidence" ] || return 0
  $SSH $HOST 'mkdir -p -m 700 /var/lib/oops/backend/evidence-backup/tasks /var/lib/oops/backend/evidence-backup/split-datasets'
  for set in "$REPO"/evidence/task-*; do
    [ -d "$set" ] || continue
    /usr/bin/rsync -a -e "$SSH" "$set/" "$HOST:/var/lib/oops/backend/evidence-backup/tasks/$(basename "$set")/"
  done
  for set in "$REPO"/models/voiceprint/split-datasets/*; do
    [ -f "$set/truth.json" ] || continue
    name=$(basename "$set")
    $SSH $HOST "mkdir -p -m 700 /var/lib/oops/backend/evidence-backup/split-datasets/$name"
    /usr/bin/rsync -a -e "$SSH" --include='truth.json' --include='manifest.json' --include='frozen.json' --exclude='*' \
      "$set/" "$HOST:/var/lib/oops/backend/evidence-backup/split-datasets/$name/"
  done
}
if push_labels; then
  date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/last-labels-push.txt"
else
  echo "label backup failed" >&2
fi
