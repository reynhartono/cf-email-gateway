import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRoutingYaml, resolveProviderName } from "../src/config.js";
import {
  assertRefShapes,
  classifyRef,
  resolveConfigRefs,
  resolveRefValue,
} from "../src/providers/provider_refs.js";
import {
  selectProviderEnv,
  sendOutboundMime,
} from "../src/providers/send_outbound.js";

const BASE_YAML = `
version: 1
default_inbox: me@gmail.com
defaults:
  provider: main
providers:
  main:
    kind: smtp
    config:
      host: mail.example.com
      port: 465
      username: \${SMTP_MAIN_USERNAME}
      password: \${SMTP_MAIN_PASSWORD}
  other:
    kind: smtp
    config:
      host: smtp.other.example.com
      port: 587
      username: plain-user
      password: \${SMTP_OTHER_PASSWORD}
domains:
  example.com:
    send_as: { enabled: true }
    provider: main
  other.example.com:
    send_as: { enabled: true }
    provider: other
`;

const SECRETS = {
  SMTP_MAIN_USERNAME: "main-user",
  SMTP_MAIN_PASSWORD: "main-pass",
  SMTP_OTHER_PASSWORD: "other-pass",
};

function load(yaml = BASE_YAML) {
  return parseRoutingYaml(yaml);
}

describe("classifyRef", () => {
  it("passes literals through, including stray dollar signs", () => {
    assert.deepStrictEqual(classifyRef("plain-user", "w"), {
      kind: "literal",
      literal: "plain-user",
    });
    assert.deepStrictEqual(classifyRef("pa$$word", "w"), {
      kind: "literal",
      literal: "pa$$word",
    });
    assert.deepStrictEqual(classifyRef("smtp.pa${ss", "w"), {
      kind: "literal",
      literal: "smtp.pa${ss",
    });
  });

  it("recognizes whole-value references", () => {
    assert.deepStrictEqual(classifyRef("${SMTP_X}", "w"), {
      kind: "ref",
      name: "SMTP_X",
    });
  });

  it("unescapes whole-value $$-references to literals", () => {
    assert.deepStrictEqual(classifyRef("$${SMTP_X}", "w"), {
      kind: "escaped",
      literal: "${SMTP_X}",
    });
  });

  it("throws on malformed whole-value reference shapes", () => {
    for (const bad of ["${}", "${UN CLOSED", "${}", "$${}", "${9LIVES}"]) {
      assert.throws(() => classifyRef(bad, "w"), /malformed secret reference/);
    }
  });
});

describe("resolveRefValue", () => {
  it("resolves refs from env", () => {
    assert.deepStrictEqual(
      resolveRefValue("${SMTP_MAIN_USERNAME}", SECRETS, "w"),
      { ok: true, value: "main-user" },
    );
  });

  it("fails closed on missing / empty / whitespace-only secrets", () => {
    for (const env of [{}, { A: "" }, { A: "   " }]) {
      const r = resolveRefValue(
        "${A}",
        { ...env, UNRELATED: "s3cr3t-content" },
        "providers.main.config.password",
      );
      assert.equal(r.ok, false);
      assert.match(r.error, /secret A for providers\.main\.config\.password/);
      assert.doesNotMatch(r.error, /s3cr3t-content/);
    }
  });

  it("resolves $$-escapes to literals without touching env", () => {
    assert.deepStrictEqual(resolveRefValue("$${A}", {}, "w"), {
      ok: true,
      value: "${A}",
    });
  });

  it("never echoes secret content in errors", () => {
    const r = resolveRefValue("${MISSING}", { MISSING: "" }, "w");
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /s3cr3t/);
  });
});

describe("resolveConfigRefs", () => {
  it("deep-resolves mixed literal / ref / escape leaves", () => {
    const r = resolveConfigRefs(
      {
        host: "mail.example.com",
        port: 465,
        username: "${U}",
        password: "$${P}",
        nested: { deep: "${D}" },
      },
      { U: "u", D: "d" },
      "w",
    );
    assert.deepStrictEqual(r, {
      ok: true,
      config: {
        host: "mail.example.com",
        port: 465,
        username: "u",
        password: "${P}",
        nested: { deep: "d" },
      },
    });
  });

  it("short-circuits on the first missing secret", () => {
    const r = resolveConfigRefs({ a: "${NOPE}", b: "x" }, {}, "w");
    assert.equal(r.ok, false);
    assert.match(r.error, /secret NOPE/);
  });
});

