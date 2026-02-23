import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const distRoot = resolve(extensionRoot, "dist");
const distManifestPath = resolve(distRoot, "manifest.json");

assert.ok(existsSync(distManifestPath), "dist/manifest.json not found. Run `npm run build` first.");

const manifest = JSON.parse(readFileSync(distManifestPath, "utf8"));

// --- Entry points ---
assert.equal(manifest.action?.default_popup, "popup/index.html");
assert.equal(manifest.background?.service_worker, "background/service_worker.js");
assert.ok(existsSync(resolve(distRoot, "popup", "index.html")), "dist/popup/index.html is missing");
assert.ok(existsSync(resolve(distRoot, "capture", "index.html")), "dist/capture/index.html is missing");
assert.ok(existsSync(resolve(distRoot, "background", "service_worker.js")), "dist/background/service_worker.js is missing");
assert.ok(existsSync(resolve(distRoot, "content", "overlay.js")), "dist/content/overlay.js is missing");

// --- Icons ---
const iconSizes = ["16", "32", "48", "128"];
for (const size of iconSizes) {
  const relativePath = manifest.icons?.[size];
  assert.equal(relativePath, `icons/icon${size}.png`, `manifest.icons.${size} must map to icons/icon${size}.png`);
  assert.ok(existsSync(resolve(distRoot, relativePath)), `dist/${relativePath} is missing`);
}

// --- Security checks ---
assert.ok(!manifest.host_permissions?.includes("<all_urls>"), "dist manifest must not include `<all_urls>`");

const dangerousPerms = ["debugger", "webNavigation", "history", "bookmarks", "downloads"];
for (const perm of dangerousPerms) {
  assert.ok(!manifest.permissions?.includes(perm), `dist manifest includes dangerous permission '${perm}'`);
}

// --- Required permissions ---
assert.ok(manifest.permissions?.includes("activeTab"), "dist manifest must include activeTab");
assert.ok(manifest.permissions?.includes("storage"), "dist manifest must include storage");
assert.ok(manifest.permissions?.includes("scripting"), "dist manifest must include scripting");

console.log("Dist package smoke checks passed.");
