import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
  // ── explore_database ──────────────────────────────────────────────
  server.registerPrompt(
    "explore_database",
    {
      title: "Explore a database",
      description:
        "Explore and map out a database: tables, schemas, relationships, ERD",
      argsSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().describe("Database name"),
      },
    },
    ({ connection, database }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Explore the database "${database}" on connection "${connection}". Follow these steps:

1. Use **list_tables** and **list_views** to enumerate tables and views
2. Use **describe_table** on the key tables, and **describe_view** on the key views, to understand their structure
3. Use **get_foreign_keys** (without a table filter) to map all relationships
4. Use **list_routines** to check for stored procedures and functions
5. Use **list_triggers** to check for triggers
6. Use **list_events** to check for scheduled events
7. Use **generate_erd** to produce a visual entity-relationship diagram
8. Summarize the database architecture: main entities, relationships, patterns, and anything notable

Give me a complete picture of this database.`,
          },
        },
      ],
    }),
  );

  // ── optimize_query ────────────────────────────────────────────────
  server.registerPrompt(
    "optimize_query",
    {
      title: "Optimize a SQL query",
      description: "Analyze and optimize a SQL query using EXPLAIN and index analysis",
      argsSchema: {
        connection: z.string().describe("Connection name"),
        query: z.string().describe("SQL query to optimize"),
      },
    },
    ({ connection, query }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Analyze and optimize this SQL query on connection "${connection}":

\`\`\`sql
${query}
\`\`\`

Follow these steps:
1. Use **explain_query** with JSON format to get the full execution plan
2. Use **get_indexes** on the tables involved to see existing indexes
3. Use **get_table_stats** to understand the table sizes
4. Identify bottlenecks: full table scans, missing indexes, suboptimal joins
5. Suggest specific improvements:
   - Index additions (with CREATE INDEX statements)
   - Query rewrites
   - Schema changes if beneficial
6. Explain the expected impact of each suggestion`,
          },
        },
      ],
    }),
  );

  // ── find_data ─────────────────────────────────────────────────────
  server.registerPrompt(
    "find_data",
    {
      title: "Find data",
      description: "Find specific data by searching column names and sampling tables",
      argsSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().describe("Database name"),
        description: z
          .string()
          .describe("Description of what data you're looking for"),
      },
    },
    ({ connection, database, description }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I need to find data in database "${database}" on connection "${connection}".

What I'm looking for: ${description}

Follow these steps:
1. Use **search_columns** with relevant patterns to find columns that might contain this data
2. Use **sample_data** on the most promising tables to verify the data exists
3. Use **get_foreign_keys** on those tables to understand how they relate to other tables
4. Write a query using **execute_query** that retrieves the data I need
5. Explain the query and the tables involved`,
          },
        },
      ],
    }),
  );

  // ── audit_schema ──────────────────────────────────────────────────
  server.registerPrompt(
    "audit_schema",
    {
      title: "Audit schema",
      description:
        "Audit a database schema for issues: missing indexes, orphan FKs, empty tables, routines",
      argsSchema: {
        connection: z.string().describe("Connection name"),
        database: z.string().describe("Database name"),
      },
    },
    ({ connection, database }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Audit the database "${database}" on connection "${connection}" for schema quality issues. Check:

1. **Tables without primary keys** — Use search_columns with pattern "%" and look for tables missing PRI keys
2. **Foreign keys without indexes** — Use get_foreign_keys then get_indexes to find FK columns lacking indexes
3. **Duplicate/overlapping indexes** — Use get_indexes to detect redundant indexes
4. **Empty tables** — Use get_table_stats to find tables with 0 rows
5. **Large tables without recent updates** — Use get_table_stats to spot stale data
6. **Stored procedures and functions** — Use list_routines to catalog programmability
7. **Triggers** — Use list_triggers to list all triggers and note any complex logic
8. **Scheduled events** — Use list_events to check for events and their status
9. **Views** — Use list_views to catalog views; spot-check the heavy ones with get_view_ddl

Produce a report with:
- Critical issues (data integrity, missing indexes on large tables)
- Warnings (redundant indexes, empty tables)
- Informational (routine/trigger inventory, schema statistics)
- Specific remediation SQL for each issue found`,
          },
        },
      ],
    }),
  );
}
