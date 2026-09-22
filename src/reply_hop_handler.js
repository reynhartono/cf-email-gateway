import * as db from "./db.js";
import { archiveEnabled, resolveSendAs } from "./config.js";
import { dedupeKeyHex, randomId } from "./util.js";
import { putArchive } from "./archive.js";
import { sendOutboundMime } from "./providers/send_outbound.js";
import { pickFromDisplayName, resolveMailFrom } from "./mail_from.js";
import {
  assertMailboxAllowedOrThrow,
  effectiveAuthorizedFrom,
  resolveInboundActor,
} from "./identity.js";
import { cfAuthLooksPass, formatSmtpMailbox } from "./reply_tokens.js";
import { isAuthorizedSender } from "./send_proxy.js";
import { rebuildOutboundMime, subjectFromRaw } from "./mime_rebuild.js";
import { logger } from "./log.js";

/**
 * Token is bound to its mint-time apex: the envelope recipient domain must
 * equal route.our_domain. Prevents a token minted for shops@example.com
 * from hopping as r+TOKEN@other.example on a shared Worker/D1.
 *
 * Canonical home of this helper: import it from ./reply_hop_handler.js
 * (delivery_exceptions.js imports it from here; do not re-export elsewhere).
 *
 * The trim is load-bearing for rows minted before mint-time normalization
 * (lowercase-only our_domain) — it lets those legacy rows keep hopping
 * without a backfill migration. Do not simplify it away.
 */
export function replyTokenDomainMatches(route, replyTok) {
  const stored = String(route?.our_domain || "").trim().toLowerCase();
  const presented = String(replyTok?.ourDomain || "").trim().toLowerCase();
  // Fail closed: never treat two empty sides as a match.
  if (!stored || !presented) return false;
  return stored === presented;
}

/**
 * Authorized Gmail → r+TOKEN@domain → ESP to original participant(s).
 * Exception route over the default cf_forward path.
 */
