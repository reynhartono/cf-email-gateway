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
 * @param {string} rawText
 * @param {string} name
 */
export function getHeader(rawText, name) {
  const want = name.toLowerCase();
  const head = rawText.split(/\r?\n\r?\n/, 1)[0] || "";
  const lines = head.split(/\r?\n/);
  let cur = null;
  const map = new Map();
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) {
      map.set(cur, map.get(cur) + " " + line.trim());
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      cur = m[1].toLowerCase();
      map.set(cur, m[2]);
    }
  }
  return map.get(want) ?? null;
}

/**
 * @param {import('./config.js').RoutingConfig} config
 * @param {string} envelopeTo
 * @param {(cfg: object, to: string, dest?: object) => string} resolveDriver
 *
 * Rules supply extra destinations. default_inbox is **always** included when set,
 * unless the matched rule has `skip_default_inbox: true`. Dest emails are de-duped.
 */
export function resolveDestinations(config, envelopeTo, resolveDriver) {
  const to = (envelopeTo || "").toLowerCase();
  const rules = config.rules || [];

  for (const rule of rules) {
    const m = rule.match || {};
    if (m.type === "address" && (m.value || "").toLowerCase() === to) {
      return finalize(config, envelopeTo, rule, rule.destinations, resolveDriver);
    }
  }

  const domain = to.includes("@") ? to.split("@").pop() : "";
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
