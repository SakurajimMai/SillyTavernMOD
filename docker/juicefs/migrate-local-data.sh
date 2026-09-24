#!/bin/sh
# STC-MOD: one-time copy of an existing local data directory into the JuiceFS (S3) volume.
#
# Usage (run from the docker/ directory, as root):
#   docker compose -f docker-compose.s3.yml up -d redis juicefs
#   docker stop sillytavernmod 2>/dev/null
#   sh juicefs/migrate-local-data.sh ./data
#   docker compose -f docker-compose.s3.yml up -d
set -eu

SRC="${1:-./data}"
DST="./juicefs/mnt/fs/data"

if [ ! -d "$SRC" ]; then
    echo "Source directory not found: $SRC" >&2
    exit 1
fi

if ! grep -qs "$(cd ./juicefs/mnt && pwd)/fs fuse.juicefs" /proc/mounts; then
    echo "JuiceFS is not mounted at ./juicefs/mnt/fs. Start it first:" >&2
    echo "  docker compose -f docker-compose.s3.yml up -d redis juicefs" >&2
    exit 1
fi

if [ "$(docker inspect -f '{{.State.Running}}' sillytavernmod 2>/dev/null)" = "true" ]; then
    echo "SillyTavern is running. Stop it first so data is not modified during the copy:" >&2
    echo "  docker stop sillytavernmod" >&2
    exit 1
fi

if [ -d "$DST" ] && [ -n "$(ls -A "$DST" 2>/dev/null)" ]; then
    echo "Target $DST is not empty; refusing to overwrite. Move or delete it first if you really want to re-import." >&2
    exit 1
fi

echo "Copying $SRC -> $DST (uploads to S3, may take a while) ..."
mkdir -p "$DST"
cp -a "$SRC"/. "$DST"/

SRC_COUNT="$(find "$SRC" -type f | wc -l)"
DST_COUNT="$(find "$DST" -type f | wc -l)"
echo "Files: source=$SRC_COUNT target=$DST_COUNT"
if [ "$SRC_COUNT" != "$DST_COUNT" ]; then
    echo "File counts differ, please check before deleting the local copy." >&2
    exit 1
fi
echo "Done. Keep $SRC as a backup until you have verified the site."
