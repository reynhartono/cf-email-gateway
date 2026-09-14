import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSendProxyAddress,
  isAuthorizedSender,
  extractBodyAndSubject,
} from "../src/send_proxy.js";
import { normalizeConfig } from "../src/config.js";
import { handleInbound } from "../src/pipeline.js";
import { createMemoryDb, fakeMessage } from "./memory-db.js";

describe("parseSendProxyAddress", () => {
  it("parses alias+user=domain@our", () => {
    const p = parseSendProxyAddress("shops+alice=gmail.com@example.com");
    assert.ok(p);
    assert.equal(p.fromEmail, "shops@example.com");
    assert.equal(p.rcptEmail, "alice@gmail.com");
    assert.equal(p.ourDomain, "example.com");
  });

  it("parses display braces", () => {
    const p = parseSendProxyAddress(
      "shops{My Shop}+bob{Bob}=outlook.com@example.com",
    );
    assert.ok(p);
    assert.equal(p.aliasLocal, "shops");
    assert.equal(p.aliasDisplay, "My Shop");
    assert.equal(p.rcptLocal, "bob");
    assert.equal(p.rcptDisplay, "Bob");
    assert.equal(p.rcptEmail, "bob@outlook.com");
    assert.equal(p.fromEmail, "shops@example.com");
  });

  it("decodes underscore to space in display braces", () => {
    const p = parseSendProxyAddress(
      "shops{CS_Support}+other{Other_Inbox}=gmail.com@example.com",
    );
    assert.ok(p);
    assert.equal(p.aliasDisplay, "CS Support");
    assert.equal(p.rcptDisplay, "Other Inbox");
    assert.equal(p.fromEmail, "shops@example.com");
    assert.equal(p.rcptEmail, "other@gmail.com");
  });

  it("returns null for normal addresses", () => {
    assert.equal(parseSendProxyAddress("hello@example.com"), null);
    assert.equal(parseSendProxyAddress("a+b@example.com"), null);
  });
});

describe("isAuthorizedSender", () => {
  it("matches allowlist", () => {
    assert.equal(
      isAuthorizedSender("Me@Gmail.com", ["me@gmail.com"]),
      true,
    );
    assert.equal(
      isAuthorizedSender("Other <me@gmail.com>", ["me@gmail.com"]),
      true,
    );
    assert.equal(isAuthorizedSender("x@y.com", ["me@gmail.com"]), false);
  });
});

describe("send proxy pipeline", () => {
  it("sends via smtp hook when authorized", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: true },
      token_auth: { authorized_from: ["me@gmail.com"] },
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const raw =
      "From: me@gmail.com\r\nTo: shops+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy1@t>\r\n\r\nHello friend";
    const msg = fakeMessage({
      from: "me@gmail.com",
      to: "shops+friend=gmail.com@example.com",
      raw,
    });
    let sent = null;
    const res = await handleInbound(
      { DB, ARCHIVE: {} },
      msg,
      config,
      {
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        smtpSend: async (_env, req) => {
          sent = req;
          return { ok: true, providerMessageId: "eid" };
        },
      },
    );
    assert.equal(res.status, "send_proxy_completed");
    assert.equal(sent.mailFrom, "shops@example.com");
    assert.ok(sent.mimeText || sent.rawMimeBase64, "should send full MIME");
    const mime =
      sent.mimeText ||
      Buffer.from(sent.rawMimeBase64, "base64").toString("utf8");
    assert.match(mime, /From:.*shops@example\.com/i);
    assert.match(mime, /To:.*friend@gmail\.com/i);
    assert.match(mime, /Subject: Hi/);
    assert.match(mime, /Hello friend/);
  });

  it("rejects unauthorized sender", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      token_auth: { authorized_from: ["me@gmail.com"] },
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const raw =
      "From: evil@gmail.com\r\nTo: a+b=gmail.com@example.com\r\nSubject: x\r\n\r\ny";
    const msg = fakeMessage({
      from: "evil@gmail.com",
      to: "a+b=gmail.com@example.com",
      raw,
    });
    await assert.rejects(
      () =>
        handleInbound({ DB, ARCHIVE: {} }, msg, config, {
          archivePut: async () => ({ ok: true, r2_key: "k" }),
        }),
      /unauthorized/,
    );
  });

  it("rejects send-proxy alias outside identity can_send_as", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
      ],
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const raw =
      "From: alice@gmail.com\r\nTo: bob.shop+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy-deny@t>\r\n\r\nNope";
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: "bob.shop+friend=gmail.com@example.com",
      raw,
    });
    await assert.rejects(
      () =>
        handleInbound({ DB, ARCHIVE: {} }, msg, config, {
          archivePut: async () => ({ ok: true, r2_key: "k" }),
        }),
      /identity_mailbox_denied/,
    );
  });

  it("allows send-proxy alias inside identity can_send_as", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
      ],
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const raw =
      "From: alice@gmail.com\r\nTo: alice.shop+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy-ok@t>\r\n\r\nYes";
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: "alice.shop+friend=gmail.com@example.com",
      raw,
    });
    let sent = null;
    const res = await handleInbound(
      { DB, ARCHIVE: {} },
      msg,
      config,
      {
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        smtpSend: async (_env, req) => {
          sent = req;
          return { ok: true, providerMessageId: "eid" };
        },
      },
    );
    assert.equal(res.status, "send_proxy_completed");
    assert.equal(sent.mailFrom, "alice.shop@example.com");
  });
});

