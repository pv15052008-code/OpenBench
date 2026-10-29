/**
 * Root of the app: fonts, data cache, sign-in state and toasts wrap every screen.
 */
import {
  IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold, useFonts,
} from "@expo-google-fonts/ibm-plex-sans";
import {
  IBMPlexSansCondensed_500Medium, IBMPlexSansCondensed_600SemiBold, IBMPlexSansCondensed_700Bold,
} from "@expo-google-fonts/ibm-plex-sans-condensed";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ToastProvider } from "@/components/ui";
import { AuthProvider } from "@/lib/auth";
import { usePalette } from "@/lib/theme";

SplashScreen.preventAutoHideAsync().catch(() => {});

// Refetch when the app comes back to the foreground on phones
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (s) => focusManager.setFocused(s === "active"));
}

export default function RootLayout() {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, retry: (n, e: any) => n < 2 && !/not found|sign in|permission/i.test(e?.message ?? "") },
      mutations: { retry: false },
    },
  }));
  const [loaded, error] = useFonts({
    IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold,
    IBMPlexSansCondensed_500Medium, IBMPlexSansCondensed_600SemiBold, IBMPlexSansCondensed_700Bold,
  });
  const p = usePalette();

  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync().catch(() => {});
  }, [loaded, error]);

  if (!loaded && !error) return null;

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <ToastProvider>
            <View style={{ flex: 1, backgroundColor: p.paper }}>
              <StatusBar style="auto" />
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.paper } }} />
            </View>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
