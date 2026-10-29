import type * as WsTypes from "ws";

export interface WebSocketKeepAliveOptions {
  readonly intervalMs: number;
  /** Silent intervals tolerated before the socket is terminated. */
  readonly missesBeforeClose: number;
}

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
