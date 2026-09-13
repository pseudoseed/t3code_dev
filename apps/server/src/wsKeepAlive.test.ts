import { describe, expect, it } from "vite-plus/test";
import * as NodeWS from "ws";

import { makeKeepAliveWebSocket } from "./wsKeepAlive.ts";

const INTERVAL_MS = 25;

function listen(server: NodeWS.WebSocketServer): Promise<number> {
  return new Promise((resolve) => {
    server.once("listening", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

function open(client: NodeWS.WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

function closed(socket: NodeWS.WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

// @effect-diagnostics-next-line globalTimers:off - exercises the raw ws object, outside any fiber.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("makeKeepAliveWebSocket", () => {
  it("keeps a responsive client and terminates one that stops answering", async () => {
    const server = new NodeWS.WebSocketServer({
      port: 0,
      WebSocket: makeKeepAliveWebSocket(NodeWS.WebSocket, {
        intervalMs: INTERVAL_MS,
        missesBeforeClose: 2,
      }),
    });
    const port = await listen(server);
    const serverSide = new Promise<NodeWS.WebSocket>((resolve) =>
      server.once("connection", resolve),
    );
    const client = new NodeWS.WebSocket(`ws://127.0.0.1:${port}`);
    await open(client);
    const socket = await serverSide;
    const serverClosed = closed(socket);
    let pongs = 0;
    socket.on("pong", () => {
      pongs += 1;
    });

    // A client that answers pings (ws does so at the protocol level) stays up
    // well past the reaping threshold.
    await sleep(INTERVAL_MS * 5);
    expect(socket.readyState).toBe(NodeWS.WebSocket.OPEN);
    expect(pongs).toBeGreaterThanOrEqual(2);

    // Pausing the client's TCP stream is the closest stand-in for a suspended
    // phone: the connection stays open, nothing is read, nothing is answered.
    const stream = (client as unknown as { _socket: { pause: () => void } })._socket;
    stream.pause();
    const code = await serverClosed;
    expect(code).toBe(1006);

    client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
