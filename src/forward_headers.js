/**
 * Build X-* headers for cf_forward (DKIM-safe; CF only allows X-*).
 *
 * Contract version 2 — see docs/15-x-cfeg-header-contract.md
 *
 * X-CFEG-Reply-To:
 *   "Original Name <original@addr>" <r+TOKEN@ourdomain>
 *
 * Extension sets compose To chip from that mailbox (display + token addr).
 * Bare token also in X-CFEG-Reply-To-Addr for simple parsers.
 */

import { formatTokenAddress } from "./reply_tokens.js";

/**
 * @param {{
 *   token: string,
 *   ourDomain: string,
 *   ourMailbox: string,
 *   primary: { email: string, display_hint?: string, role?: string, header?: string },
 *   others?: Array<{ email: string, display_hint?: string, local_suffix: string, role?: string, header?: string }>,
 *   multiparty?: boolean,
 * }} meta
 * @returns {Headers}
 */
export function buildForwardTokenHeaders(meta) {
  const h = new Headers();
  const token = String(meta.token || "").toLowerCase();
  const domain = String(meta.ourDomain || "").toLowerCase();
  const primaryToken = `r+${token}@${domain}`;
  const primaryMailbox = formatTokenAddress(
    meta.primary?.display_hint,
    meta.primary?.email,
    primaryToken,
  );

  // v2 primary — full mailbox form user requested
  h.set("X-CFEG-Version", "2");
  h.set("X-CFEG-Reply-To", primaryMailbox);
  h.set("X-Reply-To", primaryMailbox);
  h.set("X-CFEG-Reply-To-Addr", primaryToken);
  h.set("X-CFEG-Reply-Token", token);
  if (meta.ourMailbox) {
    h.set("X-CFEG-Reply-Mailbox", String(meta.ourMailbox).toLowerCase());
  }

  const display = formatDisplayLabel(
    meta.primary?.display_hint,
    meta.primary?.email,
  );
  if (display) h.set("X-CFEG-Reply-To-Display", display);

  /** @type {Array<object>} */
  const parties = [];
  parties.push({
    role: meta.primary?.role || "primary",
    header: meta.primary?.header || "from",
    name: cleanName(meta.primary?.display_hint, meta.primary?.email),
    email: String(meta.primary?.email || "").toLowerCase(),
    token: primaryToken,
    suffix: null,
    mailbox: primaryMailbox,
  });

  const others = meta.multiparty === false ? [] : meta.others || [];
  /** @type {string[]} */
  const replyAllMailboxes = [primaryMailbox];
  /** @type {string[]} */
  const replyAllAddrs = [primaryToken];

  for (const o of others) {
    const suffix = o.local_suffix || "p1";
    const pToken = `r+${token}.${suffix}@${domain}`;
    const pMailbox = formatTokenAddress(o.display_hint, o.email, pToken);
    h.set(`X-CFEG-Reply-To-${suffix}`, pMailbox);
    h.set(`X-CFEG-Reply-To-${suffix}-Addr`, pToken);
    h.set(
      `X-CFEG-Participant-${suffix}`,
      packParticipant(o.email, o.display_hint),
    );
    parties.push({
      role: o.role || (o.header === "cc" ? "cc" : "other"),
      header: o.header || "cc",
      name: cleanName(o.display_hint, o.email),
      email: String(o.email || "").toLowerCase(),
      token: pToken,
      suffix,
      mailbox: pMailbox,
    });
    replyAllMailboxes.push(pMailbox);
    replyAllAddrs.push(pToken);
  }

  // Single structured map for extension multiparty / CC (JSON, one line)
  h.set("X-CFEG-Parties", stableJson(parties));
  // Convenience for Reply-All: bare tokens only (hop addresses)
  h.set("X-CFEG-Reply-All-Addr", replyAllAddrs.join(", "));
  // Full mailboxes for Reply-All chips
  h.set("X-CFEG-Reply-All", replyAllMailboxes.join(", "));

  return h;
}

/** Display label only: `Name <email>` or email */
function formatDisplayLabel(name, email) {
  const e = String(email || "").trim();
  const n = cleanName(name, email);
  if (!e) return "";
  if (n) return `${n} <${e}>`;
  return e;
}

function cleanName(name, email) {
  let n = String(name || "")
    .replace(/[\r\n"]/g, "")
    .trim();
  const e = String(email || "").trim().toLowerCase();
  if (!n) return "";
  // strip if name is already "Foo <email>"
  const m = n.match(/^([^<]+)</);
  if (m) n = m[1].trim();
  if (n.toLowerCase() === e) return "";
  if (n.includes("@") && !n.includes(" ")) return "";
  return n;
}

function packParticipant(email, display) {
  const e = String(email || "").toLowerCase();
  const d = cleanName(display, email).replace(/\|/g, "/");
  return d ? `${e}|${d}` : e;
}

function stableJson(obj) {
  // Compact single-line JSON safe for one header line
  return JSON.stringify(obj).replace(/[\r\n]/g, "");
}

/**
 * Parse compose mailbox from X-CFEG-Reply-To v2 value.
 * Returns { displayLabel, tokenAddr } or null.
 */
export function parseCfegMailbox(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  // "label" <token@>
  const m = s.match(/^"([^"]*)"\s*<([^>]+@[^>]+)>\s*$/);
  if (m) return { displayLabel: m[1].trim(), tokenAddr: m[2].trim() };
  const m2 = s.match(/^(.*?)\s*<([^>]+@[^>]+)>\s*$/);
  if (m2) return { displayLabel: m2[1].replace(/"/g, "").trim(), tokenAddr: m2[2].trim() };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { displayLabel: "", tokenAddr: s };
  return null;
}
