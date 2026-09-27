import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { SessionTokens } from "@convo/shared";

export interface StoredSession extends SessionTokens {
  expiresAt: number;
}

const KEY = "convo.session";

/**
 * Secure local storage for tokens (spec §2 Android: secure local storage).
 * SecureStore is Android/iOS only; web preview falls back to memory.
 */
const memoryFallback = new Map<string, string>();

export async function loadStoredSession(): Promise<StoredSession | null> {
  try {
    const raw =
      Platform.OS === "web" ? memoryFallback.get(KEY) ?? null : await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export async function storeSession(tokens: SessionTokens): Promise<StoredSession> {
  const stored: StoredSession = {
    ...tokens,
    expiresAt: Date.now() + tokens.accessExpiresInSeconds * 1000,
  };
  const raw = JSON.stringify(stored);
  if (Platform.OS === "web") memoryFallback.set(KEY, raw);
  else await SecureStore.setItemAsync(KEY, raw);
  return stored;
}

export async function clearStoredSession(): Promise<void> {
  if (Platform.OS === "web") memoryFallback.delete(KEY);
  else await SecureStore.deleteItemAsync(KEY);
}

export const API_BASE =
  process.env.EXPO_PUBLIC_API_URL ??
  Platform.select({
    android: "http://10.0.2.2:4000",
    default: "http://localhost:4000",
  });
