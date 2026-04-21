
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import crypto from "crypto";
import os from "os";
import { createRequire } from "module";
import fs from "fs/promises";
import { SemanticIndex } from "./embeddings.js";
import { ActivityLog } from "./activity.js";
import { loadTemplates } from "./helpers.js";
import { createHandlers } from "./handlers.js";
import { createToolsList } from "./tools.js";

// Read version from package.json
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("./package.json");

export async function startServer() {
  // Get vault path from environment
  const VAULT_PATH = process.env.VAULT_PATH || (os.homedir() + "/Documents/PKM");

  // Template registry (populated at startup)
  let templateRegistry = new Map();
  let templateDescriptions = "";

  // Semantic index (populated at startup if VAULT_PKM_OPENAI_KEY is set)
  let semanticIndex = null;

  // Activity log (populated at startup)
  let activityLog = null;
  const SESSION_ID = crypto.randomUUID();

  // Handler map (populated at startup)
  let handlers;

  // Create the server
  const server = new Server(
    { name: "vault-pkm", version: PKG_VERSION },
    { capabilities: { tools: {} } }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: createToolsList(templateDescriptions, Array.from(templateRegistry.keys()), !!semanticIndex?.isAvailable)
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
    if (openaiApiKey && !openaiApiKey.startsWith("${")) {
      try {
        semanticIndex = new SemanticIndex({ vaultPath: VAULT_PATH, openaiApiKey });
        await semanticIndex.initialize();
        console.error("Semantic index initialized");
        if (!process.env.VAULT_PKM_OPENAI_KEY && process.env.OBSIDIAN_PKM_OPENAI_KEY) {
          console.error("Note: OBSIDIAN_PKM_OPENAI_KEY is deprecated — rename to VAULT_PKM_OPENAI_KEY");
        }
      } catch (err) {
        console.error(`Semantic index init failed (non-fatal): ${err.message}`);
        semanticIndex = null;
      }
    } else {
      console.error("VAULT_PKM_OPENAI_KEY not set — semantic search disabled");
    }

    try {
      activityLog = new ActivityLog({ vaultPath: VAULT_PATH, sessionId: SESSION_ID });
      await activityLog.initialize();
      console.error(`Activity log initialized (session: ${SESSION_ID.slice(0, 8)})`);
    } catch (err) {
      console.error(`Activity log init failed (non-fatal): ${err.message}`);
      activityLog = null;
    }

    handlers = await createHandlers({
      vaultPath: VAULT_PATH,
      templateRegistry,
      semanticIndex,
      activityLog,
      sessionId: SESSION_ID,
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`PKM MCP Server running... (${templateRegistry.size} templates loaded${semanticIndex?.isAvailable ? ", semantic search enabled" : ""}, activity log ${activityLog ? "enabled" : "disabled"})`);
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
      if (semanticIndex) await semanticIndex.shutdown();
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

// Auto-start when run directly (backward compat: existing users may have
// "args": ["/path/to/index.js"] in their settings.json)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
