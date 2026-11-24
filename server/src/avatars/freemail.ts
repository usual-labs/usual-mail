// Mailbox providers anyone can sign up to. Mail from an address at one of them is from a person (or anyone at all),
// never from the provider's brand, so its logo is never shown for it: a newsletter sent from a Gmail address must not
// wear Gmail's logo. Matched on a registrable domain: exactly, or by its first label for the providers with a domain in
// many countries (hotmail.co.uk, yahoo.co.jp, gmx.at). The provider's own mail (accounts.google.com, microsoft.com)
// comes from other domains and keeps its logo. Some providers also send their own notices from these domains
// (proton.me, hey.com, zoho.com); those get initials, an accepted cost. Platforms whose customers share the platform's
// domain (`isSharedPlatform`) are no brand either.

const DOMAINS = new Set([
  // Google, Microsoft, Apple, Yahoo, AOL
  "gmail.com", "googlemail.com", "live.com", "msn.com", "passport.com", "icloud.com", "me.com", "mac.com",
  "ymail.com", "rocketmail.com", "aim.com", "verizon.net",
  // Privacy-minded and independent providers
  "proton.me", "protonmail.com", "protonmail.ch", "pm.me", "tutanota.com", "tutanota.de", "tutamail.com", "tuta.io",
  "tuta.com", "keemail.me", "fastmail.com", "fastmail.fm", "hey.com", "mailbox.org", "posteo.de", "posteo.net",
  "disroot.org", "riseup.net", "runbox.com", "zoho.com", "zohomail.com", "zohomail.eu", "duck.com", "skiff.com",
  "mail.com", "email.com", "usa.com", "inbox.com", "hushmail.com", "startmail.com", "simplelogin.com", "aleeas.com",
  "mozmail.com",
  // Europe
  "web.de", "freenet.de", "t-online.de", "arcor.de", "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "sfr.fr",
  "neuf.fr", "libero.it", "virgilio.it", "tiscali.it", "alice.it", "seznam.cz", "centrum.cz", "wp.pl", "o2.pl",
  "interia.pl", "onet.pl", "op.pl", "bluewin.ch", "telenet.be", "skynet.be", "ziggo.nl", "kpnmail.nl", "planet.nl",
  "btinternet.com", "sky.com", "virginmedia.com", "ntlworld.com", "talktalk.net", "mail.ru", "inbox.ru", "list.ru",
  "bk.ru", "rambler.ru", "ya.ru", "ukr.net", "abv.bg", "mail.bg",
  // Americas and Asia-Pacific
  "comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "earthlink.net",
  "optonline.net", "shaw.ca", "rogers.com", "sympatico.ca", "uol.com.br", "bol.com.br", "terra.com.br",
  "bigpond.com", "bigpond.net.au", "optusnet.com.au", "xtra.co.nz", "qq.com", "foxmail.com", "163.com", "126.com",
  "yeah.net", "sina.com", "sina.cn", "sohu.com", "aliyun.com", "naver.com", "daum.net", "hanmail.net", "nate.com",
  "rediffmail.com", "yandex.com",
]);

/**
 * mail.com's own domains, as its "Domains" page lists them (https://www.mail.com/mail/domains/, read 2026-11-19): anyone
 * signing up there picks one.
 */
