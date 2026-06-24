// エントリポイント：Playwright MCP へ接続し対話ループを起動する

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { listAvailableTools } from "./lib/mcp.js";
import { printHelp, interactiveLoop } from "./lib/repl.js";

async function main() {
  const client = new Client({
    name: "playwright-mcp-node-client",
    version: "1.0.0"
  });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["@playwright/mcp@latest"]
  });

  try {
    await client.connect(transport);
    console.log("Connected to Playwright MCP");

    const tools = await listAvailableTools(client);

    if (!tools.has("browser_navigate")) {
      throw new Error("browser_navigate not available");
    }

    if (!tools.has("browser_evaluate")) {
      throw new Error("browser_evaluate not available");
    }

    printHelp();

    await interactiveLoop(client);

  } catch (err) {
    console.error("Fatal:", err);
  } finally {
    await transport.close?.();
  }
}

main();
