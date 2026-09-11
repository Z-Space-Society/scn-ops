#!/usr/bin/env node
/**
 * Deploys lexicons, Lua scripts, and script variables to a HappyView instance.
 *
 *   HAPPYVIEW_URL=http://127.0.0.1:3000 HAPPYVIEW_API_KEY=hv_... \
 *     node scripts/deploy.mjs [--dry-run]
 *
 * Endpoint config that the dashboard cannot set (target_collection, action)
 * lives in the MANIFEST below, alongside which Lua script backs which NSID.
 * Re-running is safe: every write is an upsert.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Parses KEY=value lines into [key, value] pairs, skipping comments and
 * stripping one layer of quotes. Shared by .env and .env.example so the
 * placeholder check compares values parsed the same way.
 */
function parseDotEnv(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    entries.push([match[1], match[2].trim().replace(/^["'](.*)["']$/, "$1")]);
  }
  return entries;
}

/**
 * Loads .env into process.env without overwriting values already set, so a
 * shell export or CI secret still wins over the file.
 */
async function loadDotEnv(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of parseDotEnv(text)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadDotEnv(join(ROOT, ".env"));
const REQUEST_COLLECTION = "network.sharedcomputer.membership.request";
const ADMIN_LIST_COLLECTION = "network.sharedcomputer.admin.list";

/**
 * One entry per lexicon. `script` attaches a Lua file; `targetCollection` and
 * `action` configure HappyView's built-in record-write handler (used only by
 * script-less procedures). `backfill` applies to record lexicons.
 */
const MANIFEST = [
  { file: "network.sharedcomputer.membership.request.json", backfill: true },
  { file: "network.sharedcomputer.admin.list.json", backfill: true },
  // Registry-space records, written by approve_member.lua / revoke_member.lua.
  // No backfill: unlike the two above, these never reach a public PDS or the
  // firehose, so there is no history to catch up on. Published as lexicons
  // anyway because Corliss becomes a second consumer of the grant shape.
  { file: "network.sharedcomputer.membership.grant.json" },
  { file: "network.sharedcomputer.membership.revocation.json" },
  {
    file: "network.sharedcomputer.membership.submitRequest.json",
    targetCollection: REQUEST_COLLECTION,
    action: "update",
  },
  {
    file: "network.sharedcomputer.membership.withdrawRequest.json",
    targetCollection: REQUEST_COLLECTION,
    action: "delete",
  },
  {
    file: "network.sharedcomputer.admin.setRoster.json",
    targetCollection: ADMIN_LIST_COLLECTION,
    action: "update",
  },
  { file: "network.sharedcomputer.admin.whoami.json", script: "whoami.lua" },
  { file: "network.sharedcomputer.membership.listRequests.json", script: "list_requests.lua" },
  { file: "network.sharedcomputer.membership.listMembers.json", script: "list_members.lua" },
  { file: "network.sharedcomputer.membership.syncMembers.json", script: "sync_members.lua" },
  { file: "network.sharedcomputer.membership.getMine.json", script: "get_my_membership.lua" },
  { file: "network.sharedcomputer.admin.approveMember.json", script: "approve_member.lua" },
  { file: "network.sharedcomputer.admin.revokeMember.json", script: "revoke_member.lua" },
  { file: "network.sharedcomputer.admin.setSpaceAccess.json", script: "set_space_access.lua" },
  // Workspaces. The space type declaration has no script and no backfill: it is
  // a `"type": "space"` lexicon, not a record, and HappyView copies its
  // `collections` into a space's allowedCollections at *creation* — so it must
  // be registered before the first createSpace of this type or a Workspace
  // freezes an empty list forever.
  { file: "network.sharedcomputer.workspace.json" },
  { file: "network.sharedcomputer.workspace.create.json", script: "create_workspace.lua" },
  { file: "network.sharedcomputer.workspace.listMine.json", script: "list_my_workspaces.lua" },
  { file: "network.sharedcomputer.workspace.listMembers.json", script: "list_workspace_members.lua" },
  { file: "network.sharedcomputer.workspace.addMember.json", script: "add_workspace_member.lua" },
  { file: "network.sharedcomputer.workspace.removeMember.json", script: "remove_workspace_member.lua" },
];

/**
 * Shared Lua helpers, prepended to every script body. HappyView deploys each
 * script standalone with no module system, so the alternative is copying the
 * same guards across thirteen files — which is the real maintenance risk now
 * that the workspace family exists.
 *
 * Purely additive: the eight cluster scripts keep their own inline helpers and
 * never call these, so adopting the prelude changes nothing they do. It does
 * mean a deploy rewrites all of them, which is a production write worth doing
 * in a quiet window.
 */
const PRELUDE_FILE = join(ROOT, "lua", "lib", "prelude.lua");

/**
 * Script variables to push. Read from .env or the shell; anything unset is
 * skipped, so an early deploy before the space exists is fine.
 *
 * These carried `VITE_` twins until the SPA was deleted — the browser and the
 * deployer needed the same three values, and the twin saved writing each down
 * twice. Nothing reaches a browser from this repo any more, so there is one
 * spelling per value and no prefix to explain.
 */
const VARIABLES = [
  { key: "SERVICE_DID" },
  { key: "BOOTSTRAP_ADMIN_DID" },
  { key: "REGISTRY_SPACE_URI" },
  // Membership push. Both unset means the Lua skips the notification, which
  // is the correct state before a consumer is wired up.
  { key: "CORLISS_PUSH_URL" },
  { key: "CORLISS_PUSH_TOKEN" },
  // The service read door (syncMembers). Unset means that endpoint refuses
  // every call, which is the correct state before a consumer is wired up —
  // and separate from CORLISS_PUSH_TOKEN so the read and the write-notify can
  // be rotated independently.
  { key: "RECONCILE_TOKEN" },
];

const baseUrl = (process.env.HAPPYVIEW_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.HAPPYVIEW_API_KEY;
const dryRun = process.argv.includes("--dry-run");

if (!baseUrl || !apiKey) {
  console.error(
    "Missing config. Set HAPPYVIEW_URL and HAPPYVIEW_API_KEY in .env —\n" +
      "see .env.example."
  );
  process.exit(1);
}

/**
 * Refuses to push a script variable still holding its .env.example
 * placeholder. An unset variable is skipped and harmless, but a placeholder is
 * a real value to HappyView: on 2026-09-03 a deploy pushed did:plc:xxxx… as
 * SERVICE_DID, the Lua found no roster under that DID, and every admin script
 * failed on production until the variables were fixed by hand in the dashboard.
 *
 * Checked before the first write, and on --dry-run too, so a half-filled .env
 * stops here instead of after the scripts have been replaced. Scoped to
 * VARIABLES: HAPPYVIEW_URL's example is the real production URL, and a
 * placeholder API key already fails loudly with a 401.
 */
const examples = new Map(
  parseDotEnv(await readFile(join(ROOT, ".env.example"), "utf8"))
);
const placeholders = VARIABLES.map(({ key }) => key).filter((key) => {
  const value = process.env[key];
  return value && value === examples.get(key);
});
if (placeholders.length) {
  console.error(
    `Refusing to deploy: ${placeholders.join(", ")} still set to the ` +
      ".env.example placeholder.\n" +
      "Set the real value, or leave it blank to keep what HappyView has."
  );
  process.exit(1);
}

async function send(method, path, body) {
  if (dryRun) {
    console.log(`  DRY RUN ${method} ${path}`);
    return;
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} → ${res.status} ${await res.text()}`);
  }
}

const post = (path, body) => send("POST", path, body);

const prelude = await readFile(PRELUDE_FILE, "utf8");

let failures = 0;

// Spaces ship disabled; every space route 404s and the Lua spaces API is
// absent until this instance setting is "true".
try {
  await send("PUT", "/admin/settings/feature.spaces_enabled", { value: "true" });
  console.log("feature.spaces_enabled: on");
} catch (e) {
  console.error(`feature.spaces_enabled: FAILED ${e.message}`);
  failures++;
}

for (const entry of MANIFEST) {
  const lexicon = JSON.parse(
    await readFile(join(ROOT, "lexicons", entry.file), "utf8")
  );
  const type = lexicon.defs?.main?.type;
  console.log(`${lexicon.id} (${type})`);

  try {
    await post("/admin/lexicons", {
      lexicon_json: lexicon,
      backfill: Boolean(entry.backfill),
      ...(entry.targetCollection
        ? { target_collection: entry.targetCollection }
        : {}),
      ...(entry.action ? { action: entry.action } : {}),
    });

    if (entry.script) {
      const script = await readFile(join(ROOT, "lua", entry.script), "utf8");
      await post("/admin/scripts", {
        id: `xrpc.${type}:${lexicon.id}`,
        script_type: "lua",
        // Prelude first: its helpers are globals precisely so the script body
        // appended after can see them. A `local` in the prelude could not.
        body: `${prelude}\n${script}`,
        description: `Deployed from lua/${entry.script} (+ lua/lib/prelude.lua)`,
      });
      console.log(`  + ${entry.script}`);
    }
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    failures++;
  }
}

for (const { key } of VARIABLES) {
  const value = process.env[key];
  if (!value) {
    console.log(`${key}: not set locally, skipped`);
    continue;
  }
  try {
    await post("/admin/script-variables", { key, value });
    console.log(`${key}: set`);
  } catch (e) {
    console.error(`${key}: FAILED ${e.message}`);
    failures++;
  }
}

if (failures) {
  console.error(`\n${failures} operation(s) failed`);
  process.exit(1);
}
console.log("\nDeploy complete.");
