/**
 * Generic outbound mail — SMTP DATA only (no vendor HTTP API).
 */

import { smtpSend, hasSmtp, bareEmail } from "./smtp.js";
import { resolveConfigRefs } from "./provider_refs.js";
import { resolveProviderName } from "../config.js";
import { formatSmtpMailbox } from "../reply_tokens.js";

/** @typedef {{ code: string, message: string, name: string }} ComposeMimeErrorShape */

/**
 * Invalid compose JSON field for MIME construction (caller should 400).
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function composeMimeError(message) {
  const err = new Error(message);
  err.name = "ComposeMimeError";
  err.code = "compose_mime_invalid";
  return err;
}

/**
 * RFC 5322 field-name / token — letters, digits, hyphen only.
 * @param {string} name
 * @returns {string}
 */
export function assertHeaderName(name) {
  const n = String(name);
  if (!/^[A-Za-z0-9-]+$/.test(n)) {
    throw composeMimeError(`invalid header name: ${JSON.stringify(n)}`);
  }
  return n;
}

/**
 * Single-line header value: CR/LF → space (never a new header line).
 * @param {unknown} v
 * @returns {string}
 */
export function sanitizeHeaderValue(v) {
  return String(v ?? "").replace(/[\r\n]+/g, " ");
}

/**
 * Reject control chars that break header lines (fail closed for addresses).
 * @param {string} label
 * @param {unknown} v
 * @returns {string}
 */
export function assertNoHeaderControlChars(label, v) {
  const s = String(v ?? "");
  if (/[\r\n]/.test(s)) {
    throw composeMimeError(
      `${label} contains CR/LF control characters (header injection)`,
    );
  }
  return s;
}

/**
 * Attachment filename safe for quoted-string Content-Disposition / name=.
 * @param {unknown} filename
 * @returns {string}
 */
