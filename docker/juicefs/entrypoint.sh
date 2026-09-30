#!/bin/sh
# STC-MOD: format (first run only) and mount a JuiceFS volume backed by S3-compatible storage.
# The mount point lives on a host bind with rshared propagation so the SillyTavern container can see it.
# In the running container, `sh /juicefs-entrypoint.sh pending` counts the blocks still waiting for upload.
set -eu

CACHE_DIR="/var/jfsCache"

# Write-back staging (JFS_WRITEBACK, see below). JuiceFS stages each new block as
# <cache dir>/<volume UUID>/rawstaging/chunks/<dir>/<dir>/<slice id>_<index>_<size> and deletes it once
# it is in the bucket. The rules here mirror JuiceFS 1.4.1 (pkg/chunk/disk_cache.go scanStaging and
# openCacheFile):
#   - *.tmp files are unfinished writes, never uploaded (JuiceFS removes them at start-up once they are
#     a minute old); other names and <size> 0 are ignored by JuiceFS too. None of these is counted.
#   - A block is uploaded only if the file holds all <size> bytes, followed by nothing, a complete
#     checksum (4 bytes per 32 KiB) or a footer. Staged files are not fsynced, so an unclean shutdown
#     of the host can leave a block cut short (often 0 bytes). JuiceFS retries such a "stuck" block
#     every minute ("Open staging file ...: invalid file size"), but never uploads or removes it.
# Prints "<pending> <stuck> <scan failed: 0/1>", then the paths of the stuck blocks.
scan_staging() {
    for dir in "$@"; do
        [ -d "$dir" ] || continue
        find "$dir" -type f ! -name '*.tmp' -printf '%s %P %p\n' || echo '!'
    done | awk '
        $0 == "!" { failed = 1; next }
        NF == 3 && $2 ~ /^chunks\/([0-9]+|[0-9a-fA-F][0-9a-fA-F])\/[0-9]+\/[0-9]+_[0-9]+_[0-9]+$/ {
            n = split($2, parts, "_")
            dlen = parts[n] + 0
            if (dlen == 0) next
            extra = $1 - dlen
            sums = (int((dlen - 1) / 32768) + 1) * 4
            if (extra < 0 || (extra > 0 && extra % 4 == 0 && extra < sums)) stuck[++nstuck] = $3
            else pending++
        }
        END {
            printf "%d %d %d\n", pending, nstuck, failed
            for (i = 1; i <= nstuck; i++) print stuck[i]
        }'
}

# Sets PENDING, STUCK, SCAN_FAILED and STUCK_LIST from the output of scan_staging.
read_scan() {
    PENDING="$(printf '%s\n' "$1" | awk 'NR == 1 { print $1 }')"
    STUCK="$(printf '%s\n' "$1" | awk 'NR == 1 { print $2 }')"
    SCAN_FAILED="$(printf '%s\n' "$1" | awk 'NR == 1 { print $3 }')"
    STUCK_LIST="$(printf '%s\n' "$1" | sed '1d')"
}

if [ "${1:-}" = "pending" ]; then
    # All volumes in the cache directory (normally just one).
    read_scan "$(scan_staging "$CACHE_DIR"/*/rawstaging)"
    echo "pending: $PENDING (staged blocks waiting for upload; 0 = everything is in the bucket)"
    echo "stuck: $STUCK (incomplete blocks that can never be uploaded; 0 = none)"
    if [ "$STUCK" != "0" ]; then
        printf '%s\n' "$STUCK_LIST" | sed 's/^/  /'
    fi
    if [ "$SCAN_FAILED" != "0" ]; then
        echo "Some files could not be checked (a block may have been uploaded meanwhile), run this again." >&2
        exit 1
    fi
    exit 0
fi

: "${JFS_NAME:?JFS_NAME is required (see s3.env.example)}"
: "${JFS_BUCKET:?JFS_BUCKET is required (see s3.env.example)}"
: "${JFS_ACCESS_KEY:?JFS_ACCESS_KEY is required (see s3.env.example)}"
: "${JFS_SECRET_KEY:?JFS_SECRET_KEY is required (see s3.env.example)}"
: "${JFS_META_URL:?JFS_META_URL is required (MariaDB/MySQL or Redis, see s3.env.example)}"

# Database password may be given separately in META_PASSWORD (read by JuiceFS itself),
# so it never needs URL-escaping inside JFS_META_URL.
META_URL="$JFS_META_URL"
MOUNT_POINT="/mnt/jfs-host/fs"
VOLUME_UUID=""

# Optional write-back mode (JFS_WRITEBACK=1, off by default), see the end of this script. Case and
# spaces do not matter. An unknown value leaves it off with a warning: refusing to mount would take
# the whole site down because of an optional setting.
WRITEBACK_VALUE="$(printf '%s' "${JFS_WRITEBACK:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
case "$WRITEBACK_VALUE" in
    1 | true | yes | on) WRITEBACK=1 ;;
    0 | false | no | off | "") WRITEBACK=0 ;;
    *)
        echo "[juicefs] WARNING: unknown JFS_WRITEBACK='$JFS_WRITEBACK' (use 1 to enable, 0 to disable), write-back stays off" >&2
        WRITEBACK=0
        ;;
esac

