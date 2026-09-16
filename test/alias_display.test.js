import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizeDisplayName } from "../src/config.js";
import {
  pickFromDisplayName,
  resolveAliasDisplayName,
} from "../src/mail_from.js";
import { resolveRuleDisplayName } from "../src/util.js";
import { handleInbound } from "../src/pipeline.js";
import { createMemoryDb, fakeMessage } from "./memory-db.js";

describe("rule display_name normalize (Q42)", () => {
  it("keeps display_name on rules and rejects bad values", () => {
    const c = normalizeConfig({
      version: 1,
      rules: [
        {
          id: "alice-bare",
          match: { type: "address", value: "alice@example.com" },
          display_name: " Alice ",
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
    });
    assert.equal(c.rules[0].display_name, "Alice");
    assert.equal(normalizeDisplayName("Reyn"), "Reyn");
    assert.throws(() => normalizeDisplayName("  "), /non-empty/);
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          rules: [
            {
              id: "bad",
              match: { type: "address", value: "a@example.com" },
              display_name: "x\ny",
              destinations: [{ email: "a@gmail.com" }],
            },
          ],
        }),
      /control characters|non-empty/,
    );
  });
});

describe("resolveRuleDisplayName", () => {
  const config = normalizeConfig({
    version: 1,
    rules: [
      {
        id: "alice-bare",
        skip_default_inbox: true,
        match: { type: "address", value: "alice@example.com" },
        display_name: "Alice",
        destinations: [{ email: "alice@gmail.com" }],
      },
      {
        id: "alice-person-ns",
        skip_default_inbox: true,
        match: {
          type: "local_part_prefix",
          value: "alice.",
          domain: "example.com",
        },
        display_name: "Alice NS",
        destinations: [{ email: "alice@gmail.com" }],
      },
      {
        id: "shops",
        match: { type: "address", value: "shops@example.com" },
        display_name: "Shop Support",
        destinations: [{ email: "me@gmail.com" }],
      },
      {
        id: "catch",
        match: { type: "catch_all", value: "example.com" },
        display_name: "Should Not Apply",
        destinations: [{ email: "me@gmail.com" }],
      },
    ],
  });

  it("prefers address rule over prefix", () => {
    assert.equal(resolveRuleDisplayName(config, "alice@example.com"), "Alice");
    assert.equal(
      resolveRuleDisplayName(config, "alice.netflix@example.com"),
      "Alice NS",
    );
  });

  it("ignores catch_all display_name", () => {
    assert.equal(
      resolveRuleDisplayName(config, "unknown@example.com"),
      undefined,
    );
  });

  it("honors subaddress tags on address match", () => {
    assert.equal(
      resolveRuleDisplayName(config, "alice+promo@example.com"),
      "Alice",
    );
  });
});

describe("pickFromDisplayName", () => {
  const config = normalizeConfig({
    version: 1,
    rules: [
      {
        id: "shops",
        match: { type: "address", value: "shops@example.com" },
        display_name: "Shop Support",
        destinations: [{ email: "me@gmail.com" }],
      },
    ],
    domains: { "example.com": { send_as: { enabled: true } } },
  });

  it("explicit wins; else rule", () => {
    assert.equal(
      pickFromDisplayName(config, "Brace Name", "shops@example.com"),
      "Brace Name",
    );
    assert.equal(
      pickFromDisplayName(config, null, "shops@example.com"),
      "Shop Support",
    );
    assert.equal(
      resolveAliasDisplayName(config, "missing@example.com", [
        "shops@example.com",
      ]),
      "Shop Support",
    );
  });
});

describe("send-proxy + reply hop rule display_name (Q42)", () => {
  it("send-proxy uses rule display_name when braces absent", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      token_auth: { authorized_from: ["me@gmail.com"] },
      domains: { "example.com": { send_as: { enabled: true } } },
      rules: [
        {
          id: "shops",
          match: { type: "address", value: "shops@example.com" },
          display_name: "Shop Support",
          destinations: [{ email: "me@gmail.com" }],
        },
      ],
    });
    const raw =
      "From: me@gmail.com\r\nTo: shops+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy-disp@t>\r\nAuthentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass\r\n\r\nHello friend";
    const msg = fakeMessage({
      from: "me@gmail.com",
      to: "shops+friend=gmail.com@example.com",
      raw,
    });
    let sent = null;
    const res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
      archivePut: async () => ({ ok: true, r2_key: "k" }),
      smtpSend: async (_env, req) => {
        sent = req;
        return { ok: true, providerMessageId: "eid" };
      },
    });
    assert.equal(res.status, "send_proxy_completed");
    assert.equal(sent.fromName, "Shop Support");
    assert.match(sent.mimeText, /From:\s*"Shop Support"\s*<shops@example\.com>/i);
  });

  it("send-proxy braces override rule display_name", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      token_auth: { authorized_from: ["me@gmail.com"] },
      domains: { "example.com": { send_as: { enabled: true } } },
      rules: [
        {
          id: "shops",
          match: { type: "address", value: "shops@example.com" },
          display_name: "Config Name",
          destinations: [{ email: "me@gmail.com" }],
        },
      ],
    });
    const raw =
      "From: me@gmail.com\r\nTo: shops{Brace_Name}+friend=gmail.com@example.com\r\nSubject: Hi\r\nMessage-ID: <pxy-brace@t>\r\nAuthentication-Results: mx.cloudflare.net; dkim=pass header.d=gmail.com; spf=pass\r\n\r\nHello";
    const msg = fakeMessage({
      from: "me@gmail.com",
      to: "shops{Brace_Name}+friend=gmail.com@example.com",
      raw,
    });
    let sent = null;
    const res = await handleInbound({ DB, ARCHIVE: {} }, msg, config, {
      archivePut: async () => ({ ok: true, r2_key: "k" }),
      smtpSend: async (_env, req) => {
        sent = req;
        return { ok: true, providerMessageId: "eid" };
      },
    });
    assert.equal(res.status, "send_proxy_completed");
    assert.equal(sent.fromName, "Brace Name");
    assert.match(sent.mimeText, /From:\s*"Brace Name"\s*<shops@example\.com>/i);
    assert.doesNotMatch(sent.mimeText, /Config Name/);
  });

  it("reply hop uses rule display_name for our_mailbox", async () => {
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
      rules: [
        {
          id: "alice-ns",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.",
            domain: "example.com",
          },
          display_name: "Alice Netflix",
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
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
