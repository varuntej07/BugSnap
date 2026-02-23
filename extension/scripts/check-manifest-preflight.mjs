import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const manifestPath = resolve(extensionRoot, "public", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const expectedPermissions = ["activeTab", "scripting", "storage"];
const expectedHostPermissions = [
  "http://127.0.0.1/*",
  "http://localhost/*",
  "https://*.vercel.app/*",
];
const requiredIconSizes = ["16", "32", "48", "128"];

function sorted(values = []) {
  return [...values].sort();
}

// --- Permission checks ---
assert.ok(Array.isArray(manifest.permissions), "permissions must be an array");
assert.deepEqual(sorted(manifest.permissions), sorted(expectedPermissions));
assert.ok(!manifest.permissions.includes("tabs"), "`tabs` permission should not be required");

assert.ok(Array.isArray(manifest.host_permissions), "host_permissions must be an array");
assert.ok(!manifest.host_permissions.includes("<all_urls>"), "`<all_urls>` must not be present");
assert.deepEqual(sorted(manifest.host_permissions), sorted(expectedHostPermissions));

// --- Icon checks ---
assert.ok(manifest.icons && typeof manifest.icons === "object", "manifest.icons must be defined");
for (const size of requiredIconSizes) {
  const iconPath = manifest.icons[size];
  assert.equal(iconPath, `icons/icon${size}.png`, `icons.${size} should point to icons/icon${size}.png`);
  assert.ok(existsSync(resolve(extensionRoot, "public", iconPath)), `missing icon file: public/${iconPath}`);
}

// --- Action checks ---
assert.equal(manifest.action?.default_popup, "popup/index.html");
assert.ok(manifest.action?.default_icon, "action.default_icon must be configured");
assert.equal(manifest.action.default_icon["16"], "icons/icon16.png");
assert.equal(manifest.action.default_icon["32"], "icons/icon32.png");

// --- Service worker check ---
assert.equal(manifest.background?.service_worker, "background/service_worker.js");
assert.equal(manifest.background?.type, "module");

// --- Version check ---
assert.ok(manifest.version, "manifest.version must be set");

// --- No dangerous permissions ---
const dangerousPerms = ["debugger", "webNavigation", "history", "bookmarks", "downloads"];
for (const perm of dangerousPerms) {
  assert.ok(!manifest.permissions?.includes(perm), `dangerous permission '${perm}' should not be present`);
}

console.log("Manifest preflight checks passed.");
