"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { RealtimeEvent } from "@irp/shared";
import { API_URL } from "./api";

// One EventSource per tab, shared by every component through context.
// EventSource reconnects on its own (the server sends `retry: 3000`), and
// `connected` drives the "Live" indicator in the header.
type Listener = (event: RealtimeEvent) => void;
type LiveContextValue = { connected: boolean; subscribe: (listener: Listener) => () => void };

const LiveContext = createContext<LiveContextValue>({ connected: false, subscribe: () => () => {} });

export function LiveProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const listeners = useRef(new Set<Listener>());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource(`${API_URL}/api/v1/stream`, { withCredentials: true });
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RealtimeEvent | { type: "connected" };
      if (event.type === "connected") return;
      for (const listener of listeners.current) listener(event as RealtimeEvent);
    };
    return () => source.close();
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
