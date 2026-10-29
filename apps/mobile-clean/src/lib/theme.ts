/**
 * Design tokens. Petrol is the only brand colour; green, amber and red appear only
 * when they carry meaning (go, caution, stop), the way safety signage does in a lab.
 */
import { useColorScheme } from "react-native";

const light = {
  paper: "#F5F6F3",
  surface: "#FFFFFF",
  sunken: "#ECEEEA",
  rule: "#D8DCD6",
  ruleStrong: "#B9BFB7",
  ink: "#1C2330",
  ink2: "#475061",
  ink3: "#6B7385",
  brand: "#0B5D6B",
  brandInk: "#FFFFFF",
  brandSoft: "#DCEDEF",
  go: "#1E8E4E",
  goSoft: "#DFF2E6",
  caution: "#B88600",
  cautionStrong: "#E0A800",
  cautionSoft: "#FBF0CF",
  stop: "#C8372D",
  stopSoft: "#F8E1DE",
  focus: "#0B5D6B",
};

const dark: typeof light = {
  paper: "#11161F",
  surface: "#171E2A",
  sunken: "#0D1219",
  rule: "#2A3343",
  ruleStrong: "#3B465A",
  ink: "#E8ECF2",
  ink2: "#B6BECC",
  ink3: "#8C95A6",
  brand: "#5FB4C2",
  brandInk: "#0D1219",
  brandSoft: "#173740",
  go: "#5CC489",
  goSoft: "#163626",
  caution: "#E8C25A",
  cautionStrong: "#E0A800",
  cautionSoft: "#3A3115",
  stop: "#F07D73",
  stopSoft: "#3D1C1A",
  focus: "#5FB4C2",
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export const fonts = {
  regular: "IBMPlexSans_400Regular",
  medium: "IBMPlexSans_500Medium",
  semibold: "IBMPlexSans_600SemiBold",
  condensed: "IBMPlexSansCondensed_600SemiBold",
  condensedBold: "IBMPlexSansCondensed_700Bold",
  condensedMedium: "IBMPlexSansCondensed_500Medium",
};

// Type scale (minor third, 16 px base)
export const size = { xs: 12, sm: 14, base: 16, md: 19, lg: 23, xl: 28, xxl: 33 };
export const space = (n: number) => n * 4;
