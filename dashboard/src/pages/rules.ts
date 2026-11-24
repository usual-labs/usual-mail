// What an inbox has learned: its rules in plain language, who made each and how often it sorted mail, the
// suggestions agents made, and a form to add one.
import type { DecidedCategory, Inbox, Rule, Stack } from "@usualmail/core";
import { hatFor } from "../hats.ts";
import { html, type Html } from "../html.ts";
import { alert, href, icon, notice, page, pageHead, postForm, type View } from "../view/layout.ts";
import { checkbox, confirmStep, hatLabel, hidden, selectField, textField } from "../view/parts.ts";
import { CATEGORY_NAMES, DECIDED_CATEGORIES, hits, matchWords, ruleAction, ruleMaker, STACK_NAMES } from "../view/words.ts";

/** The order the server checks them in: what a person taught first, newest first; then agents' rules, newest first. */
export function inCheckOrder(rules: Rule[]): Rule[] {
  const byNewest = (a: Rule, b: Rule) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  const taught = rules.filter((rule) => rule.source !== "agent").sort(byNewest);
  const agents = rules.filter((rule) => rule.source === "agent").sort(byNewest);
  return [...taught, ...agents];
}

/** A suggestion is a rule an agent made that nobody has turned on yet. */
export const isSuggestion = (rule: Rule) => rule.source === "agent" && !rule.enabled;

function ruleDetails(rule: Rule): Html {
  const when = matchWords(rule.match);
  const then = rule.then.map(ruleAction);
  return html`<p class="rule-when"><span>When: ${when.length ? when.join("; ") : "any mail"}</span><span>Then: ${then.join(", ") || "nothing"}</span></p>`;
}

/** A suggested rule with Accept (turn it on) and Dismiss (delete it). `returnTo` is where the forms come back to. */
export function suggestionCard(view: View, rule: Rule, inbox: Inbox | undefined, returnTo: string): Html {
  const ruleId = encodeURIComponent(rule.id);
  return html`<li class="card rule suggested">
${inbox ? hatLabel(inbox, "small") : ""}
<p class="rule-text">${rule.text}</p>
<p class="meta">${ruleMaker(rule)} · it is off until you accept it</p>
${ruleDetails(rule)}
<div class="actions">
${postForm(view, `/rules/${ruleId}/enable`, html`${hidden("enabled", "on")}${hidden("inbox", rule.inboxId)}${hidden("return", returnTo)}<button class="button primary" type="submit">${icon(view, "approve")}Accept<span class="visually-hidden">: ${rule.text}</span></button>`, "inline-form")}
${confirmStep(view, {
  open: "Dismiss…",
  explain: "The suggestion is deleted. This can't be undone, though an agent may suggest it again.",
  action: `/rules/${ruleId}/delete`,
  confirm: "Dismiss suggestion",
  fields: html`${hidden("inbox", rule.inboxId)}${hidden("return", returnTo)}`,
})}
</div>
</li>`;
}

function ruleCard(view: View, rule: Rule, returnTo: string): Html {
  const ruleId = encodeURIComponent(rule.id);
  return html`<li class="card rule${rule.enabled ? "" : " off"}">
<p class="rule-text">${rule.text}</p>
<p class="meta">${ruleMaker(rule)} · ${hits(rule.hits)} · ${rule.enabled ? "On" : "Off"}</p>
${ruleDetails(rule)}
<div class="actions">
${postForm(
  view,
  `/rules/${ruleId}/enable`,
  html`${hidden("enabled", rule.enabled ? "off" : "on")}${hidden("inbox", rule.inboxId)}${hidden("return", returnTo)}<button class="button" type="submit">${rule.enabled ? "Turn off" : "Turn on"}<span class="visually-hidden">: ${rule.text}</span></button>`,
  "inline-form",
)}
${confirmStep(view, {
  open: "Delete…",
  explain: "The rule stops sorting mail and is gone for good. Mail it already sorted stays where it is.",
  action: `/rules/${ruleId}/delete`,
  confirm: "Delete rule",
  fields: html`${hidden("inbox", rule.inboxId)}${hidden("return", returnTo)}`,
})}
</div>
</li>`;
}

/** What the add-a-rule form sent, kept when adding failed. */
export interface RuleFormValues {
  text: string;
  from: string;
  domain: string;
  listId: string;
  subjectContains: string;
  to: string;
  automated: boolean;
  category: DecidedCategory | "";
  stack: Stack | "";
  read: boolean;
  done: boolean;
  allowSender: boolean;
  blockSender: boolean;
  trash: boolean;
}

export const EMPTY_RULE: RuleFormValues = {
  text: "",
  from: "",
  domain: "",
  listId: "",
  subjectContains: "",
  to: "",
  automated: false,
  category: "",
  stack: "",
  read: false,
  done: false,
  allowSender: false,
  blockSender: false,
  trash: false,
};

