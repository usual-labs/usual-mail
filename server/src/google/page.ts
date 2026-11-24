// The small page Google sends the person's browser back to. The dashboard's safety, without the dashboard: every
// string escaped, no script, nothing loaded, no form, no referrer, never cached or framed. It shows only the server's
// own words (and a mailbox's address, escaped), never the code, the state, a token or anything Google wrote.

const STYLE =
  "body{font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;margin:0;padding:12vh 16px}" +
  "main{max-width:34em;margin:0 auto}h1{font-size:1.4em;margin:0 0 .5em}";

let styleHash: Promise<string> | undefined;

/** The CSP source for the one inline style block. */
function styleSource(): Promise<string> {
  styleHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)).then((digest) => {
    let binary = "";
    for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
    return `'sha256-${btoa(binary)}'`;
  });
  return styleHash;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** The page, with its status and strict headers. */
export async function signInPage(input: { status: number; title: string; message: string }): Promise<Response> {
  const html =
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<meta name=\"color-scheme\" content=\"light dark\"><meta name=\"referrer\" content=\"no-referrer\">" +
    `<title>${escapeHtml(input.title)} · Usual Mail</title><style>${STYLE}</style></head>` +
    `<body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p></main></body></html>`;
  return new Response(html, {
    status: input.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        `default-src 'none'; style-src ${await styleSource()}; script-src 'none'; img-src 'none'; connect-src 'none'; ` +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "same-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      "cache-control": "no-store",
    },
  });
}
