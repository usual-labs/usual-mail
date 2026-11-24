// Questions in the terminal. Only asked when input and output are a terminal; otherwise commands take flags or
// fail with a message naming them. Secrets are read without showing what is typed.

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { Failure } from "./errors.ts";

export interface Prompter {
  /** One line of answer. */
  ask(question: string): Promise<string>;
  /** One line of answer that is not shown while it is typed. */
  secret(question: string): Promise<string>;
  close(): void;
}

/** A terminal prompter. What is typed after `secret` never reaches `output`. */
export function terminalPrompter(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Prompter {
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  let rl: Interface | null = null;
  const open = () => {
    if (rl) return rl;
    rl = createInterface({ input, output: echo, terminal: true });
    // Ctrl-C ends the questions. Without a listener readline would only pause the input and wait for ever.
    rl.on("SIGINT", () => rl?.close());
    return rl;
  };
  const question = (text: string, hidden: boolean) =>
    new Promise<string>((resolve, reject) => {
      const reader = open();
      const closed = () => {
        output.write("\n");
        muted = false;
        rl = null;
        reject(new Failure("Stopped; nothing was changed."));
      };
      reader.once("close", closed);
      const answered = (answer: string) => {
        reader.off("close", closed);
        if (hidden) output.write("\n");
        muted = false;
        resolve(answer);
      };
      if (hidden) {
        // Written here, not as readline's prompt, so it stays on screen while everything readline writes is dropped.
        output.write(text);
        muted = true;
        reader.question("", answered);
      } else {
        // As readline's prompt, so redrawing the line after a backspace keeps the question.
        reader.question(text, answered);
      }
    });
  return {
    ask: (text) => question(text, false),
    secret: (text) => question(text, true),
    close: () => {
      rl?.close();
      rl = null;
    },
  };
}

/** Asks until the answer is not empty, or takes `fallback` on Enter. */
export async function askText(p: Prompter, question: string, fallback?: string): Promise<string> {
  for (;;) {
    const answer = (await p.ask(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
    if (answer) return answer;
    if (fallback !== undefined) return fallback;
  }
}

export async function askSecret(p: Prompter, question: string): Promise<string> {
  for (;;) {
    const answer = await p.secret(`${question} (not shown): `);
    if (answer) return answer;
  }
}

export async function askNumber(p: Prompter, question: string, fallback: number, min: number, max: number): Promise<number> {
  let text = question;
  for (;;) {
    const value = Number(await askText(p, text, String(fallback)));
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    text = `${question} (a whole number from ${min} to ${max})`;
  }
}

export async function confirm(p: Prompter, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await p.ask(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

export interface Choice<T> {
  label: string;
  value: T;
}

/** Shows numbered choices and takes a number. `fallback` is the index Enter picks. */
export async function choose<T>(
  p: Prompter,
  write: (text: string) => void,
  question: string,
  choices: Choice<T>[],
  fallback = 0,
): Promise<T> {
  write(`${question}\n`);
  choices.forEach((choice, i) => write(`  ${String(i + 1).padStart(2)}  ${choice.label}\n`));
  for (;;) {
    const answer = (await p.ask(`Number [${fallback + 1}]: `)).trim();
    if (!answer) return choices[fallback]!.value;
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index].value;
  }
}

/** Shows numbered choices and takes several numbers, separated by commas, or "all". */
export async function chooseMany<T>(
  p: Prompter,
  write: (text: string) => void,
  question: string,
  choices: Choice<T>[],
): Promise<T[]> {
  write(`${question}\n`);
  choices.forEach((choice, i) => write(`  ${String(i + 1).padStart(2)}  ${choice.label}\n`));
  for (;;) {
    const answer = (await p.ask("Numbers separated by commas, or all: ")).trim().toLowerCase();
    if (answer === "all") return choices.map((choice) => choice.value);
    const picked = answer
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((part) => choices[Number(part) - 1]);
    if (picked.length && picked.every(Boolean)) return [...new Set(picked.map((choice) => choice!.value))];
  }
}
