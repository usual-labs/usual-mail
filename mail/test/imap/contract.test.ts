/**
 * The shared provider contract, run against the IMAP provider and hoodiecrow, an in-process IMAP server
 * built for testing clients, in three shapes: a current server, a bare IMAP4rev1 one, and one that
 * refuses custom keywords. The Docker tests run the same suite against GreenMail and Dovecot.
 */
import { providerContract } from "../../src/testing/index.ts";
import { BARE, MODERN, NO_KEYWORDS, hoodiecrowHarness } from "./servers.ts";

for (const profile of [MODERN, BARE, NO_KEYWORDS]) {
  providerContract(`IMAP on hoodiecrow (${profile.name})`, () => hoodiecrowHarness(profile));
}
