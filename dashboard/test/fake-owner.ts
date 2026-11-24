// The owner's password, as the fake service answers it (docs/contract.md, "The owner's password"): claimable while
// there is no password and no person's device, by Google's proof when the host named an owner email; signing in with
// the password; the Account page's owner; recovery codes, which only say until when one waits.
import {
  OWNER_PASSWORD_MIN,
  ServiceError,
  type Caller,
  type Owner,
  type OwnerClaimInput,
  type OwnerClaimStart,
  type OwnerInfo,
  type OwnerPasswordInput,
  type OwnerSignInInput,
  type PairResult,
  type RecoveryCodeAnswer,
} from "@usualmail/core";

/** The proof a test's Google sign-in leaves. */
export const GOOD_PROOF = "proof-from-google";

export interface OwnerHost {
  call(method: string, args: unknown[]): void;
  person(caller: Caller, what: string): void;
  addPerson(name: string): PairResult;
  personPaired(): boolean;
}

export class FakeOwner {
  /** The owner's password, or null; tests set it. */
  password: string | null = null;
  email: string | null = null;
  /** "google" when the host named an owner email. */
  claim: "password" | "google" = "password";
  googleUrl = "https://accounts.google.com/o/oauth2/v2/auth?scope=openid+email&state=claim";
  recovery: RecoveryCodeAnswer = { kind: "recovery", expiresAt: "2026-11-16T10:00:00Z" };
  readonly #host: OwnerHost;

  constructor(host: OwnerHost) {
    this.#host = host;
  }

  info(): OwnerInfo {
    const claimable = this.password === null && !this.#host.personPaired();
    return { password: this.password !== null, claimable, ...(claimable && { claim: this.claim }) };
  }

  #checked(password: string): string {
    if ([...password].length < OWNER_PASSWORD_MIN) throw new ServiceError("invalid", `The password needs at least ${OWNER_PASSWORD_MIN} characters`);
    return password;
  }

  async claimOwner(input: OwnerClaimInput): Promise<PairResult> {
    this.#host.call("claimOwner", [input]);
    if (!this.info().claimable) throw new ServiceError("conflict", "This server already has an owner.");
    const password = this.#checked(input.password);
    if (this.claim === "google") {
      if (!input.proof) throw new ServiceError("forbidden", "Sign in with Google as the owner first.");
      if (input.proof !== GOOD_PROOF) throw new ServiceError("unauthorized", "That sign-in with Google is used, expired or unknown.");
      this.email = "owner@example.org";
    } else {
      this.email = input.email || null;
    }
    this.password = password;
    return this.#host.addPerson(input.name);
  }

  async startOwnerClaim(): Promise<OwnerClaimStart> {
    this.#host.call("startOwnerClaim", []);
    if (!this.info().claimable || this.claim !== "google") throw new ServiceError("conflict", "Nothing to claim with Google.");
    return { url: this.googleUrl, expiresAt: "2026-11-16T09:40:00Z" };
  }

  async signInOwner(input: OwnerSignInInput): Promise<PairResult> {
    this.#host.call("signInOwner", [input]);
    if (this.password === null) throw new ServiceError("conflict", "This server has no password yet.");
    if (input.password !== this.password) throw new ServiceError("unauthorized", "That password is wrong.");
    return this.#host.addPerson(input.name);
  }

  async owner(caller: Caller): Promise<Owner> {
    this.#host.call("owner", [caller]);
    this.#host.person(caller, "see the owner's account");
    return { email: this.email, password: this.password !== null, ...(this.password !== null && { passwordSetAt: "2026-11-16T09:30:00Z" }) };
  }

  async setOwnerPassword(caller: Caller, input: OwnerPasswordInput): Promise<Owner> {
    this.#host.call("setOwnerPassword", [caller, input]);
    this.#host.person(caller, "set the owner's password");
    this.password = this.#checked(input.password);
    return this.owner(caller);
  }

  async requestRecoveryCode(): Promise<RecoveryCodeAnswer> {
    this.#host.call("requestRecoveryCode", []);
    return structuredClone(this.recovery);
  }
}
