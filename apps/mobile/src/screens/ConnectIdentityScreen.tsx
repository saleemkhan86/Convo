import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { Account, Challenge } from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { Button, CardBox, Heading, Muted, Screen, TextField, usePalette } from "../components/ui";
import { colors, spacing } from "../theme";

/**
 * Flow E on mobile — connects a second identity to the CURRENT account.
 * Never creates a second account (spec §4–5, §8).
 */
export function ConnectIdentityScreen({
  channel,
  account,
  onBack,
  onConnected,
}: {
  channel: "email" | "phone";
  account: Account;
  onBack: () => void;
  onConnected: (a: Account) => void;
}) {
  const isEmail = channel === "email";
  const palette = usePalette();
  const [step, setStep] = useState<"target" | "otp">("target");
  const [target, setTarget] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyConnected = isEmail ? account.email : account.phone;

  const requestOtp = async () => {
    const value = target.trim();
    const invalid = isEmail
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? null
        : "Enter a valid email address"
      : /^\+[1-9]\d{6,14}$/.test(value)
        ? null
        : "Enter your number in E.164 format, e.g. +919876543210";
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = isEmail ? await api.connectEmailRequest(value) : await api.connectPhoneRequest(value);
      setChallenge(c);
      setStep("otp");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async () => {
    if (!challenge || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const updated = isEmail
        ? await api.connectEmailVerify(challenge.challengeId, code)
        : await api.connectPhoneVerify(challenge.challengeId, code);
      onConnected(updated);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen palette={palette}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: "center" }}>
        <View style={{ gap: spacing.sm }}>
          <Button label="← Back" variant="ghost" onPress={onBack} />
          <Heading palette={palette}>
            {isEmail ? "Connect Email" : "Connect Phone Number"}
          </Heading>
          <Muted palette={palette}>
            {isEmail
              ? "Add an email identity to your existing Convo account to unlock Mail. We'll verify you own it first — no second account is created."
              : "Add a phone identity to your existing Convo account to unlock Chats. We'll verify you own it first — no second account is created."}
          </Muted>
        </View>

        <CardBox palette={palette}>
          {alreadyConnected ? (
            <>
              <Text style={{ fontSize: 15, fontWeight: "700", color: palette.text }}>
                {isEmail ? "Email already connected" : "Phone number already connected"}
              </Text>
              <Muted palette={palette}>
                {isEmail ? account.email?.email : account.phone?.phone} is linked to this account.
              </Muted>
              <Button label="Back" variant="secondary" onPress={onBack} />
            </>
          ) : step === "target" ? (
            <>
              <TextField
                label={isEmail ? "Email address" : "Phone number"}
                value={target}
                onChangeText={setTarget}
                placeholder={isEmail ? "you@example.com" : "+919876543210"}
                keyboardType={isEmail ? "email-address" : "phone-pad"}
                error={error}
                autoFocus
                palette={palette}
              />
              <Button label="Send verification code" onPress={() => void requestOtp()} loading={busy} />
            </>
          ) : (
            <>
              {challenge?.devOtp && (
                <View style={{ backgroundColor: colors.amberBg, borderRadius: 12, padding: 12 }}>
                  <Text style={{ color: colors.amberText, fontSize: 13 }}>
                    Dev mode — your code is <Text style={{ fontWeight: "800" }}>{challenge.devOtp}</Text>
                  </Text>
                </View>
              )}
              <Muted palette={palette}>
                The {isEmail ? "email" : "phone"} identity links to this account only after verification.
              </Muted>
              <TextField
                label="Verification code"
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                keyboardType="number-pad"
                error={error}
                autoFocus
                palette={palette}
              />
              <Button label="Verify and connect" onPress={() => void verifyOtp()} loading={busy} disabled={code.length !== 6} />
              <Button label={isEmail ? "Use a different email" : "Use a different number"} variant="ghost" onPress={() => { setStep("target"); setError(null); setCode(""); }} />
            </>
          )}
        </CardBox>
      </ScrollView>
    </Screen>
  );
}
