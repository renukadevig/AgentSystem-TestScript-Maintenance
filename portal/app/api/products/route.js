import { NextResponse } from "next/server";
import { PRODUCTS } from "@/lib/products.js";
import {
  jiraConfigured,
  slackConfigured,
  geminiConfigured,
  claudeAccountsConfigured,
  cursorConfigured,
  config,
} from "@/lib/config.js";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    products: PRODUCTS.map(({ id, name, baseUrl }) => ({ id, name, baseUrl })),
    capabilities: {
      gemini: geminiConfigured(),
      jira: jiraConfigured(),
      slack: slackConfigured(),
      claudeAccounts: claudeAccountsConfigured(), // { business, personal }
      cursor: cursorConfigured(),                  // boolean — Cursor CLI installed
      cursorModel: config().cursorModel,           // e.g. "claude-4.6-sonnet-medium"
    },
  });
}
