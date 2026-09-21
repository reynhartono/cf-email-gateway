import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseReplyTokenAddress,
  generateToken,
  extractExternalParticipants,
  cfAuthLooksPass,
  domainsAlignForAuth,
  parseAuthenticationResults,
  isCloudflareAuthservId,
} from "../src/reply_tokens.js";
import { getAllHeaders, getHeader } from "../src/util.js";

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


  it("cfAuthLooksPass requires aligned pass (issue #7)", () => {
    // Aligned Gmail DKIM + SPF on CF authserv
    const alignedGmail =
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com; spf=pass smtp.mailfrom=a@gmail.com\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(alignedGmail, "a@gmail.com"), true);

    // Missing AR
    assert.equal(cfAuthLooksPass("From: a@gmail.com\r\n\r\nx", "a@gmail.com"), false);

    // Unaligned: dkim=pass for unrelated domain must not authorize gmail From
    const unaligned =
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=evil.example header.i=@evil.example\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(unaligned, "a@gmail.com"), false);

    // Bare dkim=pass with no domain props — fail closed
    const barePass =
      "Authentication-Results: mx.cloudflare.net; dkim=pass\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(barePass, "a@gmail.com"), false);

    // fail/softfail only
    const failOnly =
      "Authentication-Results: mx.cloudflare.net; spf=fail smtp.mailfrom=a@gmail.com; dkim=fail header.d=gmail.com\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(failOnly, "a@gmail.com"), false);

    // Non-Gmail aligned dkim
    const otherAligned =
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=corp.example header.i=@corp.example\r\nFrom: bob@corp.example\r\n\r\nx";
    assert.equal(cfAuthLooksPass(otherAligned, "bob@corp.example"), true);

    // Non-Gmail with pass for wrong domain
    const otherUnaligned =
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=other.example\r\nFrom: bob@corp.example\r\n\r\nx";
    assert.equal(cfAuthLooksPass(otherUnaligned, "bob@corp.example"), false);

    // DMARC aligned pass
    const dmarc =
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=corp.example\r\nFrom: bob@corp.example\r\n\r\nx";
    assert.equal(cfAuthLooksPass(dmarc, "bob@corp.example"), true);

    // SPF aligned via smtp.mailfrom addr-spec
    const spf =
      "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=bob@corp.example\r\nFrom: bob@corp.example\r\n\r\nx";
    assert.equal(cfAuthLooksPass(spf, "bob@corp.example"), true);

    // Gmail From + google.com signing domain
    const googleSign =
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=google.com header.i=@google.com\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(googleSign, "a@gmail.com"), true);

    // Prefer CF AR when both client spoof and CF present: CF fails → false
    // (do not accept client-aligned pass when CF authserv exists and does not pass)
    const spoofPlusCfFail = [
      "Authentication-Results: attacker.invalid; dkim=pass header.d=gmail.com",
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=gmail.com; spf=fail smtp.mailfrom=a@gmail.com",
      "From: a@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(spoofPlusCfFail, "a@gmail.com"), false);

    // Prefer CF AR when CF aligned pass (client noise ignored for selection)
    const spoofPlusCfPass = [
      "Authentication-Results: attacker.invalid; dkim=pass header.d=evil.example",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com",
      "From: a@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(spoofPlusCfPass, "a@gmail.com"), true);

    // Client-forged AR alone (no Cloudflare authserv) → fail closed
    const clientOnly =
      "Authentication-Results: attacker.invalid; dkim=pass header.d=gmail.com header.i=@gmail.com\r\nFrom: a@gmail.com\r\n\r\nx";
    assert.equal(cfAuthLooksPass(clientOnly, "a@gmail.com"), false);

    // ARC-Authentication-Results aligned (CF authserv after i=N)
    const arc =
      "ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=corp.example\r\nFrom: bob@corp.example\r\n\r\nx";
    assert.equal(cfAuthLooksPass(arc, "bob@corp.example"), true);
  });

  it("isCloudflareAuthservId rejects substring spoofs (issue #13)", () => {
    assert.equal(isCloudflareAuthservId("mx.cloudflare.net"), true);
    assert.equal(isCloudflareAuthservId("cloudflare.net"), true);
    assert.equal(isCloudflareAuthservId("email.mx.cloudflare.net"), true);
    assert.equal(isCloudflareAuthservId("MX.CLOUDFLARE.NET"), true);
    assert.equal(isCloudflareAuthservId("mx.cloudflare.net."), true);

    assert.equal(isCloudflareAuthservId("notcloudflare.net"), false);
    assert.equal(isCloudflareAuthservId("cloudflare.evil"), false);
    assert.equal(isCloudflareAuthservId("evil.cloudflare.attacker"), false);
    assert.equal(isCloudflareAuthservId("cloudflare"), false);
    assert.equal(isCloudflareAuthservId("cloudflare.com"), false);
    assert.equal(isCloudflareAuthservId("mail.example.com"), false);
    assert.equal(isCloudflareAuthservId(""), false);
  });

  it("cfAuthLooksPass rejects spoofed cloudflare-substring authserv (issue #13)", () => {
    const alignedProps =
      "dkim=pass header.d=gmail.com header.i=@gmail.com; spf=pass smtp.mailfrom=a@gmail.com";

    for (const spoof of [
      "notcloudflare.net",
      "cloudflare.evil",
      "evil.cloudflare.attacker",
    ]) {
      const raw = `Authentication-Results: ${spoof}; ${alignedProps}\r\nFrom: a@gmail.com\r\n\r\nx`;
      assert.equal(
        cfAuthLooksPass(raw, "a@gmail.com"),
        false,
        `spoof authserv ${spoof} must fail closed`,
      );
    }

    // Legitimate CF authserv still passes
    const legit = `Authentication-Results: mx.cloudflare.net; ${alignedProps}\r\nFrom: a@gmail.com\r\n\r\nx`;
    assert.equal(cfAuthLooksPass(legit, "a@gmail.com"), true);

    // Spoof aligned pass must not override real CF fail
    const spoofPlusCfFail = [
      `Authentication-Results: notcloudflare.net; ${alignedProps}`,
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=gmail.com; spf=fail smtp.mailfrom=a@gmail.com",
      "From: a@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(spoofPlusCfFail, "a@gmail.com"), false);
  });

  it("domainsAlignForAuth and parseAuthenticationResults helpers", () => {
    assert.equal(domainsAlignForAuth("gmail.com", "gmail.com"), true);
    assert.equal(domainsAlignForAuth("gmail.com", "googlemail.com"), true);
    assert.equal(domainsAlignForAuth("gmail.com", "google.com"), true);
    assert.equal(domainsAlignForAuth("corp.example", "mail.corp.example"), true);
    assert.equal(domainsAlignForAuth("corp.example", "evil.example"), false);

    const parsed = parseAuthenticationResults(
      "mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com; spf=pass smtp.mailfrom=a@gmail.com",
    );
    assert.equal(parsed.authservId, "mx.cloudflare.net");
    assert.equal(parsed.methods.length, 2);
    assert.equal(parsed.methods[0].method, "dkim");
    assert.equal(parsed.methods[0].result, "pass");
    assert.equal(parsed.methods[0].props["header.d"], "gmail.com");
  });

  it("getAllHeaders returns every occurrence", () => {
    const raw =
      "Authentication-Results: first.example; dkim=pass\r\nAuthentication-Results: second.example; spf=pass\r\nFrom: a@b.com\r\n\r\nx";
    assert.deepEqual(getAllHeaders(raw, "authentication-results"), [
      "first.example; dkim=pass",
      "second.example; spf=pass",
    ]);
    assert.equal(getHeader(raw, "authentication-results"), "second.example; spf=pass");
  });

  it("cfAuthLooksPass fails closed on multiple CF-looking lines (issue #22)", () => {
    // Synthetic repro from the issue: client-looking CF pass + receiving CF fail
    const cfPassPlusCfFail = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com",
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=gmail.com; spf=fail smtp.mailfrom=me@gmail.com",
      "From: me@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(cfPassPlusCfFail, "me@gmail.com"), false);

    // Reversed order must also fail (order-independent fail-closed)
    const cfFailPlusCfPass = [
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=gmail.com; spf=fail smtp.mailfrom=me@gmail.com",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com",
      "From: me@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(cfFailPlusCfPass, "me@gmail.com"), false);

    // Two CF-looking passes for the identity → still passes
    const twoCfPass = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com",
      "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=me@gmail.com",
      "From: me@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(twoCfPass, "me@gmail.com"), true);

    // CF pass for the identity + CF line that does not mention it → passes
    const passPlusUnrelated = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=other.example",
      "From: me@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(passPlusUnrelated, "me@gmail.com"), true);

    // CF none for the identity alongside a CF pass → fails closed
    const passPlusNone = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=corp.example",
      "Authentication-Results: mx.cloudflare.net; dkim=none header.d=corp.example",
      "From: bob@corp.example",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(passPlusNone, "bob@corp.example"), false);

    // ARC + AR mix: CF-looking ARC pass + CF AR fail → fails closed
    const arcPassPlusArFail = [
      "ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=corp.example",
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=corp.example",
      "From: bob@corp.example",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(arcPassPlusArFail, "bob@corp.example"), false);

    // softfail for the identity vetoes just like fail/none (docs behavior)
    const passPlusSoftfail = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=corp.example",
      "Authentication-Results: mx.cloudflare.net; dkim=softfail header.d=corp.example",
      "From: bob@corp.example",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(passPlusSoftfail, "bob@corp.example"), false);

    // dmarc-only multi-line: dmarc pass + dmarc fail → fails closed
    const dmarcPassPlusDmarcFail = [
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=corp.example",
      "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=corp.example",
      "From: bob@corp.example",
      "",
      "x",
    ].join("\r\n");
    assert.equal(
      cfAuthLooksPass(dmarcPassPlusDmarcFail, "bob@corp.example"),
      false,
    );

    // 3 lines: pass + unrelated + fail → unrelated ignored, fail still vetoes
    const passUnrelatedFail = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com header.i=@gmail.com",
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=other.example",
      "Authentication-Results: mx.cloudflare.net; dkim=fail header.d=gmail.com",
      "From: me@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(passUnrelatedFail, "me@gmail.com"), false);

    // Gmail subdomain signatures count as google ecosystem (no false veto)
    const gmailSubdomain = [
      "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=sub.gmail.com header.i=@sub.gmail.com",
      "From: me@gmail.com",
      "",
      "x",
    ].join("\r\n");
    assert.equal(cfAuthLooksPass(gmailSubdomain, "me@gmail.com"), true);
  });
});
