/**
 * Load and normalize routing config (YAML).
 */

import YAML from "yaml";
import { normalizeIdentities } from "./identity.js";
import { assertRefShapes, classifyRef } from "./config_refs.js";
import {
  isReservedPersonLocal,
  matchClaimsReservedLocal,
  splitEnvelopeTo,
} from "./util.js";
import { bareEmail } from "./providers/smtp.js";

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
  if (isReservedPersonLocal(local)) {
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
 * Named outbound providers (issue #37): `providers.<name>` with `kind` +
 * kind-specific `config`. `kind` and provider names are always literals;
 * any string inside `config` may be a literal or a whole-value
 * `${SECRET_NAME}` reference (resolved against env at send time).
 *
 * This cut supports `kind: smtp` only — unknown kinds fail closed so a
 * future sender type cannot silently ride on the SMTP path. `config`
 * schemas are strict per kind: unknown fields are rejected.
 *
 * @param {unknown} raw
 * @returns {object | undefined} — normalized map, or undefined when absent.
 */
function normalizeProviders(raw) {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("routing config: providers must be a mapping");
  }
  const out = {};
  for (const [name, p] of Object.entries(raw)) {
    const where = `providers.${name}`;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      throw new Error(`routing config: ${where} must be a mapping`);
    }
    if (p.kind !== "smtp") {
      throw new Error(
        `routing config: ${where}.kind must be "smtp" (got ${JSON.stringify(p.kind ?? null)})`,
      );
    }
    const cfg = p.config;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      throw new Error(`routing config: ${where}.config must be a mapping`);
    }
    const known = new Set(["host", "port", "tls", "username", "password"]);
    for (const k of Object.keys(cfg)) {
      if (!known.has(k)) {
        throw new Error(`routing config: ${where}.config: unknown field ${JSON.stringify(k)}`);
      }
    }
    // Strict scalar shapes: refs are strings, so string-only fields stay
    // strings; only port also accepts a YAML number. Objects/arrays must
    // never reach the send path as credentials.
    for (const f of ["host", "username", "password", "tls"]) {
      if (cfg[f] != null && typeof cfg[f] !== "string") {
        throw new Error(`routing config: ${where}.config.${f} must be a string`);
      }
    }
    if (cfg.port != null && typeof cfg.port !== "string" && typeof cfg.port !== "number") {
      throw new Error(`routing config: ${where}.config.port must be a string or number`);
    }
    // host is the only non-secret field that must always be present
    // (as a literal or a ${REF} — resolution happens at send time).
    if (cfg.host == null || String(cfg.host).trim() === "") {
      throw new Error(`routing config: ${where}.config.host required`);
    }
    // No unauthenticated providers: both auth fields required, either as
    // non-empty literals or ${REF}s (missing env fails closed at send).
    for (const f of ["username", "password"]) {
      if (cfg[f] == null || String(cfg[f]).trim() === "") {
        throw new Error(`routing config: ${where}.config.${f} required`);
      }
    }
    // Literal tls values must already be valid; ${REF}s are checked
    // against the same enum after resolution at send time (fail closed).
    if (cfg.tls != null && cfg.tls !== "") {
      const c = classifyRef(cfg.tls, `${where}.config.tls`);
      if (c.kind === "literal") {
        const v = String(cfg.tls).trim().toLowerCase();
        if (v !== "on" && v !== "starttls") {
          throw new Error(
            `routing config: ${where}.config.tls must be "on" or "starttls"`,
          );
        }
      }
    }
    // Reference shapes for every string leaf (malformed whole-value
    // `${...}` never silently becomes a literal password).
    assertRefShapes(cfg, `${where}.config`);
    out[name] = { kind: "smtp", config: { ...cfg } };
  }
  return out;
}

/**
 * Optional rule.display_name for outbound MIME From (Q42).
 * @param {unknown} raw
 * @param {string} where
 * @returns {string | undefined}
 */
export function normalizeDisplayName(raw, where = "display_name") {
  if (raw == null || raw === "") return undefined;
  const s = String(raw);
  if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new Error(`routing config: ${where} contains control characters`);
  }
  const display = s.trim();
  if (!display) {
    throw new Error(`routing config: ${where} must be a non-empty string`);
  }
  return display;
}

/**
 * @param {object} rule
 * @param {number} index
 */
