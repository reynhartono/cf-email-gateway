import { recipientDomain } from "./config.js";
import { getHeader, randomId } from "./util.js";
import * as db from "./db.js";
import {
  extractExternalParticipants,
  generateToken,
} from "./reply_tokens.js";

/**
 * Existing r+ token for this inbound, if any (oldest row if historical dups).
 */
export async function loadForwardTokenMeta(env, inboundId) {
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
export async function mintForwardReplyToken(env, config, { inboundId, envelopeTo, domain, rawText }) {
  // Normalize at the write site: D1 must hold clean apex/mailbox values so
  // readers never depend on producer hygiene (helper stays belt-and-braces).
  // Trim before the truthiness check so a whitespace-only domain falls back
  // to recipientDomain instead of trimming down to "".
  const ourDomain =
    String(domain || "").trim().toLowerCase() ||
    String(recipientDomain(envelopeTo) || "").trim().toLowerCase();
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
