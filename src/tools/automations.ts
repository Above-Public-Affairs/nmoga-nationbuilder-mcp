/**
 * Automation tools for NationBuilder
 * - list_automations: List all automations
 * - get_automation: Get automation details
 * - list_automation_enrollments: List enrollments with filters
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NationBuilderClient } from "../client/nationbuilder.js";
import type { AutomationAttributes, AutomationEnrollmentAttributes, QueryParams } from "../types/index.js";
import { formatAutomation, formatAutomationEnrollment, paginatedResult, sanitizeText } from "../utils/formatting.js";
import { reportError } from "../utils/errorReporter.js";

export function registerAutomationTools(
  server: McpServer,
  client: NationBuilderClient
): void {
  server.registerTool(
    "list_automations",
    {
      title: "List Automations",
      description: "List all automations in NationBuilder.",
      inputSchema: {
        status: z
          .string()
          .optional()
          .describe("Filter by automation status"),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Results per page (max 100)"),
        page_number: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Page number"),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
        };

        if (params.status) {
          queryParams.filter = { status: params.status };
        }

        const response = await client.get<AutomationAttributes>("automations", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No automations found." }],
          };
        }

        let result = `Automations:\n\n`;
        for (const auto of response.data) {
          result += formatAutomation(auto) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_automations failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing automations: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.registerTool(
    "get_automation",
    {
      title: "Get Automation",
      description: "Get full details for a specific automation by its NationBuilder ID.",
      inputSchema: {
        automation_id: z.string().describe("The NationBuilder automation ID"),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const response = await client.getById<AutomationAttributes>(
          "automations",
          params.automation_id
        );

        const result = formatAutomation(response.data);

        return {
          content: [{ type: "text" as const, text: sanitizeText(result) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "get_automation failed", rawError: error, context: { automation_id: params.automation_id } });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error getting automation: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );

  server.registerTool(
    "list_automation_enrollments",
    {
      title: "List Automation Enrollments",
      description: "List automation enrollments in NationBuilder, optionally filtered by automation or person.",
      inputSchema: {
        automation_id: z
          .string()
          .optional()
          .describe("Filter by automation ID"),
        signup_id: z
          .string()
          .optional()
          .describe("Filter by person's signup ID"),
        status: z
          .string()
          .optional()
          .describe("Filter by enrollment status"),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Results per page (max 100)"),
        page_number: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Page number"),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const queryParams: QueryParams = {
          page_size: params.page_size,
          page_number: params.page_number,
          include: "signup,automation",
        };

        const filter: Record<string, string | Record<string, string>> = {};

        if (params.automation_id) filter.automation_id = params.automation_id;
        if (params.signup_id) filter.signup_id = params.signup_id;
        if (params.status) filter.status = params.status;

        if (Object.keys(filter).length > 0) {
          queryParams.filter = filter;
        }

        const response = await client.get<AutomationEnrollmentAttributes>("automation_enrollments", queryParams);

        if (response.data.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No automation enrollments found matching your criteria." }],
          };
        }

        let result = `Automation Enrollments:\n\n`;
        for (const enrollment of response.data) {
          result += formatAutomationEnrollment(enrollment, response.included) + "\n\n";
        }
        return {
          content: [{ type: "text" as const, text: sanitizeText(paginatedResult(result, response, params.page_number, params.page_size)) }],
        };
      } catch (error) {
        reportError({ category: "tool_error", message: "list_automation_enrollments failed", rawError: error });
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error listing automation enrollments: ${error instanceof Error ? error.message : String(error)}` }],
        };
      }
    }
  );
}
