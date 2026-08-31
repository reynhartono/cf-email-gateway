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
});
