#!/bin/sh
# Build the addon for linux/arm64 and copy the .node out of the build stage.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/lingua_detector.linux-arm64-gnu.node"}
docker build --platform linux/arm64 -t ws27-lingua -f "$here/Dockerfile" "$here"
cid=$(docker create --platform linux/arm64 ws27-lingua /lingua_detector.node)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$cid:/lingua_detector.node" "$out"
ls -l "$out"
