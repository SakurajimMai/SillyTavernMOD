#!/bin/sh
# STC-MOD: format (first run only) and mount a JuiceFS volume backed by S3-compatible storage.
# The mount point lives on a host bind with rshared propagation so the SillyTavern container can see it.
set -eu

: "${JFS_NAME:?JFS_NAME is required (see s3.env.example)}"
: "${JFS_BUCKET:?JFS_BUCKET is required (see s3.env.example)}"
: "${JFS_ACCESS_KEY:?JFS_ACCESS_KEY is required (see s3.env.example)}"
: "${JFS_SECRET_KEY:?JFS_SECRET_KEY is required (see s3.env.example)}"
: "${JFS_META_URL:?JFS_META_URL is required (MariaDB/MySQL or Redis, see s3.env.example)}"

# Database password may be given separately in META_PASSWORD (read by JuiceFS itself),
# so it never needs URL-escaping inside JFS_META_URL.
META_URL="$JFS_META_URL"
MOUNT_POINT="/mnt/jfs-host/fs"

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
    # Keep the stored credentials in sync with s3.env. Metadata backups do not contain the
    # secret key, so this is required after `juicefs load`; it also applies key rotations.
    if ! CONFIG_OUTPUT="$(juicefs config "$META_URL" \
        --access-key "$JFS_ACCESS_KEY" \
        --secret-key "$JFS_SECRET_KEY" \
        --yes 2>&1)"; then
        echo "[juicefs] Failed to apply S3 credentials from s3.env:" >&2
        echo "$CONFIG_OUTPUT" >&2
        sleep 10
        exit 1
    fi
fi

# Clear a stale FUSE mount left behind by a crashed previous container.
if grep -qs " $MOUNT_POINT " /proc/mounts; then
    echo "[juicefs] Removing stale mount at $MOUNT_POINT"
    umount -l "$MOUNT_POINT" || true
fi
mkdir -p "$MOUNT_POINT"

echo "[juicefs] Mounting at $MOUNT_POINT"
exec juicefs mount \
    --cache-dir /var/jfsCache \
    --cache-size "${JFS_CACHE_SIZE_MIB:-10240}" \
    --backup-meta "${JFS_BACKUP_META:-1h}" \
    "$META_URL" "$MOUNT_POINT"
