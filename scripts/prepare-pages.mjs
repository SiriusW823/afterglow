#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "native-dist");

await mkdir(resolve(output, "downloads"), { recursive: true });
await copyFile(resolve(root, "public", "downloads", "availability.json"), resolve(output, "downloads", "availability.json"));
await copyFile(resolve(root, "public", "og.png"), resolve(output, "og.png"));
await writeFile(resolve(output, ".nojekyll"), "", "utf8");

const index = await readFile(resolve(output, "index.html"), "utf8");
await writeFile(resolve(output, "404.html"), index, "utf8");

process.stdout.write(`GitHub Pages bundle prepared at ${output}\n`);