function normalizeRule(rule, index) {
  if (!rule || typeof rule !== "object") return rule;
  const id = rule.id != null ? String(rule.id) : `rules[${index}]`;
  const out = { ...rule };
  const rawName = out.display_name ?? out.displayName;
  delete out.displayName;
  if (rawName != null && rawName !== "") {
    out.display_name = normalizeDisplayName(rawName, `${id}.display_name`);
  } else {
    delete out.display_name;
  }
  return out;
}

/**
 * @param {object} raw
 */
export function normalizeConfig(raw) {
  const defaults = raw.defaults ?? {};
  const providers = normalizeProviders(raw.providers);
  const providerNames = providers ? new Set(Object.keys(providers)) : null;
  // Breaking change (issue #37): with a `providers:` map, `provider`
  // names a key in that map and is required. Without the map, outbound
  // fails closed (no free-standing global SMTP_* product path).
  if (providerNames) {
    const dp = defaults.provider != null ? String(defaults.provider).trim() : "";
    if (!dp) {
      throw new Error(
        "routing config: defaults.provider is required when providers: is present",
      );
    }
    if (!providerNames.has(dp)) {
      throw new Error(
        `routing config: unknown provider ${JSON.stringify(dp)} in defaults.provider`,
      );
    }
  }
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
      // Per-domain provider selection (issue #37): optional override of
      // defaults.provider; unknown names fail closed at load.
      if (d.provider != null && d.provider !== "") {
        if (typeof d.provider !== "string" || !d.provider.trim()) {
          throw new Error(
            `routing config: domains.${k}.provider must be a non-empty string`,
          );
        }
        d.provider = d.provider.trim();
        if (!providerNames) {
          throw new Error(
            `routing config: domains.${k}.provider requires providers: map`,
          );
        }
        if (!providerNames.has(d.provider)) {
          throw new Error(
            `routing config: unknown provider ${JSON.stringify(d.provider)} in domains.${k}.provider`,
          );
        }
      } else {
        delete d.provider;
      }
      // Q42: optional domain-wide From display fallback
      const domName = d.display_name ?? d.displayName;
      delete d.displayName;
      if (domName != null && domName !== "") {
        d.display_name = normalizeDisplayName(
          domName,
          `domains.${k}.display_name`,
        );
      } else {
        delete d.display_name;
      }
      domains[k] = d;
    }
  }

  const defaultsDisplay = normalizeDisplayName(
    defaults.display_name ?? defaults.displayName,
    "defaults.display_name",
  );

  const config = {
    version: 1,
    default_inbox: raw.default_inbox ?? undefined,
    archive: { enabled: archiveEnabled },
    defaults: {
      // Only set when providers: is present (operator-chosen ID). Without
      // the map, outbound is unavailable — no legacy "smtp" driver label.
      ...(providerNames != null
        ? { provider: String(defaults.provider).trim() }
        : {}),
      send_as: sendAs,
      reply_as: defaults.reply_as ?? {},
      ...(defaultsDisplay ? { display_name: defaultsDisplay } : {}),
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
    rules: Array.isArray(raw.rules)
      ? raw.rules.map((r, i) => normalizeRule(r, i))
      : [],
    ...(providers ? { providers } : {}),
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
 * Select the named outbound provider for a final MIME From address
 * (issue #37): `domains.<apex>.provider` → `defaults.provider`.
 *
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} mailFrom — already-resolved envelope From
 * @returns {string} — provider name. Requires a non-empty `providers:` map
 *   (legacy global SMTP_* path removed). Names are validated at load; the
 *   re-check here is defense in depth (throws, never silent fallback).
 */
export function resolveProviderName(config, mailFrom) {
  const providers = config?.providers;
  if (providers == null || !Object.keys(providers).length) {
    throw new Error(
      "routing config: providers: map required for outbound " +
        "(legacy global SMTP_* path removed)",
    );
  }
  // Bare-normalize first: display/angle-addr From must not yield apex
  // "example.com>" and skip domains.<apex>.provider (issue #37 review).
  // Empty bare → empty apex → defaults.provider only (never garbage apex).
  const bare = bareEmail(mailFrom);
  const apex = recipientDomain(bare || "");
  const selected =
    (apex && config.domains?.[apex]?.provider) || config.defaults?.provider;
  if (typeof selected !== "string" || !providers[selected]) {
    throw new Error(
      `routing config: unknown provider ${JSON.stringify(selected ?? null)} for ${apex || "(no domain)"}`,
    );
  }
  return selected;
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
