/**
 * One Supabase client for the whole app.
 *
 * Sessions are stored in AsyncStorage on phones and localStorage on the web.
 * Only the public anon key lives in the app; Row Level Security and the database
 * functions decide what each signed-in person can see and do.
 */
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";
import { AppState, Platform } from "react-native";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

export const configMissing = !url || !anonKey;

export const supabase = createClient(url ?? "http://localhost", anonKey ?? "missing-key", {
  auth: {
    storage: Platform.OS === "web" ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === "web",
  },
});

// Refresh tokens only while the app is in the foreground (Supabase's recommendation for React Native)
if (Platform.OS !== "web") {
  AppState.addEventListener("change", (state) => {
    if (state === "active") supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