export const MAIL_COM_DOMAINS: readonly string[] = [
  "mail.com", "email.com", "usa.com", "myself.com", "consultant.com", "post.com", "dr.com", "execs.com", "europe.com",
  "engineer.com", "asia.com", "iname.com", "techie.com", "contractor.com", "contractor.net", "accountant.com", "musician.org",
  "artlover.com", "cheerful.com", "africamail.com", "hackermail.com", "activist.com", "adexec.com", "alumni.com",
  "archaeologist.com", "bartender.net", "chef.net", "chemist.com", "collector.org", "columnist.com", "comic.com",
  "hairdresser.net", "counsellor.com", "diplomats.com", "financier.com", "fireman.net", "gardener.com", "geologist.com",
  "graphic-designer.com", "graduate.org", "legislator.com", "lobbyist.com", "minister.com", "optician.com",
  "orthodontist.net", "pediatrician.com", "photographer.net", "physicist.net", "politician.com", "priest.com",
  "programmer.net", "registerednurses.com", "repairman.com", "secretary.net", "socialworker.net", "sociologist.com",
  "songwriter.net", "teachers.org", "technologist.com", "therapist.net", "publicist.com", "realtyagent.com",
  "bikerider.com", "birdlover.com", "kittymail.com", "lovecat.com", "marchmail.com", "boardermail.com", "brew-master.com",
  "catlover.com", "clubmember.org", "nonpartisan.com", "petlover.com", "doglover.com", "greenmail.net", "theplate.com",
  "bsdmail.com", "cyberdude.com", "cybergal.com", "cyberservices.com", "cyber-wizard.com", "linuxmail.org", "null.net",
  "webname.com", "acdcfan.com", "angelic.com", "discofan.com", "elvisfan.com", "hiphopfan.com", "kissfans.com",
  "madonnafan.com", "metalfan.com", "ninfan.com", "ravemail.com", "reggaefan.com", "californiamail.com", "dallasmail.com",
  "nycmail.com", "sanfranmail.com", "australiamail.com", "berlin.com", "brazilmail.com", "chinamail.com", "dublin.com",
  "dutchmail.com", "englandmail.com", "arcticmail.com", "europemail.com", "germanymail.com", "irelandmail.com",
  "israelmail.com", "italymail.com", "koreamail.com", "mexicomail.com", "moscowmail.com", "munich.com", "polandmail.com",
  "safrica.com", "scotlandmail.com", "spainmail.com", "swedenmail.com", "swissmail.com", "torontomail.com", "atheist.com",
  "disciples.com", "muslim.com", "protestant.com", "reborn.com", "reincarnate.com", "religious.com", "saintly.com",
  "cutey.com", "dbzmail.com", "doramail.com", "galaxyhit.com", "hilarious.com", "2trom.com", "innocent.com", "keromail.com",
  "toothfairy.com", "toke.com", "tvstar.com", "uymail.com",
];

for (const domain of MAIL_COM_DOMAINS) DOMAINS.add(domain);

/** Providers with a domain in many countries, by the first label of the registrable domain. */
const LABELS = new Set(["hotmail", "outlook", "live", "windowslive", "yahoo", "gmx", "yandex", "aol", "zoho", "zohomail"]);

/** Whether a registrable domain (ASCII, lower case) is a mailbox provider's that anyone can sign up to. */
export function isFreemail(registrable: string): boolean {
  return DOMAINS.has(registrable) || LABELS.has(registrable.split(".")[0] ?? "");
}

/**
 * Platforms anyone can sign up to whose customers send from the platform's own domain or a subdomain of it: a
 * Microsoft 365 tenant's `<name>.onmicrosoft.com`, a Google group, a newsletter writer on a publishing platform, a
 * sending service's shared domain. A tenant, group or writer is no brand, and the platform's logo isn't theirs, so none
 * gets a picture, whether or not the Public Suffix List splits them (the security review of 2026-11-19).
 */
const PLATFORMS = [
  "onmicrosoft.com", "googlegroups.com", "groups.io", "freelists.org", "substack.com", "beehiiv.com", "ghost.io",
  "buttondown.email", "convertkit-mail.com", "convertkit-mail2.com", "mailchimpapp.com", "mcsv.net", "sendgrid.net",
  "amazonses.com", "mailgun.org", "sparkpostmail.com",
];

/** Whether a host is one of those platforms' own domains or under one. */
export function isSharedPlatform(host: string): boolean {
  return PLATFORMS.some((platform) => host === platform || host.endsWith(`.${platform}`));
}
