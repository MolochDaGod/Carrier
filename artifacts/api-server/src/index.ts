import app from "./app";
import { logger } from "./lib/logger";
import { attachGameServer } from "./game/server";
import { attachCarrierServer } from "./game/carrier-server";
import { attachBrawlServer } from "./game/brawl-server";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

// Attach the space-shooter WebSocket game server onto the same HTTP server so it
// shares the port the proxy already routes `/api/*` to.
attachGameServer(server);

// Carrier game server — isolated room on /api/carrier.
attachCarrierServer(server);

// Ruins Brawler game server — isolated room on /api/brawl.
attachBrawlServer(server);
