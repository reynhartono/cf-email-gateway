/**
 * Rebuild outbound MIME: new envelope headers, body 1:1 (no re-encode).
 */

import { getHeader } from "./util.js";

/**
 * Split raw RFC822 into header block + body (body includes leading blank line separator... 
 * actually returns body WITHOUT the separating blank lines for cleaner join).
 * @param {string} rawText
 * @returns {{ headerBlock: string, body: string }}
 */
export function splitMime(rawText) {
  const text = String(rawText || "");
  const m = text.match(/\r?\n\r?\n/);
  if (!m || m.index == null) {
    return { headerBlock: text, body: "" };
  }
  return {
    headerBlock: text.slice(0, m.index),
    body: text.slice(m.index + m[0].length),
  };
}

/**
 * Get unfolded full header value (handles folded Content-Type with boundary).
 * @param {string} headerBlock
 * @param {string} name
 */
export function getFullHeader(headerBlock, name) {
  const want = name.toLowerCase();
  const lines = unfoldHeaderLines(headerBlock);
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toLowerCase() === want) {
      return line.slice(idx + 1).trim();
    }
  }
  return null;
}

function unfoldHeaderLines(headerBlock) {
  const raw = headerBlock.split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += " " + line.trim();
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * @param {{
 *   rawText: string,
 *   from: string,   // already formatted "Name" <addr> or addr
 *   to: string,
 *   subject?: string|null,  // null/undefined = keep original Subject
 *   keepMessageId?: boolean,
 *   extraHeaders?: Record<string, string>,
 * }} opts
 * @returns {string} full MIME (headers + CRLF CRLF + original body bytes as text)
 */
export function rebuildOutboundMime(opts) {
  const { rawText, from, to } = opts;
  const { headerBlock, body } = splitMime(rawText);

  const origSubject = getFullHeader(headerBlock, "Subject") || "(no subject)";
  let subject =
    opts.subject != null && opts.subject !== ""
      ? opts.subject
      : origSubject;

  const ct = getFullHeader(headerBlock, "Content-Type");
  const cte = getFullHeader(headerBlock, "Content-Transfer-Encoding");
  const mimeVer = getFullHeader(headerBlock, "MIME-Version") || "1.0";
  const inReplyTo = getFullHeader(headerBlock, "In-Reply-To");
  const references = getFullHeader(headerBlock, "References");
  const messageId =
    opts.keepMessageId !== false
      ? getFullHeader(headerBlock, "Message-ID")
      : null;

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: ${mimeVer}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
  ];
  if (messageId) lines.push(`Message-ID: ${messageId}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  // Body-describing headers MUST match body 1:1
  if (ct) lines.push(`Content-Type: ${ct}`);
  if (cte) lines.push(`Content-Transfer-Encoding: ${cte}`);

  if (opts.extraHeaders) {
    for (const [k, v] of Object.entries(opts.extraHeaders)) {
      if (v == null || v === "") continue;
      lines.push(`${k}: ${v}`);
    }
  }

  // Preserve original body exactly (quoted-printable, html part, boundaries)
  return lines.join("\r\n") + "\r\n\r\n" + body;
}

/**
 * UTF-8 string → standard base64 for SMTP DATA
 * @param {string} mimeText
 */
export function mimeToBase64(mimeText) {
  const bytes = new TextEncoder().encode(mimeText);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Subject only (for D1 logging); does not touch body.
 */
export function subjectFromRaw(rawText) {
  const { headerBlock } = splitMime(rawText);
  return getFullHeader(headerBlock, "Subject") || "(no subject)";
}
