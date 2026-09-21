import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSmtpSecureTransport, parseSmtpPort, smtpSend } from "../src/providers/smtp.js";

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

  it("maps the remaining known ports", () => {
    for (const port of [8465, 443]) {
      assert.deepStrictEqual(resolveSmtpSecureTransport({}, port), {
        ok: true,
        secureTransport: "on",
      });
    }
    for (const port of [2525, 8025]) {
      assert.deepStrictEqual(resolveSmtpSecureTransport({}, port), {
        ok: true,
        secureTransport: "starttls",
      });
    }
  });

  it("fails closed on out-of-range / non-integer ports", () => {
    for (const [raw, port] of [
      ["0", 0],
      ["65536", 65536],
      ["-1", -1],
      ["465.5", 465.5],
    ]) {
      const r = resolveSmtpSecureTransport({ SMTP_PORT: raw }, port);
      assert.equal(r.ok, false, `port ${raw} should fail closed`);
      assert.match(r.error, /invalid SMTP_PORT/);
    }
  });

  it("accepts case/whitespace variants of SMTP_TLS", () => {
    assert.deepStrictEqual(
      resolveSmtpSecureTransport({ SMTP_TLS: " ON " }, 2465),
      { ok: true, secureTransport: "on" },
    );
    assert.deepStrictEqual(
      resolveSmtpSecureTransport({ SMTP_TLS: "STARTTLS" }, 80),
      { ok: true, secureTransport: "starttls" },
    );
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

describe("parseSmtpPort", () => {
  it("defaults unset or blank to 465", () => {
    assert.equal(parseSmtpPort({}), 465);
    assert.equal(parseSmtpPort({ SMTP_PORT: undefined }), 465);
    assert.equal(parseSmtpPort({ SMTP_PORT: null }), 465);
    assert.equal(parseSmtpPort({ SMTP_PORT: "" }), 465);
    assert.equal(parseSmtpPort({ SMTP_PORT: "   " }), 465);
  });

  it("passes other values through Number", () => {
    assert.equal(parseSmtpPort({ SMTP_PORT: "465" }), 465);
    assert.equal(parseSmtpPort({ SMTP_PORT: 587 }), 587);
    assert.equal(parseSmtpPort({ SMTP_PORT: 0 }), 0);
    assert.ok(Number.isNaN(parseSmtpPort({ SMTP_PORT: "abc" })));
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

  it("treats numeric 0 as a port, not as unset (fails closed)", async () => {
    const res = await smtpSend({ ...BASE_ENV, SMTP_PORT: 0 }, REQ);
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
