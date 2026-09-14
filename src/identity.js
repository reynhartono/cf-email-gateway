/**
 * Multi-person identity ACL: who may From / reply-hop as which mailboxes.
 *
 * When config.identities is non-empty, outbound paths enforce ownership.
 * When empty, legacy behavior (global token_auth.authorized_from + open compose From).
 */

import { splitEnvelopeTo } from "./util.js";

/**
 * @param {object} raw
 * @returns {import('./config.js').Identity[]}
 */
export function normalizeIdentities(raw) {
  const list = Array.isArray(raw?.identities) ? raw.identities : [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || "").trim();
    if (!id) continue;
    const authorized_from = Array.isArray(row.authorized_from)
      ? row.authorized_from.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      : [];
    const can_send_as = Array.isArray(row.can_send_as)
      ? row.can_send_as
          .filter((m) => m && typeof m === "object" && m.type)
          .map((m) => ({
            type: String(m.type),
            value: m.value != null ? String(m.value) : "",
            domain: m.domain != null ? String(m.domain).toLowerCase() : "",
          }))
      : [];
    const compose_bearer =
      row.compose_bearer != null && String(row.compose_bearer).length
        ? String(row.compose_bearer)
        : null;
    out.push({
      id,
      authorized_from,
      can_send_as,
      compose_bearer,
      unrestricted: row.unrestricted === true,
    });
  }
  return out;
}

/** @param {import('./config.js').RoutingConfig} config */
export function identitiesEnabled(config) {
  return Array.isArray(config?.identities) && config.identities.length > 0;
}

/**
 * Union of identity authorized_from + legacy token_auth.authorized_from.
 * @param {import('./config.js').RoutingConfig} config
 * @returns {string[]}
 */
export function effectiveAuthorizedFrom(config) {
  const set = new Set(
    (config?.token_auth?.authorized_from || []).map((x) =>
      String(x).trim().toLowerCase(),
    ),
  );
  for (const id of config?.identities || []) {
    for (const e of id.authorized_from || []) set.add(e);
  }
  return [...set].filter(Boolean);
}

/**
 * @param {string} email header or bare
 */
export function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase()
    .replace(/^.*</, "")
    .replace(/>.*$/, "")
    .trim();
}

/**
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} email
 * @returns {import('./config.js').Identity | null}
 */
export function findIdentityByAuthorizedFrom(config, email) {
  const e = normalizeEmail(email);
  if (!e || !identitiesEnabled(config)) return null;
  for (const id of config.identities) {
    if ((id.authorized_from || []).includes(e)) return id;
  }
  return null;
}

/**
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} bearer
 * @returns {import('./config.js').Identity | null}
 */
export function findIdentityByComposeBearer(config, bearer) {
  const b = String(bearer || "");
  if (!b || !identitiesEnabled(config)) return null;
  for (const id of config.identities) {
    if (id.compose_bearer && id.compose_bearer === b) return id;
  }
  return null;
}

/**
 * First unrestricted identity (operator).
 * @param {import('./config.js').RoutingConfig} config
 */
export function findUnrestrictedIdentity(config) {
  if (!identitiesEnabled(config)) return null;
  return config.identities.find((i) => i.unrestricted === true) || null;
}

/**
 * Whether identity may use mailbox as outbound From / reply hop our_mailbox.
 * @param {import('./config.js').Identity | null | undefined} identity
 * @param {string} mailbox
 */
export function identityMaySendAs(identity, mailbox) {
  if (!identity) return false;
  if (identity.unrestricted === true) return true;
  const mb = normalizeEmail(mailbox);
  if (!mb.includes("@")) return false;
  const { local, domain } = splitEnvelopeTo(mb);

  for (const m of identity.can_send_as || []) {
    if (m.type === "address") {
      if ((m.value || "").toLowerCase() === mb) return true;
      continue;
    }
    if (m.type === "local_part_prefix") {
      const prefix = String(m.value || "").toLowerCase();
      const wantDomain = String(m.domain || "").toLowerCase();
      // Same lock as inbound: trailing "." required — bare local is type=address only.
      // "yumi." allows yumi.netflix@; rejects yuminetflix@ (other person may own that local).
      if (!prefix || !prefix.endsWith(".") || !wantDomain) continue;
      if (domain === wantDomain && local.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * @param {import('./config.js').Identity | null | undefined} identity
 * @param {string} mailbox
 */
export function assertMailboxAllowedOrThrow(identity, mailbox) {
  if (identityMaySendAs(identity, mailbox)) return;
  const id = identity?.id || "(none)";
  const err = new Error(
    `identity ${id} not allowed to send/reply as ${normalizeEmail(mailbox)}`,
  );
  err.code = "identity_mailbox_denied";
  err.retryable = false;
  throw err;
}

/**
 * Resolve HTTP compose caller from Bearer token.
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} gotBearer
 * @param {string} composeApiToken env COMPOSE_API_TOKEN
 * @returns {{ ok: true, identity: object, legacy?: boolean } | { ok: false, error: string, status?: number }}
 */
export function resolveComposeCaller(config, gotBearer, composeApiToken) {
  const got = String(gotBearer || "").trim();
  const envTok = String(composeApiToken || "").trim();

  if (!envTok && !identitiesEnabled(config)) {
    return { ok: false, error: "COMPOSE_API_TOKEN not configured", status: 503 };
  }

  // Legacy: no identities → single env token = unrestricted operator
  if (!identitiesEnabled(config)) {
    if (!envTok) {
      return { ok: false, error: "COMPOSE_API_TOKEN not configured", status: 503 };
    }
    if (got !== envTok) {
      return { ok: false, error: "unauthorized", status: 401 };
    }
    return {
      ok: true,
      legacy: true,
      identity: {
        id: "legacy_operator",
        unrestricted: true,
        authorized_from: [],
        can_send_as: [],
        compose_bearer: null,
      },
    };
  }

  // Principal-specific bearer
  const byBearer = findIdentityByComposeBearer(config, got);
  if (byBearer) {
    return { ok: true, identity: byBearer };
  }

  // Env COMPOSE_API_TOKEN → unrestricted identity only
  if (envTok && got === envTok) {
    const op = findUnrestrictedIdentity(config);
    if (!op) {
      return {
        ok: false,
        error:
          "COMPOSE_API_TOKEN requires an identities[].unrestricted operator when identities are configured",
        status: 403,
      };
    }
    return { ok: true, identity: op };
  }

  return { ok: false, error: "unauthorized", status: 401 };
}

/**
 * Reply / send-proxy: resolve acting identity from envelope/header From.
 * @returns {{ ok: true, identity: object | null, legacy: boolean } | { ok: false, error: string }}
 */
export function resolveInboundActor(config, envelopeFrom, headerFrom) {
  if (!identitiesEnabled(config)) {
    return { ok: true, legacy: true, identity: null };
  }
  const a =
    findIdentityByAuthorizedFrom(config, envelopeFrom) ||
    findIdentityByAuthorizedFrom(config, headerFrom);
  if (!a) {
    return {
      ok: false,
      error: "sender not bound to an identity (authorized_from)",
    };
  }
  return { ok: true, legacy: false, identity: a };
}
