import * as db from "./db.js";
import { archiveEnabled } from "./config.js";
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
 * Gmail (authorized) → special To → SMTP as alias@ourdomain → real recipient.
 * Exception route: does not CF-forward to default_inbox on success.
 * Precondition: tryDeliveryException already verified all gates.
 */
export async function handleSendProxy(env, message, config, hooks, ctx) {
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
    proxy,
  } = ctx;

  const allow = effectiveAuthorizedFrom(config);
  // Envelope From only — MIME From is spoofable.
  if (!isAuthorizedSender(envelopeFrom, allow)) {
    // Reject — do not open relay
    try {
      message.setReject?.(
        "send-proxy: sender not authorized (add Gmail to token_auth.authorized_from or identities)",
      );
    } catch {
      /* ignore */
    }
    const err = new Error("send_proxy_unauthorized");
    err.retryable = false;
    throw err;
  }

  const actor = resolveInboundActor(config, envelopeFrom);
  if (!actor.ok) {
    try {
      message.setReject?.(`send-proxy: ${actor.error}`);
    } catch {
      /* ignore */
    }
    const err = new Error("send_proxy_identity_unbound");
    err.retryable = false;
    throw err;
  }

  // Defense-in-depth: CF auth aligned to envelope identity only.
  if (!cfAuthLooksPass(rawText, envelopeFrom)) {
    if (!hooks.skipCfAuth) {
      try {
        message.setReject?.("send-proxy: missing CF auth pass");
      } catch {
        /* ignore */
      }
      const err = new Error("send_proxy_auth_failed");
      err.retryable = false;
      throw err;
    }
  }

  const resolved = resolveMailFrom(config, proxy.fromEmail);
  if (!resolved.ok) {
    const err = new Error(`send_proxy_from: ${resolved.error}`);
    err.retryable = false;
    throw err;
  }

  if (!actor.legacy) {
    try {
      assertMailboxAllowedOrThrow(actor.identity, resolved.mailFrom);
    } catch (e) {
      try {
        message.setReject?.(`send-proxy: ${e.message}`);
      } catch {
        /* ignore */
      }
      const err = new Error("send_proxy_identity_mailbox_denied");
      err.retryable = false;
      throw err;
    }
  }

  const subject = subjectFromRaw(rawText);
  const dedupeKey = await dedupeKeyHex(
    envelopeFrom,
    envelopeTo,
    messageId,
    rawSha,
  );

  let inbound = await db.getInboundByDedupe(env.DB, dedupeKey);
  const isNew = !inbound;
  const wantArchive = archiveEnabled(config, null);

  if (isNew) {
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
      rule_id: "send_proxy",
      status: "pending_deliveries",
      last_error: null,
    };
    await db.insertInbound(env.DB, inbound);
  }

  let archiveOk = !wantArchive || Boolean(inbound.r2_key);
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
        archive_enabled: 1,
      });
      inbound.r2_key = res.r2_key;
      archiveOk = true;
    } else {
      archiveOk = false;
    }
  }

  const destinations = [
    {
      email: proxy.rcptEmail,
      method: "provider_send",
      provider: "smtp",
      send_as: resolved.mailFrom,
    },
  ];
  const targets = await db.ensureTargets(env.DB, inbound.id, destinations);
  const pending = targets.filter((t) => t.state !== "succeeded");
  const sendFn = hooks.smtpSend || sendOutboundMime;
  const errors = [];

  const toField = proxy.rcptDisplay
    ? formatSmtpMailbox(proxy.rcptDisplay, proxy.rcptEmail)
    : proxy.rcptEmail;
  // Q42: braces win; else rule / domain display_name
  const fromDisplay = pickFromDisplayName(
    config,
    proxy.aliasDisplay,
    resolved.mailFrom,
    [proxy.fromEmail],
  );
  const fromField = fromDisplay
    ? formatSmtpMailbox(fromDisplay, resolved.mailFrom)
    : resolved.mailFrom;
  const mimeOut = rebuildOutboundMime({
    rawText,
    from: fromField,
    to: toField,
    subject: null,
    keepMessageId: true,
  });

  for (const t of pending) {
    const attemptNumber = (t.attempt_count || 0) + 1;
    const started = Date.now();
    const result = await sendFn(env, {
      mailFrom: resolved.mailFrom,
      fromName: fromDisplay,
      to: proxy.rcptEmail,
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
      send_as: resolved.mailFrom,
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
      t.state = "succeeded";
    } else {
      await db.updateTarget(env.DB, t.id, {
        state: "failed",
        attempt_count: attemptNumber,
        last_error: result.error || "smtp_failed",
        last_attempt_at: finished,
      });
      errors.push(result.error || "fail");
    }
  }

  const allTargets = await db.listTargets(env.DB, inbound.id);
  const deliveryOk = allTargets.every((t) => t.state === "succeeded");
  const finalArchiveOk = !wantArchive || Boolean(inbound.r2_key) || archiveOk;

  // Re-read archive key
  const row = await db.getInboundByDedupe(env.DB, dedupeKey);
  const archOk = !wantArchive || Boolean(row?.r2_key);

  if (deliveryOk && archOk) {
    await db.updateInbound(env.DB, inbound.id, {
      status: "send_proxy_completed",
      last_error: null,
      rule_id: "send_proxy",
    });
    return {
      ok: true,
      status: "send_proxy_completed",
      inboundId: inbound.id,
      mailFrom: resolved.mailFrom,
      to: proxy.rcptEmail,
    };
  }

  const msg = [
    !archOk ? "archive_missing" : null,
    !deliveryOk ? errors.join("; ") || "delivery_incomplete" : null,
  ]
    .filter(Boolean)
    .join(" | ");
  await db.updateInbound(env.DB, inbound.id, {
    status: "pending_deliveries",
    last_error: msg,
  });
  const err = new Error(msg);
  err.retryable = true;
  throw err;
}
