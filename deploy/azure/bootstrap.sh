#!/bin/bash
set -euo pipefail
owner=$(printf '%s' '__OWNER_BASE64__' | base64 -d)
# Only a single plain address may be placed in the dotenv file.
if ! [[ "$owner" != *$'\n'* && "$owner" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo 'Enter a single owner email address.' >&2
  exit 1
fi

disk=/dev/disk/azure/scsi1/lun0
for i in $(seq 1 120); do [ -b "$disk" ] && break; sleep 2; done
test -b "$disk"
signature=$(wipefs --noheadings --output TYPE "$disk")
if [ -z "$signature" ]; then mkfs.ext4 "$disk"; fi
test "$(blkid -s TYPE -o value "$disk")" = ext4
uuid=$(blkid -s UUID -o value "$disk")
mkdir -p /var/lib/docker /opt/usual-mail
entry="UUID=$uuid /var/lib/docker ext4 defaults 0 2"
grep -qxF "$entry" /etc/fstab || echo "$entry" >> /etc/fstab
mountpoint -q /var/lib/docker || mount /var/lib/docker
test "$(findmnt -n -o UUID --mountpoint /var/lib/docker)" = "$uuid"

export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update
apt-get -o Acquire::Retries=3 install -y ca-certificates curl docker.io docker-compose-v2
cd /opt/usual-mail
umask 077
printf 'USUAL_MAIL_DOMAIN=%s\nUSUAL_MAIL_OWNER_EMAIL=%s\n' '__DOMAIN__' "$owner" > .env
release=0.1.5
curl --retry 5 -fsSLo compose.release.yaml "https://raw.githubusercontent.com/usual-labs/usual-mail/v$release/compose.caddy.yaml"
sed "s|ghcr.io/usual-labs/usual-mail:latest|ghcr.io/usual-labs/usual-mail:$release|" compose.release.yaml > compose.yaml
rm compose.release.yaml
systemctl enable --now docker
docker compose up -d --wait
