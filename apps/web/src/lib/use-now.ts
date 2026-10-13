"use client";

import { useEffect, useState } from "react";

// Current time, re-rendering every `intervalMs`, so "12 sec ago" labels keep
// counting without refetching anything.
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
