import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSmtpEhloDomain } from "../src/providers/smtp.js";

describe("resolveSmtpEhloDomain", () => {
  it("uses the MAIL FROM domain", () => {
    assert.equal(resolveSmtpEhloDomain("shops@example.com"), "example.com");
  });

  it("lowercases and unwraps display form", () => {
    assert.equal(
      resolveSmtpEhloDomain('"Shops" <Shops@Example.COM>'),
      "example.com",
    );
  });

  it("uses the subdomain as-is", () => {
    assert.equal(
      resolveSmtpEhloDomain("alice@mail.example.com"),
      "mail.example.com",
    );
  });

  it("falls back when the domain is unusable", () => {
    assert.equal(
      resolveSmtpEhloDomain("not-an-address"),
      "cf-email-gateway.workers.dev",
    );
    assert.equal(
      resolveSmtpEhloDomain(""),
      "cf-email-gateway.workers.dev",
    );
  });
});
