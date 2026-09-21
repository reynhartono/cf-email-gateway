import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSmtpSecureTransport, smtpSend } from "../src/providers/smtp.js";

const BASE_ENV = {
  SMTP_HOST: "mail.example.com",
  SMTP_USERNAME: "smtp-user",
  SMTP_PASSWORD: "smtp-pass",
};

const REQ = {
  mailFrom: "shops@example.com",
  to: "me@gmail.com",
  mimeText: "Subject: hi\r\n\r\nbody\r\n",
};

describe("resolveSmtpSecureTransport", () => {
  it("maps 465 to implicit TLS", () => {
    assert.deepStrictEqual(resolveSmtpSecureTransport({}, 465), {
      ok: true,
      secureTransport: "on",
    });
  });

  it("maps 587 to STARTTLS", () => {
    assert.deepStrictEqual(resolveSmtpSecureTransport({}, 587), {
      ok: true,
      secureTransport: "starttls",
    });
  });

  it("fails closed on unknown ports", () => {
    for (const port of [25, 80, 2465, 2526]) {
      const r = resolveSmtpSecureTransport({}, port);
      assert.equal(r.ok, false, `port ${port} should fail closed`);
      assert.match(r.error, /refusing plaintext SMTP/);
    }
  });

  it("fails closed on non-numeric ports", () => {
    const r = resolveSmtpSecureTransport({ SMTP_PORT: "abc" }, NaN);
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid SMTP_PORT/);
  });

  it("validates the port even when SMTP_TLS is set", () => {
    const r = resolveSmtpSecureTransport(
      { SMTP_PORT: "abc", SMTP_TLS: "on" },
      NaN,
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid SMTP_PORT/);
  });

  it("requires explicit SMTP_TLS for port 80", () => {
    const without = resolveSmtpSecureTransport({}, 80);
    assert.equal(without.ok, false);
    const withOverride = resolveSmtpSecureTransport(
      { SMTP_TLS: "starttls" },
      80,
    );
    assert.deepStrictEqual(withOverride, {
      ok: true,
      secureTransport: "starttls",
    });
  });

  it("allows a rare port with SMTP_TLS=on", () => {
    assert.deepStrictEqual(
      resolveSmtpSecureTransport({ SMTP_TLS: "on" }, 2465),
      {
        ok: true,
        secureTransport: "on",
      },
    );
  });

  it("rejects unknown SMTP_TLS values", () => {
    const r = resolveSmtpSecureTransport({ SMTP_TLS: "off" }, 465);
    assert.equal(r.ok, false);
    assert.match(r.error, /unknown SMTP_TLS/);
  });
});

describe("smtpSend TLS fail-closed", () => {
  it("returns ok:false on unknown port without connecting", async () => {
    const res = await smtpSend({ ...BASE_ENV, SMTP_PORT: "25" }, REQ);
    assert.equal(res.ok, false);
    assert.match(res.error, /refusing plaintext SMTP/);
  });

  it("returns ok:false on non-numeric port without connecting", async () => {
    const res = await smtpSend({ ...BASE_ENV, SMTP_PORT: "abc" }, REQ);
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid SMTP_PORT/);
  });

  it("returns ok:false on bad SMTP_TLS without connecting", async () => {
    const res = await smtpSend(
      { ...BASE_ENV, SMTP_PORT: "465", SMTP_TLS: "off" },
      REQ,
    );
    assert.equal(res.ok, false);
    assert.match(res.error, /unknown SMTP_TLS/);
  });
});
