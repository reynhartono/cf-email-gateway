/**
 * Pure helpers: hashing, ids, header parse, destination resolution.
 */

/**
 * @param {ArrayBuffer | Uint8Array} data
 */
export async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer;
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomId() {
  return crypto.randomUUID();
}

/**
 * @param {string} envelopeFrom
 * @param {string} envelopeTo
 * @param {string} messageId
 * @param {string} rawSha256
 *
 * When Message-ID is present, ignore raw body hash so CF/sender retries
 * (re-stamped MIME) still map to the same inbound + skip succeeded dests.
 * Without Message-ID, fall back to raw_sha256.
 */
export function normalizeMessageId(messageId) {
  return String(messageId || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

export function buildDedupeKey(envelopeFrom, envelopeTo, messageId, rawSha256) {
  const from = String(envelopeFrom || "").trim().toLowerCase();
  const to = String(envelopeTo || "").trim().toLowerCase();
  const mid = normalizeMessageId(messageId);
  if (mid) {
    return `mid\n${from}\n${to}\n${mid}`;
  }
  return `raw\n${from}\n${to}\n${rawSha256 || ""}`;
}

/**
 * Async dedupe key = sha256 of canonical string
 */
export async function dedupeKeyHex(envelopeFrom, envelopeTo, messageId, rawSha256) {
  const s = buildDedupeKey(envelopeFrom, envelopeTo, messageId, rawSha256);
  return sha256Hex(new TextEncoder().encode(s));
}

/**
 * Minimal header get (case-insensitive) from raw RFC822 text prefix.
 * Last occurrence wins when the same name appears more than once.
 * @param {string} rawText
 * @param {string} name
 */
export function getHeader(rawText, name) {
  const all = getAllHeaders(rawText, name);
  return all.length ? all[all.length - 1] : null;
}

/**
 * All values for a header name (case-insensitive), in appearance order.
 * Folded continuation lines are joined with a space.
 * @param {string} rawText
 * @param {string} name
 * @returns {string[]}
 */
export function getAllHeaders(rawText, name) {
  const want = name.toLowerCase();
  const head = rawText.split(/\r?\n\r?\n/, 1)[0] || "";
  const lines = head.split(/\r?\n/);
  let cur = null;
  let curVal = "";
  const out = [];
  const flush = () => {
    if (cur === want && curVal !== "") out.push(curVal);
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) {
      curVal = curVal + " " + line.trim();
      continue;
    }
    flush();
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      cur = m[1].toLowerCase();
      curVal = m[2];
    } else {
      cur = null;
      curVal = "";
    }
  }
  flush();
  return out;
}

/**
 * Split envelope To into local-part + domain (lowercased). Invalid → empty parts.
 * @param {string} toLower
 * @returns {{ local: string, domain: string }}
 */
export function splitEnvelopeTo(toLower) {
  const s = String(toLower || "");
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return { local: "", domain: "" };
  return { local: s.slice(0, at), domain: s.slice(at + 1) };
}

/**
 * Reply-token local grammar (mirrors parseReplyTokenAddress) — keep in sync.
 * @param {string} local
 */
export function isReplyTokenLocal(local) {
  return /^r\+([a-z0-9]+)(?:\.(all|p\d+))?$/i.test(String(local || ""));
}

/**
 * Send-proxy local grammar (mirrors parseSendProxyAddress) — keep in sync.
 * Requires + and = (person tags like alice+promo have no =).
 * @param {string} local
 */
export function isSendProxyLocal(local) {
  const s = String(local || "");
  if (!s.includes("+") || !s.includes("=")) return false;
  return /^([^+{]+)(?:\{([^}]*)\})?\+([^=,{]+)(?:\{([^}]*)\})?=([^@]+)$/i.test(s);
}

/**
 * Strip person-style plus-tag before the first `+` only (never glue-concat).
 * `alice+promo` → `alice`; `alice+bob=gmail.com` → `alice`.
 * Does **not** strip CFEG send-proxy `{display}` braces — use
 * `stripSendProxyAliasForRuleMatch` for proxy-shaped locals.
 * @param {string} local
 * @returns {string}
 */
export function stripPersonPlusTag(local) {
  const s = String(local || "");
  if (!s) return s;
  const plus = s.indexOf("+");
  if (plus >= 0) return s.slice(0, plus);
  return s;
}

/**
 * Person-base local for **rule_match** on send-proxy-shaped To (exception skip).
 * Mirrors `parseSendProxyAddress` alias capture: drop optional `{display}` after
 * the alias so `alice{Bob}+user=domain` → `alice` (same as successful proxy
 * `aliasLocal`), not `alice{Bob}`.
 * @param {string} local
 * @returns {string}
 */
