import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerSchemaTools } from "./schema/index.js";
import { registerQueryTools } from "./query-tools.js";
import { registerDataTools } from "./data-tools.js";
import { registerRoutinesTools } from "./routines/index.js";
import { registerErdTool } from "./erd-tool.js";
import { registerAdminTools } from "./admin-tools.js";
import { registerCompareTools } from "./compare/index.js";
import { registerCompareSchemaFileTool } from "./compare-schema-file.js";
import { registerDiagnosticsTools } from "./diagnostics-tools.js";
import { registerMigrationTools } from "./migration-tools.js";
import { registerStreamingTools } from "./streaming-tools.js";
import { registerTraverseTools } from "./traverse-tools.js";

export function registerTools(server: McpServer) {
  registerConnectionTools(server);
  registerSchemaTools(server);
  registerQueryTools(server);
  registerDataTools(server);
  registerRoutinesTools(server);
  registerErdTool(server);
  registerAdminTools(server);
  registerCompareTools(server);
  registerCompareSchemaFileTool(server);
  registerDiagnosticsTools(server);
  registerMigrationTools(server);
  registerStreamingTools(server);
  registerTraverseTools(server);
}
