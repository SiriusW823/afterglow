import { readFile, writeFile } from "node:fs/promises";

const packageFile = new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url);
const source = await readFile(packageFile, "utf8");
const normalized = source.replace(/(path:\s*")([^"]+)(")/g, (_, prefix, value, suffix) => (
  `${prefix}${value.replaceAll("\\", "/")}${suffix}`
));

if (/path:\s*"[^"]*\\/.test(normalized)) {
  throw new Error("Capacitor generated an invalid Swift package path.");
}

if (normalized !== source) await writeFile(packageFile, normalized, "utf8");
