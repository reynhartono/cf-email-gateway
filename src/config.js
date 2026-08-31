/**
 * Load and normalize routing config (YAML).
 */

import YAML from "yaml";

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

  return {
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
    domains,
    rules: Array.isArray(raw.rules) ? raw.rules : [],
  };
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
