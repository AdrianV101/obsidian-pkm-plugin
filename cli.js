#!/usr/bin/env node

import { createRequire } from "module";

const subcommand = process.argv[2];

try {
  if (subcommand === "init") {
    const { runInit } = await import("./init.js");
    await runInit();
  } else if (subcommand === "--version" || subcommand === "-v") {
    const require = createRequire(import.meta.url);
    const { version } = require("./package.json");
    console.log(`obsidian-pkm v${version}`);
  } else if (subcommand === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor();
  } else if (subcommand === "migrate-devlog") {
    const { runMigrateDevlog } = await import("./migrate-devlog.js");
    process.exitCode = await runMigrateDevlog(process.argv.slice(3));
  } else if (!subcommand) {
    const { startServer } = await import("./index.js");
    await startServer();
  } else {
    console.error(`Unknown command: ${subcommand}`);
    console.error("Usage: obsidian-pkm [init | doctor | migrate-devlog <project> [--apply]]");
    process.exit(1);
  }
} catch (e) {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
}
