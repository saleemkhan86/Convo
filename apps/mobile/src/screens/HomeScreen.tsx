import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Account } from "@convo/shared";
import { Button, CardBox, Heading, LogoMark, Muted, Screen, usePalette } from "../components/ui";
import { colors, radius, spacing } from "../theme";

type Section = "chats" | "mail";

export function HomeScreen({
  account,
  onOpenSettings,
  onConnect,
}: {
  account: Account;
  onOpenSettings: () => void;
  onConnect: (channel: "email" | "phone") => void;
}) {
  const palette = usePalette();
  const [section, setSection] = useState<Section>("chats");
  const available = section === "chats" ? account.capabilities.chats : account.capabilities.mail;

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
        {(["chats", "mail"] as Section[]).map((s) => (
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
              {s === "chats" ? "Chats" : "Mail"}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Body */}
      <View style={{ flex: 1, padding: spacing.lg }}>
        {available ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm }}>
            <Heading palette={palette}>{section === "chats" ? "No conversations yet" : "No mail yet"}</Heading>
            <View style={{ maxWidth: 300, alignItems: "center" }}>
              <Muted palette={palette}>
                {section === "chats"
                  ? "Real-time phone messaging arrives in Phase 2."
                  : "Chat-style email for Convo users and any external address."}
              </Muted>
            </View>
          </View>
        ) : (
          <CardBox palette={palette}>
            <Heading palette={palette}>
              {section === "chats"
                ? "Connect a phone number to start using Chats"
                : "Connect an email address to start using Mail"}
            </Heading>
            <Muted palette={palette}>
              {section === "chats"
                ? "Add your phone identity to this account to unlock instant messaging."
                : "Add your email identity to this account to send and receive email, chat-style."}
            </Muted>
            <Button
              label={section === "chats" ? "Connect Phone Number" : "Connect Email"}
              onPress={() => onConnect(section === "chats" ? "phone" : "email")}
            />
          </CardBox>
        )}
      </View>
    </Screen>
  );
}
