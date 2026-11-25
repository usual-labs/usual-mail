// How a refused IMAP login reads to the server (0.1.2): a wrong password is core's SIGN_IN_REFUSED, needing the person
// at once; a login the server says it can't do just now (RFC 5530's UNAVAILABLE, INUSE, LIMIT, SERVERBUG, or
// Exchange's "authenticated but not connected") is a failure that may pass, which imapflow marks the same way.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIGN_IN_REFUSED } from "@usualmail/core";
import { readableError } from "../../src/imap/connection.ts";

describe("a refused IMAP login", () => {
  it("is a refused sign-in for a wrong password", () => {
    const error = readableError(
      { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED", responseText: "Authentication failed." },
      "imap.acme.example",
    );
    assert.equal(error.name, SIGN_IN_REFUSED);
    assert.equal(error.message, "The IMAP server at imap.acme.example refused the user name or password.");
  });

  it("may pass when the server says it can't sign anyone in just now", () => {
    for (const code of ["UNAVAILABLE", "INUSE", "LIMIT", "SERVERBUG", "unavailable"]) {
      const error = readableError({ authenticationFailed: true, serverResponseCode: code }, "imap.acme.example");
      assert.notEqual(error.name, SIGN_IN_REFUSED, code);
      assert.match(error.message, /^The IMAP server at imap\.acme\.example can't sign in just now: /);
    }
    const exchange = readableError(
      { authenticationFailed: true, responseText: "User is authenticated but not connected." },
      "outlook.acme.example",
    );
    assert.notEqual(exchange.name, SIGN_IN_REFUSED);
    assert.equal(
      exchange.message,
      "The IMAP server at outlook.acme.example can't sign in just now: User is authenticated but not connected.",
    );
  });
});
