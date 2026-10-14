"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { RealtimeEvent, StreamControlEvent } from "@irp/shared";
import { API_URL } from "./api";

// One EventSource per tab, shared by every component through context.
//
// Why SSE and not WebSockets: an incident dashboard consumes server-generated
// updates; everything the browser *does* is a normal REST call. SSE is plain
// HTTP (cookies, proxies and the existing auth just work) and comes with
// reconnects and Last-Event-ID built in.
//
// - Short drops: EventSource reconnects by itself (server sends retry: 3000)
//   and sends Last-Event-ID, so the server replays what was missed.
// - Hard failures (the API was down and answered with an error): the
//   browser gives up for good, so we open a new EventSource with backoff and
//   pass the last id as ?lastEventId=.
// - "resync": the server couldn't replay (too far behind); listeners get it
//   and re-fetch everything.
//
// `connected` drives the "Live" indicator in the header.
export type LiveEvent = RealtimeEvent | { type: "resync" };
type Listener = (event: LiveEvent) => void;
type LiveContextValue = { connected: boolean; subscribe: (listener: Listener) => () => void };

const LiveContext = createContext<LiveContextValue>({ connected: false, subscribe: () => () => {} });

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastEventId: string | null = null;
    let failures = 0;
    let stopped = false;

    const emit = (event: LiveEvent) => {
      for (const listener of listeners.current) listener(event);
    };

    const open = () => {
      const query = lastEventId ? `?lastEventId=${encodeURIComponent(lastEventId)}` : "";
      source = new EventSource(`${API_URL}/api/v1/stream${query}`, { withCredentials: true });
      source.onopen = () => {
        failures = 0;
        setConnected(true);
      };
      source.onerror = () => {
        setConnected(false);
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          // Browser gave up: reopen ourselves, 1s, 2s, 4s … up to 30s.
          const delay = Math.min(30_000, 1000 * 2 ** failures++);
          retryTimer = setTimeout(open, delay);
        }
      };
      source.onmessage = (message) => {
        if (message.lastEventId) lastEventId = message.lastEventId;
        const event = JSON.parse(message.data) as RealtimeEvent | StreamControlEvent;
        if (event.type === "connected") return;
        emit(event);
      };
    };

    open();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return <LiveContext.Provider value={{ connected, subscribe }}>{children}</LiveContext.Provider>;
}

export function useLiveConnected() {
  return useContext(LiveContext).connected;
}

export function useLiveUpdates(listener: Listener) {
  const { subscribe } = useContext(LiveContext);
  useEffect(() => subscribe(listener), [subscribe, listener]);
}
