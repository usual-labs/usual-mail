// Calls the dashboard's handler directly, as a browser would, against the fake service.
import { createDashboard } from "../src/index.ts";
import { formToken } from "../src/http/session.ts";
import { FakeService, PERSON_TOKEN, SAMPLE } from "./fake-service.ts";

export const ORIGIN = "http://localhost:8484";

export interface RequestOptions {
  /** The session token to send, or null for none. Defaults to the person's. */
  token?: string | null;
  headers?: Record<string, string>;
  origin?: string;
}

export function setup(options: { base?: string; origin?: string; ownerCodeWhere?: string } = {}) {
  const fake = new FakeService();
  const base = options.base ?? "";
  const origin = options.origin ?? ORIGIN;
  const handler = createDashboard(
    { service: fake, authenticate: fake.authenticate, basePath: base },
    { now: () => new Date(SAMPLE.now), ...(options.ownerCodeWhere !== undefined && { ownerCodeWhere: options.ownerCodeWhere }) },
  );
  const secure = new URL(origin).protocol === "https:" || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
  const sessionCookie = (token: string) => `${secure && !base ? "__Host-" : ""}usual-mail-session=${token}`;

  const headersFor = (o: RequestOptions) => {
    const headers: Record<string, string> = { accept: "text/html", ...o.headers };
    const token = o.token === undefined ? PERSON_TOKEN : o.token;
    if (token) headers.cookie = [headers.cookie, sessionCookie(token)].filter(Boolean).join("; ");
    return headers;
  };

  /** GET a dashboard path (without the base). */
  async function get(path: string, o: RequestOptions = {}): Promise<Response> {
    return handler(new Request(`${o.origin ?? origin}${base}${path}`, { headers: headersFor(o) }));
  }

  async function page(path: string, o: RequestOptions = {}): Promise<{ status: number; body: string; res: Response }> {
    const res = await get(path, o);
    return { status: res.status, body: await res.text(), res };
  }

  /**
   * POST a form as this site's own page would: same-origin fetch metadata and the session's form token, unless
   * the fields or headers say otherwise.
   */
  async function post(path: string, fields: Record<string, string | string[]> = {}, o: RequestOptions = {}): Promise<Response> {
    const token = o.token === undefined ? PERSON_TOKEN : o.token;
    const body = new URLSearchParams();
    if (!("_csrf" in fields) && token) body.append("_csrf", await formToken(token));
    for (const [name, value] of Object.entries(fields)) for (const item of [value].flat()) body.append(name, item);
    return handler(
      new Request(`${o.origin ?? origin}${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          origin: o.origin ?? origin,
          ...headersFor({ ...o, token }),
        },
        body,
      }),
    );
  }

  return { fake, handler, base, origin, get, page, post, sessionCookie };
}

/** The Set-Cookie headers of a response, by cookie name. */
export function cookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) out.set(line.slice(0, line.indexOf("=")), line);
  return out;
}

/** The value of a hidden field in a page. */
export function hiddenValue(body: string, name: string): string | undefined {
  return new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(body)?.[1];
}

/** Every path a signed-in person can open with GET, from the sample's ids. */
export const PAGES = [
  "/",
  "/inboxes",
  "/inboxes/new",
  "/inboxes/new?provider=gmail",
  "/inboxes/inb_northwind",
  "/inboxes/inb_personal",
  "/inboxes/inb_harbor/remove",
  "/ai/remove",
  "/inboxes/inb_northwind/rules",
  "/inboxes/inb_personal/rules",
  "/devices",
  "/handled",
  "/handled?inbox=inb_harbor",
  "/handled?silent=1",
  "/ai",
];

export { PERSON_TOKEN };
