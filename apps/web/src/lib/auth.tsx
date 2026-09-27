import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Account, AuthResult } from "@convo/shared";
import { api, clearSession, loadSession, saveSession } from "../lib/api";

type AuthStatus = "loading" | "signed-out" | "signed-in";

interface AuthContextValue {
  status: AuthStatus;
  account: Account | null;
  setAccount: (account: Account) => void;
  signIn: (result: AuthResult) => void;
  signOut: () => Promise<void>;
  reloadAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [account, setAccountState] = useState<Account | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = loadSession();
      if (!session) {
        if (!cancelled) setStatus("signed-out");
        return;
      }
      try {
        const me = await api.me();
        if (!cancelled) {
          setAccountState(me);
          setStatus("signed-in");
        }
      } catch {
        clearSession();
        if (!cancelled) setStatus("signed-out");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setAccount = useCallback((next: Account) => {
    setAccountState(next);
    setStatus("signed-in");
  }, []);

  const signIn = useCallback((result: AuthResult) => {
    saveSession(result.session);
    setAccountState(result.account);
    setStatus("signed-in");
  }, []);

  const signOut = useCallback(async () => {
    const session = loadSession();
    clearSession();
    setAccountState(null);
    setStatus("signed-out");
    if (session) {
      try {
        await api.logout(session.refreshToken);
      } catch {
        // best effort
      }
    }
  }, []);

  const reloadAccount = useCallback(async () => {
    const me = await api.me();
    setAccountState(me);
  }, []);

  const value = useMemo(
    () => ({ status, account, setAccount, signIn, signOut, reloadAccount }),
    [status, account, setAccount, signIn, signOut, reloadAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