describe("providers config load", () => {
  it("normalizes the map and trims selections", () => {
    const c = load();
    assert.deepStrictEqual(Object.keys(c.providers).sort(), ["main", "other"]);
    assert.equal(c.defaults.provider, "main");
    assert.equal(c.domains["other.example.com"].provider, "other");
  });

  it("omits defaults.provider when providers: is absent", () => {
    const c = load("version: 1\ndefault_inbox: me@gmail.com\n");
    assert.equal(c.providers, undefined);
    assert.equal(c.defaults.provider, undefined);
  });

  it("rejects unknown kinds", () => {
    assert.throws(
      () =>
        load(`
version: 1
defaults: { provider: api }
providers:
  api: { kind: http, config: { host: mail.example.com, username: u, password: p } }
`),
      /kind must be "smtp"/,
    );
  });

  it("rejects unknown config fields", () => {
    assert.throws(
      () =>
        load(`
version: 1
defaults: { provider: main }
providers:
  main: { kind: smtp, config: { host: h, username: u, password: p, carrier_pigeon: true } }
`),
      /unknown field "carrier_pigeon"/,
    );
  });

  it("requires host, username, and password", () => {
    for (const cfg of [
      "{ kind: smtp, config: { username: u, password: p } }",
      "{ kind: smtp, config: { host: h, password: p } }",
      "{ kind: smtp, config: { host: h, username: u } }",
      "{ kind: smtp, config: { host: h, username: '  ', password: p } }",
    ]) {
      assert.throws(
        () =>
          load(`version: 1\ndefaults: { provider: m }\nproviders:\n  m: ${cfg}\n`),
        /required/,
      );
    }
  });

  it("rejects bad literal tls but allows tls refs", () => {
    assert.throws(
      () =>
        load(
          `version: 1\ndefaults: { provider: m }\nproviders:\n  m: { kind: smtp, config: { host: h, username: u, password: p, tls: sometimes } }\n`,
        ),
      /tls must be "on" or "starttls"/,
    );
    const c = load(
      `version: 1\ndefaults: { provider: m }\nproviders:\n  m: { kind: smtp, config: { host: h, username: u, password: p, tls: '\${TLS_MODE}' } }\n`,
    );
    assert.equal(c.providers.m.config.tls, "${TLS_MODE}");
  });

  it("requires defaults.provider when providers: is present", () => {
    assert.throws(
      () =>
        load(
          "version: 1\nproviders:\n  m: { kind: smtp, config: { host: h, username: u, password: p } }\n",
        ),
      /defaults\.provider is required/,
    );
    assert.throws(
      () =>
        load(
          "version: 1\ndefaults: { provider: ghost }\nproviders:\n  m: { kind: smtp, config: { host: h, username: u, password: p } }\n",
        ),
      /unknown provider "ghost"/,
    );
  });

  it("rejects unknown domain providers", () => {
    assert.throws(
      () =>
        load(`
version: 1
defaults: { provider: main }
providers:
  main: { kind: smtp, config: { host: h, username: u, password: p } }
domains:
  example.com: { provider: ghost }
`),
      /unknown provider "ghost" in domains\.example\.com\.provider/,
    );
  });

  it("rejects domains.*.provider when providers: is absent", () => {
    assert.throws(
      () =>
        load(`
version: 1
default_inbox: me@gmail.com
domains:
  example.com: { provider: main }
`),
      /domains\.example\.com\.provider requires providers:/,
    );
  });

  it("rejects malformed reference shapes at load", () => {
    assert.throws(
      () =>
        load(
          "version: 1\ndefaults: { provider: m }\nproviders:\n  m: { kind: smtp, config: { host: h, username: '${UN CLOSED', password: p } }\n",
        ),
      /malformed secret reference/,
    );
  });

  it("assertRefShapes is exported for direct use", () => {
    assert.doesNotThrow(() =>
      assertRefShapes({ a: "x", b: "${Y}" }, "w"),
    );
    assert.throws(() => assertRefShapes({ a: "${}" }, "w"), /malformed/);
  });
});

describe("resolveProviderName", () => {
  it("selects domain override, then defaults", () => {
    const c = load();
    assert.equal(resolveProviderName(c, "shops@example.com"), "main");
    assert.equal(resolveProviderName(c, "shops@other.example.com"), "other");
    assert.equal(resolveProviderName(c, "shops@unlisted.example"), "main");
  });

  it("selects from angle-addr / display-form From (bare-normalized)", () => {
    const c = load();
    assert.equal(
      resolveProviderName(c, "Shop Name <shops@other.example.com>"),
      "other",
    );
    assert.equal(
      resolveProviderName(c, "shops@example.com"),
      "main",
    );
  });

  it("throws when providers: map is missing (no legacy global path)", () => {
    const c = load("version: 1\ndefault_inbox: me@gmail.com\n");
    assert.throws(
      () => resolveProviderName(c, "shops@example.com"),
      /providers:\s*map required|requires providers:/,
    );
  });

  it("throws instead of silently falling back", () => {
    const c = load();
    c.defaults.provider = "ghost";
    assert.throws(() => resolveProviderName(c, "a@b.example"), /unknown provider/);
  });
});

