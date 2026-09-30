import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Account, ConversationSummary, MailThreadSummary } from "@convo/shared";
import { useCallState } from "../calls";
import { Button, CardBox, Heading, LogoMark, Muted, Screen, usePalette } from "../components/ui";
import { CallsScreen } from "./CallsScreen";
import { ChatsScreen } from "./ChatsScreen";
import { MailScreen } from "./MailScreen";
import { StatusScreen } from "./StatusScreen";
import { colors, radius, spacing } from "../theme";

type Section = "chats" | "mail" | "status" | "calls";

const LABELS: Record<Section, string> = { chats: "Chats", mail: "Mail", status: "Status", calls: "Calls" };

export function HomeScreen({
  account,
  onOpenSettings,
  onConnect,
  onOpenChat,
  onOpenThread,
  onOpenGroups,
  onOpenContacts,
  onOpenStarred,
  onOpenSearch,
  onOpenUser,
}: {
  account: Account;
  onOpenSettings: () => void;
  onConnect: (channel: "email" | "phone") => void;
  onOpenChat: (conversation: ConversationSummary) => void;
  onOpenThread: (thread: MailThreadSummary) => void;
  onOpenGroups: () => void;
  onOpenContacts: () => void;
  onOpenStarred: () => void;
  onOpenSearch: () => void;
  onOpenUser: (userId: string) => void;
}) {
  const palette = usePalette();
  const [section, setSection] = useState<Section>("chats");
  const callSupported = useCallState().supported;
  const isStatus = section === "status";
  const isCalls = section === "calls";
  const needsEmail = section === "mail";
  const available =
    isStatus || (section === "mail" ? account.capabilities.mail : account.capabilities.chats);

  return (
    <Screen palette={palette}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
        <LogoMark size={30} />
        <Pressable onPress={onOpenSettings}>
          <View style={{ backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 }}>
            <Text style={{ color: palette.text, fontWeight: "600", fontSize: 13 }}>Settings</Text>
          </View>
        </Pressable>
      </View>

      {/* Section switcher */}
      <View style={{ flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg }}>
        {(["chats", "mail", "status", "calls"] as Section[]).map((s) => (
          <Pressable
            key={s}
            onPress={() => setSection(s)}
            style={{
              flex: 1,
              paddingVertical: 12,
              borderRadius: radius.pill,
              alignItems: "center",
              backgroundColor: section === s ? colors.iris600 : palette.surface,
              borderWidth: 1,
              borderColor: section === s ? colors.iris600 : palette.border,
            }}
          >
            <Text style={{ fontWeight: "700", fontSize: 14, color: section === s ? colors.white : palette.text }}>
              {LABELS[s]}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Body */}
      {isStatus ? (
        <View style={{ flex: 1, paddingTop: spacing.md }}>
          <StatusScreen accountId={account.id} />
        </View>
      ) : isCalls && available ? (
        <View style={{ flex: 1, paddingTop: spacing.md }}>
          <CallsScreen callSupported={callSupported} />
        </View>
      ) : available && section === "chats" ? (
        <View style={{ flex: 1, paddingTop: spacing.md }}>
          <ChatsScreen
            onOpenChat={onOpenChat}
            onOpenGroups={onOpenGroups}
            onOpenContacts={onOpenContacts}
            onOpenStarred={onOpenStarred}
            onOpenSearch={onOpenSearch}
            onOpenUser={onOpenUser}
          />
        </View>
      ) : available && section === "mail" ? (
        <View style={{ flex: 1, paddingTop: spacing.md }}>
          <MailScreen account={account} onOpenThread={onOpenThread} />
        </View>
      ) : (
        <View style={{ flex: 1, padding: spacing.lg }}>
          <CardBox palette={palette}>
            <Heading palette={palette}>
              {needsEmail
                ? "Connect an email address to start using Mail"
                : "Connect a phone number to start using Chats"}
            </Heading>
            <Muted palette={palette}>
              {needsEmail
                ? "Add your email identity to this account to send and receive email, chat-style."
                : "Add your phone identity to this account to unlock instant messaging and calls."}
            </Muted>
            <Button
              label={needsEmail ? "Connect Email" : "Connect Phone Number"}
              onPress={() => onConnect(needsEmail ? "email" : "phone")}
            />
          </CardBox>
        </View>
      )}
    </Screen>
  );
}
