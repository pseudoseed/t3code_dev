import type * as WsTypes from "ws";

export interface WebSocketKeepAliveOptions {
  readonly intervalMs: number;
  /** Silent intervals tolerated before the socket is terminated. */
  readonly missesBeforeClose: number;
}

/**
 * Server-side liveness for the Node `ws` path. A phone that gets suspended,
 * changes networks, or loses its NAT mapping never sends a close frame;
 * without this the connection, its subscriptions, and its session's
 * "connected" count outlive the device indefinitely. `ws` answers pings at
 * the protocol level without waking the client's JavaScript, so a healthy
 * but idle client costs one frame per interval and a dead one is reaped after
 * `missesBeforeClose` silent intervals. Any inbound frame counts as life.
 *
 * Returned as a `WebSocket` subclass because that is the only per-connection
 * hook `ws` exposes through `WebSocketServer` options.
 */
export function makeKeepAliveWebSocket(
  WebSocketClass: typeof WsTypes.WebSocket,
  options: WebSocketKeepAliveOptions,
): typeof WsTypes.WebSocket {
  class KeepAliveWebSocket extends WebSocketClass {
    constructor(...args: ConstructorParameters<typeof WsTypes.WebSocket>) {
      super(...args);
      let missedPongs = 0;
      // @effect-diagnostics-next-line globalTimers:off - runs inside the raw ws object, outside any fiber.
      const timer = setInterval(() => {
        if (this.readyState !== WebSocketClass.OPEN) return;
        if (missedPongs >= options.missesBeforeClose) {
          this.terminate();
          return;
        }
        missedPongs += 1;
        this.ping();
      }, options.intervalMs);
      timer.unref();
      const alive = () => {
        missedPongs = 0;
      };
      this.on("pong", alive);
      this.on("message", alive);
      this.once("close", () => clearInterval(timer));
    }
  }
  // Only behaviour is added; the constructor overloads are inherited.
  return KeepAliveWebSocket as typeof WsTypes.WebSocket;
}
