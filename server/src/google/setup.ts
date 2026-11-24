// Setting up the host's Google client from a person's own paired device (docs/contract-sync.md, "Connecting Gmail by
// signing in with Google"; the owner's decision of 2026-11-21): the guided set-up with core's words
// (`GET /v1/google/setup`), and giving the server its client (`PUT /v1/google/client`), kept through the host's seam
// (`GoogleOptions.saveClient`). Never an agent. No answer, event or log line ever holds the secret or the file sent:
// every refusal is the server's own sentence.
//
// A client is replaced only when the device confirms (`replace`): whenever a client file is saved, used or refused
// (it may hold the client some inboxes are connected with), and whenever inboxes were connected by signing in with
// Google under another client id than the one given (for example while the environment gave the client, which the
// host then removed). Either way those inboxes stop syncing until each signs in again.

import {
  GOOGLE_CLIENT_FILE_MAX_BYTES,
  googleRedirectHint,
  googleSetup as setupWith,
  readGoogleClientFile,
  ServiceError,
  type Caller,
  type GoogleClientInput,
  type GoogleClientSaved,
  type GoogleClientState,
  type GoogleSetup,
} from "@usualmail/core";
import { inboxes } from "../db/index.ts";
import { requirePerson } from "../service/access.ts";
import type { Ctx } from "../service/context.ts";
import { errorMessage } from "../util.ts";
import type { SavedGoogleClient } from "./config.ts";
import { googleSignInInfo } from "./sign-in.ts";
import { clientWords } from "./words.ts";

/** The prompt, the steps, what is missing, and the client as a person's device sees it. */
export async function googleSetup(ctx: Ctx, caller: Caller): Promise<GoogleSetup> {
  requirePerson(caller, "set up Google sign-in");
  const addressFix = ctx.google?.addressFix;
  return setupWith(await googleSignInInfo(ctx), await clientState(ctx), addressFix === undefined ? {} : { addressFix });
}

/**
 * Saves the client a person's device gave, the file as it is, where the host keeps it. Refused while the environment
 * gives the client or the host keeps none, for a file that isn't a Web application client's, and, unless `replace`,
 * while a client is saved (used or not) or inboxes are signed in with another client.
 */
export async function setGoogleClient(ctx: Ctx, caller: Caller, input: GoogleClientInput): Promise<GoogleClientSaved> {
  requirePerson(caller, "give the server its Google client");
  const reason = unchangeable(ctx);
  if (reason !== null) throw new ServiceError("conflict", `${reason} ${clientWords.notSavedYet}`);
  const file = typeof input?.file === "string" ? input.file : "";
  if (new TextEncoder().encode(file).length > GOOGLE_CLIENT_FILE_MAX_BYTES) throw new ServiceError("invalid", clientWords.tooLarge);
  if (input.replace !== undefined && typeof input.replace !== "boolean") throw new ServiceError("invalid", clientWords.replaceFlag);
  const read = readGoogleClientFile(file);
  if ("problem" in read) throw new ServiceError("invalid", clientWords[read.problem]);
  const given = read.client.clientId;
  const google = ctx.google!;
  return ctx.lock.run(async () => {
    const saved = await savedClient(ctx);
    const stranded = (await signedInClients(ctx)).filter((inbox) => inbox.clientId !== given);
    if (input.replace !== true) {
      if (saved.state === "usable") throw new ServiceError("conflict", saved.clientId === given ? clientWords.sameClient : clientWords.otherClient);
      if (saved.state === "refused") throw new ServiceError("conflict", clientWords.refusedFile(saved.reason));
      if (stranded.length) throw new ServiceError("conflict", clientWords.stranded(stranded.length, idsOf(stranded)));
    }
    try {
      await google.saveClient!(file);
    } catch (error) {
      ctx.host.log.error("Couldn't save the Google client a person's device gave", errorMessage(error));
      throw new ServiceError("internal", clientWords.notSaved);
    }
    const replaced = saved.state !== "none" || stranded.length > 0;
    ctx.host.log.info(`Google sign-in: a person's device ${replaced ? "replaced the server's Google client" : "gave the server its Google client"}.`);
    const googleSignIn = await googleSignInInfo(ctx);
    const redirect = googleSignIn.redirectUri;
    const unlisted = redirect !== undefined && read.client.redirectUris !== null && !read.client.redirectUris.includes(redirect);
    return {
      clientId: given,
      replaced,
      googleSignIn,
      ...(unlisted && { redirectHint: googleRedirectHint("The client file", redirect) }),
    };
  });
}

/** Where the client comes from, its id, whether a device may give one now, and what needs saying first. */
async function clientState(ctx: Ctx): Promise<GoogleClientState> {
  const client = (await ctx.google?.client()) ?? null;
  const reason = unchangeable(ctx);
  const notes: string[] = [];
  if (!ctx.google?.clientFromEnvironment) {
    const saved = await savedClient(ctx);
    if (saved.state === "refused") notes.push(clientWords.refusedFileNote(saved.reason));
  }
  const stranded = (await signedInClients(ctx)).filter((inbox) => inbox.clientId !== client?.clientId);
  if (stranded.length) notes.push(clientWords.strandedNote(stranded.length, idsOf(stranded)));
  return {
    source: ctx.google?.clientFromEnvironment ? "environment" : client ? "saved" : "none",
    ...(client && { clientId: client.clientId }),
    changeable: reason === null,
    ...(reason !== null && { reason }),
    ...(notes.length && { note: notes.join(" ") }),
  };
}

/** Why a device can't give the server a client, or null when it can. */
function unchangeable(ctx: Ctx): string | null {
  if (ctx.google?.clientFromEnvironment) return clientWords.environment;
  if (!ctx.google?.saveClient) return clientWords.notKept;
  return null;
}

/** What is saved, used or not. A host that can't tell says what `client()` gives. */
async function savedClient(ctx: Ctx): Promise<SavedGoogleClient> {
  const google = ctx.google;
  if (google?.savedClient) return google.savedClient();
  const client = (await google?.client()) ?? null;
  return client ? { state: "usable", clientId: client.clientId } : { state: "none" };
}

/** Every inbox connected by signing in with Google, with the client id it was connected with (its `connection`). */
async function signedInClients(ctx: Ctx): Promise<Array<{ id: string; clientId: string }>> {
  const rows = await ctx.db.select({ id: inboxes.id, connection: inboxes.connection }).from(inboxes);
  return rows.flatMap((row) =>
    row.connection?.kind === "gmail" && row.connection.signIn === "google" ? [{ id: row.id, clientId: row.connection.clientId }] : []);
}

function idsOf(list: Array<{ clientId: string }>): string[] {
  return [...new Set(list.map((inbox) => inbox.clientId))];
}