describe("reply hop identity ACL", () => {
  function multiConfig() {
    return normalizeConfig({
      version: 1,
      archive: { enabled: false },
      identities: [
        {
          id: "alice",
          authorized_from: ["alice@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "alice.",
              domain: "example.com",
            },
          ],
        },
        {
          id: "bob",
          authorized_from: ["bob@gmail.com"],
          can_send_as: [
            {
              type: "local_part_prefix",
              value: "bob.",
              domain: "example.com",
            },
          ],
        },
      ],
      domains: { "example.com": { send_as: { enabled: true } } },
    });
  }

  async function seedRoute(DB, token, our_mailbox) {
    const { insertReplyRoute, insertReplyParticipant } = await import(
      "../src/db.js"
    );
    await insertReplyRoute(DB, {
      token,
      inbound_id: "inb1",
      our_domain: "example.com",
      our_mailbox,
      created_at: Date.now(),
      multiparty: false,
      subject: "Hi",
    });
    await insertReplyParticipant(DB, {
      id: "p1",
      token,
      email: "ext@elsewhere.com",
      display_hint: "Ext",
      role: "primary",
      local_suffix: null,
      in_primary: true,
      in_all: true,
    });
  }

  it("allows hop when token our_mailbox is owned by sender identity", async () => {
    const DB = createMemoryDb();
    await seedRoute(DB, "tokalice1", "alice.netflix@example.com");
    const raw =
      "From: alice@gmail.com\r\nTo: r+tokalice1@example.com\r\nSubject: Re: Hi\r\nMessage-ID: <hop-ok@t>\r\nAuthentication-Results: mock; dkim=pass header.i=@gmail.com\r\n\r\nreply body";
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: "r+tokalice1@example.com",
      raw,
    });
    let sent = null;
    const res = await handleInbound({ DB, ARCHIVE: {} }, msg, multiConfig(), {
      skipCfAuth: true,
      archivePut: async () => ({ ok: true, r2_key: "k" }),
      smtpSend: async (_env, req) => {
        sent = req;
        return { ok: true, providerMessageId: "hop1" };
      },
    });
    assert.equal(res.status, "reply_token_completed");
    assert.equal(sent.mailFrom, "alice.netflix@example.com");
  });

  it("denies hop when sender uses another person's token mailbox", async () => {
    const DB = createMemoryDb();
    await seedRoute(DB, "tokbob1", "bob.github@example.com");
    const raw =
      "From: alice@gmail.com\r\nTo: r+tokbob1@example.com\r\nSubject: Re: Hi\r\nMessage-ID: <hop-deny@t>\r\n\r\nsteal";
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: "r+tokbob1@example.com",
      raw,
    });
    await assert.rejects(
      () =>
        handleInbound({ DB, ARCHIVE: {} }, msg, multiConfig(), {
          skipCfAuth: true,
          archivePut: async () => ({ ok: true, r2_key: "k" }),
        }),
      /identity_mailbox_denied/,
    );
  });
});
