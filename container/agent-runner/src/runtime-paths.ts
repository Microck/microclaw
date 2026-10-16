import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Explicit deployment paths. Native runners and their MCP/hook children share these values. */
export const AGENT_DIR = process.env.NANOCLAW_AGENT_DIR || '/workspace/agent';
export const SESSION_DIR = process.env.NANOCLAW_SESSION_DIR || '/workspace';
export const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_CONTEXT_PATH = process.env.NANOCLAW_CONTEXT_PATH || '/app/.nanoclaw-session.json';
