import assert from "node:assert/strict";
import test from "node:test";

import { createAvailabilityManifest } from "../scripts/release-metadata.mjs";

test("GitHub Release metadata uses exact public asset URLs", () => {
  const manifest = createAvailabilityManifest("afterglow/example", "v0.1.0", "0.1.0");

  assert.deepEqual(manifest, {
    version: 1,
    releasePage: "https://github.com/afterglow/example/releases/tag/v0.1.0",
    builds: {
      windows: {
        href: "https://github.com/afterglow/example/releases/download/v0.1.0/afterglow-0.1.0-windows-x64.exe",
        version: "0.1.0",
      },
      linux: {
        href: "https://github.com/afterglow/example/releases/download/v0.1.0/afterglow-0.1.0-linux-x86_64.AppImage",
        version: "0.1.0",
      },
      android: {
        href: "https://github.com/afterglow/example/releases/download/v0.1.0/afterglow-0.1.0-android-debug.apk",
        version: "0.1.0",
      },
    },
  });
});

test("GitHub Release metadata rejects ambiguous repositories and mismatched tags", () => {
  assert.throws(
    () => createAvailabilityManifest("missing-owner", "v0.1.0", "0.1.0"),
    /owner\/name/,
  );
  assert.throws(
    () => createAvailabilityManifest("afterglow/example", "v0.2.0", "0.1.0"),
    /expected v0\.1\.0/,
  );
});
