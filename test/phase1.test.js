import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseRoutingYaml,
  normalizeConfig,
  resolveDriver,
  archiveEnabled,
  FEATURES,
  replyTokensWanted,
} from "../src/config.js";
import {
  dedupeKeyHex,
  getHeader,
  resolveDestinations,
} from "../src/util.js";
import { handleInbound } from "../src/pipeline.js";
import { createMemoryDb, fakeMessage } from "./memory-db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleYaml = readFileSync(
  join(__dirname, "../config/routing.example.yaml"),
  "utf8",
);

describe("config", () => {
  it("parses example yaml", () => {
    const c = parseRoutingYaml(exampleYaml);
    assert.equal(c.version, 1);
    assert.equal(c.default_inbox, "me@gmail.com");
    assert.equal(c.archive.enabled, true);
    assert.equal(c.defaults.send_as.enabled, false);
    assert.ok(c.domains["example.com"]);
  });

  it("archiveEnabled respects rule override", () => {
    const c = normalizeConfig({ version: 1, archive: { enabled: true } });
    assert.equal(archiveEnabled(c, null), true);
    assert.equal(archiveEnabled(c, { archive: false }), false);
  });

  it("inbound always resolves to cf_forward by default", () => {
    const c = normalizeConfig({
      version: 1,
      defaults: { send_as: { enabled: false } },
      domains: { "example.com": { send_as: { enabled: true } } },
    });
    assert.equal(resolveDriver(c, "a@example.com", {}), "cf_forward");
    assert.equal(
      resolveDriver(c, "a@example.com", { method: "cf_forward" }),
      "cf_forward",
    );
  });

  it("reply tokens only when send_as enabled for envelope domain", () => {
    const c = normalizeConfig({
      version: 1,
      reply_tokens: { enabled: true },
      defaults: { send_as: { enabled: false } },
      domains: {
        "reyn.it": { send_as: { enabled: true } },
        "archive-only.example": { send_as: { enabled: false } },
      },
    });
    assert.equal(replyTokensWanted(c, "x@reyn.it"), true);
    assert.equal(replyTokensWanted(c, "x@archive-only.example"), false);
    assert.equal(replyTokensWanted(c, "x@unknown.example"), false);
    const off = normalizeConfig({
      version: 1,
      reply_tokens: { enabled: false },
      domains: { "reyn.it": { send_as: { enabled: true } } },
    });
    assert.equal(replyTokensWanted(off, "x@reyn.it"), false);
  });
});

describe("util", () => {
  it("getHeader finds subject and message-id", () => {
    const raw =
      "From: a@b.com\r\nSubject: Hello\r\nMessage-ID: <x@y>\r\n\r\nbody";
    assert.equal(getHeader(raw, "subject"), "Hello");
    assert.equal(getHeader(raw, "Message-ID"), "<x@y>");
  });

  it("dedupeKeyHex stable", async () => {
    const a = await dedupeKeyHex("f", "t", "m", "sha");
    const b = await dedupeKeyHex("f", "t", "m", "sha");
    assert.equal(a, b);
    assert.equal(a.length, 64);
  });

  it("dedupe ignores raw when Message-ID present", async () => {
    const a = await dedupeKeyHex("a@x", "b@y", "<id@z>", "sha1");
    const b = await dedupeKeyHex("a@x", "b@y", "<ID@z>", "sha2-different");
    assert.equal(a, b);
  });

  it("dedupe uses raw when Message-ID missing", async () => {
    const a = await dedupeKeyHex("a@x", "b@y", "", "sha1");
    const b = await dedupeKeyHex("a@x", "b@y", "", "sha2");
    assert.notEqual(a, b);
  });

  it("resolveDestinations default_inbox", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      defaults: { send_as: { enabled: false } },
    });
    const r = resolveDestinations(c, "x@z.com", resolveDriver);
    assert.equal(r.destinations.length, 1);
    assert.equal(r.destinations[0].email, "me@gmail.com");
    assert.equal(r.destinations[0].method, "cf_forward");
  });

  it("resolveDestinations address rule keeps default_inbox", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "b",
          match: { type: "address", value: "billing@example.com" },
          destinations: [{ email: "finance@gmail.com" }],
        },
      ],
    });
    const r = resolveDestinations(c, "billing@example.com", resolveDriver);
    assert.equal(r.ruleId, "b");
    assert.deepEqual(
      r.destinations.map((d) => d.email),
      ["finance@gmail.com", "me@gmail.com"],
    );
  });

  it("resolveDestinations skip_default_inbox", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "b",
          skip_default_inbox: true,
          match: { type: "address", value: "billing@example.com" },
          destinations: [{ email: "finance@gmail.com" }],
        },
      ],
    });
    const r = resolveDestinations(c, "billing@example.com", resolveDriver);
    assert.deepEqual(
      r.destinations.map((d) => d.email),
      ["finance@gmail.com"],
    );
  });
});

