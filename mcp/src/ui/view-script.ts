/**
 * The script inside both chat views. It speaks the MCP Apps postMessage protocol (2026-01-26) by hand, as the
 * extension allows, so the views need no bundle: ui/initialize, then ui/notifications/initialized, then it draws
 * each ui/notifications/tool-result. It only calls act_on_threads and undo_action, which an agent may call.
 *
 * Every value from a result reaches the page through textContent; the script never writes markup from data.
 * Kept free of backticks and dollar-brace so it can live in this template string.
 */
export const VIEW_SCRIPT = String.raw`
(function () {
  "use strict";
  var host = window.parent;
  var view = document.body.getAttribute("data-view");
  var root = document.getElementById("root");
  var SVG = "http://www.w3.org/2000/svg";
  var HATS = ["red", "orange", "amber", "olive", "green", "teal", "sky", "blue", "violet", "plum", "pink", "slate"];
  var CATEGORIES = {
    conversation: "Conversations", newsletter: "Newsletters", invoice: "Invoices", receipt: "Receipts",
    notification: "Notifications", otp: "One-time codes", unknown: "Not sorted yet", done: "Done", trash: "Trash"
  };
  var COUNT_ORDER = ["conversation", "newsletter", "invoice", "receipt", "notification", "otp", "unknown", "done", "trash"];
  var STACKS = { reply_later: { label: "Reply later", icon: "reply-later" }, set_aside: { label: "Set aside", icon: "set-aside" } };
  var VIEWS = {
    home: "Home", conversation: "Conversations", newsletter: "Newsletters", invoice: "Invoices", receipt: "Receipts",
    notification: "Notifications", otp: "One-time codes", unknown: "Not sorted yet", reply_later: "Reply later",
    set_aside: "Set aside", waiting: "Waiting", screening: "Screening"
  };
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var nextId = 1;
  var pending = {};
  var hostCapabilities = {};
  var timeZone;

  function post(message) { host.postMessage(message, "*"); }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params) {
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.setAttribute("class", className);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function icon(name) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS(SVG, "use");
    use.setAttribute("href", "#icon-" + name);
    svg.appendChild(use);
    return svg;
  }
  function hatName(value) { return HATS.indexOf(value) >= 0 ? value : "slate"; }
  function hatLabel(name, hat, small) {
    var label = el(small ? "span" : "p", small ? "hat-label small" : "hat-label");
    label.setAttribute("data-hat", hatName(hat));
    var dot = el("span", "hat-dot");
    dot.setAttribute("aria-hidden", "true");
    label.appendChild(dot);
    label.appendChild(el("span", "hat-name", name));
    return label;
  }
  function resized() {
    var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    notify("ui/notifications/size-changed", { height: height });
  }

  // Times in the person's time zone when the host says which.
  function dayParts(date) {
    var out = {};
    var options = { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" };
    if (timeZone) options.timeZone = timeZone;
    new Intl.DateTimeFormat("en-GB", options).formatToParts(date).forEach(function (part) { out[part.type] = part.value; });
    return out;
  }
  function dayNumber(parts) { return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000; }
  function clock(parts) { return parts.hour + ":" + parts.minute; }
  function shortDay(parts) { return Number(parts.day) + " " + MONTHS[Number(parts.month) - 1]; }
  function listTime(iso) {
    var when = dayParts(new Date(iso));
    var ago = dayNumber(dayParts(new Date())) - dayNumber(when);
    if (ago === 0) return clock(when);
    if (ago === 1) return "Yesterday";
    if (ago > 1 && ago < 7) return when.weekday;
    return shortDay(when);
  }
  function aheadTime(iso) {
    var when = dayParts(new Date(iso));
    var ahead = dayNumber(when) - dayNumber(dayParts(new Date()));
    var day = ahead === 0 ? "today" : ahead === 1 ? "tomorrow" : ahead < 7 ? when.weekday : shortDay(when);
    return day + " " + clock(when);
  }
  function period(from, to) {
    var a = dayParts(new Date(from));
    var b = dayParts(new Date(to));
    return shortDay(a) + " " + clock(a) + " to " + (dayNumber(a) === dayNumber(b) ? "" : shortDay(b) + " ") + clock(b);
  }

  function applyContext(context) {
    if (!context) return;
    if (context.theme === "light" || context.theme === "dark") document.documentElement.setAttribute("data-theme", context.theme);
    if (typeof context.timeZone === "string") {
      try { new Intl.DateTimeFormat("en-GB", { timeZone: context.timeZone }); timeZone = context.timeZone; } catch (error) { timeZone = undefined; }
    }
  }

  // The brief card (design/specs/brief-card.md).
  function drawBrief(brief) {
    var card = el("article", "card brief");
    var header = el("header");
    header.appendChild(el("h2", null, "Brief"));
    if (!brief) {
      header.appendChild(el("p", "meta", "No brief yet."));
      card.appendChild(header);
      return card;
    }
    header.appendChild(el("p", "meta", period(brief.from, brief.to) + " \u00b7 Written by " + brief.writtenBy));
    card.appendChild(header);
    (brief.sections || []).forEach(function (section) {
      var part = el("section", "section");
      part.appendChild(hatLabel(section.inboxName, section.hat, false));
      if (section.summary) part.appendChild(el("p", "summary", section.summary));
      if (section.highlights && section.highlights.length) {
        var list = el("ul", "highlights");
        section.highlights.forEach(function (highlight) {
          var item = el("li");
          var canOpen = Boolean(hostCapabilities.message);
          var target = el(canOpen ? "a" : "div", "highlight");
          target.appendChild(el("span", "hl-line", highlight.line));
          if (highlight.subject) target.appendChild(el("span", "hl-subject", highlight.subject));
          if (canOpen) {
            target.setAttribute("href", "#");
            target.addEventListener("click", function (event) {
              event.preventDefault();
              request("ui/message", { role: "user", content: [{ type: "text", text: "Open the thread " + highlight.threadId + " from the Usual Mail brief." }] }).catch(function () {});
            });
          }
          item.appendChild(target);
          list.appendChild(item);
        });
        part.appendChild(list);
      }
      var counts = [];
      COUNT_ORDER.forEach(function (key) {
        var count = section.counts ? section.counts[key] : 0;
        if (count > 0) counts.push(CATEGORIES[key] + " " + count);
      });
      if (counts.length) part.appendChild(el("p", "counts", counts.join(" \u00b7 ")));
      card.appendChild(part);
    });
    return card;
  }

  // Thread rows (design/specs/pile-row.md), with the actions an agent may take.
  function callTool(name, args) {
    return request("tools/call", { name: name, arguments: args }).then(function (result) {
      if (!result || result.isError || !result.structuredContent) throw new Error("refused");
      return result.structuredContent;
    });
  }
  function button(label, iconName, onClick) {
    var node = el("button", "button");
    node.setAttribute("type", "button");
    if (iconName) node.appendChild(icon(iconName));
    node.appendChild(el("span", null, label));
    node.addEventListener("click", onClick);
    return node;
  }
  function settle(actions, record, appliedText) {
    actions.replaceChildren();
    if (!record) { actions.appendChild(el("span", "note", "Nothing to change.")); resized(); return; }
    if (record.state === "proposed") {
      actions.appendChild(el("span", "note attention", "Proposed: waiting for your yes in Usual Mail."));
    } else if (record.state === "applied") {
      actions.appendChild(el("span", "note", appliedText));
      if (record.undoable) {
        actions.appendChild(button("Undo", "undo", function () {
          actions.replaceChildren(el("span", "note", "Undoing\u2026"));
          callTool("undo_action", { actionId: record.actionId }).then(function () {
            actions.replaceChildren(el("span", "note", "Undone."));
            resized();
          }, function () { actions.replaceChildren(el("span", "note danger", "Couldn\u2019t undo that.")); resized(); });
        }));
      }
    } else {
      actions.appendChild(el("span", "note", "Done already."));
    }
    resized();
  }
  function act(actions, item, action, extra, appliedText, reason) {
    actions.replaceChildren(el("span", "note", "Working\u2026"));
    var args = { threadIds: [item.threadId], action: action, reason: reason };
    Object.keys(extra).forEach(function (key) { args[key] = extra[key]; });
    callTool("act_on_threads", args).then(function (result) {
      settle(actions, (result.records || [])[0], appliedText);
    }, function () {
      actions.replaceChildren(el("span", "note danger", "Couldn\u2019t do that."));
      resized();
    });
  }
  function drawRow(item, single) {
    var row = el("li", "row" + (item.unread ? " unread" : "") + (item.done ? " done" : ""));
    var lead = el("div", "lead");
    var dot = el("span", item.unread ? "unread-dot" : "read-dot");
    if (item.unread) dot.setAttribute("aria-label", "Unread"); else dot.setAttribute("aria-hidden", "true");
    lead.appendChild(dot);
    row.appendChild(lead);
    var main = el("div", "main");
    var first = el("div", "line1");
    first.appendChild(el("span", "sender", item.sender));
    if (item.messageCount > 1) first.appendChild(el("span", "count", item.messageCount));
    first.appendChild(el("span", "time", listTime(item.lastMessageAt)));
    main.appendChild(first);
    main.appendChild(el("div", "subject", item.subject));
    // Usual Mail's summary when its AI wrote one, else the snippet. Both are data, put in as text.
    main.appendChild(el("div", "snippet", item.summary || item.snippet));
    var tags = el("div", "tags");
    if (!single) tags.appendChild(hatLabel(item.inboxName, item.hat, true));
    if (item.screened) tags.appendChild(el("span", "tag", "Screened"));
    if (item.stack && STACKS[item.stack]) {
      var stack = el("span", "tag");
      stack.appendChild(icon(STACKS[item.stack].icon));
      stack.appendChild(el("span", null, STACKS[item.stack].label));
      tags.appendChild(stack);
    }
    if (item.comeBackAt && new Date(item.comeBackAt).getTime() > Date.now()) {
      var back = el("span", "tag");
      back.appendChild(icon("come-back"));
      back.appendChild(el("span", null, "Comes back " + aheadTime(item.comeBackAt) + (item.comeBackIfNoReply ? " if no reply" : "")));
      tags.appendChild(back);
    }
    if (item.done) {
      var done = el("span", "tag");
      done.appendChild(icon("done"));
      done.appendChild(el("span", null, "Done"));
      tags.appendChild(done);
    }
    if (item.hasAttachments) {
      var clip = el("span", "tag");
      clip.setAttribute("aria-label", "Has attachments");
      clip.appendChild(icon("attachment"));
      tags.appendChild(clip);
    }
    if (tags.childNodes.length) main.appendChild(tags);
    if (!item.done) {
      var actions = el("div", "actions");
      actions.appendChild(button("Done", "done", function () {
        act(actions, item, "done", {}, "Marked done.", "Marked done from a Usual Mail list in a chat app");
      }));
      if (!item.stack) {
        actions.appendChild(button("Reply later", "reply-later", function () {
          act(actions, item, "stack", { stack: "reply_later" }, "On Reply later.", "Put on Reply later from a Usual Mail list in a chat app");
        }));
      }
      main.appendChild(actions);
    }
    row.appendChild(main);
    return row;
  }
  function drawThreads(data) {
    var card = el("div", "card threads");
    var items = data.items || [];
    if (!items.length) {
      card.appendChild(el("p", "empty", "Nothing here."));
      return card;
    }
    var list = el("ul", "rows");
    list.setAttribute("aria-label", VIEWS[data.view] || "Threads");
    items.forEach(function (item) { list.appendChild(drawRow(item, Boolean(data.singleInbox))); });
    card.appendChild(list);
    if (data.nextCursor) card.appendChild(el("p", "more", "More in Usual Mail."));
    return card;
  }

  function show(result) {
    var data = result && result.structuredContent;
    if (!data) return;
    if (view === "brief" && data.kind === "brief") root.replaceChildren(drawBrief(data.brief));
    else if (view === "threads" && data.kind === "threads") root.replaceChildren(drawThreads(data));
    else return;
    resized();
  }

  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined) {
      var waiting = pending[message.id];
      if (!waiting) return;
      delete pending[message.id];
      if (message.error) waiting.reject(message.error); else waiting.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") show(message.params);
    else if (message.method === "ui/notifications/host-context-changed") applyContext(message.params);
    else if (message.method === "ui/resource-teardown" && message.id !== undefined) post({ jsonrpc: "2.0", id: message.id, result: {} });
    else if (message.id !== undefined && typeof message.method === "string") post({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  });

  if (typeof ResizeObserver === "function") new ResizeObserver(resized).observe(document.documentElement);

  request("ui/initialize", {
    appInfo: { name: "usual-mail-" + view, version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline"] },
    protocolVersion: "2026-01-26"
  }).then(function (result) {
    hostCapabilities = (result && result.hostCapabilities) || {};
    applyContext(result && result.hostContext);
    notify("ui/notifications/initialized", {});
  });
})();
`;
