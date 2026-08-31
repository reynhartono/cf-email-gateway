import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReplyTokenAddress,
  generateToken,
  extractExternalParticipants,
  cfAuthLooksPass,
} from "../src/reply_tokens.js";

describe("reply_tokens", () => {
  it("parse r+ forms", () => {
    assert.deepEqual(parseReplyTokenAddress("r+abc123@example.com"), {
      token: "abc123",
      suffix: null,
      ourDomain: "example.com",
      address: "r+abc123@example.com",
    });
    assert.equal(parseReplyTokenAddress("r+abc123.p1@example.com").suffix, "p1");
    assert.equal(parseReplyTokenAddress("r+abc123.all@example.com").suffix, "all");
    assert.equal(parseReplyTokenAddress("shops+a=b.com@example.com"), null);
  });

  it("generateToken length", () => {
    assert.equal(generateToken(10).length, 10);
  });

  it("extractExternalParticipants", () => {
    const raw =
      "From: Alice <alice@a.com>\r\nTo: x@example.com\r\nCc: Carol <carol@c.com>\r\n\r\nHi";
    const p = extractExternalParticipants(raw, "example.com", []);
    assert.ok(p.some((x) => x.email === "alice@a.com"));
    assert.ok(p.some((x) => x.email === "carol@c.com"));
  });

  it("CC Test: From + bare mail-tester local with digits", () => {
    const raw = [
      "From: Alice Example <alice@a.com>",
      "To: cc-test@example.com",
      "Cc: test-azr9s08j7@srv1.mail-tester.com",
      "Subject: CC Test 3",
      "",
      "body",
    ].join("\r\n");
    const p = extractExternalParticipants(raw, "example.com", [
      "me@gmail.com",
    ]);
    assert.equal(p.length, 2);
    assert.equal(p[0].email, "alice@a.com");
    assert.equal(p[0].role, "primary");
    assert.equal(p[0].display_hint, "Alice Example");
    assert.equal(p[1].email, "test-azr9s08j7@srv1.mail-tester.com");
    assert.equal(p[1].role, "cc");
  });

  it("Reply-To wins primary over From", () => {
    const raw = [
      "From: Alice <alice@a.com>",
      "Reply-To: Desk <desk@other.com>",
      "To: catch@example.com",
      "Cc: Carol <carol@c.com>",
      "",
      "hi",
    ].join("\r\n");
    const p = extractExternalParticipants(raw, "example.com", []);
    assert.equal(p[0].email, "desk@other.com");
    assert.equal(p[0].role, "primary");
    assert.equal(p[0].header, "reply-to");
    assert.equal(p[0].display_hint, "Desk");
    const emails = p.map((x) => x.email);
    assert.deepEqual(emails, [
      "desk@other.com",
      "alice@a.com",
      "carol@c.com",
    ]);
    assert.equal(p.find((x) => x.email === "alice@a.com").role, "from");
    assert.equal(p.find((x) => x.email === "carol@c.com").role, "cc");
  });

  it("multiple external To + Cc", () => {
    const raw = [
      "From: Alice <alice@a.com>",
      "To: Bob <bob@b.com>, catch@example.com, Dana <dana@d.com>",
      "Cc: Carol <carol@c.com>, Eve <eve@e.com>",
      "",
      "hi",
    ].join("\r\n");
    const p = extractExternalParticipants(raw, "example.com", []);
    assert.equal(p[0].email, "alice@a.com");
    assert.deepEqual(
      p.map((x) => x.email),
      [
        "alice@a.com",
        "bob@b.com",
        "dana@d.com",
        "carol@c.com",
        "eve@e.com",
      ],
    );
    assert.equal(p.find((x) => x.email === "bob@b.com").role, "to");
    assert.equal(p.find((x) => x.email === "carol@c.com").role, "cc");
    // our domain not included
    assert.ok(!p.some((x) => x.email.endsWith("@example.com")));
  });

  it("multi Reply-To", () => {
    const raw = [
      "From: Alice <alice@a.com>",
      "Reply-To: R1 <r1@x.com>, R2 <r2@x.com>",
      "To: catch@example.com",
      "",
      "hi",
    ].join("\r\n");
    const p = extractExternalParticipants(raw, "example.com", []);
    assert.equal(p[0].email, "r1@x.com");
    assert.equal(p[1].email, "r2@x.com");
    assert.equal(p[1].role, "reply-to");
    assert.equal(p[2].email, "alice@a.com");
  });


  it("cfAuthLooksPass", () => {
    const raw =
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(raw, "a@gmail.com"), true);
    assert.equal(cfAuthLooksPass("From: a@gmail.com\r\n\r\nx", "a@gmail.com"), false);
  });
});
