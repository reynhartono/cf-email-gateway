import * as db from "./db.js";
import { resolveMailFrom } from "./mail_from.js";
import { identityMaySendAs } from "./identity.js";
import { cfAuthLooksPass } from "./reply_tokens.js";
import {
  logger,
  redactReplyTokenAddressForLog,
  replyTokenLogFields,
} from "./log.js";
import { handleSendProxy } from "./send_proxy_handler.js";
import {
  handleReplyHop,
  replyTokenDomainMatches,
} from "./reply_hop_handler.js";

export { replyTokenDomainMatches };

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
export async function tryDeliveryException(env, message, config, hooks, ctx) {
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
export function evaluateProxyException(config, hooks, ctx) {
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
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
export async function evaluateReplyException(env, config, hooks, ctx) {
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
