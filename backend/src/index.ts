import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import { config } from "./config.js";
import { StreamHub } from "./ws/streams.js";
import { DeviceManager } from "./device/deviceManager.js";
import { registerRoutes } from "./api/routes.js";

const app = Fastify({ logger: true });

// index.html не кешируем, иначе браузер может держать старый бандл
app.addHook("onSend", async (req, reply, payload) => {
  if (req.url === "/" || req.url.endsWith(".html")) {
    reply.header("cache-control", "no-store, max-age=0");
  }
  return payload;
});
const hub = new StreamHub();
const manager = new DeviceManager(hub);

registerRoutes(app, manager);

if (fs.existsSync(config.frontendDist)) {
  await app.register(fastifyStatic, { root: config.frontendDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "not found" });
  });
}

await app.listen({ port: config.port, host: "0.0.0.0" });

const wss = new WebSocketServer({ server: app.server, path: "/ws" });
wss.on("connection", (ws) => {
  hub.add(ws);
  ws.send(JSON.stringify({ type: "status", ...manager.getStatus() }));
});

manager.start();
