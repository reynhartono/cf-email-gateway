/**
 * Core inbound pipeline: archive B9, cf_forward + X-CFEG, send-proxy, reply hop.
 *
 * Default route = normal inbound (rules / default_inbox → cf_forward) after insert+archive.
 * Exceptions (opt-in): authorized reply hop or send-proxy take over delivery only when
 * the envelope matches that pattern AND the sender is authorized + identity-bound.
 * Unauthorized pattern traffic stays on the default route (never outer setReject blackhole).
 *
 * Thin orchestrator: exception gates live in ./delivery_exceptions.js,
 * forward-token mint in ./forward_tokens.js, default delivery in
 * ./default_deliver.js, handlers in ./send_proxy_handler.js +
 * ./reply_hop_handler.js. This module owns handleInbound (default route) only.
 */

import {
  archiveEnabled,
  resolveDriver,
  recipientDomain,
  replyTokensWanted,
} from "./config.js";
import {
  dedupeKeyHex,
  getHeader,
  randomId,
  resolveDestinations,
  sha256Hex,
} from "./util.js";
import * as db from "./db.js";
import { putArchive } from "./archive.js";
import {
  parseSendProxyAddress,
  isAuthorizedSender,
} from "./send_proxy.js";
import {
  effectiveAuthorizedFrom,
  resolveInboundActor,
} from "./identity.js";
import { parseReplyTokenAddress } from "./reply_tokens.js";
import {
  logger,
  redactReplyTokenAddressForLog,
  replyTokenLogFields,
} from "./log.js";
import { tryDeliveryException } from "./delivery_exceptions.js";
import {
  loadForwardTokenMeta,
  mintForwardReplyToken,
} from "./forward_tokens.js";
import { defaultDeliver } from "./default_deliver.js";

/**
 * @param {object} env
 * @param {ForwardableEmailMessage} message
 * @param {import('./config.js').RoutingConfig} config
 * @param {{ deliver?: Function, archivePut?: Function, smtpSend?: Function }} [hooks]
 */