export function sanitizeAttachmentFilename(filename) {
  const raw = String(filename ?? "");
  if (!raw.trim()) {
    throw composeMimeError("attachment filename required");
  }
  if (/[\r\n\x00-\x1f\x7f]/.test(raw)) {
    throw composeMimeError(
      "attachment filename contains control characters (CRLF/header breakout)",
    );
  }
  // quoted-string safe: no " \ or ;
  if (/["\\;]/.test(raw)) {
    throw composeMimeError(
      'attachment filename must not contain ", \\, or ;',
    );
  }
  return raw;
}

/**
 * Restrict Content-Type to type/subtype tokens (no params / CRLF).
 * @param {unknown} contentType
 * @returns {string}
 */
export function sanitizeContentType(contentType) {
  const raw = String(
    contentType ?? "application/octet-stream",
  ).trim();
  // RFC 2045 token-ish type/subtype only
  if (
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
      raw,
    )
  ) {
    throw composeMimeError(
      `invalid attachment contentType: ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Format one mailbox for a To/Cc header line (no raw paste).
 * @param {string} label
 * @param {unknown} entry
 * @returns {string}
 */
function formatAddressHeaderEntry(label, entry) {
  const s = assertNoHeaderControlChars(label, entry).trim();
  if (!s) {
    throw composeMimeError(`${label} entry empty`);
  }
  const bare = bareEmail(s);
  if (!bare || /[\r\n]/.test(bare)) {
    throw composeMimeError(`${label} is not a valid email address`);
  }
  // Display name form: Name <addr> or "Name" <addr>
  const full = s.match(/^(.+?)\s*<\s*([^>]+@[^>]+)\s*>$/);
  if (full) {
    const display = assertNoHeaderControlChars(
      `${label} display`,
      full[1].replace(/^["']|["']$/g, "").replace(/"/g, ""),
    ).trim();
    const addr = bareEmail(full[2]) || bare;
    if (display) return `"${display}" <${addr}>`;
    return addr;
  }
  return bare;
}

/**
 * @param {string} label
 * @param {unknown} v
 * @returns {string}
 */
function formatAddressListHeader(label, v) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  if (!list.length) {
    throw composeMimeError(`${label} required`);
  }
  return list.map((e) => formatAddressHeaderEntry(label, e)).join(", ");
}

/**
 * Build the effective SMTP env for one named provider (issue #37):
 * `${SECRET_NAME}` refs resolved against env, then overlaid onto the
 * legacy SMTP_* keys the SMTP client already reads. Only the secret NAME
 * (never its content) may appear in errors.
 *
 * @param {object} provider — normalized `providers.<name>` entry
 * @param {string} name
 * @param {object} env
 * @returns {{ ok: true, env: object } | { ok: false, error: string }}
 */
function overlayProviderEnv(provider, name, env) {
  const where = `providers.${name}.config`;
  const resolved = resolveConfigRefs(provider?.config, env, where);
  if (!resolved.ok) return resolved;
  const cfg = resolved.config || {};
  const overlay = {
    ...env,
    SMTP_HOST: cfg.host,
    SMTP_USERNAME: cfg.username,
    SMTP_PASSWORD: cfg.password,
  };
  if (cfg.port != null && String(cfg.port).trim() !== "") {
    overlay.SMTP_PORT = cfg.port;
  }
  if (cfg.tls != null && String(cfg.tls).trim() !== "") {
    overlay.SMTP_TLS = cfg.tls;
  }
  return { ok: true, env: overlay };
}

/**
 * @param {object} env
 * @param {{
 *   mailFrom: string,
 *   to?: string|string[],
 *   fromName?: string,
 *   mimeText?: string,
 *   rawMimeBase64?: string,
 *   subject?: string,
 *   text?: string,
 *   html?: string,
 *   cc?: string|string[],
 *   bcc?: string|string[],
 *   headers?: Record<string, string>,
 *   attachments?: Array<{ filename: string, contentType?: string, content: string }>,
 * }} req
 * @param {import('../config.js').RoutingConfig} [config] — when it carries a
 *   `providers:` map, the provider is selected from the final mailFrom apex
 *   (`domains.<apex>.provider` → `defaults.provider`); otherwise the legacy
 *   global SMTP_* env path applies.
 */
export async function sendOutboundMime(env, req, config) {
  let mimeText =
    req.mimeText ||
    (req.rawMimeBase64
      ? new TextDecoder().decode(
          Uint8Array.from(atob(req.rawMimeBase64), (c) => c.charCodeAt(0)),
        )
      : null);

  if (!mimeText) {
    try {
      mimeText = buildComposeMime(req);
    } catch (err) {
      if (err && err.code === "compose_mime_invalid") {
        return {
          ok: false,
          error: err.message,
          transport: "smtp",
          clientError: true,
        };
      }
      throw err;
    }
  }
  if (!mimeText) {
    return {
      ok: false,
      error: "mimeText or subject+body required",
      transport: "smtp",
      clientError: true,
    };
  }

  const toBare = bareList(req.to || req.rcpt || extractHeaderAddr(mimeText, "To"));
  if (!toBare.length) {
    return {
      ok: false,
      error: "to required",
      transport: "smtp",
      clientError: true,
    };
  }

  // Named provider selection (issue #37). Without a `providers:` map —
  // or when no config reaches this layer (unit tests) — the legacy
  // global SMTP_* env path applies untouched.
  let sendEnv = env;
  let providerName = "smtp";
  if (config?.providers) {
    const sel = selectProviderEnv(config, req.mailFrom, env);
    if (!sel.ok) {
      return {
        ok: false,
        error: sel.error,
        transport: "smtp",
        provider: sel.name,
      };
    }
    sendEnv = sel.env;
    providerName = sel.name;
  }

  if (!hasSmtp(sendEnv)) {
    return {
      ok: false,
      error: hasSmtpError(providerName),
      transport: "smtp",
      provider: providerName,
    };
  }

  const result = await smtpSend(sendEnv, {
    mailFrom: req.mailFrom,
    to: toBare,
    mimeText,
  });
  return { ...result, transport: "smtp", provider: providerName };
}

/**
 * Select the named provider for a mailFrom and build its effective SMTP
 * env (issue #37). Exported for unit tests; `sendOutboundMime` is the
 * product path.
 *
 * @param {import('../config.js').RoutingConfig} config
 * @param {string} mailFrom
 * @param {object} env
 * @returns {{ ok: true, name: string, env: object } | { ok: false, name: string | null, error: string }}
 */
export function selectProviderEnv(config, mailFrom, env) {
  let selected;
  try {
    selected = resolveProviderName(config, mailFrom);
  } catch (err) {
    return { ok: false, name: null, error: err?.message || "unknown provider" };
  }
  if (selected == null) return { ok: true, name: "smtp", env };
  const overlay = overlayProviderEnv(config.providers[selected], selected, env);
  if (!overlay.ok) return { ok: false, name: selected, error: overlay.error };
  return { ok: true, name: selected, env: overlay.env };
}

/**
 * Missing-credential error naming the selected provider when one was
 * selected (name only — never secret content).
 */
function hasSmtpError(providerName) {
  if (providerName && providerName !== "smtp") {
    return (
      `SMTP not configured for provider "${providerName}" ` +
      `(check its host/username/password or referenced secrets)`
    );
  }
  return "SMTP not configured (need SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD)";
}

/**
 * Build a simple RFC822 message for compose API (text and/or html).
 * Throws ComposeMimeError (code compose_mime_invalid) on unsafe header material.
 */
export function buildComposeMime(req) {
  const mailFrom = String(req.mailFrom || "").trim();
  if (!mailFrom) return null;
  if (/[\r\n]/.test(mailFrom)) {
    throw composeMimeError("mailFrom contains CR/LF control characters");
  }
  const fromHeader = req.fromName
    ? formatSmtpMailbox(req.fromName, bareEmail(mailFrom) || mailFrom)
    : mailFrom;
  if (/[\r\n]/.test(String(fromHeader))) {
    throw composeMimeError("From header contains CR/LF control characters");
  }

  let toHeader;
  try {
    toHeader = formatAddressListHeader("to", req.to);
  } catch (err) {
    if (err && err.code === "compose_mime_invalid") throw err;
    throw err;
  }

  const subject = sanitizeHeaderValue(req.subject || "(no subject)");
  const text = req.text != null ? String(req.text) : "";
  const html = req.html != null ? String(req.html) : "";
  if (!text && !html && !(req.attachments && req.attachments.length)) {
    return null;
  }

  const lines = [`From: ${fromHeader}`, `To: ${toHeader}`];
  if (req.cc != null && req.cc !== "" && !(Array.isArray(req.cc) && !req.cc.length)) {
    lines.push(`Cc: ${formatAddressListHeader("cc", req.cc)}`);
  }
  // bcc is envelope-only when supported; never emit Bcc header from compose JSON
  lines.push(`Subject: ${subject}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`);
  lines.push(
    `Message-ID: <compose-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@cf-email-gateway>`,
  );

  if (req.headers && typeof req.headers === "object") {
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || v === "") continue;
      const name = assertHeaderName(k);
      if (/^(from|to|cc|bcc|subject|mime-version|content-type)$/i.test(name)) {
        continue;
      }
      lines.push(`${name}: ${sanitizeHeaderValue(v)}`);
    }
  }

  const atts = Array.isArray(req.attachments) ? req.attachments : [];
  const boundaryMixed = `mixed_${Date.now()}`;
  const boundaryAlt = `alt_${Date.now()}`;

  const hasBoth = Boolean(text && html);
  const bodyParts = [];

  if (hasBoth) {
    bodyParts.push(`--${boundaryAlt}`);
    bodyParts.push(`Content-Type: text/plain; charset="UTF-8"`);
    bodyParts.push(`Content-Transfer-Encoding: 8bit`);
    bodyParts.push(``);
    bodyParts.push(text.replace(/\r?\n/g, "\r\n"));
    bodyParts.push(`--${boundaryAlt}`);
    bodyParts.push(`Content-Type: text/html; charset="UTF-8"`);
    bodyParts.push(`Content-Transfer-Encoding: 8bit`);
    bodyParts.push(``);
    bodyParts.push(html.replace(/\r?\n/g, "\r\n"));
    bodyParts.push(`--${boundaryAlt}--`);
  } else if (html) {
    bodyParts.push(`Content-Type: text/html; charset="UTF-8"`);
    bodyParts.push(`Content-Transfer-Encoding: 8bit`);
    bodyParts.push(``);
    bodyParts.push(html.replace(/\r?\n/g, "\r\n"));
  } else {
    bodyParts.push(`Content-Type: text/plain; charset="UTF-8"`);
    bodyParts.push(`Content-Transfer-Encoding: 8bit`);
    bodyParts.push(``);
    bodyParts.push((text || "").replace(/\r?\n/g, "\r\n"));
  }

  if (atts.length) {
    lines.push(
      `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    );
    const out = [...lines, ``];
    out.push(`--${boundaryMixed}`);
    if (hasBoth) {
      out.push(
        `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
      );
      out.push(``);
      out.push(...bodyParts);
    } else {
      out.push(...bodyParts);
    }
    for (const a of atts) {
      if (!a?.filename) continue;
      const filename = sanitizeAttachmentFilename(a.filename);
      const ctype = sanitizeContentType(a.contentType || a.mimetype);
      const b64 =
        typeof a.content === "string"
          ? a.content.replace(/\s/g, "")
          : "";
      out.push(`--${boundaryMixed}`);
      out.push(
        `Content-Type: ${ctype}; name="${filename}"`,
      );
      out.push(`Content-Transfer-Encoding: base64`);
      out.push(
        `Content-Disposition: attachment; filename="${filename}"`,
      );
      out.push(``);
      for (let i = 0; i < b64.length; i += 76) {
        out.push(b64.slice(i, i + 76));
      }
    }
    out.push(`--${boundaryMixed}--`);
    out.push(``);
    return out.join("\r\n");
  }

  if (hasBoth) {
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    );
    return [...lines, ``, ...bodyParts, ``].join("\r\n");
  }

  // single part: Content-Type already in bodyParts head
  return [...lines, ...bodyParts, ``].join("\r\n");
}

function bareList(v) {
  if (Array.isArray(v)) return v.map(bareOne).filter(Boolean);
  if (v) return [bareOne(v)].filter(Boolean);
  return [];
}

function bareOne(s) {
  return bareEmail(s);
}

function extractHeaderAddr(mime, name) {
  const m = String(mime).match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return m ? m[1].trim() : "";
}
