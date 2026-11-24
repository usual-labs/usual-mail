/**
 * Just enough of a browser to run a view's script in node:vm: elements, text, attributes, events and
 * window.postMessage. Writing markup (innerHTML and friends) throws, so a test fails if the script ever tries.
 */
import vm from "node:vm";

export class FakeText {
  readonly data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

type Listener = (event: unknown) => void;

export class FakeElement {
  readonly attributes = new Map<string, string>();
  childNodes: Array<FakeElement | FakeText> = [];
  private listeners = new Map<string, Listener[]>();

  readonly tagName: string;
  readonly namespace: string;

  constructor(tagName: string, namespace = "http://www.w3.org/1999/xhtml") {
    this.tagName = tagName;
    this.namespace = namespace;
  }

  setAttribute(name: string, value: unknown): void {
    if (/^on/i.test(name)) throw new Error(`event handler attribute ${name}`);
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  appendChild<T extends FakeElement | FakeText>(child: T): T {
    this.childNodes.push(child);
    return child;
  }
  replaceChildren(...children: Array<FakeElement | FakeText>): void {
    this.childNodes = [...children];
  }
  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes = [new FakeText(String(value))];
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML was used");
  }
  set outerHTML(_value: string) {
    throw new Error("outerHTML was used");
  }
  insertAdjacentHTML(): void {
    throw new Error("insertAdjacentHTML was used");
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener({ preventDefault() {} });
  }
  getBoundingClientRect() {
    return { width: 400, height: 240 };
  }

  /** Every element under this one, depth first. */
  all(): FakeElement[] {
    return this.childNodes.flatMap((child) => (child instanceof FakeElement ? [child, ...child.all()] : []));
  }
  byClass(name: string): FakeElement[] {
    return this.all().filter((element) => (element.getAttribute("class") ?? "").split(" ").includes(name));
  }
}

export interface Page {
  root: FakeElement;
  html: FakeElement;
  /** Messages the view posted to its host, as the host receives them. */
  sent: Array<Record<string, unknown>>;
  /** Delivers a message to the view, from the host unless `source` says otherwise. */
  deliver(message: unknown, source?: unknown): void;
  host: { postMessage(message: unknown, origin: string): void };
}

/** The moment the views treat as now in tests: the sample data's own "now", so times read the same any day. */
export const VIEW_NOW = "2026-11-16T09:30:00Z";

/** A Date whose "now" is pinned, for the view's script: `new Date()` and `Date.now()` give `now`. */
function pinnedDate(now: string): DateConstructor {
  const at = Date.parse(now);
  class PinnedDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(at);
      else super(...(args as [string]));
    }
    static override now(): number {
      return at;
    }
  }
  return PinnedDate as unknown as DateConstructor;
}

export function runView(
  script: string,
  view: string,
  onPost: (message: Record<string, unknown>) => void = () => {},
  now: string = VIEW_NOW,
): Page {
  const sent: Array<Record<string, unknown>> = [];
  const windowListeners: Listener[] = [];
  const html = new FakeElement("html");
  const body = new FakeElement("body");
  body.setAttribute("data-view", view);
  const root = new FakeElement("main");
  root.setAttribute("id", "root");
  const host = {
    postMessage(message: unknown, origin: string) {
      if (origin !== "*") throw new Error("unexpected target origin");
      const copy = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
      sent.push(copy);
      onPost(copy);
    },
  };
  const document = {
    body,
    documentElement: html,
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: (tag: string) => new FakeElement(tag.toLowerCase()),
    createElementNS: (namespace: string, tag: string) => new FakeElement(tag, namespace),
    write() {
      throw new Error("document.write was used");
    },
  };
  const window = {
    parent: host,
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") windowListeners.push(listener);
    },
  };
  vm.runInNewContext(script, { window, document, Date: pinnedDate(now) });
  return {
    root,
    html,
    sent,
    host,
    deliver(message, source = host) {
      const data = JSON.parse(JSON.stringify(message)) as unknown;
      for (const listener of windowListeners) listener({ source, data });
    },
  };
}

/** Lets promises and timers the view started run to completion. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}
