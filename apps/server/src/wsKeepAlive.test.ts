import { describe, expect, it, vi } from "vite-plus/test";
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

describe("makeKeepAliveWebSocket", () => {
  it("keeps a responsive client and terminates one that stops answering", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
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
    try {
      await open(client);
      const socket = await serverSide;
      const serverClosed = closed(socket);
      // Advance the heartbeat clock only after the actual network pong arrives,
      // so CPU load cannot make a responsive client miss the assertion window.
      for (let interval = 0; interval < 5; interval += 1) {
        const pong = new Promise<void>((resolve) => socket.once("pong", () => resolve()));
        vi.advanceTimersByTime(INTERVAL_MS);
        await pong;
        expect(socket.readyState).toBe(NodeWS.WebSocket.OPEN);
      }

      // Pausing the client's TCP stream is the closest stand-in for a suspended
      // phone: the connection stays open, nothing is read, nothing is answered.
      const stream = (client as unknown as { _socket: { pause: () => void } })._socket;
      stream.pause();
      vi.advanceTimersByTime(INTERVAL_MS * 3);
      const code = await serverClosed;
      expect(code).toBe(1006);
    } finally {
      client.terminate();
      for (const connection of server.clients) connection.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vi.useRealTimers();
    }
  });
});
