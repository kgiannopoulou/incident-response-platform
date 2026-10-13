"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, apiFetch, post } from "./api";
import type { User } from "./types";

type AuthState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | { status: "signed-in"; user: User };

type AuthContextValue = {
  state: AuthState;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let ignore = false;
    apiFetch<{ user: User }>("/auth/me")
      .then(({ user }) => !ignore && setState({ status: "signed-in", user }))
      .catch((err) => {
        if (ignore) return;
        setState(err instanceof ApiError && err.status === 401 ? { status: "signed-out" } : { status: "error", message: err.message });
      });
    return () => {
      ignore = true;
    };
  }, [attempt]);

  const login = useCallback(async (email: string, password: string) => {
    const { user } = await post<{ user: User }>("/auth/login", { email, password });
    setState({ status: "signed-in", user });
  }, []);

  const logout = useCallback(async () => {
    await post("/auth/logout").catch(() => {});
    setState({ status: "signed-out" });
  }, []);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return <AuthContext.Provider value={{ state, login, logout, retry }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

export function useUser() {
  const { state } = useAuth();
  return state.status === "signed-in" ? state.user : null;
}
