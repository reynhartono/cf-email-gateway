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

  it("buildComposeMime rejects CRLF in To (no header injection)", () => {
    assert.throws(
      () =>
        buildComposeMime({
          mailFrom: "me@example.com",
          to: "a@b.com\r\nBcc: evil@evil.com",
          subject: "Hi",
          text: "Hello",
        }),
      (err) => {
        assert.match(String(err.message), /to|CRLF|header|control/i);
        return true;
      },
    );
  });

  it("buildComposeMime rejects CRLF in Cc", () => {
    assert.throws(
      () =>
        buildComposeMime({
          mailFrom: "me@example.com",
          to: "a@b.com",
          cc: "c@d.com\nX-Injected: yes",
          subject: "Hi",
          text: "Hello",
        }),
      (err) => {
        assert.match(String(err.message), /cc|CRLF|header|control/i);
        return true;
      },
    );
  });

  it("buildComposeMime rejects illegal custom header names", () => {
    assert.throws(
      () =>
        buildComposeMime({
          mailFrom: "me@example.com",
          to: "a@b.com",
          subject: "Hi",
          text: "Hello",
          headers: { "X-Foo\r\nBcc": "smuggled@evil.com" },
        }),
      (err) => {
        assert.match(String(err.message), /header name/i);
        return true;
      },
    );
  });

  it("buildComposeMime strips CR/LF in custom header values (no new header line)", () => {
    const mime = buildComposeMime({
      mailFrom: "me@example.com",
      to: "a@b.com",
      subject: "Hi",
      text: "Hello",
      headers: { "X-Trace": "one\r\nBcc: evil@evil.com" },
    });
    assert.equal(mime.includes("\nBcc:"), false);
    assert.equal(mime.includes("\rBcc:"), false);
    assert.match(mime, /^X-Trace: one\s+Bcc: evil@evil.com$/m);
  });

  it("buildComposeMime rejects CRLF / breakout in attachment filename", () => {
    assert.throws(
      () =>
        buildComposeMime({
          mailFrom: "me@example.com",
          to: "a@b.com",
          subject: "Hi",
          text: "Hello",
          attachments: [
            {
              filename: 'x.txt"\r\nContent-Type: text/plain',
              contentType: "application/octet-stream",
              content: Buffer.from("hi").toString("base64"),
            },
          ],
        }),
      (err) => {
        assert.match(String(err.message), /filename|CRLF|control|attachment/i);
        return true;
      },
    );
  });

  it("buildComposeMime rejects illegal attachment contentType", () => {
    assert.throws(
      () =>
        buildComposeMime({
          mailFrom: "me@example.com",
          to: "a@b.com",
          subject: "Hi",
          text: "Hello",
          attachments: [
            {
              filename: "x.bin",
              contentType: 'application/octet-stream; x="y"\r\nX-Evil: 1',
              content: "YQ==",
            },
          ],
        }),
      (err) => {
        assert.match(String(err.message), /contentType|content-type|type/i);
        return true;
      },
    );
  });

  it("buildComposeMime allows safe custom X- header and attachment", () => {
    const mime = buildComposeMime({
      mailFrom: "me@example.com",
      to: "a@b.com",
      subject: "Hi",
      text: "Hello",
      headers: { "X-Request-Id": "abc-123" },
      attachments: [
        {
          filename: "note.txt",
          contentType: "text/plain",
          content: Buffer.from("hi").toString("base64"),
        },
      ],
    });
    assert.match(mime, /^X-Request-Id: abc-123$/m);
    assert.match(mime, /filename="note.txt"/);
    assert.match(mime, /Content-Type: text\/plain; name="note.txt"/);
  });

  it("sendOutboundMime returns clientError before SMTP check on bad To", async () => {
    const r = await sendOutboundMime(
      {},
      {
        to: "a@b.com\r\nBcc: evil@evil.com",
        mailFrom: "me@example.com",
        subject: "x",
        text: "y",
      },
    );
    assert.equal(r.ok, false);
    assert.equal(r.clientError, true);
    assert.match(r.error, /to|CRLF|header|control/i);
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

  it("403 when identity compose bearer used outside can_send_as", async () => {
    const multi = normalizeConfig({
      version: 1,
      domains: { "example.com": { send_as: { enabled: true } } },
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          compose_bearer: "tok-alice",
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
        {
          id: "operator",
          authorized_from: ["me@gmail.com"],
          unrestricted: true,
        },
      ],
    });
    const res = await handleCompose(
      new Request("https://x/v1/compose", {
        method: "POST",
        headers: {
          authorization: "Bearer tok-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: "bob.shop@example.com",
          to: "friend@gmail.com",
          subject: "nope",
          text: "x",
        }),
      }),
      { COMPOSE_API_TOKEN: "secret" },
      multi,
    );
    assert.equal(res.status, 403);
    const j = await res.json();
    assert.match(j.error, /not allowed/i);
    assert.equal(j.identity, "alice");
  });

  it("allows identity compose from own prefix (fails later on SMTP)", async () => {
    const multi = normalizeConfig({
      version: 1,
      domains: { "example.com": { send_as: { enabled: true } } },
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          compose_bearer: "tok-alice",
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
      ],
    });
    const res = await handleCompose(
      new Request("https://x/v1/compose", {
        method: "POST",
        headers: {
          authorization: "Bearer tok-alice",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: "alice.netflix@example.com",
          to: "friend@gmail.com",
          subject: "ok",
          text: "x",
        }),
      }),
      { COMPOSE_API_TOKEN: "secret" },
      multi,
    );
    assert.equal(res.status, 502); // ACL passed; SMTP missing
    const j = await res.json();
    assert.equal(j.identity, "alice");
    assert.equal(j.mail_from, "alice.netflix@example.com");
  });

  it("400 when To contains CRLF header injection", async () => {
    const res = await handleCompose(
      new Request("https://x/v1/compose", {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: "friend@gmail.com\r\nBcc: evil@evil.com",
          subject: "Hello",
          text: "World",
        }),
      }),
      { COMPOSE_API_TOKEN: "secret" },
      config,
    );
    assert.equal(res.status, 400);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(j.error, /to|CRLF|header|control/i);
  });
});

describe("FEATURES", () => {
  it("provider_send enabled", () => {
    assert.equal(FEATURES.provider_send, true);
  });
});
