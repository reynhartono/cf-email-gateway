#!/usr/bin/env node
/**
 * CI: validate config/routing.example.yaml with the production loader.
 *
 * The example file is docs/copy-paste only — the Worker never imports it
 * (Q41: runtime config is the ROUTING_YAML secret). This check fails the PR
 * when the example no longer parses under the real loader, i.e. a new
 * contributor copying it would get a broken starting point.
 *
 * Covered by the loader itself: reserved `r` / `r.*` locals, prefix trailing
 * `.`, display_name rules, identities shape. Enforced here on top (Q42):
 * no top-level `aliases` registry — From display lives on matching rules,
 * `domains.<apex>.display_name`, and `defaults.display_name`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseRoutingYaml } from "../src/config.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "config", "routing.example.yaml");
const raw = readFileSync(path, "utf8");

if (/^aliases\s*:/m.test(raw)) {
  console.error(
    "config/routing.example.yaml: top-level `aliases` map is rejected " +
      "(Q42) — put display_name on the matching rule / domain / defaults.",
  );
  process.exit(1);
}

const config = parseRoutingYaml(raw);
console.log(
  `routing.example.yaml OK ` +
    `(${config.rules.length} rules, ` +
    `${Object.keys(config.domains).length} domains, ` +
    `${config.identities.length} identities)`,
);
