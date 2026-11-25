// What `usual-mail doctor` says to do about an inbox that needs attention, by why it does (0.1.2).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Inbox, InboxStatusReason } from "@usualmail/core";
import { attentionFix } from "../src/commands/doctor.ts";

const inbox = (provider: "imap" | "gmail", statusReason?: InboxStatusReason) =>
  ({ name: "Acme", provider, status: "needs_attention", ...(statusReason && { statusReason }) }) as Inbox;

test("each reason names the step that fits; no reason, from an older server, the old advice", () => {
  assert.equal(attentionFix(inbox("imap", "needs_sign_in")), 'Give the new password: `usual-mail inbox reconnect "Acme"`.');
  assert.match(attentionFix(inbox("gmail", "needs_sign_in")), /^Sign in with Google again from the Mac or iPhone app or the dashboard/);
  assert.match(attentionFix(inbox("gmail", "host_setup")), /`usual-mail google set --file <it>`/);
  assert.match(attentionFix(inbox("imap", "provider_error")), /^The provider kept failing: once it answers, `usual-mail inbox sync "Acme"`/);
  assert.match(attentionFix(inbox("imap", "not_syncing")), /`usual-mail stop` and `usual-mail start`/);
  assert.match(attentionFix(inbox("imap")), /^Fix what it says, then run `usual-mail inbox sync "Acme"`\. A changed password/);
});
