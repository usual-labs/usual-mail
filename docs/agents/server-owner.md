# Server: the owner's password

Built 2026-11-24 at the owner's request ("I think we need to handle it better… they sign up and set a password"),
on the `ios-ui-tweaks` branch. The contract is [contract.md](../contract.md#the-owners-password); the rest of the
server is in [server.md](server.md), the Cloudflare host in [server-cloudflare-access.md](server-cloudflare-access.md).
**Not yet reviewed for security**: the coordinator has a separate agent review it before any commit. Never run
against a real deploy or a real Google account.

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
  `ownerEmailSetting`. Claimable means no password **and** no person's device, so a server paired before this build
  (the owner's own) can't be claimed; it gets a password from a signed-in device. A claim and a sign-in pair the device
  as a person's through `devices.addDevice` (one batch with the owner's row). A claim drops the waiting owner's code and
  logs `This server now has an owner, claimed from the device "<name>".`; setting the password logs one line too.
- **`service/password.ts`**: PBKDF2-SHA256 through WebCrypto, 16-byte salt, 100,000 iterations (Workers' cap), stored
  as `pbkdf2-sha256$100000$<salt>$<hash>`; NFKC before hashing and comparing; constant-time compare; 12 to 256
  characters (`OWNER_PASSWORD_MIN`/`MAX` in core).
- **`db/schema.ts` `owner`, migration `0020_owner.sql`**: one row, id 1: `email`, `password_hash`, `password_set_at`,
  `created_at`. Empty after the upgrade.
- **The limit:** `devices.checkPairingLimit` and `countPairingFailure`, shared by wrong pairing codes and wrong
  passwords (ten in ten minutes, then `rate_limited` for everyone). Claims aren't counted (a proof is 256 bits).
- **Recovery codes** (`devices.requestRecoveryCode`): a person code of 30 minutes, told to the owner's code's listener
  with `kind: "recovery"`; the keeper now holds `kind` and `expiresAt`. A recovery code stays while another person's
  code is used (`keepOwnerCodeCurrent(ctx, used)` drops it only when it is the code used) and is dropped (the listener
  hears null) when it expires; an expiring owner's code once a person paired is dropped the same way (before, its
  timer made nothing and told nothing). While no person's device is paired the request answers the owner's code's
  expiry and makes nothing. A restart forgets a waiting recovery code's place (the host hears null), though the code
  stays valid in the store until it expires.
- **`google/owner-claim.ts`**: `startOwnerClaim` (no caller; at most 20 waiting; `login_hint` the owner email),
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

## Tests

`test/owner-password.test.ts` (13): claiming, the pre-password server, sign-in and a new password, the shared limit,
agents refused, recovery codes (one at a time, kept through another code's use, dropped on use and expiry), the owner
email through Google (refused account, unverified email, expired proof, no Google), PBKDF2 and NFKC, `verifiedEmail`,
`ownerEmailSetting`, and the routes over HTTP. `test/rest.test.ts`'s info answer gained `owner`. Cloudflare
(`test/cloudflare/pairing.test.ts`, 9): the sign-in page with `?with=code`, the 429 words, a recovery code only in the
table (not the answer, not the log) and used once, and wrong passwords counted per address with wrong codes.

Checks run 2026-11-24: `npm test` in `server/` (1,028, all passing after `rest.test.ts`'s info answer was updated),
`npm run check:cloudflare` (84 with the two new; type checks clean), `core`'s check, the dashboard's check (169), MCP's
check (134).

## Not done

- The `usual-mail` command pairs with a code only (`init` unchanged).
- Passkeys, two-factor, several people; ending other sessions when the password changes.
- No test drives Google's real sign-in with the identity scope; `FakeGoogle` (mail/testing) issues no ID token, so the
  claim tests use their own token endpoint.
