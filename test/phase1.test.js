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
  normalizeLocalForRouting,
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

  it("resolveDestinations local_part_prefix routes person namespace", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "alice-ns",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.",
            domain: "example.com",
          },
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
    });
    const hit = resolveDestinations(
      c,
      "alice.netflix@example.com",
      resolveDriver,
    );
    assert.equal(hit.ruleId, "alice-ns");
    assert.deepEqual(
      hit.destinations.map((d) => d.email),
      ["alice@gmail.com"],
    );
    const missOtherDomain = resolveDestinations(
      c,
      "alice.netflix@other.example",
      resolveDriver,
    );
    assert.equal(missOtherDomain.ruleId, null);
    assert.deepEqual(
      missOtherDomain.destinations.map((d) => d.email),
      ["me@gmail.com"],
    );
    const missBare = resolveDestinations(c, "alice@example.com", resolveDriver);
    assert.equal(missBare.ruleId, null);
    // Glue local must not match person. prefix (other user may own alicenetflix@)
    const missGlue = resolveDestinations(
      c,
      "alicenetflix@example.com",
      resolveDriver,
    );
    assert.equal(missGlue.ruleId, null);
  });

  it("resolveDestinations local_part_prefix without trailing dot never matches", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "bad-prefix",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice",
            domain: "example.com",
          },
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
    });
    assert.equal(
      resolveDestinations(c, "alice.netflix@example.com", resolveDriver).ruleId,
      null,
    );
    assert.equal(
      resolveDestinations(c, "alicenetflix@example.com", resolveDriver).ruleId,
      null,
    );
  });

  it("resolveDestinations match priority: address > local_part_prefix > catch_all", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "catch-ex",
          skip_default_inbox: true,
          match: { type: "catch_all", value: "example.com" },
          destinations: [{ email: "catch@gmail.com" }],
        },
        {
          id: "alice-ns",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.",
            domain: "example.com",
          },
          destinations: [{ email: "alice@gmail.com" }],
        },
        {
          id: "alice-exact",
          skip_default_inbox: true,
          match: { type: "address", value: "alice.netflix@example.com" },
          destinations: [{ email: "exact@gmail.com" }],
        },
      ],
    });
    assert.equal(
      resolveDestinations(c, "alice.netflix@example.com", resolveDriver).ruleId,
      "alice-exact",
    );
    assert.equal(
      resolveDestinations(c, "alice.github@example.com", resolveDriver).ruleId,
      "alice-ns",
    );
    assert.equal(
      resolveDestinations(c, "unknown@example.com", resolveDriver).ruleId,
      "catch-ex",
    );
  });

  it("resolveDestinations local_part_prefix first-match among prefixes", () => {
    const c = normalizeConfig({
      version: 1,
      rules: [
        {
          id: "alice-smith",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.smith.",
            domain: "example.com",
          },
          destinations: [{ email: "smith@gmail.com" }],
        },
        {
          id: "alice",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.",
            domain: "example.com",
          },
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
    });
    assert.equal(
      resolveDestinations(c, "alice.smith.work@example.com", resolveDriver)
        .ruleId,
      "alice-smith",
    );
    assert.equal(
      resolveDestinations(c, "alice.work@example.com", resolveDriver).ruleId,
      "alice",
    );
  });

  it("normalizeLocalForRouting strips person + proxy-shaped on rule_match; keeps r+", () => {
    assert.equal(normalizeLocalForRouting("alice+promo"), "alice");
    assert.equal(normalizeLocalForRouting("alice.netflix+id1"), "alice.netflix");
    assert.equal(normalizeLocalForRouting("alicenetflix"), "alicenetflix");
    assert.equal(normalizeLocalForRouting("r+abc123"), "r+abc123");
    assert.equal(normalizeLocalForRouting("r+abc123.p1"), "r+abc123.p1");
    // Default / rule_match: strip send-proxy-shaped local to person base
    assert.equal(normalizeLocalForRouting("alice+bob=gmail.com"), "alice");
    assert.equal(
      normalizeLocalForRouting("alice+bob=gmail.com", { purpose: "rule_match" }),
      "alice",
    );
    // Display braces (CFEG proxy grammar) drop like parseSendProxyAddress aliasLocal
    assert.equal(
      normalizeLocalForRouting("alice{Bob}+bob=gmail.com", {
        purpose: "rule_match",
      }),
      "alice",
    );
    assert.equal(
      normalizeLocalForRouting("alice.shop{My_Shop}+friend=gmail.com", {
        purpose: "rule_match",
      }),
      "alice.shop",
    );
    // can_send_as: leave proxy-shaped From unchanged (Q36), braces included
    assert.equal(
      normalizeLocalForRouting("alice+bob=gmail.com", { purpose: "can_send_as" }),
      "alice+bob=gmail.com",
    );
    assert.equal(
      normalizeLocalForRouting("alice{Bob}+bob=gmail.com", {
        purpose: "can_send_as",
      }),
      "alice{Bob}+bob=gmail.com",
    );
    assert.equal(
      normalizeLocalForRouting("r+abc123", { purpose: "can_send_as" }),
      "r+abc123",
    );
  });

  it("resolveDestinations honors subaddress tags on address and prefix", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "alice-bare",
          skip_default_inbox: true,
          match: { type: "address", value: "alice@example.com" },
          destinations: [{ email: "alice@gmail.com" }],
        },
        {
          id: "alice-smith",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.smith.",
            domain: "example.com",
          },
          destinations: [{ email: "smith@gmail.com" }],
        },
        {
          id: "alice-ns",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "alice.",
            domain: "example.com",
          },
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
    });
    assert.equal(
      resolveDestinations(c, "alice+promo@example.com", resolveDriver).ruleId,
      "alice-bare",
    );
    assert.equal(
      resolveDestinations(c, "alice@example.com", resolveDriver).ruleId,
      "alice-bare",
    );
    assert.equal(
      resolveDestinations(c, "alice.netflix+id1@example.com", resolveDriver)
        .ruleId,
      "alice-ns",
    );
    // Longer prefix still first-match on base after strip
    assert.equal(
      resolveDestinations(c, "alice.smith.work+x@example.com", resolveDriver)
        .ruleId,
      "alice-smith",
    );
    // Glue local still must not match alice.
    assert.equal(
      resolveDestinations(c, "alicenetflix@example.com", resolveDriver).ruleId,
      null,
    );
    // Hop skip Option A: r+ local not stripped → no bare r@ person hit
    assert.equal(
      resolveDestinations(c, "r+abc123@example.com", resolveDriver).ruleId,
      null,
    );
    // Proxy-shaped exception-skip → strip to alice → person bare rule
    assert.equal(
      resolveDestinations(c, "alice+bob=gmail.com@example.com", resolveDriver)
        .ruleId,
      "alice-bare",
    );
    // Braced proxy display on skip → same person base (not alice{Bob})
    assert.equal(
      resolveDestinations(
        c,
        "alice{Bob}+bob=gmail.com@example.com",
        resolveDriver,
      ).ruleId,
      "alice-bare",
    );
    assert.equal(
      resolveDestinations(
        c,
        "alice.shop{My_Shop}+x=gmail.com@example.com",
        resolveDriver,
      ).ruleId,
      "alice-ns",
    );
  });

  it("normalizeConfig rejects reserved local r on rules, identities, defaults", () => {
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "r@example.com",
        }),
      /reserved local/,
    );
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "me@gmail.com",
          compose: { default_from: "r@example.com" },
        }),
      /reserved local/,
    );
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "me@gmail.com",
          rules: [
            {
              id: "bad-r",
              match: { type: "address", value: "r@example.com" },
              destinations: [{ email: "me@gmail.com" }],
            },
          ],
        }),
      /reserved local/,
    );
    // address match must ban full reserved set (r and r.*), not bare r only
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "me@gmail.com",
          rules: [
            {
              id: "bad-r-dot",
              match: { type: "address", value: "r.github@example.com" },
              destinations: [{ email: "me@gmail.com" }],
            },
          ],
        }),
      /reserved local/,
    );
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "r.github@example.com",
        }),
      /reserved local/,
    );
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "me@gmail.com",
          rules: [
            {
              id: "bad-r-ns",
              match: {
                type: "local_part_prefix",
                value: "r.",
                domain: "example.com",
              },
              destinations: [{ email: "me@gmail.com" }],
            },
          ],
        }),
      /reserved local/,
    );
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          default_inbox: "me@gmail.com",
          identities: [
            {
              id: "bad",
              authorized_from: ["a@gmail.com"],
              can_send_as: [{ type: "address", value: "r@example.com" }],
            },
          ],
        }),
      /reserved local/,
    );
    // ryan. is not reserved
    const ok = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "ryan-ns",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "ryan.",
            domain: "example.com",
          },
          destinations: [{ email: "ryan@gmail.com" }],
        },
      ],
    });
    assert.equal(ok.rules[0].id, "ryan-ns");
  });

  it("resolveDestinations runtime defense skips slipped reserved r rules", () => {
    // Bypass normalizeConfig validate by building a minimal config object.
    const c = {
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "slipped-r",
          skip_default_inbox: true,
          match: { type: "address", value: "r@example.com" },
          destinations: [{ email: "r-dest@gmail.com" }],
        },
        {
          id: "slipped-r-github",
          skip_default_inbox: true,
          match: { type: "address", value: "r.github@example.com" },
          destinations: [{ email: "r-github-dest@gmail.com" }],
        },
        {
          id: "slipped-r-ns",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "r.",
            domain: "example.com",
          },
          destinations: [{ email: "r-ns@gmail.com" }],
        },
      ],
      defaults: { provider: "smtp", send_as: { enabled: false } },
    };
    assert.equal(
      resolveDestinations(c, "r@example.com", resolveDriver).ruleId,
      null,
    );
    assert.equal(
      resolveDestinations(c, "r.github@example.com", resolveDriver).ruleId,
      null,
    );
    assert.deepEqual(
      resolveDestinations(c, "r@example.com", resolveDriver).destinations.map(
        (d) => d.email,
      ),
      ["me@gmail.com"],
    );
    assert.deepEqual(
      resolveDestinations(c, "r.github@example.com", resolveDriver).destinations.map(
        (d) => d.email,
      ),
      ["me@gmail.com"],
    );
  });

  it("resolveDestinations: invalid reply-ish locals strip to r then reserved defense (no bare r@ person hit)", () => {
    // Near-miss r+ grammar (fails isReplyTokenLocal) → stripPersonPlusTag → "r"
    // → isReservedPersonLocal blocks person match. Document so nobody "fixes"
    // this into inventing bare r@ hits.
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "should-never-match",
          skip_default_inbox: true,
          match: { type: "address", value: "alice@example.com" },
          destinations: [{ email: "alice@gmail.com" }],
        },
      ],
    });
    for (const to of [
      "r+TOK-bad@example.com",
      "r+abc!@example.com",
      "r+not.a.valid.suffix@example.com",
    ]) {
      const r = resolveDestinations(c, to, resolveDriver);
      assert.equal(r.ruleId, null, to);
      assert.deepEqual(
        r.destinations.map((d) => d.email),
        ["me@gmail.com"],
        to,
      );
    }
    // Valid r+ still Option A (no strip) — also no person rule
    assert.equal(
      resolveDestinations(c, "r+abc123@example.com", resolveDriver).ruleId,
      null,
    );
  });

  it("resolveDestinations local_part_prefix ignores empty prefix", () => {
    const c = normalizeConfig({
      version: 1,
      default_inbox: "me@gmail.com",
      rules: [
        {
          id: "bad",
          skip_default_inbox: true,
          match: {
            type: "local_part_prefix",
            value: "",
            domain: "example.com",
          },
          destinations: [{ email: "oops@gmail.com" }],
        },
      ],
    });
    const r = resolveDestinations(c, "anyone@example.com", resolveDriver);
    assert.equal(r.ruleId, null);
    assert.deepEqual(
      r.destinations.map((d) => d.email),
      ["me@gmail.com"],
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
