#!/bin/bash
# Read-only environment inventory. Does not build, install, sign, or start devices.
set -u

if [ "$(uname -s)" != Darwin ]; then
  echo 'Apple Watch development requires macOS and full Xcode.'
  exit 1
fi

echo '== macOS =='
sw_vers
uname -m
echo '== Available disk space =='
df -h .
echo '== Active developer directory =='
developer_dir="$(xcode-select -p 2>/dev/null || true)"
echo "${developer_dir:-Not configured}"
if [ -n "${DEVELOPER_DIR:-}" ]; then
  echo "DEVELOPER_DIR override: $DEVELOPER_DIR"
fi

echo '== Xcode =='
if ! xcodebuild -version; then
  echo 'NOT READY: Full Xcode is missing, not selected, or not initialized.'
  echo 'Install official Xcode and complete its first-launch setup.'
  exit 1
fi

echo '== First-launch setup =='
if ! xcodebuild -checkFirstLaunchStatus; then
  echo 'NOT READY: Complete Xcode first-launch setup.'
  exit 1
fi

echo '== Installed SDKs =='
sdk_list="$(xcodebuild -showsdks 2>&1)"
sdk_status=$?
echo "$sdk_list"
if [ "$sdk_status" -ne 0 ] || ! echo "$sdk_list" | /usr/bin/grep -q -- '-sdk watchos'; then
  echo 'NOT READY: watchOS SDK is unavailable.'
  exit 1
fi

echo '== Available simulator runtimes =='
if ! runtime_list="$(xcrun simctl list runtimes -j)"; then
  echo 'NOT READY: Simulator tooling is unavailable.'
  exit 1
fi
echo "$runtime_list" | /usr/bin/python3 -c '
import json, sys
runtimes = json.load(sys.stdin)["runtimes"]
for runtime in runtimes:
    print("{}: {}".format(runtime["name"], "available" if runtime.get("isAvailable") else "unavailable"))
if not any(r.get("isAvailable") and r.get("identifier", "").startswith("com.apple.CoreSimulator.SimRuntime.watchOS-") for r in runtimes):
    print("NOT READY: No available watchOS simulator runtime.")
    sys.exit(1)
'
runtime_status=$?
echo '== Available signing identities (count only) =='
security find-identity -v -p codesigning | /usr/bin/grep 'valid identities found' || true
if [ "$runtime_status" -ne 0 ]; then
  exit "$runtime_status"
fi
echo 'Xcode, watchOS SDK, and a watchOS runtime are available. Simulator pairing and physical-device signing require separate setup.'
