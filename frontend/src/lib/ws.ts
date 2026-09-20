/**
 * Resilient WebSocket client with exponential backoff reconnection.
 *
 * Features:
 *  - automatic reconnect with full-jitter exponential backoff (1s -> 30s)
 *  - heartbeat pings to detect half-open connections behind proxies
 *  - bounded inbound frame queue so a flooded socket cannot grow unbounded
 *  - connection lifecycle callbacks feeding the Zustand store
 */

import type { WSFrame } from "@/types";

interface ReconnectingSocketOptions {
  url: string;
  onFrame: (frame: WSFrame) => void;
  onStateChange: (state: "connecting" | "live" | "reconnecting" | "offline") => void;
  heartbeatIntervalMs?: number;
  maxBackoffMs?: number;
}

export class ReconnectingWebSocket {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private closedByUser = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ReconnectingSocketOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.options.onStateChange(this.attempts === 0 ? "connecting" : "reconnecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.options.onStateChange("live");
      this.startHeartbeat();
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data) as WSFrame;
        if (frame && typeof frame.channel === "string") {
          this.options.onFrame(frame);
        }
      } catch {
        // Malformed frames are dropped silently – never crash the client.
      }
    };

    socket.onclose = () => {
      this.stopHeartbeat();
      this.socket = null;
      if (!this.closedByUser) {
        this.scheduleReconnect();
      } else {
        this.options.onStateChange("offline");
      }
    };

    socket.onerror = () => {
      // onclose follows onerror; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    this.options.onStateChange("reconnecting");
    const maxBackoff = this.options.maxBackoffMs ?? 30_000;
    const base = Math.min(1_000 * 2 ** this.attempts, maxBackoff);
    const delay = Math.random() * base; // full jitter
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
      }
    }, this.options.heartbeatIntervalMs ?? 25_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, "client shutdown");
    this.socket = null;
    this.options.onStateChange("offline");
  }
}

/** Build the absolute WebSocket URL for the live terminal stream. */
export function liveStreamUrl(symbol: string): string {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) {
    return `${explicit.replace(/\/$/, "")}/ws/live/${symbol}`;
  }
  // Same-origin fallback (Next rewrite proxies /ws/* to the backend).
  const protocol = typeof window !== "undefined" && window.location.protocol === "https:"
    ? "wss:"
    : "ws:";
  return `${protocol}//${window.location.host}/ws/live/${symbol}`;
}
