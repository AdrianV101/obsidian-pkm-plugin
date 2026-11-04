
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import crypto from "crypto";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { pathToFileURL } from "url";
import fs from "fs/promises";
import { SemanticIndex } from "./embeddings.js";
import { KeywordIndex } from "./keyword-index.js";
import { HousekeeperLease } from "./lease.js";
import { openLocalIndex } from "./local-index.js";
import { loadMachineSettings } from "./machine-settings.js";
import { CACHE_FOLDER } from "./embedding-cache.js";
import { cacheDir, stateDir } from "./local-paths.js";
import { describeHealth } from "./semantic-health.js";
import { ActivityLog } from "./activity.js";
import { loadTemplates } from "./helpers.js";
import { createHandlers } from "./handlers.js";
import { createToolsList } from "./tools.js";
import { buildServerInstructions } from "./instructions.js";
import { normalizeVaultRoot } from "./vault-fs.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("./package.json");

export async function startServer() {
  // Get vault path from environment
  const VAULT_PATH = normalizeVaultRoot(process.env.VAULT_PATH || path.join(os.homedir(), "Documents", "PKM"));
  // Vault name for obsidian:// URI links — defaults to basename of VAULT_PATH.
  // Override when the on-disk folder name differs from the registered Obsidian vault name.
  const VAULT_NAME = process.env.VAULT_PKM_VAULT_NAME || path.basename(VAULT_PATH);

  // Template registry (populated at startup)
  let templateRegistry = new Map();
  let templateDescriptions = "";

  // Semantic index (populated at startup if VAULT_PKM_OPENAI_KEY is set)
  let semanticIndex = null;

  // Local index, lease and keyword index (opened at startup, with or without a key)
  let localIndex = null;
  let lease = null;
  let keywordIndex = null;

  // Activity log (populated at startup)
  let activityLog = null;
  const SESSION_ID = crypto.randomUUID();

  // Handler map (populated at startup)
  let handlers;

  // Create the server
  const server = new Server(
    { name: "vault-pkm", version: PKG_VERSION },
    { capabilities: { tools: {} }, instructions: buildServerInstructions({ vaultName: VAULT_NAME }) }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: createToolsList(templateDescriptions, Array.from(templateRegistry.keys()), semanticIndex !== null)
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Log activity (skip vault_activity to avoid noise)
    if (name !== "vault_activity") {
      try { activityLog?.log(name, args); } catch (e) { console.error(`Activity log: ${e.message}`); }
    }

    try {
      const handler = handlers.get(name);
      if (!handler) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return await handler(args);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  });

  // Initialize and start the server
  async function initializeServer() {
    // Validate vault path exists
    try {
      const stat = await fs.stat(VAULT_PATH);
      if (!stat.isDirectory()) {
        console.error(`Error: VAULT_PATH is not a directory: ${VAULT_PATH}`);
        process.exit(1);
      }
    } catch (e) {
      if (e.code === "ENOENT") {
        console.error(`Error: VAULT_PATH does not exist: ${VAULT_PATH}`);
        console.error("Set the VAULT_PATH environment variable to your Obsidian vault directory.");
        process.exit(1);
      }
      throw e;
    }

    templateRegistry = await loadTemplates(VAULT_PATH);

    if (templateRegistry.size > 0) {
      templateDescriptions = Array.from(templateRegistry.values())
        .map(t => `- **${t.shortName}**: ${t.description}`)
        .join("\n");
    } else {
      templateDescriptions = "(No templates found - add .md files to 05-Templates/)";
    }

    const openaiApiKey = process.env.VAULT_PKM_OPENAI_KEY
      || process.env.OBSIDIAN_PKM_OPENAI_KEY
      || process.env.OPENAI_API_KEY;
    const CACHE_DIR = cacheDir(VAULT_PATH);
    const STATE_DIR = stateDir(VAULT_PATH);
    const hasKey = !!openaiApiKey && !openaiApiKey.startsWith("${");
    // The local index and the housekeeper lease exist with or without a key: the keyword index lives there.
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      lease = new HousekeeperLease({ stateDir: STATE_DIR });
      localIndex = openLocalIndex({ vaultPath: VAULT_PATH, dbPath: path.join(CACHE_DIR, "index.db") });
    } catch (err) {
      console.error(`Local index init failed (non-fatal): ${err.message}`);
      localIndex?.close();
      await lease?.release();
      localIndex = null;
      lease = null;
    }

    if (localIndex) {
      try {
        keywordIndex = new KeywordIndex({ localIndex, vaultPath: VAULT_PATH, lease });
      } catch (err) {
        console.error(`Keyword index init failed (non-fatal): ${err.message}`);
        keywordIndex = null;
      }
    }

    if (hasKey && localIndex) {
      try {
        const settings = loadMachineSettings(STATE_DIR);
        // The pack folder is created on the first pack write, not here.
        semanticIndex = new SemanticIndex({
          vaultPath: VAULT_PATH, openaiApiKey, localIndex, lease, stateDir: STATE_DIR,
          settings, cacheDirAbs: path.join(VAULT_PATH, CACHE_FOLDER),
        });
        await semanticIndex.initialize();
        console.error("Semantic index initialized");
        if (!process.env.VAULT_PKM_OPENAI_KEY && process.env.OBSIDIAN_PKM_OPENAI_KEY) {
          console.error("Note: OBSIDIAN_PKM_OPENAI_KEY is deprecated — rename to VAULT_PKM_OPENAI_KEY");
        }
      } catch (err) {
        console.error(`Semantic index init failed (non-fatal): ${err.message}`);
        semanticIndex = null;
      }
    } else if (!hasKey) {
      console.error("VAULT_PKM_OPENAI_KEY not set — semantic search disabled");
    }

    // Not awaited: a slow state folder must not delay server startup.
    if (lease) lease.tryAcquire().catch((e) => console.error(`Housekeeper lease: ${e.message}`));

    try {
      activityLog = new ActivityLog({ vaultPath: VAULT_PATH, sessionId: SESSION_ID, stateDir: STATE_DIR });
      await activityLog.initialize();
      console.error(`Activity log initialized (session: ${SESSION_ID.slice(0, 8)})`);
    } catch (err) {
      console.error(`Activity log init failed (non-fatal): ${err.message}`);
      activityLog = null;
    }

    handlers = await createHandlers({
      vaultPath: VAULT_PATH,
      vaultName: VAULT_NAME,
      templateRegistry,
      semanticIndex,
      keywordIndex,
      localIndex,
      lease,
      activityLog,
      sessionId: SESSION_ID,
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    const semanticStatus = semanticIndex ? `, semantic search ${describeHealth(semanticIndex.health())}` : "";
    console.error(`PKM MCP Server running... (${templateRegistry.size} templates loaded${semanticStatus}, activity log ${activityLog ? "enabled" : "disabled"})`);
  }

  let shuttingDown = false;

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("Shutting down...");
    const forceTimer = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceTimer.unref();
    try {
      await keywordIndex?.shutdown();
    } catch (e) {
      console.error(`Keyword index shutdown error: ${e.message}`);
    }
    try {
      // The semantic index closes the local index and releases the lease when it exists.
      if (semanticIndex) await semanticIndex.shutdown();
      else {
        localIndex?.close();
        await lease?.release();
      }
    } catch (e) {
      console.error(`Semantic index shutdown error: ${e.message}`);
    }
    if (activityLog) activityLog.shutdown();
    clearTimeout(forceTimer);
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  initializeServer().catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

/**
 * Whether the module at `metaUrl` is the script node was started with.
 * @param {string} metaUrl - import.meta.url of the module
 * @param {string|undefined} argv1 - process.argv[1]
 * @param {{ windows?: boolean }} [options]
 * @returns {boolean}
 */
export function isMainModule(metaUrl, argv1, { windows = process.platform === "win32" } = {}) {
  if (!argv1) return false;
  return pathToFileURL(argv1, { windows }).href === metaUrl;
}

// Auto-start when run directly (backward compat: existing users may have
// "args": ["/path/to/index.js"] in their settings.json)
if (isMainModule(import.meta.url, process.argv[1])) {
  startServer();
}
