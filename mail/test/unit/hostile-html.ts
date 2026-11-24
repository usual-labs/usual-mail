/**
 * Hostile mail HTML and the check every sanitized output must pass, shared by the sanitizer's tests and the
 * picture pass's tests. The check parses the output again and fails on anything outside the allow-list.
 */
import assert from "node:assert/strict";
import { Parser } from "htmlparser2";

export const HOSTILE = [
  `<script>alert(1)</script>`,
  `<SCRIPT SRC=https://evil.example/x.js></SCRIPT>`,
  `<img src=x onerror=alert(1)>`,
  `<IMG SRC="javascript:alert(1)">`,
  `<a href="javascript:alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<a href="&#106;avascript:alert(1)">x</a>`,
  `<a href="&#x6A;avascript&#x3A;alert(1)">x</a>`,
  `<a href="&#0000106&#0000097vascript:alert(1)">x</a>`,
  `<a href="java\tscript:alert(1)">x</a>`,
  `<a href="java&#9;script:alert(1)">x</a>`,
  `<a href="  javascript:alert(1)">x</a>`,
  `<a href="\u0001javascript:alert(1)">x</a>`,
  `<a href="javascript&colon;alert(1)">x</a>`,
  `<a href="vbscript:msgbox(1)">x</a>`,
  `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`,
  `<a href="https://ok.example" onclick="alert(1)" target="_blank">x</a>`,
  `<P ONCLICK="alert(1)" OnMouseOver="alert(2)">x</P>`,
  `<iframe src="https://evil.example"></iframe>`,
  `<iframe srcdoc="<script>alert(1)</script>"></iframe>`,
  `<frameset><frame src="https://evil.example"></frameset>`,
  `<object data="https://evil.example/x.swf"></object>`,
  `<embed src="https://evil.example/x.swf">`,
  `<applet code="x.class"></applet>`,
  `<form action="https://evil.example"><input name="password" type="password"><button formaction="javascript:alert(1)">Go</button></form>`,
  `<select><option>x</option></select><textarea>t</textarea>`,
  `<svg onload=alert(1)><circle r=1></circle></svg>`,
  `<svg><script>alert(1)</script></svg>`,
  `<svg><style><img src=x onerror=alert(1)></style></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>`,
  `<template><img src=x onerror=alert(1)></template>`,
  `<xmp><img src=x onerror=alert(1)></xmp>`,
  `<noembed><img src=x onerror=alert(1)></noembed>`,
  `<!-- <img src=x onerror=alert(1)> -->`,
  `<![CDATA[<img src=x onerror=alert(1)>]]>`,
  `<p title='"><script>alert(1)</script>'>x</p>`,
  `<link rel="stylesheet" href="https://evil.example/x.css">`,
  `<base href="https://evil.example/">`,
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
  `<style>@import 'https://evil.example/x.css'; p{color:red}</style>`,
  `<style>@import url("https://evil.example/x.css");</style>`,
  `<style>body{background:url("javascript:alert(1)")}</style>`,
  `<style>body{behavior:url(x.htc);-moz-binding:url(https://evil.example/x.xml#x)}</style>`,
  `<style>a{content:"</style><script>alert(1)</script>"}</style>`,
  `<style>a{}</stylex><script>alert(1)</script></style>`,
  `<style>@media all{a{background:url(javascript:alert(1))}}</style>`,
  `<style>@-moz-document url-prefix(){a{color:red}}</style>`,
  `<div style="background:url(javascript:alert(1))">x</div>`,
  `<div style="background:url(&quot;javascript:alert(1)&quot;)">x</div>`,
  `<div style="background:url(\\6a avascript:alert(1))">x</div>`,
  `<div style="width: expression(alert(1))">x</div>`,
  `<div style="behavior: url(x.htc)">x</div>`,
  `<div style="color:red} body {background:url(https://evil.example/x)">x</div>`,
  `<table background="javascript:alert(1)"><tr><td background="vbscript:x">x</td></tr></table>`,
  `<img src="data:text/html,<script>alert(1)</script>">`,
  `<img src="//evil.example/x.png" srcset="javascript:alert(1) 1x">`,
  `<details open ontoggle=alert(1)><summary>s</summary></details>`,
  `<video><source onerror="alert(1)"></video><audio src=x onerror=alert(1)></audio>`,
  `<marquee onstart=alert(1)>x</marquee><isindex action="javascript:alert(1)">`,
  `<a href="https://ok.example"><img src="https://ok.example/a.png" usemap="#m"></a><map name="m"><area href="javascript:alert(1)"></map>`,
  `<body onload=alert(1)><p>body</p></body>`,
  // CSS functions nested in others, ")" inside strings, and comment markers inside strings (the security review of
  // 2026-11-18): a reader that stops at the first ")" or strips "/*…*/" inside strings misses what they hide.
  `<div style='background-image:image-set("cid:a" 1x, url(javascript:alert(1)) 2x)'>x</div>`,
  `<div style='background-image:image-set("cid:a" 1x, url(file:///etc/passwd) 2x)'>x</div>`,
  `<div style='background:url("cid:a/*"), url("javascript:alert(1)"), url("*/")'>x</div>`,
  `<style>p{background:url("cid:x/*"), url("vbscript:msgbox(1)"), url("*/")}</style><p>x</p>`,
  `<style>p{background-image:-webkit-image-set("cid:a" 1x, url(data:text/html,x) 2x)}</style><p>x</p>`,
  `<div style='background-image:image-set("data:image/png;base64,AA" 1x, url(//evil.example/a1.png) 2x)'>x</div>`,
  `<style>.x{background-image:image-set("data:image/png;base64,AA" 1x, url(https://evil.example/a1b.png) 2x)}</style><p class=x>x</p>`,
  `<div style='background-image:-webkit-image-set("data:image/png;base64,AA" 1x, url(https://evil.example/a1c.png) 2x)'>x</div>`,
  `<div style='background-image:image-set("cid:a" 1x, "https://evil.example/a).png" 2x)'>x</div>`,
  `<div style='--u:"https://evil.example/a3.png";background-image:image-set("cid:a" 1x, var(--u) 2x)'>x</div>`,
  `<div style='background:url("cid:a/*"), url("https://evil.example/b1.png"), url("*/")'>x</div>`,
  `<style>p{background:url("cid:a/*"), url("//evil.example/b1b.png"), url("*/")}</style><p>x</p>`,
  `<div style='background-image:image-set("cid:x/*" 1x, "https://evil.example/b2.png" 2x, "*/" 3x)'>x</div>`,
  `<style>@font-face{font-family:F;src:url("data:font/woff2;base64,AA/*"), url("https://evil.example/b3.woff2"), url("*/")}</style>`,
  `<style>@font-face{font-family:F;src:url("data:image/png;base64,AA/*"), url("https://evil.example/b4.woff2"), url("*/")}</style><p>x</p>`,
  `<div style="background:cross-fade(url(https://evil.example/c1.png), url(https://evil.example/c2.png))">x</div>`,
  `<div style="background:\\75 rl(https://evil.example/escaped-name.png)">x</div>`,
  `<div style="background:url(https://evil.example/unclosed.png">x</div>`,
  // A string in a declaration's name that a newline ends for a browser but not for postcss hides what follows (the
  // security review's second round, 2026-11-18), with the newline written as itself, as \r or \f, or as &#10;.
  `<div style='x"a\n;background:url(javascript:alert(1));width:expression(alert(1));b"y: red'>x</div>`,
  `<div style='x"a\r;background:url("javascript:alert(1)");b"y: red'>x</div>`,
  `<div style='x"a\f;width:expression(alert(1));b"y: red'>x</div>`,
  `<div style="x&quot;a&#10;;background:url('javascript:alert(1)');width:expression(alert(1));background-image:url('https://evil.example/q.png');b&quot;y: red">x</div>`,
  `<div style='x"a\n;background:url(https://evil.example/p1.png);b"y: red'>x</div>`,
  `<style>p{x"a\n;background:url(javascript:alert(1));b"y: red}</style><p>x</p>`,
  `<style>p{x"a\n;background:url(https://evil.example/p2.png);b"y: red}</style><p>x</p>`,
  `<style>a{}b[x="\n}c{background:url(javascript:alert(1))}d[y="]{color:red}</style><p>x</p>`,
  `<style>@media "a\n{} b{background:url(vbscript:x)} c "{}</style><p>x</p>`,
  `<div style='color:"a\n;background:url(javascript:alert(1));b"'>x</div>`,
  `<div style='x"a\n;--u:"//evil.example/c2.png";b"y: red;background-image:image-set(var(--u) 1x)'>x</div>`,
  `<style>${"@media all{".repeat(3000)}p{background:url(javascript:alert(1))}${"}".repeat(3000)}</style><p>x</p>`,
];