export function stripSendProxyAliasForRuleMatch(local) {
  const s = String(local || "");
  if (!s) return s;
  // Keep in sync with parseSendProxyAddress / isSendProxyLocal.
  const m = s.match(
    /^([^+{]+)(?:\{([^}]*)\})?\+([^=,{]+)(?:\{([^}]*)\})?=([^@]+)$/i,
  );
  if (m && m[1]) return m[1].trim().toLowerCase();
  // Fallback: before first + only (no brace-aware parse).
  return stripPersonPlusTag(s);
}

/**
 * Reserved person local for reply-token grammar (`r+TOKEN@`).
 * Bare `r` and namespace prefix `r.` must never be person mailboxes.
 * @param {string} local routing-normalized or raw local-part
 */
export function isReservedPersonLocal(local) {
  const s = String(local || "").toLowerCase();
  return s === "r" || s.startsWith("r.");
}

/**
 * Whether a rule / can_send_as match claims reserved local `r` / prefix `r.`.
 * @param {{ type?: string, value?: string, domain?: string }} match
 */
export function matchClaimsReservedLocal(match) {
  if (!match || typeof match !== "object") return false;
  const type = String(match.type || "");
  if (type === "address") {
    const { local } = splitEnvelopeTo(String(match.value || "").toLowerCase());
    // Same set as isReservedPersonLocal / assertEmailNotReservedLocal (Q37):
    // bare `r` and any `r.*` address — not only bare `r@`.
    return isReservedPersonLocal(local);
  }
  if (type === "local_part_prefix") {
    const prefix = String(match.value || "").toLowerCase();
    // Exact reserved namespace only — `ryan.` is not reserved.
    return prefix === "r." || prefix === "r";
  }
  return false;
}

/**
 * RFC 5233-style plus-tag strip for **match only**.
 * Does not rewrite envelope To stored in D1 / logs / archive.
 *
 * @param {string} local already-lowercased local-part
 * @param {{ purpose?: 'rule_match' | 'can_send_as' }} [opts]
 *   - `rule_match` (default, inbound resolveDestinations): strip person tags **and**
 *     send-proxy-shaped locals (`alice+bob=gmail.com` → `alice`;
 *     `alice{Name}+bob=gmail.com` → `alice`) so exception-skip default forward
 *     still hits person bare/prefix rules. **Never** strip `r+…` (Option A).
 *   - `can_send_as` (outbound identity ACL): strip person tags only; leave r+ and
 *     send-proxy-shaped From locals unchanged (Q36).
 * @returns {string}
 */
export function normalizeLocalForRouting(local, opts = {}) {
  const s = String(local || "");
  if (!s) return s;
  // Option A: reply-token locals never strip on any purpose.
  if (isReplyTokenLocal(s)) return s;
  if (isSendProxyLocal(s)) {
    if (opts.purpose === "can_send_as") return s;
    return stripSendProxyAliasForRuleMatch(s);
  }
  return stripPersonPlusTag(s);
}

/**
 * @param {object} match rule.match
 * @param {string} local
 * @param {string} domain
 */
export function matchLocalPartPrefix(match, local, domain) {
  if (matchClaimsReservedLocal(match)) return false;
  const prefix = String(match.value || "").toLowerCase();
  // Namespace lock: require trailing "." so "yumi" cannot claim "yuminetflix".
  // Bare vanity is match.type=address only (yumi@apex).
  if (!prefix || !prefix.endsWith(".")) return false;
  const wantDomain = String(match.domain || "").toLowerCase();
  if (!wantDomain || domain !== wantDomain) return false;
  // Defense: never treat routing local `r` / `r.*` as a normal person hit.
  if (isReservedPersonLocal(local)) return false;
  return local.startsWith(prefix);
}

/**
 * Outbound From display name (Q42).
 * Tiers (first hit wins):
 *   1. rule match.type=address with optional display_name
 *   2. rule match.type=local_part_prefix with optional display_name
 *   3. domains.<apex>.display_name (domain default when no rule name)
 *   4. defaults.display_name (global fallback)
 * catch_all rules are not used for From display. Rule display_name is always
 * optional — omit → fall through. Subaddress-normalized local for match input.
 *
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} mailbox - full alias / our_mailbox / mailFrom
 * @returns {string | undefined}
 */
