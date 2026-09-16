/**
 * Reply tokens: parse r+, participants, CF auth check, mailbox format
 */

import { recipientDomain } from "./config.js";
import { getAllHeaders, getHeader } from "./util.js";

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


/**
 * Canonicalize mailbox domains for alignment (googlemail ↔ gmail).
 * @param {string} dom
 */
function canonicalizeAuthDomain(dom) {
  const d = String(dom || "")
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/\.$/, "");
  if (d === "googlemail.com") return "gmail.com";
  return d;
}

/**
 * Relaxed domain alignment: exact match, or one is a labeled subdomain of the other.
 * Also treats gmail.com / googlemail.com as the same org; google.com aligns to gmail From
 * (Gmail often DKIM-signs with d=google.com / i=@google.com in some paths).
 * @param {string} fromDomain domain of the identity we are authorizing
 * @param {string} authDomain domain extracted from AR props
 */
export function domainsAlignForAuth(fromDomain, authDomain) {
  const a = canonicalizeAuthDomain(fromDomain);
  const b = canonicalizeAuthDomain(authDomain);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith("." + b) || b.endsWith("." + a)) return true;
  // Gmail From may be authenticated under google.com signing domain
  if (
    (a === "gmail.com" || a === "google.com") &&
    (b === "gmail.com" || b === "google.com")
  ) {
    return true;
  }
  return false;
}

/**
 * Extract domain from an AR property value (addr-spec or bare domain).
 * @param {string} raw
 */
function domainFromArValue(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^<|>$/g, "");
  if (!s) return "";
  const at = s.lastIndexOf("@");
  if (at >= 0) return canonicalizeAuthDomain(s.slice(at + 1));
  return canonicalizeAuthDomain(s);
}

/**
 * Parse one Authentication-Results / ARC-Authentication-Results payload
 * into method results with property map.
 * @param {string} arValue header body (may include authserv-id)
 * @returns {{ authservId: string, methods: Array<{ method: string, result: string, props: Record<string,string> }> }}
 */
export function parseAuthenticationResults(arValue) {
  let text = String(arValue || "").trim();
  if (!text) return { authservId: "", methods: [] };

  // ARC-Authentication-Results often starts with instance tag: i=1; authserv-id; ...
  text = text.replace(/^i\s*=\s*\d+\s*;\s*/i, "");

  // authserv-id is the first token before ';' (may include version)
  const semi = text.indexOf(";");
  const authservId = (semi >= 0 ? text.slice(0, semi) : text)
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  const rest = semi >= 0 ? text.slice(semi + 1) : "";

  /** @type {Array<{ method: string, result: string, props: Record<string,string> }>} */
  const methods = [];
  // Split on ';' but keep method chunks
  for (const chunk of rest.split(";")) {
    const c = chunk.trim();
    if (!c) continue;
    // method=result ...props
    const m = c.match(
      /^([a-z0-9][a-z0-9_-]*)\s*=\s*([a-z0-9][a-z0-9_-]*)\b(.*)$/i,
    );
    if (!m) continue;
    const method = m[1].toLowerCase();
    const result = m[2].toLowerCase();
    /** @type {Record<string, string>} */
    const props = {};
    const propRe =
      /\b([a-z0-9._-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;]+))/gi;
    let pm;
    const propStr = m[3] || "";
    while ((pm = propRe.exec(propStr)) !== null) {
      const key = pm[1].toLowerCase();
      const val = (pm[2] ?? pm[3] ?? pm[4] ?? "").trim();
      props[key] = val;
    }
    methods.push({ method, result, props });
  }
  return { authservId, methods };
}

/**
 * Collect Authentication-Results / ARC-Authentication-Results from the
 * receiving ADMD only. Cloudflare Email Routing injects an authserv-id
 * containing "cloudflare"; client-supplied AR alone must not authorize
 * hop/proxy (fail closed if no CF line is present).
 * @param {string} rawText
 * @returns {string[]}
 */
function collectAuthResultsHeaders(rawText) {
  const ar = getAllHeaders(rawText, "authentication-results");
  const arc = getAllHeaders(rawText, "arc-authentication-results");
  const all = [...ar, ...arc];
  return all.filter((v) => {
    const id = parseAuthenticationResults(v).authservId;
    return /cloudflare/i.test(id);
  });
}

/**
 * True when a **Cloudflare** Authentication-Results line shows an **aligned**
 * pass for the mailbox identity we are authorizing (typically envelope From).
 *
 * Alignment (any one is enough):
 * - dkim=pass with header.d or header.i domain aligned to fromEmail
 * - spf=pass with smtp.mailfrom / smtp.helo domain aligned
 * - dmarc=pass with header.from domain aligned
 *
 * Gmail From: requires google/gmail/googlemail marker on the aligned method
 * (or authserv), never a bare unrelated dkim=pass.
 *
 * Domain alignment is relaxed (subdomain OK) — a compromised subdomain of an
 * allowlisted apex can align; operators should treat apex ownership carefully.
 *
 * @param {string} rawText
 * @param {string} fromEmail identity being authorized (envelope From on hop/proxy)
 */
export function cfAuthLooksPass(rawText, fromEmail) {
  const fromDom = canonicalizeAuthDomain(recipientDomain(fromEmail));
  if (!fromDom) return false;

  const headers = collectAuthResultsHeaders(rawText);
  if (!headers.length) return false;

  const isGmailFrom = fromDom === "gmail.com";

  for (const arValue of headers) {
    const { authservId, methods } = parseAuthenticationResults(arValue);
    for (const { method, result, props } of methods) {
      if (result !== "pass") continue;

      let authDom = "";
      if (method === "dkim") {
        authDom =
          domainFromArValue(props["header.d"] || "") ||
          domainFromArValue(props["header.i"] || "") ||
          domainFromArValue(props.d || "") ||
          domainFromArValue(props.i || "");
      } else if (method === "spf") {
        authDom =
          domainFromArValue(props["smtp.mailfrom"] || "") ||
          domainFromArValue(props["smtp.helo"] || "") ||
          domainFromArValue(props.mailfrom || "");
      } else if (method === "dmarc") {
        authDom =
          domainFromArValue(props["header.from"] || "") ||
          domainFromArValue(props.from || "");
      } else {
        continue;
      }

      if (!authDom || !domainsAlignForAuth(fromDom, authDom)) continue;

      if (isGmailFrom) {
        // Narrow Gmail acceptance: aligned domain must be google ecosystem,
        // or authserv-id must look like Google/CF evaluating Gmail.
        const googleish =
          /^(gmail\.com|google\.com|googlemail\.com)$/.test(authDom) ||
          /gmail\.com|google\.com|googlemail\.com/i.test(authservId);
        if (!googleish) continue;
      }

      return true;
    }
  }
  return false;
}
