# Server: the owner's password

Built 2026-11-24 at the owner's request ("I think we need to handle it better… they sign up and set a password"),
on the `ios-ui-tweaks` branch. The contract is [contract.md](../contract.md#the-owners-password); the rest of the
server is in [server.md](server.md), the Cloudflare host in [server-cloudflare-access.md](server-cloudflare-access.md).
Reviewed for security by a separate agent after it shipped on `main` (`09675db`); its findings were fixed on
2026-11-24 ([After the security review](#after-the-security-review)). Never run against a real deploy or a real Google
account.

## Decided by the owner (2026-11-24)

- The dashboard at the server's address is where the owner signs up (a password, an email optional) and signs in.
- **The first visitor owns an unclaimed server**, unless the host sets `USUAL_MAIL_OWNER_EMAIL`, when only Google's
  proof of that address claims it. Asked about the claim window (scanners read Certificate Transparency logs and reach
  new hostnames within minutes; the coordinator's warning), the owner chose "first visitor + email prompt": the deploy
  files ask for the email (Render's `sync: false`, Coolify's and Caddy's compose variables), and the docs say to set it
  first. Cloudflare's Deploy form can't ask for it without making it required (server-cloudflare.md, check (c)), so
  there it is a Worker variable set by hand.
- No Better Auth: the owner's sessions are paired devices, as before.
- Apps sign in with the address and the password too.

## What is built

- **`service/owner.ts`**: `ownerInfo` (`ServerInfo.owner`), `claimOwner`, `signInOwner`, `getOwner`, `setOwnerPassword`,
  `ownerEmailSetting`. Claimable means nobody has used the server: no password, no device row at all (`everPaired`,
  revoked ones included), no inbox. One-way: a server paired before this build (the owner's own) can't be claimed even
  after every device is revoked; it gets a password from a signed-in device, and the owner's code is the way back in.
  A claim and a sign-in pair the device as a person's through `devices.addDevice` (one batch with the owner's row). A
  claim ends every unused person code in that batch (`expirePersonCodes`: while none is paired those are all owner's
  codes), drops the waiting owner's code and logs `This server now has an owner, claimed from the device "<name>".`
  (the name JSON-quoted); a sign-in while no person's device is paired ends them too and drops whatever code waited.
  Setting the password logs one line too.
- **`service/password.ts`**: PBKDF2-SHA256 through WebCrypto, 16-byte salt, 100,000 iterations (Workers' cap), stored
  as `pbkdf2-sha256$100000$<salt>$<hash>`; NFKC before hashing and comparing; constant-time compare; 12 to 256
  characters (`OWNER_PASSWORD_MIN`/`MAX` in core).
- **`db/schema.ts` `owner`, migration `0020_owner.sql`**: one row, id 1: `email`, `password_hash`, `password_set_at`,
  `created_at`. Empty after the upgrade.
- **The limit:** `devices.checkPairingLimit` and `countPairingFailure` over `service/attempts.ts`, shared by wrong
  pairing codes and wrong passwords: ten from one client address (an IPv6 address by its /64) in ten minutes, then
  `rate_limited` for that address ("from your address"); a hundred from everyone, then for everyone ("from everyone
  together"). The address comes from `Host.clientAddress` ([server.md](server.md), "Wrong codes and passwords are
  counted per client address"). Claims aren't counted (a proof is 256 bits).
- **Recovery codes** (`devices.requestRecoveryCode`): a person code of 30 minutes, told to the owner's code's listener
  with `kind: "recovery"`; the keeper now holds `kind` and `expiresAt`. A recovery code stays while another person's
  code is used (`keepOwnerCodeCurrent(ctx, used)` drops it only when it is the code used) and is dropped (the listener
  hears null) when it expires; an expiring owner's code once a person paired is dropped the same way (before, its
  timer made nothing and told nothing). While no person's device is paired the request answers the owner's code's
  expiry and makes nothing. A restart forgets a waiting recovery code's place (the host hears null), though the code
  stays valid in the store until it expires.
- **`google/owner-claim.ts`**: `startOwnerClaim` (no caller; at most three waiting per client address and a hundred in
  all, `rate_limited` until the oldest expires; no `login_hint`, so the answer, which anyone may ask for, never holds
  the owner email),
  `finishOwnerClaim` (from `finishGoogleSignIn` for an entry with `claim`), `claimPage` (303 to
  `DASHBOARD_PATHS.claim` with the proof, once), `claimProof` (used only when the claim goes ahead). `oauth.ts` gained
  the `identity` purpose (`openid email`, `select_account`, no offline access), `idToken` in the exchange, and
  `verifiedEmail` (issuer, audience, expiry, `email_verified`; no signature check, as OIDC allows for a token taken
  straight from the token endpoint).
- **REST** (`rest/app.ts`): the six routes; the no-token ones take pairing's 16 KiB body limit; the callback turns a
  page with `redirect` into a 303 with `referrer-policy: no-referrer` and `cache-control: no-store`.
- **Hosts:** Node reads `USUAL_MAIL_OWNER_EMAIL` (refuses to start on one that isn't an address) and prints a
  recovery code once, as it prints the owner's code, writing it to the same file. Cloudflare reads it from the Worker's
  variables or secrets (one that isn't an address is logged and keeps claiming closed), writes a recovery code to
  `owner_pairing_code` and logs only that one waits; `requests.ts` counts `POST /v1/owner/sign-in` and
  `/v1/owner/claim` and the dashboard's `POST /claim` per address with pairing.

## After the security review

The review (2026-11-24, a separate agent, against `09675db` on Node and in workerd) found, and the branch
`owner-claim-fix` fixed:

1. **High: a server in use could be claimed again.** Claimable was "no password and no person's device paired", and
   `personPaired` ignores revoked devices: on a server without a password (every upgraded v0.1.0 server, any paired
   with `usual-mail init`), revoking the last person's device (the dashboard's "Sign out", an app's "Disconnect")
   opened it to anyone, mail included. Now claimable is one-way, decided from rows every server already has: no
   device row ever (devices are revoked, never deleted), no inbox, no password. Chosen over writing an owner row at the
   first pairing because it needs no migration (0020 has shipped; a backfill would be one more forward-only file run
   on both hosts) and holds for devices paired any way (`pair`, a claim, a sign-in), on both hosts, with nothing to
   keep in step. What it relies on: no code deletes a device row (`everPaired`'s comment says so).
2. **Medium: anyone could lock the owner out of new sign-ins.** Node's ten-in-ten-minutes was global; on Cloudflare
   one IPv4 address and one IPv6 /64 beat the door's five per address and reached it. Now counted per address on both
   hosts, under a ceiling of a hundred; Node takes the socket's address, or behind `USUAL_MAIL_TRUSTED_PROXIES` the
   right-most untrusted `X-Forwarded-For` entry.
3. The deploy guide said nothing of the owner's was there after someone else claimed first; a claimer can leave an AI
   key or a Google client behind, so the docs now say to wipe and redeploy, or check both.
4. The owner's code still paired for up to a day after a claim (its row stayed valid); now ended in the claim's batch.
5. Cloudflare's claim window was described as "before you first open its address"; it runs from the deploy until the
   owner email is set, whoever opens it.
6. `POST /v1/owner/claim/google` returned the owner email to anyone through `login_hint`; removed.
7. Twenty anonymous starts blocked the Google claim for ten minutes; now capped per address too.
8. Control characters in a device's name reached the log; `line()` refuses them (C0, DEL, C1, U+2028, U+2029) and the
   claim's log line quotes the name. A teach prompt turns them into spaces in a sender's name, and offers no list-id
   match that holds one, so its rule still passes `line()`.

Left as it is: `PUT /v1/owner/password` doesn't ask for the current password (improvement-ideas.md; the apps call
it); the apps sending the password over plain HTTP on a LAN is the apps' to fix.

## Tests

`test/owner-password.test.ts` (13): claiming, the pre-password server, sign-in and a new password, the shared limit,
agents refused, recovery codes (one at a time, kept through another code's use, dropped on use and expiry), the owner
email through Google (refused account, unverified email, expired proof, no Google), PBKDF2 and NFKC, `verifiedEmail`,
`ownerEmailSetting`, and the routes over HTTP. `test/rest.test.ts`'s info answer gained `owner`. Cloudflare
(`test/cloudflare/pairing.test.ts`, 9): the sign-in page with `?with=code`, the 429 words, a recovery code only in the
table (not the answer, not the log) and used once, and wrong passwords counted per address with wrong codes.

After the review: `test/owner-claim-safety.test.ts` (14: pair or claim then sign out, an upgraded server with only
revoked devices, an inbox alone, the same over REST; ten per address, IPv6 by /64, the reviewer's IPv4 plus /64, the
hundred; the owner's code after a claim and after a sign-in, a person's code kept; no owner email in the claim's
start; the claim caps; one-line names and the quoted log line), `test/client-address.test.ts` (4: keys, ranges,
`X-Forwarded-For` only from a trusted proxy, Node's per-request client); the shared harness is
`test/owner-helpers.ts`. In workerd, `test/cloudflare/owner.test.ts` (5) and `pairing.test.ts`'s IPv6 test rewritten
(it had asserted the global lock).

Checks run 2026-11-24, before the review: `npm test` in `server/` (1,028, all passing after `rest.test.ts`'s info answer was updated),
`npm run check:cloudflare` (84 with the two new; type checks clean), `core`'s check, the dashboard's check (169), MCP's
check (134).

## Not done

- The `usual-mail` command pairs with a code only (`init` unchanged).
- Passkeys, two-factor, several people; ending other sessions when the password changes.
- No test drives Google's real sign-in with the identity scope; `FakeGoogle` (mail/testing) issues no ID token, so the
  claim tests use their own token endpoint.
