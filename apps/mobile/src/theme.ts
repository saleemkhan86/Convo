/** Convo design tokens for React Native — mirrors apps/web tokens (spec §26). */
export const colors = {
  iris500: "#6f55e9",
  iris600: "#5f43dd",
  iris700: "#5136c4",
  iris100: "#e2e0fd",
  signal400: "#3fd8ec",
  signal500: "#17c1dc",

  ink50: "#f6f7f9",
  ink100: "#eceef3",
  ink200: "#d6dae4",
  ink400: "#8691ab",
  ink500: "#66728f",
  ink700: "#424a60",
  ink900: "#1a1f2c",

  nightBg: "#0b0e17",
  nightSurface: "#11151f",
  nightRaised: "#171c2a",
  nightBorder: "#242b3d",

  white: "#ffffff",
  danger: "#dc2626",
  success: "#059669",
  amberBg: "#fef3c7",
  amberText: "#92400e",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  card: 16,
  field: 12,
  pill: 999,
};

export interface Palette {
  bg: string;
  surface: string;
  raised: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
}

export const lightPalette: Palette = {
  bg: colors.ink50,
  surface: colors.white,
  raised: colors.ink100,
  border: colors.ink200,
  text: colors.ink900,
  textMuted: colors.ink500,
  textFaint: colors.ink400,
};

export const darkPalette: Palette = {
  bg: colors.nightBg,
  surface: colors.nightSurface,
  raised: colors.nightRaised,
  border: colors.nightBorder,
  text: colors.white,
  textMuted: "#b1b9cb",
  textFaint: "#8691ab",
};