describe("selectProviderEnv", () => {
  it("builds per-provider overlays with refs resolved", () => {
    const c = load();
    const main = selectProviderEnv(c, "shops@example.com", SECRETS);
    assert.equal(main.ok, true);
    assert.equal(main.name, "main");
    assert.equal(main.env.SMTP_HOST, "mail.example.com");
    assert.equal(main.env.SMTP_USERNAME, "main-user");
    assert.equal(main.env.SMTP_PASSWORD, "main-pass");
    assert.equal(main.env.SMTP_PORT, 465);
    assert.equal(main.env.SMTP_TLS, undefined);

    const other = selectProviderEnv(c, "shops@other.example.com", SECRETS);
    assert.equal(other.ok, true);
    assert.equal(other.name, "other");
    assert.equal(other.env.SMTP_HOST, "smtp.other.example.com");
    assert.equal(other.env.SMTP_PORT, 587);
    // literal username passes through; isolation: no main creds leak over
    assert.equal(other.env.SMTP_USERNAME, "plain-user");
    assert.equal(other.env.SMTP_PASSWORD, "other-pass");
  });

  it("keeps provider port/tls overrides isolated", () => {
    const c = load(`
version: 1
defaults: { provider: a }
providers:
  a:
    kind: smtp
    config: { host: a.example, port: 8465, tls: starttls, username: u, password: p }
`);
    const r = selectProviderEnv(c, "x@example.com", {});
    assert.equal(r.ok, true);
    assert.equal(r.env.SMTP_PORT, 8465);
    assert.equal(r.env.SMTP_TLS, "starttls");
  });

  it("does not inherit global SMTP_PORT/SMTP_TLS when provider omits them", () => {
    const c = load(`
version: 1
defaults: { provider: a }
providers:
  a:
    kind: smtp
    config: { host: a.example, username: u, password: p }
`);
    const r = selectProviderEnv(c, "x@example.com", {
      SMTP_PORT: "587",
      SMTP_TLS: "starttls",
      SMTP_HOST: "legacy.example",
    });
    assert.equal(r.ok, true);
    assert.equal(r.env.SMTP_HOST, "a.example");
    assert.equal(r.env.SMTP_PORT, undefined);
    assert.equal(r.env.SMTP_TLS, undefined);
  });

  it("rejects bad resolved port/tls without echoing secret content", () => {
    const c = load(`
version: 1
defaults: { provider: a }
providers:
  a:
    kind: smtp
    config:
      host: a.example
      port: \${PORT_SECRET}
      username: u
      password: p
`);
    const badPort = selectProviderEnv(c, "x@example.com", {
      PORT_SECRET: "not-a-port",
    });
    assert.equal(badPort.ok, false);
    assert.match(badPort.error, /invalid resolved port/);
    assert.doesNotMatch(badPort.error, /not-a-port/);

    const cTls = load(`
version: 1
defaults: { provider: a }
providers:
  a:
    kind: smtp
    config:
      host: a.example
      tls: \${TLS_SECRET}
      username: u
      password: p
`);
    const badTls = selectProviderEnv(cTls, "x@example.com", {
      TLS_SECRET: "plaintext-leak-candidate",
    });
    assert.equal(badTls.ok, false);
    assert.match(badTls.error, /invalid resolved tls/);
    assert.doesNotMatch(badTls.error, /plaintext-leak-candidate/);
  });

  it("rejects non-string host/username/password at load", () => {
    assert.throws(
      () =>
        load(`
version: 1
defaults: { provider: m }
providers:
  m: { kind: smtp, config: { host: { secret: X }, username: u, password: p } }
`),
      /config\.host must be a string/,
    );
  });

  it("fails closed on missing secrets without connecting", () => {
    const c = load();
    const r = selectProviderEnv(c, "shops@example.com", {});
    assert.equal(r.ok, false);
    assert.equal(r.name, "main");
    assert.match(r.error, /secret SMTP_MAIN_USERNAME/);
  });

  it("fails closed without providers: map (no legacy global env path)", () => {
    const c = load("version: 1\ndefault_inbox: me@gmail.com\n");
    const env = { SMTP_HOST: "h", SMTP_USERNAME: "u", SMTP_PASSWORD: "p" };
    const r = selectProviderEnv(c, "shops@example.com", env);
    assert.equal(r.ok, false);
    assert.equal(r.name, null);
    assert.match(r.error, /providers:\s*map required|requires providers:/);
  });
});

describe("sendOutboundMime provider integration", () => {
  const REQ = {
    mailFrom: "shops@example.com",
    to: "me@gmail.com",
    mimeText: "Subject: hi\r\n\r\nbody\r\n",
  };

  it("reports the selected provider name on pre-connect failures", async () => {
    const c = load();
    const r = await sendOutboundMime({}, REQ, c);
    assert.equal(r.ok, false);
    assert.equal(r.provider, "main");
    assert.equal(r.transport, "smtp");
    assert.match(r.error, /secret SMTP_MAIN_USERNAME/);
  });

  it("fails closed without providers: even if global SMTP_* env is set", async () => {
    const r = await sendOutboundMime(
      { SMTP_HOST: "h", SMTP_USERNAME: "u", SMTP_PASSWORD: "p" },
      REQ,
    );
    assert.equal(r.ok, false);
    assert.equal(r.provider, null);
    assert.match(r.error, /providers:\s*map required|requires providers:/);
  });

  it("does not leak secret values through result errors", async () => {
    const c = load();
    const r = await sendOutboundMime(
      { SMTP_MAIN_USERNAME: "u", SMTP_MAIN_PASSWORD: "topsecret-value" },
      { ...REQ, mailFrom: "shops@other.example.com" },
      c,
    );
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error || "", /topsecret-value/);
  });
});
