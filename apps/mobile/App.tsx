import { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View, useColorScheme } from "react-native";
import type { Account, ConversationSummary, MailThreadSummary, SessionAuthResult } from "@convo/shared";
import { api, hydrateSession } from "./src/api";
import { CallOverlay } from "./src/components/CallOverlay";
import { connectRealtime, disconnectRealtime } from "./src/realtime";
import { AuthScreen } from "./src/screens/AuthScreen";
import { ChatRoomScreen } from "./src/screens/ChatRoomScreen";
import { ConnectIdentityScreen } from "./src/screens/ConnectIdentityScreen";
import { ContactsScreen } from "./src/screens/ContactsScreen";
import { GroupDirectoryScreen } from "./src/screens/GroupDirectoryScreen";
import { GroupInfoScreen } from "./src/screens/GroupInfoScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { MailThreadScreen } from "./src/screens/MailThreadScreen";
import { SearchScreen } from "./src/screens/SearchScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { StarredScreen } from "./src/screens/StarredScreen";
import { UserCardScreen } from "./src/screens/UserCardScreen";
import { WelcomeScreen, type AuthChannel } from "./src/screens/WelcomeScreen";
import { darkPalette, lightPalette } from "./src/theme";

type Route =
  | { name: "welcome" }
  | { name: "auth"; channel: AuthChannel }
  | { name: "home" }
  | { name: "settings" }
  | { name: "chatRoom"; conversation: ConversationSummary }
  | { name: "groupInfo"; conversation: ConversationSummary }
  | { name: "groupDirectory" }
  | { name: "mailThread"; thread: MailThreadSummary }
  | { name: "contacts" }
  | { name: "starred" }
  | { name: "search" }
  | { name: "userCard"; userId: string }
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

  const handleSignedIn = async (result: SessionAuthResult) => {
    await api.signInWith(result);
    setAccount(result.account);
    setRoute({ name: "home" });
  };

  const handleSignedOut = () => {
    setAccount(null);
    setRoute({ name: "welcome" });
  };

  /** Search, starred and the contact card only know ids; the chat needs its summary. */
  const openConversationById = async (conversationId: string) => {
    const list = await api.listConversations().catch(() => null);
    const found = list?.conversations.find((c) => c.id === conversationId);
    if (found) setRoute({ name: "chatRoom", conversation: found });
    else setRoute({ name: "home" });
  };

  // Keep the realtime socket alive for as long as we're authenticated.
  const authed = account !== null;
  useEffect(() => {
    if (!authed) return;
    connectRealtime();
    return () => disconnectRealtime();
  }, [authed]);

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
          onOpenChat={(conversation) => setRoute({ name: "chatRoom", conversation })}
          onOpenThread={(thread) => setRoute({ name: "mailThread", thread })}
          onOpenGroups={() => setRoute({ name: "groupDirectory" })}
          onOpenContacts={() => setRoute({ name: "contacts" })}
          onOpenStarred={() => setRoute({ name: "starred" })}
          onOpenSearch={() => setRoute({ name: "search" })}
          onOpenUser={(userId) => setRoute({ name: "userCard", userId })}
        />
      )}
      {route.name === "chatRoom" && account && (
        <ChatRoomScreen
          conversation={route.conversation}
          account={account}
          onBack={() => setRoute({ name: "home" })}
          onOpenGroup={() => setRoute({ name: "groupInfo", conversation: route.conversation })}
          onOpenUser={(userId) => setRoute({ name: "userCard", userId })}
        />
      )}
      {route.name === "groupInfo" && account && (
        <GroupInfoScreen
          conversationId={route.conversation.id}
          selfUserId={account.id}
          onBack={() => setRoute({ name: "chatRoom", conversation: route.conversation })}
          onLeft={() => setRoute({ name: "home" })}
          onOpenChat={() => setRoute({ name: "chatRoom", conversation: route.conversation })}
        />
      )}
      {route.name === "groupDirectory" && (
        <GroupDirectoryScreen
          onBack={() => setRoute({ name: "home" })}
          onOpenGroup={(conversationId) => void openConversationById(conversationId)}
        />
      )}
      {route.name === "contacts" && (
        <ContactsScreen
          onBack={() => setRoute({ name: "home" })}
          onOpenChat={(conversation) => setRoute({ name: "chatRoom", conversation })}
          onOpenConversation={(conversationId) => void openConversationById(conversationId)}
          onOpenUser={(userId) => setRoute({ name: "userCard", userId })}
        />
      )}
      {route.name === "starred" && (
        <StarredScreen
          onBack={() => setRoute({ name: "home" })}
          onOpenConversation={(conversationId) => void openConversationById(conversationId)}
        />
      )}
      {route.name === "search" && (
        <SearchScreen
          onBack={() => setRoute({ name: "home" })}
          onOpenChat={(conversation) => setRoute({ name: "chatRoom", conversation })}
          onOpenConversation={(conversationId) => void openConversationById(conversationId)}
        />
      )}
      {route.name === "userCard" && (
        <UserCardScreen
          userId={route.userId}
          onBack={() => setRoute({ name: "home" })}
          onOpenConversation={(conversationId) => void openConversationById(conversationId)}
        />
      )}
      {route.name === "mailThread" && account && (
        <MailThreadScreen
          thread={route.thread}
          account={account}
          onBack={() => setRoute({ name: "home" })}
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
      {/* Mounted outside the router so a ring can interrupt any screen. */}
      {authed && <CallOverlay />}
    </>
  );
}
