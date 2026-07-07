import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getIconData } from "@iconify/utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const phNames = new Set();
const dataFiles = ["platforms.ts", "platform-content.ts", "api-content.ts"];
for (const f of dataFiles) {
  const text = fs.readFileSync(path.join(root, "data", f), "utf8");
  for (const m of text.matchAll(/icon:\s*["'`]([a-z0-9-]+)["'`]/g)) {
    phNames.add(m[1]);
  }
}
for (const n of [
  "butterfly",
  "linkedin-logo",
  "x-logo",
  "instagram-logo",
  "facebook-logo",
  "threads-logo",
  "youtube-logo",
  "tiktok-logo",
  "pinterest-logo",
  "circle",
  "plus-circle",
]) {
  phNames.add(n);
}

const siNames = ["claude", "openai", "cursor", "zedindustries"];

function subset(full, names) {
  const icons = {};
  const missing = [];
  for (const name of [...names].sort()) {
    const data = getIconData(full, name);
    if (!data) {
      missing.push(name);
      continue;
    }
    icons[name] = data;
  }
  return { collection: { prefix: full.prefix, icons }, missing };
}

const phFull = readJson(
  path.join(root, "node_modules", "@iconify-json", "ph", "icons.json"),
);
const siFull = readJson(
  path.join(
    root,
    "node_modules",
    "@iconify-json",
    "simple-icons",
    "icons.json",
  ),
);

const ph = subset(phFull, phNames);
const si = subset(siFull, siNames);

const allMissing = [
  ...ph.missing.map((n) => `ph:${n}`),
  ...si.missing.map((n) => `simple-icons:${n}`),
];
if (allMissing.length) {
  console.error("Missing icons (not found in collections):", allMissing);
  process.exit(1);
}

const out = [ph.collection, si.collection];
fs.writeFileSync(
  path.join(root, "lib", "icon-data.json"),
  JSON.stringify(out),
);
console.log(
  `Wrote lib/icon-data.json: ${Object.keys(ph.collection.icons).length} ph + ${Object.keys(si.collection.icons).length} simple-icons icons.`,
);
