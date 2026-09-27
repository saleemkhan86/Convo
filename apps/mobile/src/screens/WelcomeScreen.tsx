import { ScrollView, Text, View } from "react-native";
import { Button, CardBox, Heading, LogoMark, Muted, Screen, usePalette } from "../components/ui";
import { spacing } from "../theme";

export type AuthChannel = "phone" | "email";

export function WelcomeScreen({ onContinue }: { onContinue: (channel: AuthChannel) => void }) {
  const palette = usePalette();
  return (
    <Screen palette={palette}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: "center" }}>
        <View style={{ alignItems: "center", gap: spacing.md }}>
          <LogoMark size={56} />
          <Text style={{ fontSize: 30, fontWeight: "900", color: palette.text, letterSpacing: -0.5 }}>Convo</Text>
          <Heading palette={palette}>One account. Every way to talk.</Heading>
          <View style={{ maxWidth: 340 }}>
            <Muted palette={palette}>
              Instant chats with your phone number, email messaging that reaches
              Gmail, Outlook and beyond — all from a single Convo account.
            </Muted>
          </View>
        </View>

        <CardBox palette={palette}>
          <Button label="Continue with Phone Number" onPress={() => onContinue("phone")} />
          <Button label="Continue with Email" variant="secondary" onPress={() => onContinue("email")} />
          <Muted palette={palette}>
            You can connect the other identity later — both live on the same Convo account.
          </Muted>
        </CardBox>
      </ScrollView>
    </Screen>
  );
}
