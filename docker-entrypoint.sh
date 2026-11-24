#!/bin/sh
# The image's entry point: runs the server (or any command given) as the unprivileged `node` user (uid 1000).
#
# Started as root, the image's default, it makes sure `node` owns the data folder's contents, then drops to `node`
# with setpriv. Who owns the folder itself decides:
# - root (Railway's volumes, a disk made by root, a bind mount of a folder made by root): the folder becomes
#   `node`'s, and then as below, but only when it is new (empty, or holding only lost+found) or already holds the
#   server's data (usual-mail.db or secret.key). Anything else is left alone and the container stops with a line
#   saying so: a mistaken mount (-v /srv:/data) must not take another service's files;
# - `node` (a named volume, which takes the image's /data): anything in it that isn't `node`'s becomes `node`'s, such
#   as files copied in from a backup (`docker compose cp` keeps the files' own uid and group) or written from a shell
#   opened as root;
# - anyone else (a person's own folder mounted from the host): nothing is changed, and a line says to start the
#   container as that owner with --user.
# A folder on a read-only mount (`:ro`, the folder's own or one above it, or the container's own read-only filesystem
# with the folder on it) stops it with a line saying so. An ordinary start changes nothing. Started as
# another user (`docker run --user`, as `usual-mail init --mode docker` does), it changes nothing and runs the
# command as that user. Containers without the capabilities to change owners and users (`--cap-drop ALL`) must be
# started that way, `--user 1000:1000`, on a folder that is already uid 1000's.
set -eu

say() { echo "usual-mail-entrypoint: $*" >&2; }
hardened() {
  say "$1; if the container runs without the capabilities to change owners and users (--cap-drop ALL), start it as the data folder's owner instead: --user 1000:1000 (user: \"1000:1000\" in Compose)"
  exit 1
}
# Whether the folder is on a read-only mount: the one holding it, or the nearest folder above it that exists, as
# findmnt finds it (its own mount or one above it; findmnt reads /proc/mounts' escapes, so a path with spaces works).
read_only() {
  dir="$1"
  while [ ! -e "$dir" ]; do dir="$(dirname -- "$dir")"; done
  case ",$(findmnt -n -o OPTIONS -T "$dir")," in *,ro,*) return 0 ;; esac
  return 1
}

if [ "$(id -u)" = 0 ]; then
  data="${USUAL_MAIL_DATA_DIR:-/data}"
  node_uid="$(id -u node)"
  if read_only "$data"; then
    say "$data is on a read-only mount, and the server must write there; mount a folder or volume there read-write (without :ro)"
    exit 1
  fi
  mkdir -p "$data" || hardened "couldn't make $data"
  owner="$(stat -c %u "$data")"
  if [ "$owner" = 0 ]; then
    if [ ! -e "$data/usual-mail.db" ] && [ ! -e "$data/secret.key" ]; then
      other="$(find "$data" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)" || hardened "couldn't read $data"
      if [ -n "$other" ]; then
        say "$data belongs to root and holds files that aren't Usual Mail's (such as $other), so it is left as it is; mount an empty folder or volume there, or the one holding Usual Mail's data"
        exit 1
      fi
    fi
    if ! chown node:node "$data"; then
      say "couldn't give $data, which belongs to root, to node (uid $node_uid); if the container runs without the capabilities to change owners (--cap-drop ALL), give the folder to 1000:1000 first, then start it with --user 1000:1000: start it once without --cap-drop, or run chown -R 1000:1000 on the folder on the host"
      exit 1
    fi
    owner="$node_uid"
  fi
  if [ "$owner" = "$node_uid" ]; then
    find "$data" -xdev \( ! -user node -o ! -group node \) -exec chown -h node:node {} + || hardened "couldn't give the files in $data to node (uid $node_uid)"
    chmod 700 "$data" || hardened "couldn't make $data private to node"
  else
    say "$data belongs to uid $owner, not node (uid $node_uid), so it is left as it is; if the server can't write it, start the container as its owner: --user $(stat -c %u:%g "$data")"
  fi
  setpriv --reuid=node --regid=node --init-groups -- true || hardened "couldn't switch to the node user"
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