export function resolveRuleDisplayName(config, mailbox) {
  const to = String(mailbox || "")
    .trim()
    .toLowerCase();
  if (!to || !to.includes("@")) return undefined;
  const rules = config?.rules || [];
  const { local, domain } = splitEnvelopeTo(to);
  const routingLocal = normalizeLocalForRouting(local, { purpose: "rule_match" });
  const routingTo =
    routingLocal && domain ? `${routingLocal}@${domain}` : to;

  for (const rule of rules) {
    const m = rule?.match || {};
    if (m.type !== "address") continue;
    if (matchClaimsReservedLocal(m)) continue;
    if (isReservedPersonLocal(routingLocal)) continue;
    if ((m.value || "").toLowerCase() !== routingTo) continue;
    const name = String(rule.display_name || "").trim();
    if (name) return name;
    // Matched address rule without display_name → keep looking (prefix / domain)
  }

  for (const rule of rules) {
    const m = rule?.match || {};
    if (m.type !== "local_part_prefix") continue;
    if (!matchLocalPartPrefix(m, routingLocal, domain)) continue;
    const name = String(rule.display_name || "").trim();
    if (name) return name;
    // Matched prefix without name → keep looking (domain default)
  }

  if (domain) {
    const domName = String(
      config?.domains?.[domain]?.display_name || "",
    ).trim();
    if (domName) return domName;
  }

  const defName = String(config?.defaults?.display_name || "").trim();
  if (defName) return defName;

  return undefined;
}

/**
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} envelopeTo
 * @param {(cfg: object, to: string, dest?: object) => string} resolveDriver
 *
 * Rules supply extra destinations. default_inbox is **always** included when set,
 * unless the matched rule has `skip_default_inbox: true`. Dest emails are de-duped.
 *
 * Match tiers (higher wins regardless of YAML order within lower tiers):
 *   1. address (exact on subaddress-normalized local + domain)
 *   2. local_part_prefix (first matching rule in YAML order; normalized local)
 *   3. catch_all (optional domain in match.value)
 *   4. default_inbox / ingest-only
 *
 * Envelope To stored elsewhere stays raw; only match input is normalized.
 */
export function resolveDestinations(config, envelopeTo, resolveDriver) {
  const to = (envelopeTo || "").toLowerCase();
  const rules = config.rules || [];
  const { local, domain } = splitEnvelopeTo(to);
  const routingLocal = normalizeLocalForRouting(local, { purpose: "rule_match" });
  const routingTo =
    routingLocal && domain ? `${routingLocal}@${domain}` : to;

  for (const rule of rules) {
    const m = rule.match || {};
    if (m.type !== "address") continue;
    // Config validate bans these; runtime skip if invalid config slipped through.
    if (matchClaimsReservedLocal(m)) continue;
    if (isReservedPersonLocal(routingLocal)) continue;
    if ((m.value || "").toLowerCase() === routingTo) {
      return finalize(config, envelopeTo, rule, rule.destinations, resolveDriver);
    }
  }

  for (const rule of rules) {
    const m = rule.match || {};
    if (
      m.type === "local_part_prefix" &&
      matchLocalPartPrefix(m, routingLocal, domain)
    ) {
      return finalize(config, envelopeTo, rule, rule.destinations, resolveDriver);
    }
  }

  for (const rule of rules) {
    const m = rule.match || {};
    if (m.type === "catch_all") {
      if (!m.value || (m.value || "").toLowerCase() === domain) {
        return finalize(config, envelopeTo, rule, rule.destinations, resolveDriver);
      }
    }
  }

  if (config.default_inbox) {
    return finalize(config, envelopeTo, null, [{ email: config.default_inbox }], resolveDriver);
  }

  return { ruleId: null, rule: null, destinations: [] };
}

function finalize(config, envelopeTo, rule, list, resolveDriver) {
  let destinations = normalizeDests(config, envelopeTo, list, resolveDriver);
  destinations = withDefaultInbox(config, envelopeTo, rule, destinations, resolveDriver);
  return {
    ruleId: rule?.id ?? null,
    rule: rule ?? null,
    destinations,
  };
}

/**
 * Append default_inbox unless skip_default_inbox on rule or already listed.
 */
function withDefaultInbox(config, envelopeTo, rule, dests, resolveDriver) {
  if (!config.default_inbox) return dests;
  if (rule && rule.skip_default_inbox === true) return dests;
  const di = String(config.default_inbox).toLowerCase();
  if (dests.some((d) => d.email === di)) return dests;
  const extra = normalizeDests(
    config,
    envelopeTo,
    [{ email: config.default_inbox }],
    resolveDriver,
  );
  return dests.concat(extra);
}

function normalizeDests(config, envelopeTo, list, resolveDriver) {
  const out = [];
  for (const d of list || []) {
    if (!d?.email) continue;
    const method = resolveDriver(config, envelopeTo, d);
    out.push({
      email: String(d.email).toLowerCase(),
      method,
      provider: d.provider ?? config.defaults?.provider ?? null,
      send_as: d.send_as ?? null,
    });
  }
  return out;
}
