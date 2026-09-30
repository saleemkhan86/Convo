import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import type { AuthResult, Challenge, SessionAuthResult } from "@convo/shared";
import { api, ApiRequestError } from "../api";
import { Button, CardBox, Heading, Muted, Screen, TextField, usePalette } from "../components/ui";
import { colors, spacing } from "../theme";
import type { AuthChannel } from "./WelcomeScreen";

export function AuthScreen({
  channel,
  onBack,
  onSignedIn,
}: {
  channel: AuthChannel;
  onBack: () => void;
  onSignedIn: (result: SessionAuthResult) => void;
}) {
  const isEmail = channel === "email";
  const palette = usePalette();
  const [step, setStep] = useState<"target" | "otp" | "pin">("target");
  const [target, setTarget] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [twoFactorToken, setTwoFactorToken] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validate = (v: string): string | null =>
    isEmail
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
        ? null
        : "Enter a valid email address"
      : /^\+[1-9]\d{6,14}$/.test(v.trim())
        ? null
        : "Enter your number in E.164 format, e.g. +919876543210";

  const requestOtp = async () => {
    const invalid = validate(target);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = isEmail
        ? await api.requestEmailOtp(target.trim())
        : await api.requestPhoneOtp(target.trim());
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
      const result: AuthResult = isEmail
        ? await api.verifyEmailOtp(challenge.challengeId, code)
        : await api.verifyPhoneOtp(challenge.challengeId, code);
      if ("session" in result) {
        onSignedIn(result);
        return;
      }
      setTwoFactorToken(result.twoFactorToken);
      setStep("pin");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const verifyPin = async () => {
    if (!twoFactorToken || pin.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.verifyTwoFactor(twoFactorToken, pin));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen palette={palette}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: "center" }}>
          <View style={{ gap: spacing.sm }}>
            <Button label="← Back" variant="ghost" onPress={onBack} />
            <Heading palette={palette}>
              {step === "target"
                ? isEmail
                  ? "Continue with your email"
                  : "Continue with your phone number"
                : step === "otp"
                  ? "Enter your code"
                  : "Enter your PIN"}
            </Heading>
            <Muted palette={palette}>
              {step === "target"
                ? isEmail
                  ? "Your email identity powers Mail on Convo."
                  : "Your phone identity powers Chats on Convo."
                : step === "otp"
                  ? `We sent a 6-digit code to ${target}`
                  : "Two-step verification is on for this account."}
            </Muted>
          </View>

          <CardBox palette={palette}>
            {step === "target" ? (
              <>
                <TextField
                  label={isEmail ? "Email" : "Phone Number"}
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
            ) : step === "otp" ? (
              <>
                {challenge?.devOtp && (
                  <View style={{ backgroundColor: colors.amberBg, borderRadius: 12, padding: 12 }}>
                    <Text style={{ color: colors.amberText, fontSize: 13 }}>
                      Dev mode — your code is <Text style={{ fontWeight: "800" }}>{challenge.devOtp}</Text>
                    </Text>
                  </View>
                )}
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
                <Button label="Verify and continue" onPress={() => void verifyOtp()} loading={busy} disabled={code.length !== 6} />
                <Button label={isEmail ? "Use a different email" : "Use a different number"} variant="ghost" onPress={() => { setStep("target"); setError(null); setCode(""); }} />
              </>
            ) : (
              <>
                <TextField
                  label="Security PIN"
                  value={pin}
                  onChangeText={(v) => setPin(v.replace(/\D/g, "").slice(0, 6))}
                  placeholder="000000"
                  keyboardType="number-pad"
                  secureTextEntry
                  error={error}
                  autoFocus
                  palette={palette}
                />
                <Button label="Unlock" onPress={() => void verifyPin()} loading={busy} disabled={pin.length !== 6} />
                <Button
                  label="Back to the code"
                  variant="ghost"
                  onPress={() => {
                    setStep("otp");
                    setPin("");
                    setError(null);
                  }}
                />
              </>
            )}
          </CardBox>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
