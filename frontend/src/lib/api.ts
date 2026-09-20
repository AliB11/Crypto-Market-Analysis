/**
 * REST client for the /api/v1 gateway.
 *
 * API resolution order:
 *   1. NEXT_PUBLIC_API_URL (baked at build time – e.g. http://localhost:8000)
 *   2. same-origin relative URLs (Next.js rewrites proxy to the backend)
 */

import type {
  ConfluenceScore,
  DivergenceResponse,
  OHLCVResponse,
  Resolution,
  WatchlistResponse,
} from "@/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    signal,
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ detail: response.statusText }));
    throw new ApiError(response.status, (detail as { detail?: string }).detail ?? "request failed");
  }
  return (await response.json()) as T;
}

export const api = {
  fetchWatchlist: (signal?: AbortSignal) =>
    request<WatchlistResponse>("/api/v1/market/symbols", signal),

  fetchOHLCV: (symbol: string, resolution: Resolution, limit = 500, signal?: AbortSignal) =>
    request<OHLCVResponse>(
      `/api/v1/market/ohlcv/${symbol}?resolution=${resolution}&limit=${limit}`,
      signal,
    ),

  fetchDivergences: (symbol: string, windowHours = 72, signal?: AbortSignal) =>
    request<DivergenceResponse>(
      `/api/v1/sentiment/divergence/${symbol}?window_hours=${windowHours}`,
      signal,
    ),

  fetchCompositeScore: (symbol: string, signal?: AbortSignal) =>
    request<ConfluenceScore>(`/api/v1/analytics/composite-score/${symbol}`, signal),
};
