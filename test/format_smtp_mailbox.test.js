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

  it("never takes angle-addr from nested Name <foreign> display", () => {
    assert.equal(
      formatSmtpMailbox("CEO <ceo@other.com>", trusted),
      `"CEO" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox('"CEO" <ceo@other.com>', trusted),
      `"CEO" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox("CEO_ <ceo@other.com>", trusted),
      `"CEO_" <${trusted}>`,
    );
    // empty display-name + nested mailbox → bare trusted
    assert.equal(formatSmtpMailbox("<ceo@other.com>", trusted), trusted);
  });

  it("strips loose angle segments instead of emitting foreign mailbox", () => {
    assert.equal(
      formatSmtpMailbox("CEO <ceo@other.com> ", trusted),
      `"CEO" <${trusted}>`,
    );
    assert.equal(
      formatSmtpMailbox("Label <not-an-email> tail", trusted),
      `"Label tail" <${trusted}>`,
    );
  });

  it("strips CR/LF from display", () => {
    assert.equal(
      formatSmtpMailbox("Bad\r\nName", trusted),
      `"BadName" <${trusted}>`,
    );
  });

  it("send-proxy braces that smuggle Name <foreign> keep gated From", () => {
    const p = parseSendProxyAddress(
      "shops{CEO_<ceo@other.com>}+alice=gmail.com@example.com",
    );
    assert.ok(p);
    assert.equal(p.fromEmail, "shops@example.com");
    // decodeDisplayName turns _ → space → "CEO <ceo@other.com>"
    assert.equal(p.aliasDisplay, "CEO <ceo@other.com>");
    assert.equal(
      formatSmtpMailbox(p.aliasDisplay, p.fromEmail),
      `"CEO" <shops@example.com>`,
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
