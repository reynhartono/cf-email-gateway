import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeAliases } from "../src/config.js";
import {
  pickFromDisplayName,
  resolveAliasDisplayName,
} from "../src/mail_from.js";
import { handleInbound } from "../src/pipeline.js";
import { createMemoryDb, fakeMessage } from "./memory-db.js";

describe("normalizeAliases (Q42)", () => {
  it("accepts object and string shorthand", () => {
    const a = normalizeAliases({
      "Shops@Example.com": { display_name: " Shop Support " },
      "me@example.com": "Reyn",
      "billing@example.com": { displayName: "Billing Desk" },
    });
    assert.equal(a["shops@example.com"].display_name, "Shop Support");
    assert.equal(a["me@example.com"].display_name, "Reyn");
    assert.equal(a["billing@example.com"].display_name, "Billing Desk");
  });

  it("rejects empty, non-email keys, reserved r, and arrays", () => {
    assert.throws(() => normalizeAliases({ "not-an-email": "X" }), /bare email/);
    assert.throws(
      () => normalizeAliases({ "shops@example.com": "  " }),
      /non-empty/,
    );
    assert.throws(
      () => normalizeAliases({ "r@example.com": "Nope" }),
      /reserved local/,
    );
    assert.throws(
      () => normalizeAliases({ "r.github@example.com": "Nope" }),
      /reserved local/,
    );
    assert.throws(() => normalizeAliases([]), /mapping/);
  });

  it("wires through normalizeConfig", () => {
    const c = normalizeConfig({
      version: 1,
      aliases: { "shops@example.com": "Shop Support" },
    });
    assert.equal(c.aliases["shops@example.com"].display_name, "Shop Support");
  });
});

describe("resolveAliasDisplayName / pickFromDisplayName", () => {
  const config = normalizeConfig({
    version: 1,
    aliases: {
      "shops@example.com": "Shop Support",
      "me@example.com": { display_name: "Reyn" },
    },
    domains: { "example.com": { send_as: { enabled: true } } },
  });

  it("looks up mailFrom then alsoTry", () => {
    assert.equal(
      resolveAliasDisplayName(config, "shops@example.com"),
      "Shop Support",
    );
    assert.equal(
      resolveAliasDisplayName(config, "unknown@example.com", [
        "me@example.com",
      ]),
      "Reyn",
    );
    assert.equal(
      resolveAliasDisplayName(config, "missing@example.com"),
      undefined,
    );
  });

  it("explicit display wins over config", () => {
    assert.equal(
      pickFromDisplayName(config, "Brace Name", "shops@example.com"),
      "Brace Name",
    );
    assert.equal(
      pickFromDisplayName(config, "  ", "shops@example.com"),
      "Shop Support",
    );
    assert.equal(
      pickFromDisplayName(config, null, "shops@example.com"),
      "Shop Support",
    );
  });
});

describe("send-proxy + reply hop alias display (Q42)", () => {
  it("send-proxy uses config display when braces absent", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      token_auth: { authorized_from: ["me@gmail.com"] },
      aliases: { "shops@example.com": { display_name: "Shop Support" } },
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const raw =
      "From: me@gmail.com\r\nTo: shops+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy-disp@t>\r\nAuthentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass\r\n\r\nHello friend";
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
    assert.equal(sent.fromName, "Shop Support");
    assert.match(sent.mimeText, /From:\s*"Shop Support"\s*<shops@example\.com>/i);
  });

  it("send-proxy braces override config display", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      token_auth: { authorized_from: ["me@gmail.com"] },
      aliases: { "shops@example.com": "Config Name" },
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    const raw =
      "From: me@gmail.com\r\nTo: shops{Brace_Name}+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy-brace@t>\r\nAuthentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass\r\n\r\nHello";
    const msg = fakeMessage({
      from: "me@gmail.com",
      to: "shops{Brace_Name}+friend=gmail.com@example.com",
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
    assert.equal(sent.fromName, "Brace Name");
    assert.match(sent.mimeText, /From:\s*"Brace Name"\s*<shops@example\.com>/i);
    assert.doesNotMatch(sent.mimeText, /Config Name/);
  });

  it("reply hop uses config display for our_mailbox", async () => {
    const DB = createMemoryDb();
    const { insertReplyRoute, insertReplyParticipant } = await import(
      "../src/db.js"
    );
    await insertReplyRoute(DB, {
      token: "tokdisp1",
      inbound_id: "inb-disp",
      our_domain: "example.com",
      our_mailbox: "alice.netflix@example.com",
      created_at: Date.now(),
      multiparty: false,
      subject: "Hi",
    });
    await insertReplyParticipant(DB, {
      id: "p-disp",
      token: "tokdisp1",
      email: "ext@elsewhere.com",
      display_hint: "Ext",
      role: "primary",
      local_suffix: null,
      in_primary: true,
      in_all: true,
    });
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      aliases: {
        "alice.netflix@example.com": { display_name: "Alice Netflix" },
      },
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
      "From: alice@gmail.com\r\nTo: r+tokdisp1@example.com\r\nSubject: Re: Hi\r\nMessage-ID: <hop-disp@t>\r\nAuthentication-Results: mock; dkim=pass header.i=@gmail.com\r\n\r\nreply body";
    const msg = fakeMessage({
      from: "alice@gmail.com",
      to: "r+tokdisp1@example.com",
      raw,
    });
    let sent = null;
    const res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
      skipCfAuth: true,
      archivePut: async () => ({ ok: true, r2_key: "k" }),
      smtpSend: async (_env, req) => {
        sent = req;
        return { ok: true, providerMessageId: "hop1" };
      },
    });
    assert.equal(res.status, "reply_token_completed");
    assert.equal(sent.mailFrom, "alice.netflix@example.com");
    assert.equal(sent.fromName, "Alice Netflix");
    assert.match(
      sent.mimeText,
      /From:\s*"Alice Netflix"\s*<alice\.netflix@example\.com>/i,
    );
  });
});
