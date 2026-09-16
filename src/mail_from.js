/**
 * Resolve outbound ESP From (our domain only — never third-party Alice).
 */

import { recipientDomain } from "./config.js";

/**
 * Bare mailbox address for aliases lookup (strip optional "Name" <addr>).
 * @param {string} email
 * @returns {string}
 */
export function bareMailboxAddress(email) {
  let s = String(email || "").trim();
  const angle = s.match(/<([^>]+@[^>]+)>/);
  if (angle) s = angle[1].trim();
  return s.toLowerCase();
}

/**
 * Configured From display name for an alias (Q42).
 * Lookup order: exact mailFrom, then any extra candidate addresses (e.g. pre-remap).
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} email
 * @param {string[]} [alsoTry]
 * @returns {string | undefined}
 */
export function resolveAliasDisplayName(config, email, alsoTry = []) {
  const aliases = config?.aliases;
  if (!aliases || typeof aliases !== "object") return undefined;
  const keys = [email, ...alsoTry]
    .map((e) => bareMailboxAddress(e))
    .filter(Boolean);
  const seen = new Set();
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    const entry = aliases[k];
    const name =
      entry && typeof entry === "object"
        ? String(entry.display_name || "").trim()
        : "";
    if (name) return name;
  }
  return undefined;
}

/**
 * Prefer explicit display, else configured alias display (Q42).
 * @param {import('./config.js').RoutingConfig} config
 * @param {string | undefined | null} explicit
 * @param {string} mailFrom
 * @param {string[]} [alsoTry]
 * @returns {string | undefined}
 */
export function pickFromDisplayName(config, explicit, mailFrom, alsoTry = []) {
  const e = explicit != null ? String(explicit).trim() : "";
  if (e) return e;
  return resolveAliasDisplayName(config, mailFrom, alsoTry);
}

/**
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} domain
 */
export function effectiveSendAs(config, domain) {
  const d = (domain || "").toLowerCase();
  const base = { ...(config.defaults?.send_as || {}) };
  const over = d && config.domains?.[d]?.send_as ? { ...config.domains[d].send_as } : {};
  return { ...base, ...over };
}

/**
 * Whether compose/outbound is allowed for this From domain.
 */
export function sendAsAllowed(config, domain) {
  const d = (domain || "").toLowerCase();
  if (!d) return false;
  if (!config.domains?.[d]) {
    // defaults-only: require defaults.send_as.enabled
    return config.defaults?.send_as?.enabled === true;
  }
  const sa = effectiveSendAs(config, d);
  return sa.enabled === true || Boolean(sa.address) || Boolean(sa.domain);
}

/**
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} fromAddress - requested From
 * @returns {{ ok: true, mailFrom: string, sendAs: object } | { ok: false, error: string }}
 */
export function resolveMailFrom(config, fromAddress) {
  const from = String(fromAddress || "").trim().toLowerCase();
  if (!from || !from.includes("@")) {
    return { ok: false, error: "from address required" };
  }
  const local = from.split("@")[0];
  const domain = recipientDomain(from);
  if (!sendAsAllowed(config, domain)) {
    return { ok: false, error: `send_as not enabled for domain ${domain}` };
  }
  const sa = effectiveSendAs(config, domain);

  if (sa.address) {
    return { ok: true, mailFrom: String(sa.address).toLowerCase(), sendAs: sa };
  }
  if (sa.domain) {
    return {
      ok: true,
      mailFrom: `${local}@${String(sa.domain).toLowerCase()}`,
      sendAs: sa,
    };
  }
  return { ok: true, mailFrom: from, sendAs: sa };
}