describe("pipeline B9", () => {
  const baseConfig = normalizeConfig({
    version: 1,
    default_inbox: "me@gmail.com",
    archive: { enabled: true },
    defaults: { send_as: { enabled: false } },
  });

  function rawMail() {
    return (
      "From: alice@a.com\r\nTo: bob@example.com\r\nSubject: Hi\r\nMessage-ID: <m1@a>\r\n\r\nHello"
    );
  }

  it("success when archive + deliver ok", async () => {
    const DB = createMemoryDb();
    const msg = fakeMessage({
      from: "alice@a.com",
      to: "bob@example.com",
      raw: rawMail(),
    });
    const res = await handleInbound(
      { DB, ARCHIVE: {} },
      msg,
      baseConfig,
      {
        archivePut: async () => ({ ok: true, r2_key: "raw/test.eml" }),
        deliver: async () => ({ ok: true }),
      },
    );
    assert.equal(res.ok, true);
    assert.equal(res.status, "completed");
    assert.equal(msg._forwarded, undefined); // custom deliver hook
    assert.equal(DB._attempts.length, 1);
    assert.equal(DB._attempts[0].success, 1);
  });

  it("throws when deliver ok but archive fails (B9)", async () => {
    const DB = createMemoryDb();
    const msg = fakeMessage({
      from: "alice@a.com",
      to: "bob@example.com",
      raw: rawMail(),
    });
    await assert.rejects(
      () =>
        handleInbound(
          { DB, ARCHIVE: {} },
          msg,
          baseConfig,
          {
            archivePut: async () => ({ ok: false, error: "r2 down" }),
            deliver: async () => ({ ok: true }),
          },
        ),
      /archive_missing/,
    );
    assert.equal(DB._attempts.length, 1);
    assert.equal(DB._attempts[0].success, 1);
  });

  it("retry skips succeeded dest and completes archive", async () => {
    const DB = createMemoryDb();
    const msg = fakeMessage({
      from: "alice@a.com",
      to: "bob@example.com",
      raw: rawMail(),
    });
    const env = { DB, ARCHIVE: {} };
    // first: deliver ok, archive fail
    await assert.rejects(
      () =>
        handleInbound(env, msg, baseConfig, {
          archivePut: async () => ({ ok: false, error: "r2" }),
          deliver: async () => ({ ok: true }),
        }),
    );
    assert.equal(DB._attempts.length, 1);

    // second: archive ok, no new deliver attempt
    const res = await handleInbound(env, msg, baseConfig, {
      archivePut: async () => ({ ok: true, r2_key: "raw/ok.eml" }),
      deliver: async () => {
        throw new Error("should not deliver again");
      },
    });
    assert.equal(res.status, "completed");
    assert.equal(DB._attempts.length, 1);
  });

  it("throws on dest fail; retry only failed", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: false },
      rules: [
        {
          id: "m",
          match: { type: "address", value: "x@y.com" },
          destinations: [
            { email: "a@gmail.com" },
            { email: "b@gmail.com" },
          ],
        },
      ],
    });
    const msg = fakeMessage({
      from: "alice@a.com",
      to: "x@y.com",
      raw: rawMail(),
    });
    let n = 0;
    await assert.rejects(
      () =>
        handleInbound(
          { DB, ARCHIVE: {} },
          msg,
          config,
          {
            deliver: async (_e, _m, t) => {
              n++;
              if (t.destination === "a@gmail.com") return { ok: true };
              return { ok: false, error: "bounce" };
            },
          },
        ),
    );
    assert.equal(n, 2);
    assert.equal(DB._attempts.filter((a) => a.success).length, 1);

    n = 0;
    const res = await handleInbound(
      { DB, ARCHIVE: {} },
      msg,
      config,
      {
        deliver: async (_e, _m, t) => {
          n++;
          assert.equal(t.destination, "b@gmail.com");
          return { ok: true };
        },
      },
    );
    assert.equal(res.status, "completed");
    assert.equal(n, 1);
  });

  it("retry same Message-ID skips succeeded dest", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: true },
      rules: [
        {
          id: "m",
          match: { type: "address", value: "x@y.com" },
          destinations: [
            { email: "a@gmail.com" },
            { email: "bad@invalid.example" },
          ],
        },
      ],
    });
    // Same Message-ID, different "raw" bodies (simulates CF re-stamp)
    const raw1 =
      "From: alice@a.com\r\nTo: x@y.com\r\nSubject: Hi\r\nMessage-ID: <same@id>\r\n\r\nHello";
    const raw2 =
      "Received: from cf\r\nFrom: alice@a.com\r\nTo: x@y.com\r\nSubject: Hi\r\nMessage-ID: <same@id>\r\n\r\nHello";
    const msg1 = fakeMessage({ from: "alice@a.com", to: "x@y.com", raw: raw1 });
    const msg2 = fakeMessage({ from: "alice@a.com", to: "x@y.com", raw: raw2 });
    const env = { DB, ARCHIVE: {} };

    await assert.rejects(() =>
      handleInbound(env, msg1, config, {
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        deliver: async (_e, _m, t) => {
          if (t.destination === "a@gmail.com") return { ok: true };
          return { ok: false, error: "not verified" };
        },
      }),
    );

    let deliverCalls = 0;
    await assert.rejects(() =>
      handleInbound(env, msg2, config, {
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        deliver: async (_e, _m, t) => {
          deliverCalls++;
          assert.equal(t.destination, "bad@invalid.example");
          return { ok: false, error: "not verified" };
        },
      }),
    );
    assert.equal(deliverCalls, 1);
    assert.equal(DB._inbound.size, 1);
    const goodAttempts = DB._attempts.filter(
      (a) => a.destination === "a@gmail.com" && a.success,
    );
    assert.equal(goodAttempts.length, 1);
  });

  it("ingested_only when no default_inbox", async () => {
    const DB = createMemoryDb();
    const config = normalizeConfig({
      version: 1,
      archive: { enabled: true },
    });
    delete config.default_inbox;
    const msg = fakeMessage({
      from: "alice@a.com",
      to: "x@y.com",
      raw: rawMail(),
    });
    const res = await handleInbound(
      { DB, ARCHIVE: {} },
      msg,
      config,
      {
        archivePut: async () => ({ ok: true, r2_key: "k" }),
        deliver: async () => {
          throw new Error("no deliver");
        },
      },
    );
    assert.equal(res.status, "ingested_only");
  });
});