const ALLOWED_TAGS = new Set([
  "a", "abbr", "acronym", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br", "caption",
  "center", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn", "div", "dl", "dt", "em",
  "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "i", "img",
  "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt", "ruby", "s", "samp", "section",
  "small", "span", "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th",
  "thead", "time", "tr", "tt", "u", "ul", "var", "wbr",
]);
const URL_ATTRIBUTES = new Set(["href", "src", "background", "cite"]);

/**
 * Parses sanitized output again and fails on anything outside the allow-list. `alsoAllowed` admits more addresses in
 * URL attributes (the picture pass's own paths).
 */
export function assertSafe(html: string | undefined, input: string, alsoAllowed?: RegExp): void {
  if (html === undefined) return;
  const problems: string[] = [];
  let inStyle = false;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (!ALLOWED_TAGS.has(name)) problems.push(`element <${name}>`);
        if (name === "style") inStyle = true;
        for (const [attr, value] of Object.entries(attribs)) {
          if (/^on/i.test(attr)) problems.push(`handler ${attr}`);
          if (attr === "srcset" || attr === "formaction" || attr === "action" || attr === "srcdoc") problems.push(`attribute ${attr}`);
          if (URL_ATTRIBUTES.has(attr)) {
            const url = value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
            if (!/^(?:https?:|mailto:|tel:|cid:|data:image\/|#|\/\/)/.test(url) && !alsoAllowed?.test(value)) problems.push(`${attr}="${value}"`);
          }
          if (attr === "style" && /expression|javascript|behavior|binding|vbscript|file:|data:text/i.test(value)) problems.push(`style="${value}"`);
        }
      },
      ontext(text) {
        if (inStyle && (/</.test(text) || /@import|javascript|vbscript|expression|behavior|binding|file:|data:text/i.test(text))) problems.push(`style text ${text}`);
      },
      onclosetag(name) {
        if (name === "style") inStyle = false;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  assert.deepEqual(problems, [], `for input ${input}\noutput: ${html}`);
  assert.doesNotMatch(html, /<script|javascript:|vbscript:/i, `for input ${input}`);
}
