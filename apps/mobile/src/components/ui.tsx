import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { colors, darkPalette, lightPalette, radius, spacing, type Palette } from "../theme";

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? darkPalette : lightPalette;
}

export function Screen({ children, palette }: { children: ReactNode; palette: Palette }) {
  return <View style={{ flex: 1, backgroundColor: palette.bg, paddingTop: spacing.xl }}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = "primary",
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
  disabled?: boolean;
}) {
  const styles = {
    primary: { backgroundColor: colors.iris600, textColor: colors.white, borderColor: colors.iris600 },
    secondary: { backgroundColor: "transparent", textColor: colors.iris600, borderColor: colors.iris600 },
    danger: { backgroundColor: colors.danger, textColor: colors.white, borderColor: colors.danger },
    ghost: { backgroundColor: "transparent", textColor: colors.ink500, borderColor: "transparent" },
  }[variant];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => ({
        backgroundColor: styles.backgroundColor,
        borderColor: styles.borderColor,
        borderWidth: variant === "secondary" ? 1.5 : 0,
        borderRadius: radius.pill,
        paddingVertical: 14,
        paddingHorizontal: spacing.lg,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: spacing.sm,
        opacity: disabled || pressed ? 0.6 : 1,
      })}
    >
      {loading && <ActivityIndicator size="small" color={styles.textColor} />}
      <Text style={{ color: styles.textColor, fontSize: 15, fontWeight: "700" }}>{label}</Text>
    </Pressable>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  error,
  autoFocus,
  palette,
}: {
  label?: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "email-address" | "phone-pad" | "number-pad";
  error?: string | null;
  autoFocus?: boolean;
  palette: Palette;
}) {
  return (
    <View style={{ gap: 6 }}>
      {label && (
        <Text style={{ fontSize: 13, fontWeight: "600", color: palette.textMuted }}>{label}</Text>
      )}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.textFaint}
        keyboardType={keyboardType ?? "default"}
        autoFocus={autoFocus}
        autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
        autoComplete={keyboardType === "email-address" ? "email" : undefined}
        style={{
          backgroundColor: palette.surface,
          borderColor: error ? colors.danger : palette.border,
          borderWidth: 1,
          borderRadius: radius.field,
          paddingHorizontal: spacing.md,
          paddingVertical: 13,
          fontSize: 15,
          color: palette.text,
        }}
      />
      {error && <Text style={{ fontSize: 13, color: colors.danger }}>{error}</Text>}
    </View>
  );
}

export function CardBox({ children, palette }: { children: ReactNode; palette: Palette }) {
  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: radius.card,
        padding: spacing.lg,
        gap: spacing.md,
      }}
    >
      {children}
    </View>
  );
}

export function Heading({ children, palette }: { children: ReactNode; palette: Palette }) {
  return <Text style={{ fontSize: 24, fontWeight: "800", color: palette.text }}>{children}</Text>;
}

export function Muted({ children, palette }: { children: ReactNode; palette: Palette }) {
  return <Text style={{ fontSize: 14, lineHeight: 21, color: palette.textMuted }}>{children}</Text>;
}

export function LogoMark({ size = 36 }: { size?: number }) {  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: colors.iris600,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: colors.white, fontSize: size * 0.5, fontWeight: "900" }}>C</Text>
    </View>
  );
}

export function Avatar({
  initial,
  online,
  size = 44,
}: {
  initial: string;
  online?: boolean;
  size?: number;
}) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: colors.iris600,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.white, fontSize: size * 0.4, fontWeight: "800" }}>{initial}</Text>
      </View>
      {online && (
        <View
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: size * 0.3,
            height: size * 0.3,
            borderRadius: size * 0.15,
            backgroundColor: colors.success,
            borderWidth: 2,
            borderColor: colors.white,
          }}
        />
      )}
    </View>
  );
}
