import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROUTING_YAML_MISSING,
  hasRoutingYaml,
  isRoutingConfigError,
  loadConfig,
} from "../src/load_config.js";
import worker from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const exampleYaml = readFileSync(
  join(__dirname, "../config/routing.example.yaml"),
  "utf8",
);

describe("loadConfig / ROUTING_YAML fail-closed", () => {
  it("hasRoutingYaml rejects missing, empty, whitespace", () => {
    assert.equal(hasRoutingYaml({}), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: "" }), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: "   \n" }), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: null }), false);
    assert.equal(hasRoutingYaml({ ROUTING_YAML: exampleYaml }), true);
  });

  it("missing ROUTING_YAML throws (no silent example)", () => {
    assert.throws(
      () => loadConfig({}),
      (err) => {
        assert.equal(err.message, ROUTING_YAML_MISSING);
        assert.equal(isRoutingConfigError(err), true);
        return true;
      },
    );
  });

  it("empty ROUTING_YAML throws", () => {
    assert.throws(
      () => loadConfig({ ROUTING_YAML: "" }),
      /ROUTING_YAML secret missing or empty/,
    );
  });

  it("present ROUTING_YAML parses", () => {
    const c = loadConfig({ ROUTING_YAML: exampleYaml });
    assert.ok(c);
    assert.equal(c.version, 1);
    assert.equal(c.default_inbox, "me@gmail.com");
  });

  it("unparsable ROUTING_YAML throws routing config error", () => {
    assert.throws(
      () => loadConfig({ ROUTING_YAML: "not: [valid\n" }),
      (err) => isRoutingConfigError(err) || /YAML|routing/i.test(String(err)),
    );
  });
});

describe("Worker entry: ROUTING_YAML missing", () => {
  it("fetch /health stays up with routing_ok false", async () => {
    const res = await worker.fetch(
      new Request("https://cf-email-gateway.test/health"),
      {},
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.routing_ok, false);
    assert.equal(body.service, "cf-email-gateway");
  });

  it("fetch /health routing_ok true when secret present", async () => {
    const res = await worker.fetch(
      new Request("https://cf-email-gateway.test/health"),
      { ROUTING_YAML: exampleYaml, SERVICE_NAME: "cf-email-gateway" },
      {},
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.routing_ok, true);
  });

  it("fetch compose path returns 503 when secret missing", async () => {
    const res = await worker.fetch(
      new Request("https://cf-email-gateway.test/v1/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "a@b.com", subject: "s", text: "t" }),
      }),
      {},
      {},
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /ROUTING_YAML/);
  });

  it("fetch compose path returns 503 when secret empty", async () => {
    const res = await worker.fetch(
      new Request("https://cf-email-gateway.test/v1/compose", { method: "POST" }),
      { ROUTING_YAML: "  " },
      {},
    );
    assert.equal(res.status, 503);
  });

  it("email throws when ROUTING_YAML missing", async () => {
    await assert.rejects(
      () =>
        worker.email(
          { from: "a@b.com", to: "x@example.com", headers: new Map(), raw: async () => "" },
          { DB: {}, ARCHIVE: {} },
          {},
        ),
      /ROUTING_YAML secret missing or empty/,
    );
  });

  it("email throws when ROUTING_YAML empty even with bindings", async () => {
    await assert.rejects(
      () =>
        worker.email(
          { from: "a@b.com", to: "x@example.com", headers: new Map(), raw: async () => "" },
          { DB: {}, ARCHIVE: {}, ROUTING_YAML: "" },
          {},
        ),
      /ROUTING_YAML/,
    );
  });
});
