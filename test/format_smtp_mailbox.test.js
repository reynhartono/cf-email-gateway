import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSmtpMailbox } from "../src/reply_tokens.js";
import { parseSendProxyAddress } from "../src/send_proxy.js";

describe("formatSmtpMailbox trusted angle-addr", () => {
  const trusted = "shops@example.com";

  it("uses plain display name with trusted addr", () => {
    assert.equal(formatSmtpMailbox("Shop Support", trusted), `"Shop Support" <${trusted}>`);
  });

  it("returns bare addr when name empty or equals trusted", () => {
    assert.equal(formatSmtpMailbox("", trusted), trusted);
    assert.equal(formatSmtpMailbox(null, trusted), trusted);
    assert.equal(formatSmtpMailbox(trusted, trusted), trusted);
    assert.equal(formatSmtpMailbox("Shops@Example.com", trusted), trusted);
  });

  it("allows email-as-display-name without changing angle-addr", () => {
    assert.equal(
      formatSmtpMailbox("ceo@other.com", trusted),
      `"ceo@other.com" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox("support@partner.example", trusted),
      `"support@partner.example" <${trusted}>`,
    );
  });

  it("keeps nested Name <foreign> inside quotes; angle-addr stays trusted", () => {
    assert.equal(
      formatSmtpMailbox("CEO <ceo@other.com>", trusted),
      `"CEO <ceo@other.com>" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox('"CEO" <ceo@other.com>', trusted),
      `"CEO <ceo@other.com>" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox("CEO_ <ceo@other.com>", trusted),
      `"CEO_ <ceo@other.com>" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox("<ceo@other.com>", trusted),
      `"<ceo@other.com>" <${trusted}>`,
    );
  });

  it("does not double-wrap when name already uses the trusted mailbox", () => {
    assert.equal(
      formatSmtpMailbox(`Shop Support <${trusted}>`, trusted),
      `"Shop Support" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox(`"Shop Support" <${trusted}>`, trusted),
      `"Shop Support" <${trusted}>`,
    );
  });

  it("strips CR/LF from display", () => {
    assert.equal(
      formatSmtpMailbox("Bad\r\nName", trusted),
      `"BadName" <${trusted}>`,
    );
  });

  it("escapes backslash so trailing \\ cannot break the quoted-string", () => {
    assert.equal(
      formatSmtpMailbox("CEO\\", trusted),
      `"CEO\\\\" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox("a\\b\\", trusted),
      `"a\\\\b\\\\" <${trusted}>`,
    );
    // nested foreign mailbox + trailing \ still keeps trusted angle-addr
    assert.equal(
      formatSmtpMailbox("CEO <ceo@other.com>\\", trusted),
      `"CEO <ceo@other.com>\\\\" <${trusted}>`,
    );
  });

  it("send-proxy braces {CEO_<ceo@other.com>} → quoted nested display + gated From", () => {
    const p = parseSendProxyAddress(
      "shops{CEO_<ceo@other.com>}+alice=gmail.com@example.com",
    );
    assert.ok(p);
    assert.equal(p.fromEmail, "shops@example.com");
    // decodeDisplayName turns _ → space → "CEO <ceo@other.com>"
    assert.equal(p.aliasDisplay, "CEO <ceo@other.com>");
    assert.equal(
      formatSmtpMailbox(p.aliasDisplay, p.fromEmail),
      `"CEO <ceo@other.com>" <shops@example.com>`,
    );
  });

  it("send-proxy braces with email-as-display keep that label on trusted From", () => {
    const p = parseSendProxyAddress(
      "shops{ceo@other.com}+alice=gmail.com@example.com",
    );
    assert.ok(p);
    assert.equal(p.aliasDisplay, "ceo@other.com");
    assert.equal(
      formatSmtpMailbox(p.aliasDisplay, p.fromEmail),
      `"ceo@other.com" <shops@example.com>`,
    );
  });
});
