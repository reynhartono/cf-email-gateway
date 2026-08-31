/**
 * Generic outbound mail — SMTP DATA only (no vendor HTTP API).
 */

import { smtpSend, hasSmtp, bareEmail } from "./smtp.js";
import { formatSmtpMailbox } from "../reply_tokens.js";

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
 */
export async function sendOutboundMime(env, req) {
  if (!hasSmtp(env)) {
    return {
      ok: false,
      error:
        "SMTP not configured (need SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD)",
      transport: "smtp",
    };
  }

  let mimeText =
    req.mimeText ||
    (req.rawMimeBase64
      ? new TextDecoder().decode(
          Uint8Array.from(atob(req.rawMimeBase64), (c) => c.charCodeAt(0)),
        )
      : null);

  if (!mimeText) {
    mimeText = buildComposeMime(req);
  }
  if (!mimeText) {
    return { ok: false, error: "mimeText or subject+body required", transport: "smtp" };
  }

  const toBare = bareList(req.to || req.rcpt || extractHeaderAddr(mimeText, "To"));
  if (!toBare.length) {
    return { ok: false, error: "to required", transport: "smtp" };
  }

  const result = await smtpSend(env, {
    mailFrom: req.mailFrom,
    to: toBare,
    mimeText,
  });
  return { ...result, transport: "smtp" };
}

/**
 * Build a simple RFC822 message for compose API (text and/or html).
 */
export function buildComposeMime(req) {
  const mailFrom = String(req.mailFrom || "").trim();
  if (!mailFrom) return null;
  const fromHeader = req.fromName
    ? formatSmtpMailbox(req.fromName, bareEmail(mailFrom) || mailFrom)
    : mailFrom;

  const toList = Array.isArray(req.to) ? req.to : req.to ? [req.to] : [];
  if (!toList.length) return null;
  const toHeader = toList.map((t) => String(t).trim()).join(", ");

  const subject = String(req.subject || "(no subject)").replace(/[\r\n]/g, " ");
  const text = req.text != null ? String(req.text) : "";
  const html = req.html != null ? String(req.html) : "";
  if (!text && !html && !(req.attachments && req.attachments.length)) {
    return null;
  }

  const lines = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
  ];
  if (req.cc) {
    const cc = Array.isArray(req.cc) ? req.cc : [req.cc];
    lines.push(`Cc: ${cc.map(String).join(", ")}`);
  }
  lines.push(`Subject: ${subject}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`);
  lines.push(
    `Message-ID: <compose-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@cf-email-gateway>`,
  );

  if (req.headers && typeof req.headers === "object") {
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null || v === "") continue;
      const name = String(k);
      if (/^(from|to|cc|bcc|subject|mime-version|content-type)$/i.test(name)) {
        continue;
      }
      lines.push(`${name}: ${String(v).replace(/[\r\n]/g, " ")}`);
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
      const b64 =
        typeof a.content === "string"
          ? a.content.replace(/\s/g, "")
          : "";
      out.push(`--${boundaryMixed}`);
      out.push(
        `Content-Type: ${a.contentType || a.mimetype || "application/octet-stream"}; name="${a.filename.replace(/"/g, "")}"`,
      );
      out.push(`Content-Transfer-Encoding: base64`);
      out.push(
        `Content-Disposition: attachment; filename="${a.filename.replace(/"/g, "")}"`,
      );
      out.push(``);
      // fold base64
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
