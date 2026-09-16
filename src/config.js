/**
 * Load and normalize routing config (YAML).
 */

import YAML from "yaml";
import { normalizeIdentities } from "./identity.js";
import {
  matchClaimsReservedLocal,
  splitEnvelopeTo,
} from "./util.js";

/** Feature gates (product surface) */
export const FEATURES = {
  /** Compose / send-proxy / reply-hop outbound via SMTP */
  provider_send: true,
  /** Mint reply tokens + X-CFEG-* on cf_forward */
  reply_tokens_on_forward: true,
};

/**
 * @param {string} text
 * @returns {object}
 */
export function parseRoutingYaml(text) {
  const raw = YAML.parse(text);
  if (!raw || typeof raw !== "object") {
    throw new Error("routing config: root must be a mapping");
  }
  if (raw.version !== 1 && raw.version !== "1") {
    throw new Error(`routing config: unsupported version ${raw.version}`);
  }
  return normalizeConfig(raw);
}

/**
 * Local `r` is reserved for reply-token grammar (`r+TOKEN@`).
 * Ban bare `r@…` and prefix `r.` on rules, identities, and sensitive defaults.
 * @param {string | undefined} email
 * @param {string} where
 */
function assertEmailNotReservedLocal(email, where) {
  if (email == null || email === "") return;
  const { local } = splitEnvelopeTo(String(email).trim().toLowerCase());
  if (local === "r" || local.startsWith("r.")) {
    throw new Error(
      `routing config: reserved local "r" forbidden in ${where}: ${email}`,
    );
  }
}

/**
 * @param {{ type?: string, value?: string, domain?: string }} match
 * @param {string} where
 */
function assertMatchNotReserved(match, where) {
  if (!match || typeof match !== "object") return;
  if (matchClaimsReservedLocal(match)) {
    throw new Error(
      `routing config: reserved local "r" / prefix "r." forbidden in ${where}`,
    );
  }
}

/**
 * @param {import('./config.js').RoutingConfig} config
 */
function assertNoReservedPersonLocal(config) {
  assertEmailNotReservedLocal(config.default_inbox, "default_inbox");
  assertEmailNotReservedLocal(config.compose?.default_from, "compose.default_from");

  for (const rule of config.rules || []) {
    const id = rule?.id != null ? String(rule.id) : "(unnamed)";
    assertMatchNotReserved(rule?.match, `rules[${id}].match`);
  }

  for (const identity of config.identities || []) {
    const id = identity?.id != null ? String(identity.id) : "(unnamed)";
    for (const m of identity.can_send_as || []) {
      assertMatchNotReserved(m, `identities[${id}].can_send_as`);
    }
  }
}

/**
 * Keep only known send_as fields (enabled, multiparty, domain, address, …).
 * @param {object} sa
 */
function normalizeSendAs(sa) {
  if (!sa || typeof sa !== "object") return { enabled: false, multiparty: true };
  const out = {
    enabled: sa.enabled === true,
    multiparty: sa.multiparty !== false,
  };
  if (sa.domain != null) out.domain = sa.domain;
  if (sa.address != null) out.address = sa.address;
  return out;
}

/**
 * @param {object} raw
 */
export function normalizeConfig(raw) {
  const defaults = raw.defaults ?? {};
  const sendAs = normalizeSendAs({
    enabled: false,
    multiparty: true,
    ...(defaults.send_as ?? {}),
  });

  const archiveEnabled =
    raw.archive && typeof raw.archive.enabled === "boolean"
      ? raw.archive.enabled
      : true;

  const domains = {};
  if (raw.domains && typeof raw.domains === "object") {
    for (const [k, v] of Object.entries(raw.domains)) {
      if (!v || typeof v !== "object") {
        domains[k] = v;
        continue;
      }
      const d = { ...v };
      if (d.send_as && typeof d.send_as === "object") {
        d.send_as = normalizeSendAs({ ...sendAs, ...d.send_as });
      }
      domains[k] = d;
    }
  }

  const config = {
    version: 1,
    default_inbox: raw.default_inbox ?? undefined,
    archive: { enabled: archiveEnabled },
    defaults: {
      provider: defaults.provider ?? "smtp",
      send_as: sendAs,
      reply_as: defaults.reply_as ?? {},
    },
    compose: {
      default_from: raw.compose?.default_from ?? undefined,
    },
    reply_tokens: {
      /** Add X-CFEG-Reply-To etc. on cf_forward (extension-friendly). Default on. */
      enabled: raw.reply_tokens?.enabled !== false,
    },
    token_auth: {
      authorized_from: Array.isArray(raw.token_auth?.authorized_from)
        ? raw.token_auth.authorized_from.map(String)
        : [],
    },
    identities: normalizeIdentities(raw),
    domains,
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };
  assertNoReservedPersonLocal(config);
  return config;
}

export function archiveEnabled(config, rule) {
  if (rule && typeof rule.archive === "boolean") return rule.archive;
  return Boolean(config.archive?.enabled);
}

export function recipientDomain(email) {
  if (!email || typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  return email.slice(at + 1).toLowerCase();
}

export function resolveSendAs(config, envelopeTo) {
  const apex = recipientDomain(envelopeTo);
  const base = { ...(config.defaults?.send_as ?? {}) };
  const over =
    apex && config.domains?.[apex]?.send_as ? config.domains[apex].send_as : {};
  return { ...base, ...over };
}

/**
 * Mint X-CFEG reply tokens on cf_forward only when:
 * - global reply_tokens.enabled (default true), and
 * - envelope domain has send_as.enabled (reply hop / send-proxy apex).
 * Archive-only Worker zones keep cf_forward without r+ tokens.
 */
export function replyTokensWanted(config, envelopeTo) {
  if (!FEATURES.reply_tokens_on_forward) return false;
  if (config.reply_tokens?.enabled === false) return false;
  return resolveSendAs(config, envelopeTo).enabled === true;
}

/**
 * Inbound delivery driver. Default cf_forward.
 * provider_send / smtp only when explicitly set.
 */
export function resolveDriver(config, envelopeTo, dest = {}) {
  const explicit = dest.method;
  if (explicit === "cf_forward" || explicit == null || explicit === "") {
    return "cf_forward";
  }

  if (
    explicit === "provider_send" ||
    explicit === "smtp" ||
    explicit === "smtp2go"
  ) {
    if (!FEATURES.provider_send) {
      throw new Error("provider_send not enabled");
    }
    return "provider_send";
  }

  // Unknown method → default inbound path
  return "cf_forward";
}
