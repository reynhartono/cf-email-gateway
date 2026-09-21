import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSmtpEhloDomain, smtpSend } from "../src/providers/smtp.js";

describe("resolveSmtpEhloDomain", () => {
  it("uses the MAIL FROM domain", () => {
    assert.deepStrictEqual(resolveSmtpEhloDomain("shops@example.com"), {
      ok: true,
      ehlo: "example.com",
    });
  });

  it("lowercases and unwraps display form", () => {
    assert.deepStrictEqual(
      resolveSmtpEhloDomain('"Shops" <Shops@Example.COM>'),
      { ok: true, ehlo: "example.com" },
    );
  });

  it("uses the subdomain as-is", () => {
    assert.deepStrictEqual(resolveSmtpEhloDomain("alice@mail.example.com"), {
      ok: true,
      ehlo: "mail.example.com",
    });
  });

  it("fails closed on single-label names such as localhost", () => {
    for (const from of ["app@localhost", "app@mailserver"]) {
      const r = resolveSmtpEhloDomain(from);
      assert.equal(r.ok, false, `${from} should fail closed`);
      assert.match(r.error, /invalid EHLO domain/);
    }
  });

  it("fails closed on bare IPs and malformed domains", () => {
    for (const from of [
      "app@192.168.1.1",
      "app@123.456",
      "not-an-address",
      "",
      "app@-bad.example.com",
      "app@bad..example.com",
    ]) {
      const r = resolveSmtpEhloDomain(from);
      assert.equal(r.ok, false, `${from || "(empty)"} should fail closed`);
      assert.match(r.error, /invalid EHLO domain/);
    }
  });

  it("fails closed on overlong labels, trailing dots, and unicode", () => {
    for (const from of [
      `app@${"a".repeat(64)}.example.com`,
      "app@example.com.",
      "app@münchen.example.com",
      "app@under_score.example.com",
    ]) {
      const r = resolveSmtpEhloDomain(from);
      assert.equal(r.ok, false, `${from.slice(0, 30)} should fail closed`);
      assert.match(r.error, /invalid EHLO domain/);
    }
    // 63-char labels are still fine.
    assert.deepStrictEqual(
      resolveSmtpEhloDomain(`app@${"a".repeat(63)}.example.com`),
      { ok: true, ehlo: `${"a".repeat(63)}.example.com` },
    );
  });

  it("keeps the error single-line on control-character input", () => {
    const r = resolveSmtpEhloDomain("foo\r\nBAR");
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid EHLO domain/);
    assert.doesNotMatch(r.error, /[\r\n]/);
  });
});

describe("smtpSend EHLO fail-closed", () => {
  it("returns ok:false without connecting on invalid EHLO domain", async () => {
    const env = {
      SMTP_HOST: "mail.example.com",
      SMTP_USERNAME: "smtp-user",
      SMTP_PASSWORD: "smtp-pass",
    };
    const res = await smtpSend(env, {
      mailFrom: "app@localhost",
      to: "me@gmail.com",
      mimeText: "Subject: hi\r\n\r\nbody\r\n",
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /invalid EHLO domain/);
  });

  it("reports missing body before invalid EHLO domain", async () => {
    const env = {
      SMTP_HOST: "mail.example.com",
      SMTP_USERNAME: "smtp-user",
      SMTP_PASSWORD: "smtp-pass",
    };
    const res = await smtpSend(env, {
      mailFrom: "app@localhost",
      to: "me@gmail.com",
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /smtp mimeText required/);
  });
});
