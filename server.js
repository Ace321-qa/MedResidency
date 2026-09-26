require("dotenv").config();

const http = require("http");
const db = require("./src/db");

const PORT = Number(process.env.PORT || 3000);
const APP = "MedResidency";

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const path = (req.url || "").split("?")[0];

  if (path === "/") {
    sendJson(res, 200, { application: APP, status: "running" });
    return;
  }

  if (path === "/health") {
    sendJson(res, 200, { application: APP, status: "running" });
    return;
  }

  if (path === "/health/db") {
    try {
      await db.ping();
      sendJson(res, 200, { application: APP, database: "connected" });
    } catch (error) {
      // Full detail stays in the server log. The public response never
      // contains credentials, hostnames, usernames or driver messages.
      console.error("[health/db] database check failed:", {
        code: error.code || null,
        errno: error.errno || null,
        target: db.describeTarget(),
      });

      sendJson(res, 503, { application: APP, database: "connection_failed" });
    }
    return;
  }

  sendJson(res, 404, { application: APP, error: "not_found" });
});

server.on("error", (error) => {
  console.error("[server] fatal error:", error.message);
  process.exit(1);
});

server.listen(PORT, () => {
  const missing = db.missingVariables();

  if (missing.length > 0) {
    console.error(
      `[config] MISSING environment variables: ${missing.join(", ")}. ` +
        "Set them in the Hostinger Web App environment variables."
    );
  } else {
    console.log("[config] database target:", db.describeTarget());
  }

  console.log(`${APP} backend running on port ${PORT}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    console.log(`[server] ${signal} received, closing.`);
    server.close(async () => {
      await db.pool.end().catch(() => {});
      process.exit(0);
    });
  });
}
