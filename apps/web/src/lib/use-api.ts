"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./api";
import { useLiveUpdates, type LiveEvent } from "./live";
import type { RealtimeEvent } from "@irp/shared";

// Loads `path` and keeps it fresh: re-fetches whenever a realtime event
// matching `refreshOn` arrives, and always after a "resync" (the live
// stream lost events it couldn't replay). Exposes the error so every page can show a
// message with a Retry button instead of an endless "Loading…".
export function useApi<T>(path: string | null, refreshOn?: (event: RealtimeEvent) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState(0); // Date.now() of the last successful load
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!path) return;
    let ignore = false;
    apiFetch<T>(path)
      .then((result) => {
        if (ignore) return;
        setData(result);
        setLoadedAt(Date.now());
        setError(null);
      })
      .catch((err) => {
        if (!ignore) setError(err.message);
      });
    return () => {
      ignore = true;
    };
  }, [path, version]);

  // Callers pass an inline predicate; keep the latest one in a ref so the
  // live subscription isn't torn down and re-created on every render.
  const refreshOnRef = useRef(refreshOn);
  useEffect(() => {
    refreshOnRef.current = refreshOn;
  });
  useLiveUpdates(
    useCallback(
      (event: LiveEvent) => {
        if (event.type === "resync" || refreshOnRef.current?.(event)) reload();
      },
      [reload]
    )
  );

  return { data, error, reload, loadedAt, loading: data === null && error === null };
}