# Format only when the metadata engine reports an unformatted volume.
# Any other status failure (e.g. database unreachable) aborts so we never re-format by accident.
if ! STATUS_OUTPUT="$(juicefs status "$META_URL" 2>&1)"; then
    if echo "$STATUS_OUTPUT" | grep -qi "not formatted"; then
        echo "[juicefs] Volume not formatted yet, formatting '$JFS_NAME' on $JFS_BUCKET"
        if ! FORMAT_OUTPUT="$(juicefs format \
            --storage s3 \
            --bucket "$JFS_BUCKET" \
            --access-key "$JFS_ACCESS_KEY" \
            --secret-key "$JFS_SECRET_KEY" \
            --compress lz4 \
            --trash-days "${JFS_TRASH_DAYS:-7}" \
            "$META_URL" "$JFS_NAME" 2>&1)"; then
            echo "$FORMAT_OUTPUT" >&2
            if echo "$FORMAT_OUTPUT" | grep -qi "is not empty"; then
                # JuiceFS refuses to format over existing data: the metadata database is empty
                # but the bucket still holds a volume. Never force it; restore the metadata instead.
                echo "" >&2
                echo "[juicefs] The bucket already contains volume '$JFS_NAME', but the metadata database is empty." >&2
                echo "[juicefs] Check JFS_META_URL. To restore metadata from the automatic backup in the bucket:" >&2
                echo "[juicefs]   1. Download the newest $JFS_NAME/meta/dump-*.json.gz from the bucket" >&2
                echo "[juicefs]   2. docker compose -f docker-compose.s3.yml run --rm -v \"\$PWD/dump.json.gz:/dump.json.gz:ro\" --entrypoint sh juicefs -c 'juicefs load \"\$JFS_META_URL\" /dump.json.gz'" >&2
            fi
            sleep 10
            exit 1
        fi
        echo "$FORMAT_OUTPUT"
    else
        echo "[juicefs] Cannot read volume status, refusing to continue:" >&2
        echo "$STATUS_OUTPUT" >&2
        exit 1
    fi
else
    # Keep the stored settings in sync with s3.env (format only runs once). Metadata backups
    # do not contain the secret key, so this is required after `juicefs load`; it also applies
    # key rotations and changes of JFS_TRASH_DAYS.
    if ! CONFIG_OUTPUT="$(juicefs config "$META_URL" \
        --access-key "$JFS_ACCESS_KEY" \
        --secret-key "$JFS_SECRET_KEY" \
        --trash-days "${JFS_TRASH_DAYS:-7}" \
        --yes 2>&1)"; then
        echo "[juicefs] Failed to apply settings from s3.env:" >&2
        echo "$CONFIG_OUTPUT" >&2
        sleep 10
        exit 1
    fi
    # The volume UUID names the cache subdirectory (checked for staged blocks below).
    VOLUME_UUID="$(printf '%s\n' "$STATUS_OUTPUT" | sed -n 's/^ *"UUID": *"\([0-9a-f-]*\)".*/\1/p' | head -n 1)"
    [ -n "$VOLUME_UUID" ] || VOLUME_UUID='*'
fi

# Clear a stale FUSE mount left behind by a crashed previous container.
if grep -qs " $MOUNT_POINT " /proc/mounts; then
    echo "[juicefs] Removing stale mount at $MOUNT_POINT"
    umount -l "$MOUNT_POINT" || true
fi
mkdir -p "$MOUNT_POINT"

# Write-back mode: fsync/close only write new blocks to $CACHE_DIR/<volume UUID>/rawstaging and
# return; the blocks are uploaded to the bucket in the background. Until then they exist only on this
# disk, so never delete the cache directory while blocks are pending (see s3.env.example).
# Blocks left there by an earlier run (crash, or stopped before the upload finished) are uploaded after
# mounting, but JuiceFS only does that in write-back mode: keep it on for this run until they are gone.
# Stuck blocks (see scan_staging) can never be uploaded, so they are reported but do not keep it on.
PENDING=0
STUCK=0
SCAN_FAILED=0
STUCK_LIST=""
if [ -n "$VOLUME_UUID" ]; then
    # Unquoted on purpose: VOLUME_UUID is hex digits and hyphens, or the glob '*' as a fallback.
    read_scan "$(scan_staging "$CACHE_DIR"/$VOLUME_UUID/rawstaging)"
fi
if [ "$STUCK" != "0" ]; then
    echo "[juicefs] WARNING: $STUCK staged block(s) are incomplete and can never be uploaded (the server was not shut down cleanly?):" >&2
    printf '%s\n' "$STUCK_LIST" | head -n 20 | sed 's/^/[juicefs]   /' >&2
    echo "[juicefs] Files that use them cannot be read: find them with juicefs fsck and restore them from the" >&2
    echo "[juicefs] JuiceFS trash; the blocks go away once the broken files are deleted (README.md, S3 storage, section 8)." >&2
fi
if [ "$PENDING" != "0" ]; then
    echo "[juicefs] $PENDING staged block(s) from an earlier run are waiting for upload"
fi
if [ "$SCAN_FAILED" != "0" ]; then
    echo "[juicefs] WARNING: could not check all staged blocks in $CACHE_DIR, some may be waiting for upload" >&2
fi
if [ "$WRITEBACK" = "0" ] && { [ "$PENDING" != "0" ] || [ "$SCAN_FAILED" != "0" ]; }; then
    echo "[juicefs] JFS_WRITEBACK is off, but staged blocks are only uploaded in write-back mode:" >&2
    echo "[juicefs] enabling it for this run. Recreate juicefs once 'sh /juicefs-entrypoint.sh pending' shows 0 to turn it off." >&2
    WRITEBACK=1
fi

set -- \
    --cache-dir "$CACHE_DIR" \
    --cache-size "${JFS_CACHE_SIZE_MIB:-10240}" \
    --backup-meta "${JFS_BACKUP_META:-1h}"
if [ "$WRITEBACK" = "1" ]; then
    set -- "$@" --writeback
    echo "[juicefs] Write-back enabled: new data is staged in $CACHE_DIR and uploaded in the background"
fi

echo "[juicefs] Mounting at $MOUNT_POINT"
exec juicefs mount "$@" "$META_URL" "$MOUNT_POINT"