export async function handleReplyHop(env, message, config, hooks, ctx) {
  const {
    invocationId,
    now,
    rawAb,
    rawBytes,
    rawText,
    rawSha,
    messageId,
    envelopeFrom,
    envelopeTo,
    domain,
    replyTok,
  } = ctx;

  const allow = effectiveAuthorizedFrom(config);
  // Envelope From only — MIME From is spoofable.
  if (!isAuthorizedSender(envelopeFrom, allow)) {
    try {
      message.setReject?.("reply-token: sender not authorized");
    } catch {
      /* */
    }
    const err = new Error("reply_token_unauthorized");
    err.retryable = false;
    throw err;
  }

  const actor = resolveInboundActor(config, envelopeFrom);
  if (!actor.ok) {
    try {
      message.setReject?.(`reply-token: ${actor.error}`);
    } catch {
      /* */
    }
    const err = new Error("reply_token_identity_unbound");
    err.retryable = false;
    throw err;
  }

  // Defense-in-depth: CF auth aligned to envelope identity only.
  if (!cfAuthLooksPass(rawText, envelopeFrom)) {
    // Fail closed unless hook overrides for tests
    if (!hooks.skipCfAuth) {
      try {
        message.setReject?.("reply-token: missing CF auth pass");
      } catch {
        /* */
      }
      const err = new Error("reply_token_auth_failed");
      err.retryable = false;
      throw err;
    }
  }

  const route = await db.getReplyRoute(env.DB, replyTok.token);
  if (!route) {
    try {
      message.setReject?.("reply-token: unknown token");
    } catch {
      /* */
    }
    const err = new Error("reply_token_unknown");
    err.retryable = false;
    throw err;
  }

  // Defense-in-depth: same apex bind as evaluateReplyException, in case this
  // handler is ever reached without the outer gate.
  if (!replyTokenDomainMatches(route, replyTok)) {
    try {
      message.setReject?.("reply-token: domain mismatch");
    } catch {
      /* */
    }
    const err = new Error("reply_token_domain_mismatch");
    err.retryable = false;
    throw err;
  }

  // Person may only hop tokens whose our_mailbox is in their can_send_as prefix.
  if (!actor.legacy) {
    const hopMailbox = (
      route.our_mailbox ||
      `noreply@${route.our_domain}`
    ).toLowerCase();
    try {
      assertMailboxAllowedOrThrow(actor.identity, hopMailbox);
    } catch (e) {
      try {
        message.setReject?.(`reply-token: ${e.message}`);
      } catch {
        /* */
      }
      const err = new Error("reply_token_identity_mailbox_denied");
      err.retryable = false;
      throw err;
    }
  }

  const participants = await db.listReplyParticipants(env.DB, replyTok.token);
  let dests = [];
  if (!replyTok.suffix) {
    dests = participants.filter((p) => p.in_primary);
    if (!dests.length) dests = participants.filter((p) => p.role === "primary");
  } else if (replyTok.suffix === "all") {
    dests = participants.filter((p) => p.in_all);
  } else {
    dests = participants.filter(
      (p) => (p.local_suffix || "").toLowerCase() === replyTok.suffix,
    );
  }
  if (!dests.length) {
    const err = new Error("reply_token_no_participants");
    err.retryable = false;
    throw err;
  }

  const sa = resolveSendAs(config, route.our_mailbox || `x@${route.our_domain}`);
  // From = original receiving mailbox on our domain, NOT reply@
  const mailbox = (
    route.our_mailbox ||
    sa.address ||
    `noreply@${route.our_domain}`
  ).toLowerCase();
  const resolved = resolveMailFrom(config, mailbox);
  let mailFrom = resolved.ok ? resolved.mailFrom : mailbox;

  const subject = subjectFromRaw(rawText);
  const dedupeKey = await dedupeKeyHex(
    envelopeFrom,
    envelopeTo,
    messageId,
    rawSha,
  );

  let inbound = await db.getInboundByDedupe(env.DB, dedupeKey);
  const wantArchive = archiveEnabled(config, null);
  if (!inbound) {
    inbound = {
      id: randomId(),
      dedupe_key: dedupeKey,
      received_at: now,
      updated_at: now,
      envelope_from: envelopeFrom,
      envelope_to: envelopeTo,
      recipient_domain: domain,
      subject,
      message_id: messageId,
      raw_sha256: rawSha,
      archive_enabled: wantArchive ? 1 : 0,
      r2_key: null,
      raw_size: rawBytes.byteLength,
      archived_at: null,
      rule_id: "reply_token",
      status: "pending_deliveries",
      last_error: null,
    };
    await db.insertInbound(env.DB, inbound);
  }

  if (wantArchive && !inbound.r2_key) {
    const put = hooks.archivePut || putArchive;
    const res = await put(env.ARCHIVE, {
      id: inbound.id,
      recipient_domain: domain,
      raw: rawAb,
      raw_size: rawBytes.byteLength,
    });
    if (res.ok) {
      await db.updateInbound(env.DB, inbound.id, {
        r2_key: res.r2_key,
        archived_at: Date.now(),
      });
      inbound.r2_key = res.r2_key;
    }
  }

  const destinations = dests.map((d) => ({
    email: d.email,
    method: "provider_send",
    provider: "smtp",
    send_as: mailFrom,
    display_hint: d.display_hint,
  }));
  const targets = await db.ensureTargets(env.DB, inbound.id, destinations);
  const pending = targets.filter((t) => t.state !== "succeeded");
  const sendFn = hooks.smtpSend || sendOutboundMime;
  const errors = [];

  for (const t of pending) {
    const attemptNumber = (t.attempt_count || 0) + 1;
    const started = Date.now();
    const part = dests.find(
      (d) => d.email.toLowerCase() === t.destination.toLowerCase(),
    );
    const toField = formatSmtpMailbox(part?.display_hint || "", t.destination);
    // Q42: rule / domain display_name for our_mailbox / resolved From
    const fromDisplay = pickFromDisplayName(config, null, mailFrom, [mailbox]);
    const fromField = fromDisplay
      ? formatSmtpMailbox(fromDisplay, mailFrom)
      : formatSmtpMailbox(mailbox, mailFrom);
    // Body 1:1 — rebuild headers only, keep multipart/HTML/QP untouched
    const mimeOut = rebuildOutboundMime({
      rawText,
      from: fromField,
      to: toField,
      subject: null,
      keepMessageId: true,
    });
    const result = await sendFn(env, {
      mailFrom,
      fromName: fromDisplay || mailbox,
      to: t.destination,
      mimeText: mimeOut,
    });
    const finished = Date.now();
    await db.insertAttempt(env.DB, {
      id: randomId(),
      inbound_id: inbound.id,
      delivery_target_id: t.id,
      destination: t.destination,
      attempt_number: attemptNumber,
      started_at: started,
      finished_at: finished,
      success: result.ok,
      error: result.error || null,
      method: "provider_send",
      provider: "smtp",
      send_as: mailFrom,
      provider_message_id: result.providerMessageId || null,
      provider_status:
        result.providerStatus != null ? String(result.providerStatus) : null,
      invocation_id: invocationId,
    });
    if (result.ok) {
      await db.updateTarget(env.DB, t.id, {
        state: "succeeded",
        attempt_count: attemptNumber,
        last_error: null,
        last_provider_message_id: result.providerMessageId || null,
        last_attempt_at: finished,
        succeeded_at: finished,
      });
      logger.info("reply_hop.ok", {
        invocationId,
        mailFrom,
        to: toField,
      });
    } else {
      await db.updateTarget(env.DB, t.id, {
        state: "failed",
        attempt_count: attemptNumber,
        last_error: result.error || "fail",
        last_attempt_at: finished,
      });
      errors.push(`${t.destination}: ${result.error || "fail"}`);
      logger.error("reply_hop.fail", {
        invocationId,
        mailFrom,
        to: toField,
        error: result.error,
      });
    }
  }

  const allTargets = await db.listTargets(env.DB, inbound.id);
  const deliveryOk = allTargets.every((t) => t.state === "succeeded");
  const archOk = !wantArchive || Boolean(inbound.r2_key);
  if (deliveryOk && archOk) {
    await db.updateInbound(env.DB, inbound.id, {
      status: "reply_token_completed",
      last_error: null,
    });
    return { ok: true, status: "reply_token_completed", inboundId: inbound.id };
  }
  const msg = [!archOk && "archive_missing", !deliveryOk && errors.join("; ")]
    .filter(Boolean)
    .join(" | ");
  await db.updateInbound(env.DB, inbound.id, {
    status: "pending_deliveries",
    last_error: msg,
  });
  const err = new Error(msg || "reply_incomplete");
  err.retryable = true;
  throw err;
}
