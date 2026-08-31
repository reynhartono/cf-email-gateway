import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, FEATURES } from "../src/config.js";
import { resolveMailFrom, sendAsAllowed } from "../src/mail_from.js";
import { buildComposeMime, sendOutboundMime } from "../src/providers/send_outbound.js";
import { hasSmtp } from "../src/providers/smtp.js";
import { handleCompose } from "../src/compose.js";

describe("mail_from", () => {
  it("allows example.com when send_as enabled", () => {
    const c = normalizeConfig({
      version: 1,
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    assert.equal(sendAsAllowed(c, "example.com"), true);
    const r = resolveMailFrom(c, "me@example.com");
    assert.equal(r.ok, true);
    assert.equal(r.mailFrom, "me@example.com");
  });

  it("remaps via send_as.domain", () => {
    const c = normalizeConfig({
      version: 1,
      domains: {
        "example.com": { send_as: { enabled: true, domain: "example.com" } },
      },
    });
    const r = resolveMailFrom(c, "alias@example.com");
    assert.equal(r.ok, true);
    assert.equal(r.mailFrom, "alias@example.com");
  });

  it("rejects unknown domain", () => {
    const c = normalizeConfig({ version: 1, domains: {} });
    const r = resolveMailFrom(c, "x@evil.com");
    assert.equal(r.ok, false);
  });
});

describe("generic smtp outbound", () => {
  it("hasSmtp requires host+user+pass", () => {
    assert.equal(hasSmtp({}), false);
    assert.equal(
      hasSmtp({
        SMTP_HOST: "mail.example.com",
        SMTP_USERNAME: "u",
        SMTP_PASSWORD: "p",
      }),
      true,
    );
  });

  it("buildComposeMime multipart alt", () => {
    const mime = buildComposeMime({
      mailFrom: "me@example.com",
      fromName: "Operator",
      to: "a@b.com",
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
    });
    assert.match(mime, /multipart\/alternative/);
    assert.match(mime, /From: "Operator" <me@example\.com>/);
    assert.match(mime, /To: a@b.com/);
    assert.match(mime, /Hello/);
    assert.match(mime, /<p>Hello<\/p>/);
  });

  it("sendOutboundMime fails without SMTP secrets", async () => {
    const r = await sendOutboundMime(
      {},
      { to: "a@b.com", mailFrom: "me@example.com", subject: "x", text: "y" },
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /SMTP/);
  });
});

describe("compose HTTP", () => {
  const config = normalizeConfig({
    version: 1,
    compose: { default_from: "me@example.com" },
    domains: { "example.com": { send_as: { enabled: true } } },
  });

  it("401 without token", async () => {
    const res = await handleCompose(
      new Request("https://x/v1/compose", {
        method: "POST",
        body: JSON.stringify({ to: "a@b.com", subject: "s", text: "t" }),
      }),
      { COMPOSE_API_TOKEN: "secret" },
      config,
    );
    assert.equal(res.status, 401);
  });

  it("502 when SMTP not configured", async () => {
    const res = await handleCompose(
      new Request("https://x/v1/compose", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: "friend@gmail.com",
          subject: "Hello",
          text: "World",
        }),
      }),
      { COMPOSE_API_TOKEN: "secret" },
      config,
    );
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(j.error, /SMTP/);
  });
});

describe("FEATURES", () => {
  it("provider_send enabled", () => {
    assert.equal(FEATURES.provider_send, true);
  });
});
