import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import worker from "./src/index.js";

const workerRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(workerRoot, "..");
const frontendRoot = path.join(projectRoot, "frontend");
const localVarsPath = path.join(workerRoot, ".dev.vars");
const localDataDir = path.join(workerRoot, ".wrangler", "local-node");
const localDatabasePath = path.join(localDataDir, "study.sqlite3");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";

function loadLocalVars() {
  if (!fs.existsSync(localVarsPath)) return;
  for (const line of fs.readFileSync(localVarsPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

class D1StatementShim {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new D1StatementShim(this.database, this.sql, bindings);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.bindings) || null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid || 0)
      }
    };
  }
}

class D1DatabaseShim {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
  }

  exec(sql) {
    this.database.exec(sql);
  }

  prepare(sql) {
    return new D1StatementShim(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

loadLocalVars();
const DB = new D1DatabaseShim(localDatabasePath);
DB.exec(fs.readFileSync(path.join(workerRoot, "schema.sql"), "utf8"));

const openAiKey = process.env.OPENAI_API_KEY || "";
const azureOpenAiKey = process.env.AZURE_OPENAI_API_KEY || "";
const providerKey = openAiKey || azureOpenAiKey;
const env = {
  DB,
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || `http://${host}:${port},http://localhost:${port}`,
  PARTICIPANT_CODES: process.env.PARTICIPANT_CODES || "EXPERT-5136,EXPERT-8427",
  PROFILE_ASSIGNMENTS: process.env.PROFILE_ASSIGNMENTS || "EXPERT-5136:1-20,EXPERT-8427:21-40",
  EXPERT_ACCESS_CODES: process.env.EXPERT_ACCESS_CODES || JSON.stringify({
    "EXPERT-5136": "LOCAL-EXPERT-5136",
    "EXPERT-8427": "LOCAL-EXPERT-8427"
  }),
  TOKEN_SECRET: process.env.TOKEN_SECRET || "local-development-token-secret",
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4.1",
  OPENAI_API_KEY: openAiKey,
  AZURE_OPENAI_API_KEY: azureOpenAiKey,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  MOCK_OPENAI: process.env.MOCK_OPENAI || (providerKey ? "false" : "true")
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function handleApi(nodeRequest, nodeResponse) {
  const body = ["GET", "HEAD"].includes(nodeRequest.method || "GET")
    ? undefined
    : await readRequestBody(nodeRequest);
  const request = new Request(`http://${host}:${port}${nodeRequest.url}`, {
    method: nodeRequest.method,
    headers: nodeRequest.headers,
    body,
    ...(body ? { duplex: "half" } : {})
  });
  const response = await worker.fetch(request, env);
  nodeResponse.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

function handleStatic(nodeRequest, nodeResponse) {
  const url = new URL(nodeRequest.url || "/", `http://${host}:${port}`);
  const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const resolved = path.resolve(frontendRoot, requested);
  if (!resolved.startsWith(`${frontendRoot}${path.sep}`) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    nodeResponse.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    nodeResponse.end("Not found");
    return;
  }
  nodeResponse.writeHead(200, {
    "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  fs.createReadStream(resolved).pipe(nodeResponse);
}

const server = http.createServer(async (request, response) => {
  try {
    if (String(request.url || "").startsWith("/api/")) await handleApi(request, response);
    else handleStatic(request, response);
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Local development server error." }));
  }
});

server.listen(port, host, () => {
  const responseMode = String(env.MOCK_OPENAI).toLowerCase() === "true" ? "mock responses" : env.OPENAI_MODEL;
  console.log(`CBT simulator evaluation: http://${host}:${port}`);
  console.log("Local logins: EXPERT-5136 / LOCAL-EXPERT-5136 and EXPERT-8427 / LOCAL-EXPERT-8427");
  console.log(`Patient response mode: ${responseMode}`);
  console.log(`Local database: ${localDatabasePath}`);
});
