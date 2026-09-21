/**
 * Core inbound pipeline: archive B9, cf_forward + X-CFEG, send-proxy, reply hop.
 *
 * Default route = normal inbound (rules / default_inbox → cf_forward) after insert+archive.
 * Exceptions (opt-in): authorized reply hop or send-proxy take over delivery only when
 * the envelope matches that pattern AND the sender is authorized + identity-bound.
 * Unauthorized pattern traffic stays on the default route (never outer setReject blackhole).
 */

import {
  archiveEnabled,
  resolveDriver,
  recipientDomain,
  FEATURES,
  resolveSendAs,
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
import { cfForward } from "./providers/cf_forward.js";
import { sendOutboundMime } from "./providers/send_outbound.js";
import { pickFromDisplayName, resolveMailFrom } from "./mail_from.js";
import {
  parseSendProxyAddress,
  isAuthorizedSender,
} from "./send_proxy.js";
import {
  assertMailboxAllowedOrThrow,
  effectiveAuthorizedFrom,
  resolveInboundActor,
  identityMaySendAs,
} from "./identity.js";
import { buildForwardTokenHeaders } from "./forward_headers.js";
import {
  parseReplyTokenAddress,
  generateToken,
  extractExternalParticipants,
  cfAuthLooksPass,
  formatSmtpMailbox,
} from "./reply_tokens.js";
import { rebuildOutboundMime, subjectFromRaw } from "./mime_rebuild.js";
import {
  logger,
  redactReplyTokenAddressForLog,
  replyTokenLogFields,
} from "./log.js";

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

/**
 * Opt-in exceptions to the default cf_forward route.
 * Enter hop/proxy only when every gate passes; otherwise return null
 * and stay on the default path (no setReject at the outer gate).
 *
 * Gates (all required):
 *  - address shape matches (r+ or send-proxy)
 *  - sender authorized_from / identity-bound
 *  - mailbox ACL: proxy alias or token our_mailbox ∈ can_send_as (or unrestricted/legacy)
 *  - CF auth looks pass (unless hooks.skipCfAuth) — reply hop and send-proxy
 *  - reply: token row exists
 *  - proxy: resolveMailFrom OK for alias@apex
 */
async function tryDeliveryException(env, message, config, hooks, ctx) {
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
    proxy,
    senderAuthorized,
    actor,
  } = ctx;

  if (replyTok) {
    const hop = await evaluateReplyException(env, config, hooks, {
      invocationId,
      envelopeFrom,
      envelopeTo,
      replyTok,
      senderAuthorized,
      actor,
      rawText,
    });
    if (hop.ok) {
      logger.info("inbound.route", {
        invocationId,
        kind: "reply_token",
        suffix: replyTok.suffix,
        ...(await replyTokenLogFields(replyTok.token, replyTok.ourDomain)),
      });
      return handleReplyHop(env, message, config, hooks, {
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
      });
    }
    logger.warn("reply_token.exception_skipped", {
      invocationId,
      envelopeFrom,
      envelopeTo: redactReplyTokenAddressForLog(envelopeTo),
      reason: hop.reason,
    });
  }

  if (proxy) {
    const pxy = evaluateProxyException(config, hooks, {
      invocationId,
      envelopeFrom,
      envelopeTo,
      proxy,
      senderAuthorized,
      actor,
      rawText,
    });
    if (pxy.ok) {
      logger.info("inbound.route", {
        invocationId,
        kind: "send_proxy",
        fromEmail: proxy.fromEmail,
        rcptEmail: proxy.rcptEmail,
      });
      return handleSendProxy(env, message, config, hooks, {
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
      });
    }
    logger.warn("send_proxy.exception_skipped", {
      invocationId,
      envelopeFrom,
      envelopeTo,
      reason: pxy.reason,
    });
  }

  return null;
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function evaluateProxyException(config, hooks, ctx) {
  const { proxy, senderAuthorized, actor, rawText, envelopeFrom } = ctx;
  if (!senderAuthorized) return { ok: false, reason: "sender_not_authorized" };
  if (!actor.ok) return { ok: false, reason: "identity_unbound" };

  // CF auth must align to the allowlisted envelope identity — not MIME From
  // and not "either address" (attacker envelope + spoofed allowlisted From).
  if (!hooks.skipCfAuth && !cfAuthLooksPass(rawText, envelopeFrom)) {
    return { ok: false, reason: "cf_auth_failed" };
  }

  const resolved = resolveMailFrom(config, proxy.fromEmail);
  if (!resolved.ok) return { ok: false, reason: `send_proxy_from:${resolved.error}` };

  if (!actor.legacy) {
    if (!identityMaySendAs(actor.identity, resolved.mailFrom)) {
      return { ok: false, reason: "identity_mailbox_denied" };
    }
  }
  return { ok: true };
}

/**
 * Token is bound to its mint-time apex: the envelope recipient domain must
 * equal route.our_domain. Prevents a token minted for shops@example.com
 * from hopping as r+TOKEN@other.example on a shared Worker/D1.
 */
function replyTokenDomainMatches(route, replyTok) {
  return (
    String(route?.our_domain || "").trim().toLowerCase() ===
    String(replyTok?.ourDomain || "").trim().toLowerCase()
  );
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function evaluateReplyException(env, config, hooks, ctx) {
  const { replyTok, senderAuthorized, actor, rawText, envelopeFrom } = ctx;
  if (!senderAuthorized) return { ok: false, reason: "sender_not_authorized" };
  if (!actor.ok) return { ok: false, reason: "identity_unbound" };

  if (!hooks.skipCfAuth && !cfAuthLooksPass(rawText, envelopeFrom)) {
    return { ok: false, reason: "cf_auth_failed" };
  }

  const route = await db.getReplyRoute(env.DB, replyTok.token);
  if (!route) return { ok: false, reason: "token_unknown" };

  // Bind token to mint-time apex (shared Worker/D1 must not cross-hop).
  if (!replyTokenDomainMatches(route, replyTok)) {
    return { ok: false, reason: "token_domain_mismatch" };
  }

  if (!actor.legacy) {
    const hopMailbox = (
      route.our_mailbox ||
      `noreply@${route.our_domain}`
    ).toLowerCase();
    if (!identityMaySendAs(actor.identity, hopMailbox)) {
      return { ok: false, reason: "identity_mailbox_denied" };
    }
  }
  return { ok: true };
}

/**
 * Gmail (authorized) → special To → SMTP as alias@ourdomain → real recipient.
 * Exception route: does not CF-forward to default_inbox on success.
 * Precondition: tryDeliveryException already verified all gates.
 */
async function handleSendProxy(env, message, config, hooks, ctx) {
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

async function defaultDeliver(env, message, target, config, rawCtx = {}) {
  let method = target.method;
  if (!method && config) {
    method = resolveDriver(config, message.to || "", {
      email: target.destination,
    });
    target.method = method;
  }
  if (method === "cf_forward") {
    let headers;
    if (rawCtx.forwardTokenMeta) {
      headers = buildForwardTokenHeaders(rawCtx.forwardTokenMeta);
    }
    return cfForward(message, target.destination, headers);
  }
  if (method === "provider_send" || method === "smtp") {
    return {
      ok: false,
      error: "provider_send on normal inbound not wired; use send-proxy or r+ token",
    };
  }
  return {
    ok: false,
    error: `unsupported method: ${method}`,
  };
}

/**
 * Existing r+ token for this inbound, if any (oldest row if historical dups).
 */
async function loadForwardTokenMeta(env, inboundId) {
  const route = await db.getReplyRouteByInboundId(env.DB, inboundId);
  if (!route) return null;
  const participants = await db.listReplyParticipants(env.DB, route.token);
  const primaryRow =
    participants.find((p) => p.role === "primary" || p.in_primary) ||
    participants[0];
  const others = participants
    .filter((p) => !primaryRow || p.email !== primaryRow.email)
    .map((p) => ({
      email: p.email,
      display_hint: p.display_hint,
      role: p.role,
      local_suffix: p.local_suffix,
    }));
  return {
    token: route.token,
    ourDomain: route.our_domain,
    ourMailbox: route.our_mailbox,
    primary: primaryRow
      ? {
          email: primaryRow.email,
          display_hint: primaryRow.display_hint,
          role: primaryRow.role || "primary",
          header: "from",
        }
      : { email: "unknown@invalid", role: "primary", header: "from" },
    others,
    multiparty: Boolean(Number(route.multiparty)),
  };
}

/**
 * Create reply_routes row + participants for X-CFEG forward headers / later r+ hop.
 */
async function mintForwardReplyToken(env, config, { inboundId, envelopeTo, domain, rawText }) {
  // Normalize at the write site: D1 must hold clean apex/mailbox values so
  // readers never depend on producer hygiene (helper stays belt-and-braces).
  const ourDomain = String(domain || recipientDomain(envelopeTo) || "")
    .trim()
    .toLowerCase();
  const ourMailbox = String(envelopeTo || "").trim().toLowerCase();
  // Only exclude *our* destinations / operator inbox — NOT authorized_from
  // (authorized_from are external senders who use the gateway; they ARE reply peers)
  const exclude = [config.default_inbox].filter(Boolean);
  const parts = extractExternalParticipants(rawText, ourDomain, exclude);
  if (!parts.length) {
    // still create token keyed off envelope from if present
    const from = getHeader(rawText, "from") || "";
    const m = from.match(/[^\s<>"]+@[^\s<>"]+/);
    parts.push({
      email: (m ? m[0] : "unknown@invalid").toLowerCase(),
      display_hint: from,
      role: "primary",
      header: "from",
    });
  }
  // Primary already first from extractExternalParticipants
  const primary = parts.find((p) => p.is_primary) || parts[0];
  const others = parts
    .filter((p) => p.email !== primary.email)
    .map((o, i) => ({ ...o, local_suffix: `p${i + 1}` }));
  const token = generateToken();
  const multiparty = true;

  await db.insertReplyRoute(env.DB, {
    token,
    inbound_id: inboundId,
    our_domain: ourDomain,
    our_mailbox: ourMailbox,
    created_at: Date.now(),
    multiparty,
    subject: getHeader(rawText, "subject") || "",
  });
  await db.insertReplyParticipant(env.DB, {
    id: randomId(),
    token,
    email: primary.email,
    display_hint: primary.display_hint,
    role: "primary",
    local_suffix: null,
    in_primary: true,
    in_all: true,
  });
  for (const o of others) {
    await db.insertReplyParticipant(env.DB, {
      id: randomId(),
      token,
      email: o.email,
      display_hint: o.display_hint,
      role: o.role || "cc",
      local_suffix: o.local_suffix,
      in_primary: false,
      in_all: true,
    });
  }

  return {
    token,
    ourDomain,
    ourMailbox,
    primary,
    others,
    multiparty,
  };
}

/**
 * Authorized Gmail → r+TOKEN@domain → ESP to original participant(s).
 * Exception route over the default cf_forward path.
 */
async function handleReplyHop(env, message, config, hooks, ctx) {
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
