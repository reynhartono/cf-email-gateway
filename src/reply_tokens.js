/**
 * Reply tokens: parse r+, participants, CF auth check, mailbox format
 */

import { recipientDomain } from "./config.js";
import { getHeader } from "./util.js";

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function generateToken(bytes = 12) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let out = "";
  for (const b of arr) out += TOKEN_ALPHABET[b % 32];
  return out;
}

/**
 * Parse r+TOKEN / r+TOKEN.pN / r+TOKEN.all @ domain
 */
export function parseReplyTokenAddress(envelopeTo) {
  const raw = String(envelopeTo || "").trim();
  const at = raw.lastIndexOf("@");
  if (at < 0) return null;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1).toLowerCase();
  const m = local.match(/^r\+([a-z0-9]+)(?:\.(all|p\d+))?$/i);
  if (!m) return null;
  return {
    token: m[1].toLowerCase(),
    suffix: m[2] ? m[2].toLowerCase() : null,
    ourDomain: domain,
    address: raw.toLowerCase(),
  };
}

/**
 * Display label for tokenized addresses:
 *   "Name <real@addr>" <r+token@ourdomain>
 * If no separate name, use real email only in the quotes:
 *   "real@addr" <r+token@ourdomain>
 */
export function formatTokenAddress(name, realEmail, tokenAddr) {
  const email = String(realEmail || "").trim();
  const token = String(tokenAddr || "").trim();
  const n = String(name || "")
    .replace(/[\r\n"]/g, "")
    .trim();
  let label;
  if (n && n.toLowerCase() !== email.toLowerCase() && !n.includes("@")) {
    label = `${n} <${email}>`;
  } else if (n && n.toLowerCase() !== email.toLowerCase()) {
    // name already looks like "something <email>" or contains @
    label = n.includes(email) ? n : `${n} <${email}>`;
  } else {
    label = email;
  }
  label = label.replace(/"/g, "").trim();
  return `"${label}" <${token}>`;
}

/**
 * SMTP To/From style: "Name" <email>
 * Never double-wrap "Name <email>" into "Name <email>" <email>.
 */
export function formatSmtpMailbox(name, email) {
  const addr = String(email || "").trim();
  let n = String(name || "")
    .replace(/[\r\n]/g, "")
    .trim();

  // Already a full mailbox: Name <addr> or "Name" <addr>
  const full = n.match(/^"?([^"<>]*)"?\s*<\s*([^>]+@[^>]+)\s*>$/);
  if (full) {
    const d = full[1].trim().replace(/"/g, "");
    const e = full[2].trim();
    if (d) return `"${d}" <${e}>`;
    return e;
  }

  // display_hint is literally the email
  if (!n || n.toLowerCase() === addr.toLowerCase()) {
    return addr;
  }

  // "Name <email>" without proper parse (loose)
  if (n.includes("<") && n.includes("@")) {
    const cleaned = n.replace(/"/g, "").trim();
    // if it already ends with > treat as complete
    if (/>\s*$/.test(cleaned)) return cleaned;
  }

  const d = n.replace(/"/g, "").trim();
  if (!d) return addr;
  return `"${d}" <${addr}>`;
}

/**
 * Extract external participants for reply tokens.
 *
 * Primary (Reply): first external Reply-To, else first external From.
 * Others (Reply-All): remaining Reply-To, From, external To, external Cc
 *   (deduped; our-domain addresses excluded — they are "us").
 *
 * @param {string} rawText
 * @param {string} ourDomain
 * @param {string[]} excludeEmails
 * @returns {Array<{
 *   email: string,
 *   display_hint: string,
 *   role: string,
 *   header: string,
 *   is_primary?: boolean,
 * }>}
 */
export function extractExternalParticipants(rawText, ourDomain, excludeEmails = []) {
  const exclude = new Set(
    excludeEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean),
  );
  const domain = String(ourDomain || "").toLowerCase();

  /** @type {Map<string, { email: string, display_hint: string, headers: Set<string> }>} */
  const byEmail = new Map();

  /**
   * @param {string} headerName
   */
  function ingest(headerName) {
    const val = getHeader(rawText, headerName);
    if (!val) return;
    for (const addr of splitAddresses(val)) {
      const email = addr.email.toLowerCase();
      if (!email.includes("@")) continue;
      if (exclude.has(email)) continue;
      if (recipientDomain(email) === domain) continue;
      const prev = byEmail.get(email);
      if (prev) {
        prev.headers.add(headerName);
        // Prefer a non-empty display from From/Reply-To over bare Cc
        if (!prev.display_hint && addr.display) {
          prev.display_hint = addr.display;
        }
        if (
          addr.display &&
          (headerName === "from" || headerName === "reply-to")
        ) {
          prev.display_hint = addr.display;
        }
      } else {
        byEmail.set(email, {
          email,
          display_hint: addr.display || "",
          headers: new Set([headerName]),
        });
      }
    }
  }

  // Ingest all; order of ingest doesn't decide primary
  for (const h of ["reply-to", "from", "to", "cc"]) {
    ingest(h);
  }

  if (byEmail.size === 0) return [];

  /** ordered emails for primary candidates */
  const replyToOrder = emailsFromHeader(rawText, "reply-to", exclude, domain);
  const fromOrder = emailsFromHeader(rawText, "from", exclude, domain);
  const toOrder = emailsFromHeader(rawText, "to", exclude, domain);
  const ccOrder = emailsFromHeader(rawText, "cc", exclude, domain);

  let primaryEmail =
    replyToOrder[0] || fromOrder[0] || toOrder[0] || ccOrder[0] || null;
  if (!primaryEmail || !byEmail.has(primaryEmail)) {
    primaryEmail = [...byEmail.keys()][0];
  }

  /** Build others in stable multiparty order: other reply-to → from → to → cc */
  const otherOrder = [];
  const pushUnique = (list) => {
    for (const e of list) {
      if (e === primaryEmail) continue;
      if (!byEmail.has(e)) continue;
      if (otherOrder.includes(e)) continue;
      otherOrder.push(e);
    }
  };
  pushUnique(replyToOrder);
  pushUnique(fromOrder);
  pushUnique(toOrder);
  pushUnique(ccOrder);
  // any leftover
  for (const e of byEmail.keys()) {
    if (e !== primaryEmail && !otherOrder.includes(e)) otherOrder.push(e);
  }

  function roleFor(email, headers) {
    if (email === primaryEmail) return "primary";
    if (headers.has("reply-to")) return "reply-to";
    if (headers.has("from")) return "from";
    if (headers.has("cc")) return "cc";
    if (headers.has("to")) return "to";
    return "other";
  }

  function mainHeader(email, headers) {
    if (email === primaryEmail) {
      if (headers.has("reply-to")) return "reply-to";
      if (headers.has("from")) return "from";
    }
    for (const h of ["reply-to", "from", "to", "cc"]) {
      if (headers.has(h)) return h;
    }
    return "other";
  }

  const primaryMeta = byEmail.get(primaryEmail);
  const out = [
    {
      email: primaryEmail,
      display_hint: primaryMeta.display_hint,
      role: "primary",
      header: mainHeader(primaryEmail, primaryMeta.headers),
      is_primary: true,
    },
  ];
  for (const e of otherOrder) {
    const meta = byEmail.get(e);
    out.push({
      email: e,
      display_hint: meta.display_hint,
      role: roleFor(e, meta.headers),
      header: mainHeader(e, meta.headers),
      is_primary: false,
    });
  }
  return out;
}

/**
 * @param {string} rawText
 * @param {string} headerName
 * @param {Set<string>} exclude
 * @param {string} domain
 * @returns {string[]}
 */
function emailsFromHeader(rawText, headerName, exclude, domain) {
  const val = getHeader(rawText, headerName);
  if (!val) return [];
  const out = [];
  for (const addr of splitAddresses(val)) {
    const email = addr.email.toLowerCase();
    if (!email.includes("@")) continue;
    if (exclude.has(email)) continue;
    if (recipientDomain(email) === domain) continue;
    if (!out.includes(email)) out.push(email);
  }
  return out;
}

function splitAddresses(val) {
  const parts = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < val.length; i++) {
    const c = val[i];
    if (c === '"') inQuote = !inQuote;
    if (c === "," && !inQuote) {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.map(parseOneAddress).filter(Boolean);
}

function parseOneAddress(s) {
  const raw = String(s || "").trim();
  if (!raw) return null;

  // Angle-addr form: Display Name <user@host> or "Display" <user@host>
  const angle = raw.match(/^(?:"([^"]*)"|([^<]*?))\s*<\s*([^>]+@[^>]+)\s*>\s*$/);
  if (angle) {
    const display = (angle[1] ?? angle[2] ?? "").trim();
    return { display, email: angle[3].trim() };
  }

  // Bare addr-spec — do NOT let optional display group eat local-part
  // (bug: test-azr9s08j7@x.com → name=test-azr9s08j email=7@x.com)
  const bare = raw.replace(/^mailto:/i, "").trim();
  if (/^[^\s<>"]+@[^\s<>"]+$/.test(bare)) {
    return { display: "", email: bare };
  }

  // Last resort: extract first email-shaped token
  const any = bare.match(/[^\s<>"]+@[^\s<>"]+/);
  if (any) {
    return { display: "", email: any[0] };
  }
  return null;
}


export function cfAuthLooksPass(rawText, fromEmail) {
  const ar =
    getHeader(rawText, "authentication-results") ||
    getHeader(rawText, "arc-authentication-results") ||
    "";
  if (!ar) return false;
  const low = ar.toLowerCase();
  const hasPass =
    /dkim=pass/.test(low) || /spf=pass/.test(low) || /dmarc=pass/.test(low);
  if (!hasPass) return false;
  const dom = recipientDomain(fromEmail);
  if (dom === "gmail.com" || dom === "googlemail.com") {
    return /gmail\.com|google\.com|googlemail\.com/.test(low) || hasPass;
  }
  return hasPass;
}
