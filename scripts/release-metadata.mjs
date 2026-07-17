#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function releaseAssets(version) {
  return {
    windows: `afterglow-${version}-windows-x64.exe`,
    "linux-appimage": `afterglow-${version}-linux-x86_64.AppImage`,
    "linux-deb": `afterglow-${version}-linux-amd64.deb`,
    android: `afterglow-${version}-android-debug.apk`,
    checksums: `afterglow-${version}-SHA256SUMS.txt`,
  };
}

function readOption(args, option) {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function validateRepository(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Repository must use the GitHub owner/name form.");
  }
  const [owner, name] = repository.split("/");
  if ([owner, name].some((part) => part === "." || part === "..")) {
    throw new Error("Repository contains an invalid path segment.");
  }
}

function validateTag(tag, version) {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag ${tag} does not match package version ${version}; expected ${expected}.`);
  }
}

function releaseUrl(repository, tag, assetName) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function createAvailabilityManifest(repository, tag, version) {
  validateRepository(repository);
  validateTag(tag, version);
  const assets = releaseAssets(version);
  return {
    version: 1,
    releasePage: `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    builds: {
      windows: {
        href: releaseUrl(repository, tag, assets.windows),
        version,
      },
      linux: {
        href: releaseUrl(repository, tag, assets["linux-appimage"]),
        version,
      },
      android: {
        href: releaseUrl(repository, tag, assets.android),
        version,
      },
    },
  };
}

async function readProjectVersion() {
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const version = packageJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("package.json must contain a valid semantic version.");
  }
  return version;
}

async function validateAndroidVersion(version) {
  const gradle = await readFile(resolve(projectRoot, "android", "app", "build.gradle"), "utf8");
  const match = gradle.match(/versionName\s+"([^"]+)"/);
  if (!match) throw new Error("android/app/build.gradle does not contain versionName.");
  if (match[1] !== version) {
    throw new Error(`Android versionName ${match[1]} does not match package version ${version}.`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const version = await readProjectVersion();
  const tag = readOption(args, "--tag") ?? process.env.RELEASE_TAG;
  const repository = readOption(args, "--repository") ?? process.env.GITHUB_REPOSITORY;
  const asset = readOption(args, "--asset");
  const output = readOption(args, "--output");

  await validateAndroidVersion(version);
  if (tag) validateTag(tag, version);

  if (asset) {
    const assets = releaseAssets(version);
    if (!(asset in assets)) throw new Error(`Unknown asset key: ${asset}.`);
    process.stdout.write(`${assets[asset]}\n`);
    return;
  }

  if (output) {
    if (!repository) throw new Error("--repository owner/name (or GITHUB_REPOSITORY) is required with --output.");
    if (!tag) throw new Error("--tag vX.Y.Z (or RELEASE_TAG) is required with --output.");
    const destination = resolve(projectRoot, output);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(createAvailabilityManifest(repository, tag, version), null, 2)}\n`, "utf8");
    process.stdout.write(`${destination}\n`);
    return;
  }

  if (args.includes("--check")) {
    process.stdout.write(`Release metadata OK for Afterglow ${version}${tag ? ` (${tag})` : ""}.\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({ version, expectedTag: `v${version}`, assets: releaseAssets(version) }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
