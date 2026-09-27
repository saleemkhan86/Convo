import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View, useColorScheme } from "react-native";
import type { Account, AuthResult } from "@convo/shared";
import { api, hydrateSession } from "./src/api";
import { AuthScreen } from "./src/screens/AuthScreen";
import { ConnectIdentityScreen } from "./src/screens/ConnectIdentityScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { WelcomeScreen, type AuthChannel } from "./src/screens/WelcomeScreen";
import { darkPalette, lightPalette } from "./src/theme";

type Route =
  | { name: "welcome" }
  | { name: "auth"; channel: AuthChannel }
  | { name: "home" }
  | { name: "settings" }
  | { name: "connect"; channel: "email" | "phone" };

export default function App() {
  const scheme = useColorScheme();
  const palette = scheme === "dark" ? darkPalette : lightPalette;
  const [bootstrapping, setBootstrapping] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [route, setRoute] = useState<Route>({ name: "welcome" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await hydrateSession();
      if (stored) {
        try {
          const me = await api.me();
          if (!cancelled) {
            setAccount(me);
            setRoute({ name: "home" });
          }
        } catch {
          await api.signOut();
        }
      }
      if (!cancelled) setBootstrapping(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignedIn = async (result: AuthResult) => {
    await api.signInWith(result);
    setAccount(result.account);
    setRoute({ name: "home" });
  };

  const handleSignedOut = () => {
    setAccount(null);
    setRoute({ name: "welcome" });
  };

  if (bootstrapping) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color="#6f55e9" />
      </View>
    );
  }

  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {route.name === "welcome" && (
        <WelcomeScreen onContinue={(channel) => setRoute({ name: "auth", channel })} />
      )}
      {route.name === "auth" && (
        <AuthScreen
          channel={route.channel}
          onBack={() => setRoute({ name: "welcome" })}
          onSignedIn={(result) => void handleSignedIn(result)}
        />
      )}
      {route.name === "home" && account && (
        <HomeScreen
          account={account}
          onOpenSettings={() => setRoute({ name: "settings" })}
          onConnect={(channel) => setRoute({ name: "connect", channel })}
        />
      )}
      {route.name === "settings" && account && (
        <SettingsScreen
          account={account}
          onBack={() => setRoute({ name: "home" })}
          onAccountUpdated={setAccount}
          onConnect={(channel) => setRoute({ name: "connect", channel })}
          onSignedOut={handleSignedOut}
        />
      )}
      {route.name === "connect" && account && (
        <ConnectIdentityScreen
          channel={route.channel}
          account={account}
          onBack={() => setRoute({ name: "settings" })}
          onConnected={(updated) => {
            setAccount(updated);
            setRoute({ name: "home" });
          }}
        />
      )}
    </>
  );
}
