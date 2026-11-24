# Setting up Sign in with Google for Gmail

For whoever runs a Usual Mail server (the host). With this set up, a person connects their Gmail by signing in with
Google in their browser, as in other mail apps, instead of pasting a client id, secret and refresh token. The server
receives Google's answer itself and keeps the access sealed.

**Status, 2026-11-17: tested against a fake of Google's endpoints, and signed in once with a real Google account**
(the maintainer's own Gmail, on their own server; it worked). The steps below follow Google's documentation as read on
2026-11-17 (sources at the end); Google's console changes its wording from time to time.

You create one Google OAuth client, in your own Google Cloud project, and give it to your server. It belongs to you
as the host: your server uses it for every Gmail inbox connected this way.

## 1. At Google Cloud

To have your own AI agent that controls your browser do this section's clicking for you, see
[Setting up the Google client with a browser agent](google-setup-agent.md): a prompt to give it, not yet run from start
to finish as written. `usual-mail google prompt` prints that prompt with your server's redirect address filled in.

In the Google Cloud console (console.cloud.google.com), signed in with your own Google account:

1. **A project.** Create a new project, for example "Usual Mail".
2. **The Gmail API.** In APIs and services, Library, find "Gmail API" and enable it.
3. **The consent screen** (Google Auth Platform, called the OAuth consent screen before):
   - Branding: an app name you will recognise, for example "Usual Mail (mine)", and your email address where asked.
   - Audience: user type **External**, publishing status **Testing**. Under test users, add every Gmail address you
     will connect (up to 100). With a Google Workspace account you may choose Internal instead: then only your
     organisation's accounts can sign in, there are no test users, and the weekly sign-in below doesn't apply.
   - Data access: add the one scope `https://www.googleapis.com/auth/gmail.modify` (read, compose and send email,
     never delete it for good). Nothing else: the server learns the mailbox's address from Gmail itself, so it needs
     no `email` or `openid` scope.
4. **The client.** In Clients, create an OAuth client:
   - Application type: **Web application** (not Desktop app).
   - Authorized redirect URIs: exactly the address your server prints for it, which is
     `http://127.0.0.1:<port>/v1/google/callback` for a server on your own Mac. With `usual-mail init`'s default port
     that is `http://127.0.0.1:8484/v1/google/callback`; on port 8585 it is
     `http://127.0.0.1:8585/v1/google/callback`. `usual-mail google` prints your server's own. It must match to the
     character: `127.0.0.1`, not `localhost`; `http`, not `https`; no slash at the end. A server on Cloudflare uses
     `https://<its workers.dev address or custom domain>/v1/google/callback` (never tried at Google:
     [On Cloudflare](self-hosting.md#google-sign-in-on-cloudflare)).
   - No authorized JavaScript origins are needed.
   - Create it, and **download its JSON** when Google offers it (a file named like `client_secret_….json`). Google may
     not show the secret again later; if you lose it, add a new secret to the client.

## 2. Give it to your server

The client reaches the server through a file in its data directory, the environment, or one of your own paired apps,
and the server never shows the secret. A server on Cloudflare has no data directory: give it the client from the
apps, or set the two variables below as the Worker's secrets.

- **From the apps** (the Mac app and the iPhone app; built 2026-11-21, seen only at rest, on the Mac): while the
  server has no Google client, the app shows a guided set-up where **Sign in with Google** would be (its **Connect
  your Gmail** step, **Add a Gmail account**, and **Sign in with Google again** in **Settings** and in search): the browser
  agent's prompt to copy, or these steps by hand, then the downloaded file, chosen with **Choose file…** (on the Mac
  you can also drop it there). The app hands the server the file as it is (`PUT /v1/google/client`), which saves it
  as `google-client.json` in its data directory, as the command does. The server replaces only once you confirm with
  **Replace it**: a client file already there (even one it doesn't use, because others can read it or it isn't a Web
  application client's), or a client that inboxes were signed in with (for example while the environment gave it),
  since another client stops those inboxes until each signs in with Google again. If a client reaches the server
  another way meanwhile, the app sees it when it comes back to the front and shows **Sign in with Google** instead.
- **With the command** (when `usual-mail init` set the server up on this machine):

  ```
  usual-mail google set --file ~/Downloads/client_secret_….json
  ```

  It copies the file as it is to `<data-dir>/google-client.json` (by default `~/.local/share/usual-mail/google-client.json`),
  readable only by you, and checks the client is a web application. It replaces a client file already there without
  asking. Without the file, `usual-mail google set` asks
  for the id and the secret (the secret unseen). Pass `--data-dir` for a server whose data directory the command
  doesn't know.
- **By hand:** save the downloaded file as `google-client.json` in the server's data directory and run
  `chmod 600` on it. The server refuses a file other users can read.
- **Or the environment:** `USUAL_MAIL_GOOGLE_CLIENT_ID` and `USUAL_MAIL_GOOGLE_CLIENT_SECRET`, both, where the server
  starts. They win over the file.

The server reads the file whenever it needs it, so no restart is needed. Check with `usual-mail google` or
`usual-mail doctor`: it says "Google sign-in is available" and the redirect address Google sends people back to.

**A file older than a change at Google.** The file is the client as it was when you downloaded it. If you added or
changed the redirect address at Google afterwards, the file doesn't list it, and `usual-mail google`, `usual-mail
doctor` and the server's log say so, as a hint: the file may simply be older than the change, and Google's own list
for the client is what counts. Nothing is wrong while sign-ins work. If Google refuses a sign-in (its page says
`redirect_uri_mismatch`), check that address in the client at Google. Downloading the file again makes the hint go.

A server that listens on every address (in Docker, or for other devices) doesn't know its own name: give it
`USUAL_MAIL_PUBLIC_URL` (or `--public-url`), the address people reach it at, HTTPS unless it is this machine, and
register that address followed by `/v1/google/callback` at Google. `usual-mail init --mode docker` does this for you
with `http://127.0.0.1:<port>`.

## 3. Connect Gmail

From the Mac app (**Sign in with Google** on its **Connect your Gmail** step, or **Add Gmail…** in **Settings**), the
dashboard's Gmail page, or:

```
usual-mail inbox add --provider gmail
```

Your browser opens Google's sign-in (`--no-browser` prints the address instead). What you see at Google:

1. The account chooser: choose the Gmail account to connect.
2. A warning that Google hasn't verified the app. Your own client in Testing isn't verified; as one of its test
   users you can continue past it.
3. Google's consent screen, with "Read, compose, and send emails from your Gmail account" (Google may show a box to
   tick for it: tick it). Continue.
4. A page from your own server: "Gmail is connected", or what went wrong and what to do. Go back to Usual Mail.

The browser must reach the redirect address: with `http://127.0.0.1:…`, sign in from a browser on the server's own
machine.

## 4. Every week, while in Testing

While the consent screen is in Testing, Google ends each sign-in after seven days. The inbox then shows that it needs
attention: "Google no longer accepts this inbox's sign-in … Sign in with Google again". Sign in again in place, with
**Sign in with Google again…** on the inbox in the Mac app's **Settings**, the inbox's page in the dashboard, or
`usual-mail inbox reconnect <inbox>`. Its rules, history and settings stay. The same happens if you revoke the access in your Google Account or change the account's
password.

Moving the app to In production ends the weekly sign-in. Unverified, it keeps showing the warning, and at most 100
people can ever sign in to it.

## "Access blocked … Error 403: access_denied"

Google answers a sign-in with "Access blocked: … has not completed the Google verification process … can only be
accessed by developer-approved testers" when the client is in Testing and the account isn't one of its test users.
Two ways out, in Google Auth Platform:

- **Add the account as a test user** (Audience, Test users, Add users). It can sign in at once; the weekly sign-in
  above applies.
- **Publish the app** (Audience, Publish app). Google allows it only once Branding has an application home page, a
  privacy policy link and a terms of service link, each on an authorized domain you list there; until then the
  button is greyed out with "To publish your app, you must complete your configuration on the Branding page". Its
  dialog, "Push to production?", says the app becomes available to any Google Account and that an app with a
  restricted scope will need to be submitted for verification. After confirming, the Audience page says "Your app
  requires verification" and offers **Back to testing**. Without that review anyone can sign in, past the
  unverified-app warning, up to the 100-account cap, which Google says can never be reset.

A Google Workspace account can also be blocked by its own administrator ("admin_policy_enforced"): the Workspace
admin allows the app in the Admin console, Security, API controls, App access control.

## Google's rules

- Reading and changing Gmail (`gmail.modify`) is one of Google's **restricted** scopes.
- Until Google verifies the app, Google warns before anyone signs in. An app only you, or a few people you know, use
  doesn't need verification (Google's "personal use" exception).
- In Testing: only the test users you list, up to 100, and each sign-in lasts seven days.
- A server hosted for other people needs Google's verification and, for a restricted scope, a security assessment by
  an assessor Google names, repeated at least every 12 months.

## Good to know

- Removing an inbox connected this way revokes its access at Google. Google ends the whole grant of that account to
  your client: if the same account is also connected through the same client on another server, that one stops too.
- Google keeps at most 100 live sign-ins per account and client; each sign-in makes a new one, and the oldest stop
  working beyond that.
- An inbox connected by pasting a client id, secret and refresh token keeps working as before, and can be signed in
  again with Google in place.

## Sources (read 2026-11-17)

- Google for Developers: "Using OAuth 2.0 for Web Server Applications"; "OAuth 2.0 for Mobile and Desktop Apps";
  "Using OAuth 2.0 to Access Google APIs" (refresh token expiry, the 100-token limit); "OpenID Connect" (the
  discovery document lists PKCE `S256`); "Choose Gmail API scopes"; `users.getProfile`; "Restricted scope
  verification".
- Google Cloud Help: "Unverified apps"; "Manage App Audience".