export async function handleInbound(env, message, config, hooks = {}) {
  const invocationId = randomId();
  const now = Date.now();

  const rawAb = await new Response(message.raw).arrayBuffer();
  const rawBytes = new Uint8Array(rawAb);
  const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);
  const rawSha = await sha256Hex(rawAb);
  const messageId = getHeader(rawText, "message-id") || "";
  const subjectHdr = getHeader(rawText, "subject") || "";
  const envelopeFrom = message.from || "";
  const envelopeTo = message.to || "";
  const domain = recipientDomain(envelopeTo);

  logger.info("inbound.start", {
    invocationId,
    envelopeFrom,
    envelopeTo: redactReplyTokenAddressForLog(envelopeTo),
    domain,
    subject: subjectHdr?.slice(0, 80),
    rawSize: rawBytes.byteLength,
  });

  // Detect special address shapes early, but do not branch yet.
  // Unauthorized / unbound senders fall through to normal cf_forward.
  const replyTok = parseReplyTokenAddress(envelopeTo);
  const proxy = parseSendProxyAddress(envelopeTo);

  const matched = resolveDestinations(config, envelopeTo, resolveDriver);
  const wantArchive = archiveEnabled(config, matched.rule);
  let destinations = matched.destinations;
  const ruleId = matched.ruleId;

  logger.info("inbound.destinations", {
    invocationId,
    ruleId,
    dests: destinations.map((d) => ({ email: d.email, method: d.method })),
    wantArchive,
    replyTok: Boolean(replyTok),
    proxy: Boolean(proxy),
  });

  // Insert-first: always record + archive before special-route authz.
  const dedupeKey = await dedupeKeyHex(envelopeFrom, envelopeTo, messageId, rawSha);
  let inbound = await db.getInboundByDedupe(env.DB, dedupeKey);
  const isNew = !inbound;

  if (isNew) {
    inbound = {
      id: randomId(),
      dedupe_key: dedupeKey,
      received_at: now,
      updated_at: now,
      envelope_from: envelopeFrom,
      envelope_to: envelopeTo,
      recipient_domain: domain,
      subject: subjectHdr,
      message_id: messageId,
      raw_sha256: rawSha,
      archive_enabled: wantArchive ? 1 : 0,
      r2_key: null,
      raw_size: rawBytes.byteLength,
      archived_at: null,
      rule_id: ruleId,
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
      await db.updateInbound(env.DB, inbound.id, {
        last_error: `archive_failed: ${res.error || "unknown"}`,
      });
    }
  }

  const allowList = effectiveAuthorizedFrom(config);
  // Exception authz uses envelope From only — MIME From is spoofable and must
  // not grant hop/proxy by itself (paired with CF auth on the same identity).
  const senderAuthorized = isAuthorizedSender(envelopeFrom, allowList);
  const actor = senderAuthorized
    ? resolveInboundActor(config, envelopeFrom)
    : { ok: false };

  // Exceptions to the default route (only when pattern ∧ authorized ∧ bound).
  const exception = await tryDeliveryException(env, message, config, hooks, {
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
    proxy,
    senderAuthorized,
    actor,
  });
  if (exception) return exception;

  // ---- DEFAULT ROUTE: rules / default_inbox → cf_forward (+ X-CFEG) ----
  if (!destinations.length) {
    if (archiveOk || !wantArchive) {
      await db.updateInbound(env.DB, inbound.id, {
        status: "ingested_only",
        last_error: null,
      });
      return { ok: true, status: "ingested_only", inboundId: inbound.id };
    }
    const err = new Error("archive_required_failed");
    err.retryable = true;
    throw err;
  }

  const targets = await db.ensureTargets(env.DB, inbound.id, destinations);
  for (const t of targets) {
    t.inbound_id = inbound.id;
    if (!t.method) {
      t.method = resolveDriver(config, envelopeTo, { email: t.destination });
    }
  }

  // Mint reply token only on send_as-enabled apexes (not archive-only zones).
  // Dedupe/retry: reuse the existing inbound_id route — do not mint another.
  // Note: an empty apex mints only when defaults.send_as.enabled is true;
  // such a row can never hop — the apex gate stays fail-closed.
  let forwardTokenMeta = null;
  const wantTokens = replyTokensWanted(config, envelopeTo);
  if (wantTokens) {
    try {
      forwardTokenMeta = await loadForwardTokenMeta(env, inbound.id);
      if (forwardTokenMeta) {
        logger.info("forward.token_reuse", {
          invocationId,
          ...(await replyTokenLogFields(
            forwardTokenMeta.token,
            forwardTokenMeta.ourDomain,
          )),
        });
      } else {
        forwardTokenMeta = await mintForwardReplyToken(env, config, {
          inboundId: inbound.id,
          envelopeTo,
          domain,
          rawText,
        });
        logger.info("forward.token", {
          invocationId,
          ...(forwardTokenMeta
            ? await replyTokenLogFields(
                forwardTokenMeta.token,
                forwardTokenMeta.ourDomain,
              )
            : {}),
        });
      }
    } catch (e) {
      logger.warn("forward.token_fail", { error: e?.message || String(e) });
    }
  }

  const pending = targets.filter((t) => t.state !== "succeeded");

  const deliverFn = hooks.deliver || defaultDeliver;
  const errors = [];

  for (const t of pending) {
    const attemptNumber = (t.attempt_count || 0) + 1;
    const started = Date.now();
    let result;
    try {
      result = await deliverFn(env, message, t, config, {
        rawText,
        rawBytes,
        rawAb,
        forwardTokenMeta,
      });
    } catch (e) {
      result = { ok: false, error: e?.message || String(e) };
    }
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
      method: t.method,
      provider: t.provider,
      send_as: t.send_as,
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
        last_error: result.error || "deliver_failed",
        last_attempt_at: finished,
      });
      t.state = "failed";
      errors.push(`${t.destination}: ${result.error || "fail"}`);
    }
  }

  const allTargets = await db.listTargets(env.DB, inbound.id);
  const deliveryOk = allTargets.every((t) => t.state === "succeeded");
  const row = await db.getInboundByDedupe(env.DB, dedupeKey);
  const finalArchiveOk = !wantArchive || Boolean(row?.r2_key);

  if (deliveryOk && finalArchiveOk) {
    await db.updateInbound(env.DB, inbound.id, {
      status: "completed",
      last_error: null,
    });
    return { ok: true, status: "completed", inboundId: inbound.id };
  }

  const parts = [];
  if (!finalArchiveOk) parts.push("archive_missing");
  if (!deliveryOk) parts.push(errors.join("; ") || "delivery_incomplete");
  await db.updateInbound(env.DB, inbound.id, {
    status: "pending_deliveries",
    last_error: parts.join(" | "),
  });
  const err = new Error(parts.join(" | "));
  err.retryable = true;
  throw err;
}
