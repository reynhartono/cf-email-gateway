/**
 * Structured logging for Workers (JSON lines → wrangler tail / dashboard).
 */

import { parseReplyTokenAddress } from "./reply_tokens.js";
import { sha256Hex } from "./util.js";

export const REPLY_TOKEN_LOG_PREFIX_LEN = 4;
export const REPLY_TOKEN_LOG_HASH_LEN = 16;

export function log(level, event, fields = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event, fields) => log("info", event, fields),
  warn: (event, fields) => log("warn", event, fields),
  error: (event, fields) => log("error", event, fields),
};

export function replyTokenLogPrefix(token) {
  return String(token || "").slice(0, REPLY_TOKEN_LOG_PREFIX_LEN);
}

export async function replyTokenLogSha256(token) {
  const hex = await sha256Hex(new TextEncoder().encode(String(token || "")));
  return hex.slice(0, REPLY_TOKEN_LOG_HASH_LEN);
}

/**
 * Non-secret identifiers for reply-token logs.
 * Never includes the raw token or a complete r+TOKEN@apex address.
 */
export async function replyTokenLogFields(token, ourDomain) {
  const token_prefix = replyTokenLogPrefix(token);
  const token_sha256 = await replyTokenLogSha256(token);
  const out = { token_prefix, token_sha256 };
  if (ourDomain != null && String(ourDomain) !== "") {
    out.replyTo = `r+${token_prefix}…@${String(ourDomain).toLowerCase()}`;
  }
  return out;
}

/** Replace r+TOKEN[.suffix]@apex with a prefix-only local for logs. */
export function redactReplyTokenAddressForLog(address) {
  const parsed = parseReplyTokenAddress(address);
  if (!parsed) return address;
  const prefix = replyTokenLogPrefix(parsed.token);
  const suffix = parsed.suffix ? `.${parsed.suffix}` : "";
  return `r+${prefix}…${suffix}@${parsed.ourDomain}`;
}
