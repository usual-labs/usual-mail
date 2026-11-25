// What `usual-mail doctor` says to do about an inbox that needs attention, by why it does (0.1.2).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Inbox, InboxStatusReason } from "@usualmail/core";
import { attentionFix } from "../src/commands/doctor.ts";

const inbox = (provider: "imap" | "gmail", statusReason?: InboxStatusReason) =>
  ({ name: "Acme", provider, status: "needs_attention", ...(statusReason && { statusReason }) }) as Inbox;

test("each reason names the step that fits; no reason, from an older server, the old advice", () => {
  assert.equal(attentionFix(inbox("imap", "needs_sign_in")), 'Give the new password: `usual-mail inbox reconnect "Acme"`.');
  // `inbox reconnect` signs a Gmail inbox in with Google again, whichever way it was connected.
  assert.match(attentionFix(inbox("gmail", "needs_sign_in")), /^`usual-mail inbox reconnect "Acme"` signs it in with Google again in your browser/);
  assert.match(attentionFix(inbox("gmail", "host_setup")), /`usual-mail google set --file <it>`/);
  // The host's setup is also the Gmail API off in its client's project: turning it on is the step then.
  assert.match(attentionFix(inbox("gmail", "host_setup")), /when the words above say the Gmail API is off, turn it on in that client's Google Cloud project/);
  assert.match(attentionFix(inbox("imap", "provider_error")), /^The provider kept failing: once it answers, `usual-mail inbox sync "Acme"`/);
  assert.match(attentionFix(inbox("imap", "not_syncing")), /`usual-mail stop` and `usual-mail start`/);
  assert.match(attentionFix(inbox("imap")), /^Fix what it says, then run `usual-mail inbox sync "Acme"`\. A changed password/);
});

test("for a server this command doesn't run (Cloudflare, say), the host's own way", () => {
  const host = attentionFix(inbox("gmail", "host_setup"), false);
  assert.doesNotMatch(host, /google set/);
  assert.match(host, /on Cloudflare, the Worker's secrets USUAL_MAIL_GOOGLE_CLIENT_ID and USUAL_MAIL_GOOGLE_CLIENT_SECRET/);
  assert.match(host, /turns on the Gmail API in that client's Google Cloud project when they say it is off/);
  assert.match(attentionFix(inbox("imap", "not_syncing"), false), /restart the server where it runs\.$/);
});