function addRuleForm(view: View, inbox: Inbox, v: RuleFormValues, errors: Partial<Record<string, string>>): Html {
  const categories = DECIDED_CATEGORIES.map((category): [string, string] => [category, CATEGORY_NAMES[category]]);
  const stacks = Object.entries(STACK_NAMES) as Array<[Stack, string]>;
  return postForm(
    view,
    `/inboxes/${encodeURIComponent(inbox.id)}/rules`,
    html`<h2 id="add-rule">Add a rule</h2>
${textField({ id: "rule-text", name: "text", label: "The rule in plain words", value: v.text, required: true, maxlength: 200, hint: "Shown as you write it, for example “Receipts from paperloop.example are receipts”.", error: errors.text })}
<fieldset><legend>When new mail…</legend>
<p class="hint">Fill in one or more. Mail must match all of them.${errors.match ? html` <span class="field-error">${errors.match}</span>` : ""}</p>
${textField({ id: "rule-from", name: "from", label: "Comes from this address", value: v.from, type: "email", autocomplete: "off" })}
${textField({ id: "rule-domain", name: "domain", label: "Comes from this domain", value: v.domain, autocomplete: "off", hint: "Also matches its subdomains. Without “@”.", placeholder: "example.com" })}
${textField({ id: "rule-list", name: "listId", label: "Comes from this mailing list (List-Id)", value: v.listId, autocomplete: "off" })}
${textField({ id: "rule-subject", name: "subjectContains", label: "Has this in its subject", value: v.subjectContains, autocomplete: "off" })}
${textField({ id: "rule-to", name: "to", label: "Was sent to this address", value: v.to, type: "email", autocomplete: "off", hint: "For aliases." })}
${checkbox({ id: "rule-automated", name: "automated", label: "Was sent by a machine (newsletters, notifications, no-reply)", checked: v.automated })}
</fieldset>
<fieldset><legend>Then…</legend>
<p class="hint">At least one.${errors.then ? html` <span class="field-error">${errors.then}</span>` : ""}</p>
${selectField({ id: "rule-category", name: "category", label: "Put it in", value: v.category, options: [["", "Leave its category to Usual Mail"], ...categories], hint: "A category a rule sets is kept: Usual Mail's AI doesn't decide it again." })}
${selectField({ id: "rule-stack", name: "stack", label: "Put it on a stack", value: v.stack, options: [["", "No stack"], ...stacks] })}
${checkbox({ id: "rule-read", name: "read", label: "Mark it read", checked: v.read })}
${checkbox({ id: "rule-done", name: "done", label: "Mark it done", checked: v.done })}
${checkbox({ id: "rule-allow", name: "allowSender", label: "Let the sender in", checked: v.allowSender })}
${checkbox({ id: "rule-block", name: "blockSender", label: "Block the sender", checked: v.blockSender })}
${checkbox({ id: "rule-trash", name: "trash", label: "Move it to the trash", checked: v.trash })}
<p class="hint">Blocking and moving to the trash always wait for your yes in Handled. A thread on a stack is never done.</p>
</fieldset>
<div class="actions"><button class="button primary" type="submit">Add rule</button></div>`,
    "card form",
  );
}

export interface RulesPageOptions {
  done?: string;
  error?: string;
  values?: RuleFormValues;
  errors?: Partial<Record<string, string>>;
}

export function rulesPage(view: View, inbox: Inbox, rules: Rule[], o: RulesPageOptions = {}): Html {
  const returnTo = `/inboxes/${encodeURIComponent(inbox.id)}/rules`;
  const ordered = inCheckOrder(rules);
  const suggestions = ordered.filter(isSuggestion);
  const others = ordered.filter((rule) => !isSuggestion(rule));
  return page(view, {
    title: `Rules for ${inbox.name}`,
    section: "inboxes",
    signedIn: true,
    hat: hatFor(inbox.color).name,
    body: html`${pageHead(view, {
      title: html`What ${inbox.name} has learned`,
      back: { path: `/inboxes/${encodeURIComponent(inbox.id)}`, label: inbox.name },
      lede: "Rules sort new mail first, before Usual Mail's AI or an agent sees it. What you taught is checked first, newest first, then rules agents made. The first rule that matches wins.",
    })}
${notice(view, o.done)}
${o.error ? alert(view, "error", o.error) : ""}
${suggestions.length
  ? html`<section class="block" aria-labelledby="suggested-title"><h2 id="suggested-title">Suggested by agents</h2><p class="note">An agent's rule stays off until you accept it.</p><ul class="list">${suggestions.map((rule) => suggestionCard(view, rule, undefined, returnTo))}</ul></section>`
  : ""}
<section class="block" aria-labelledby="rules-title"><h2 id="rules-title">Rules</h2>
${others.length
  ? html`<ol class="list">${others.map((rule) => ruleCard(view, rule, returnTo))}</ol>`
  : html`<p class="empty">No rules yet. When you correct where mail went, Usual Mail asks whether to make a rule of it.</p>`}
</section>
${addRuleForm(view, inbox, o.values ?? EMPTY_RULE, o.errors ?? {})}`,
  });
}
