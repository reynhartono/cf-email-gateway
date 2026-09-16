/**
 * HTTP: compose + SMTP selftest
 * (GET /health is owned by src/index.js — includes routing_ok; do not duplicate here.)
 */

import { resolveMailFrom } from "./mail_from.js";
import {
  assertNoHeaderControlChars,
  sendOutboundMime,
} from "./providers/send_outbound.js";
import { bareEmail, hasSmtp } from "./providers/smtp.js";
import { randomId } from "./util.js";
import {
  identityMaySendAs,
  resolveComposeCaller,
} from "./identity.js";

/**
 * @param {Request} request
 * @param {object} env
 * @param {import('./config.js').RoutingConfig} config
 */
export async function handleCompose(request, env, config) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/v1/smtp-selftest" || path === "/smtp-selftest") {
    return handleSmtpSelftest(request, env, config);
  }

  if (path !== "/v1/compose" && path !== "/compose") {
    return json({ ok: false, error: "not found" }, 404);
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "POST required" }, 405);
  }

  const got = bearerFromRequest(request);
  const caller = resolveComposeCaller(config, got, env.COMPOSE_API_TOKEN);
  if (!caller.ok) {
    return json({ ok: false, error: caller.error }, caller.status || 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const to = body.to;
  const toList = Array.isArray(to) ? to : to ? [to] : [];
  if (!toList.length) {
    return json({ ok: false, error: "to required" }, 400);
  }

  const requestedFrom =
    body.from || body.mail_from || config.compose?.default_from || "";
  const resolved = resolveMailFrom(config, requestedFrom);
  if (!resolved.ok) {
    return json({ ok: false, error: resolved.error }, 400);
  }

  if (!identityMaySendAs(caller.identity, resolved.mailFrom)) {
    return json(
      {
        ok: false,
        error: `identity ${caller.identity.id} not allowed to compose from ${resolved.mailFrom}`,
        identity: caller.identity.id,
        mail_from: resolved.mailFrom,
      },
      403,
    );
  }

  const attachments = [];
  for (const a of body.attachments || []) {
    if (!a?.filename || a.content_base64 == null) continue;
    attachments.push({
      filename: a.filename,
      contentType: a.content_type || a.contentType || "application/octet-stream",
      content: a.content_base64,
    });
  }

  const result = await sendOutboundMime(env, {
    to: toList,
    cc: body.cc,
    bcc: body.bcc,
    mailFrom: resolved.mailFrom,
    fromName: body.from_name || body.fromName,
    subject: body.subject,
    text: body.text,
    html: body.html,
    headers: body.headers,
    attachments: attachments.length ? attachments : undefined,
  });

  const id = randomId();
  if (!result.ok) {
    // clientError = bad JSON fields / MIME construction (issue #9) → 400
    const status = result.clientError ? 400 : 502;
    return json(
      {
        ok: false,
        error: result.error,
        compose_id: id,
        mail_from: resolved.mailFrom,
        identity: caller.identity.id,
        provider_status: result.providerStatus,
      },
      status,
    );
  }

  return json({
    ok: true,
    compose_id: id,
    mail_from: resolved.mailFrom,
    identity: caller.identity.id,
    provider_message_id: result.providerMessageId,
  });
}

function bearerFromRequest(request) {
  const auth = request.headers.get("authorization") || "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : auth.trim();
}

function requireComposeAuth(request, env) {
  const token = env.COMPOSE_API_TOKEN;
  if (!token) {
    return json({ ok: false, error: "COMPOSE_API_TOKEN not configured" }, 503);
  }
  const got = bearerFromRequest(request);
  if (got !== token) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

/**
 * POST/GET /v1/smtp-selftest — multipart/alternative via SMTP DATA
 * Query: to=email (default default_inbox or me@gmail.com)
 */
async function handleSmtpSelftest(request, env, config) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "GET or POST" }, 405);
  }
  const authErr = requireComposeAuth(request, env);
  if (authErr) return authErr;

  const present = {
    SMTP_HOST: Boolean(env.SMTP_HOST),
    SMTP_USERNAME: Boolean(env.SMTP_USERNAME || env.SMTP_USER),
    SMTP_PASSWORD: Boolean(env.SMTP_PASSWORD || env.SMTP_PASS),
    SMTP_PORT: env.SMTP_PORT || "465",
    hasSmtp: hasSmtp(env),
  };

  if (!present.hasSmtp) {
    return json(
      {
        ok: false,
        error: "SMTP secrets missing",
        present,
        hint: "SMTP_HOST + SMTP_USERNAME + SMTP_PASSWORD",
      },
      503,
    );
  }

  const url = new URL(request.url);
  let toRaw =
    url.searchParams.get("to") || config?.default_inbox || "me@gmail.com";
  if (request.method === "POST") {
    try {
      const b = await request.json();
      if (b?.to) toRaw = b.to;
    } catch {
      /* ignore */
    }
  }

  let to;
  try {
    assertNoHeaderControlChars("to", toRaw);
    to = bareEmail(toRaw);
  } catch (err) {
    return json(
      {
        ok: false,
        error: err?.message || "invalid to",
        present,
      },
      400,
    );
  }
  if (!to) {
    return json({ ok: false, error: "to must be a valid email", present }, 400);
  }

  const boundary = `b${Date.now()}`;
  const from = "smtp-selftest@example.com";
  const mime = [
    `From: "SMTP Selftest" <${from}>`,
    `To: ${to}`,
    `Subject: cf-email-gateway smtp-selftest multipart`,
    `Message-ID: <smtp-selftest-${Date.now()}@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    `SMTP 1:1 selftest plain`,
    `Best regards,`,
    `Operator`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    `<div dir=3D"ltr"><b>SMTP 1:1 selftest HTML</b><div>Best regards,</div><div><a href=3D"https://example.com/">example.com</a></div></div>`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  const result = await sendOutboundMime(env, {
    mailFrom: from,
    to,
    mimeText: mime,
  });

  return json({
    ok: Boolean(result.ok),
    present,
    transport: result.transport,
    provider_message_id: result.providerMessageId,
    error: result.error || null,
    to,
    from,
    note: "Open message and confirm multipart/alternative + HTML part present",
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
