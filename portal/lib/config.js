/**
 * Central config. Everything is overridable via environment variables
 * (see .env.example). Read lazily so Next picks up .env.local at request time.
 */
import path from "node:path";
import * as _fs from "node:fs";

export function config() {
  return {
    // --- VLM ---
    // Two providers: Google Gemini direct, OR OpenRouter (OpenAI-compatible
    // gateway). If OPENROUTER_API_KEY is set, OpenRouter is used and VLM_MODEL
    // should be an OpenRouter slug (e.g. "google/gemini-2.5-flash").
    googleApiKey: process.env.GOOGLE_API_KEY || "",
    openRouterKey: process.env.OPENROUTER_API_KEY || "",
    vlmModel: process.env.VLM_MODEL || "gemini-2.5-pro",

    // --- GitHub ---
    githubToken: process.env.GITHUB_TOKEN || "",

    // --- Self-heal (Claude Code CLI) ---
    // Absolute path to the `claude` binary. Defaults to "claude" on PATH; set
    // CLAUDE_CLI_PATH when it's installed under nvm and not on the server's PATH.
    claudeCliPath: process.env.CLAUDE_CLI_PATH || "claude",
    // Optional per-account config dirs. Claude Code keeps its login/credentials in
    // CLAUDE_CONFIG_DIR; point each of these at a directory you've logged into once
    // (`CLAUDE_CONFIG_DIR=<dir> claude /login`) with the matching account, so the
    // portal can pick which subscription self-heal runs under. Blank = the CLI's
    // default login (~/.claude).
    claudeAccounts: {
      business: process.env.CLAUDE_CONFIG_DIR_BUSINESS || "",
      personal: process.env.CLAUDE_CONFIG_DIR_PERSONAL || "",
    },

    // --- Self-heal (Cursor CLI) ---
    // Absolute path to the `agent` binary (Cursor CLI). Install via:
    //   curl https://cursor.com/install -fsS | bash
    // then set CURSOR_CLI_PATH if it's not on PATH (default: ~/.local/bin/agent).
    cursorCliPath: process.env.CURSOR_CLI_PATH || `${process.env.HOME || "~"}/.local/bin/agent`,
    // Model to use with Cursor CLI for self-heal runs.
    cursorModel: process.env.CURSOR_MODEL || "claude-4.6-sonnet-medium",

    // --- Jira (optional dispatch target) ---
    jira: {
      baseUrl: (process.env.JIRA_BASE_URL || "").replace(/\/+$/, ""),
      email: process.env.JIRA_EMAIL || "",
      apiToken: process.env.JIRA_API_TOKEN || "",
      projectKey: process.env.JIRA_PROJECT_KEY || "QA",
      issueType: process.env.JIRA_ISSUE_TYPE || "Bug",
    },

    // --- Slack (optional dispatch target) ---
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",

    // --- Runtime workspace ---
    workspaceDir: path.resolve(
      process.cwd(),
      process.env.WORKSPACE_DIR || ".workspaces"
    ),
  };
}

export function jiraConfigured() {
  const c = config().jira;
  return Boolean(c.baseUrl && c.email && c.apiToken);
}

export function slackConfigured() {
  return Boolean(config().slackWebhookUrl);
}

// Whether the Cursor CLI binary exists and is usable.
export function cursorConfigured() {
  try {
    const { existsSync } = _fs;
    return existsSync(config().cursorCliPath);
  } catch {
    return false;
  }
}

// Which self-heal Claude accounts have a config dir set (usable in the portal).
export function claudeAccountsConfigured() {
  const a = config().claudeAccounts;
  return { business: Boolean(a.business), personal: Boolean(a.personal) };
}

// Resolve an account key ("business" | "personal") to its CLAUDE_CONFIG_DIR.
// Unknown/blank returns "" so the CLI falls back to its default login.
export function claudeConfigDirFor(account) {
  const a = config().claudeAccounts;
  return (account && a[account]) || "";
}

// VLM is usable if EITHER provider is configured (OpenRouter takes precedence).
export function geminiConfigured() {
  const c = config();
  return Boolean(c.openRouterKey || c.googleApiKey);
}

export function useOpenRouter() {
  return Boolean(config().openRouterKey);
}
