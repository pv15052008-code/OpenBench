/**
 * Sign in, create an account, or pick a demo account. The left column tells a
 * first-time visitor (or judge) what to try, in the order the lifecycle runs.
 */
import { Feather } from "@expo/vector-icons";
import { Redirect } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Body, Button, ErrorNote, Field, H2, H3, Small, useWide } from "@/components/ui";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, useAuth } from "@/lib/auth";
import { configMissing, supabase } from "@/lib/supabase";
import { fonts, size, space, usePalette } from "@/lib/theme";

const STEPS = [
  "Sign in as Aarav. Open the Prusa 3D printer: the eligibility panel shows the missing training.",
  "Request a slot anyway: it is blocked, with the rule that failed.",
  "Go to Me and upload a training certificate photo.",
  "Sign in as Prof. Mehta. Verify the certificate under Verify.",
  "Back as Aarav, request a slot starting now. Every check is shown before you send.",
  "As Prof. Mehta, open Review. Read the brief and approve with a reason.",
  "As Aarav, check in with the checklist and a photo, then return it the same way.",
  "As Prof. Mehta, compare the before and after photos and confirm the return.",
  "Open the booking: the register shows every step, who did it and why.",
  "Fairness: in Review, two students want the same printer slot tomorrow. See who ranks first and why.",
];

export default function SignIn() {
  const { session } = useAuth();
  const p = usePalette();
  const wide = useWide();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (session) return <Redirect href="/" />;

  const signIn = async (e = email, pw = password) => {
    setBusy(e); setError(null); setNotice(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: e.trim().toLowerCase(), password: pw });
    setBusy(null);
    if (err) setError(new Error(err.message === "Invalid login credentials" ? "That email and password don't match an account." : err.message));
  };

  const signUp = async () => {
    setError(null); setNotice(null);
    if (name.trim().length < 2) return setError(new Error("Enter your full name."));
    if (password.length < 8) return setError(new Error("Use a password of at least 8 characters."));
    setBusy("signup");
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim().toLowerCase(), password, options: { data: { full_name: name.trim() } },
    });
    setBusy(null);
    if (err) return setError(new Error(err.message.includes("institution") ? "Use your college email address." : err.message));
    if (!data.session) setNotice("Check your inbox to confirm your email, then sign in. An admin verifies new accounts before they can book.");
  };

  const steps = (
    <View style={{ gap: space(4) }}>
      <H2 style={{ color: wide ? "#E8F1F2" : p.ink }}>Try the whole journey</H2>
      {STEPS.map((s, i) => (
        <View key={i} style={{ flexDirection: "row", gap: space(3) }}>
          <Text style={{ fontFamily: fonts.condensedBold, fontSize: size.md, color: wide ? "#7FC7D2" : p.brand, width: 24 }}>{i + 1}</Text>
          <Small style={{ flex: 1, color: wide ? "#C9DCDF" : p.ink2 }}>{s}</Small>
        </View>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.paper }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View style={{ flex: 1, flexDirection: wide ? "row" : "column" }}>
            {wide ? (
              <View style={{ width: "42%", maxWidth: 560, backgroundColor: "#0B3F49", padding: space(12), gap: space(8), justifyContent: "space-between" }}>
                <View style={{ gap: space(4) }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: space(3) }}>
                    <View style={{ width: 36, height: 36, borderRadius: 4, backgroundColor: "#E8F1F2", alignItems: "center", justifyContent: "center" }}>
                      <Feather name="tool" size={20} color="#0B3F49" />
                    </View>
                    <Text style={{ fontFamily: fonts.condensedBold, fontSize: size.lg, color: "#E8F1F2" }}>OpenBench</Text>
                  </View>
                  <Text style={{ fontFamily: fonts.condensedBold, fontSize: 44, lineHeight: 48, color: "#FFFFFF", letterSpacing: -0.5 }}>
                    The lab's equipment, shared with a record of every hand it passes through.
                  </Text>
                  <Body style={{ color: "#C9DCDF" }}>
                    Students find and book printers, scopes, cameras and rooms. Owners stay in control. Every approval, check-in, return and dispute is signed into the register.
                  </Body>
                </View>
                {steps}
              </View>
            ) : null}

            <View style={{ flex: 1, padding: wide ? space(12) : space(5), gap: space(6), maxWidth: 560, width: "100%", alignSelf: wide ? "flex-start" : "center" }}>
              {!wide ? (
                <View style={{ gap: space(2) }}>
                  <Text style={{ fontFamily: fonts.condensedBold, fontSize: size.xxl, color: p.ink }}>OpenBench</Text>
                  <Body style={{ color: p.ink2 }}>Share lab equipment and rooms, with a record of every hand they pass through.</Body>
                </View>
              ) : null}

              {configMissing ? (
                <ErrorNote error={new Error("This build has no Supabase URL or key. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.")} />
              ) : null}

              <View style={{ gap: space(4) }}>
                <View style={{ flexDirection: "row", gap: space(5) }} accessibilityRole="tablist">
                  {(["in", "up"] as const).map((m) => (
                    <Pressable key={m} onPress={() => { setMode(m); setError(null); setNotice(null); }} accessibilityRole="tab" accessibilityState={{ selected: mode === m }}
                      style={{ borderBottomWidth: 2, borderBottomColor: mode === m ? p.brand : "transparent", paddingBottom: 6 }}>
                      <Text style={{ fontFamily: fonts.condensed, fontSize: size.lg, color: mode === m ? p.ink : p.ink3 }}>{m === "in" ? "Sign in" : "Create account"}</Text>
                    </Pressable>
                  ))}
                </View>
                {mode === "up" ? <Field label="Full name" value={name} onChangeText={setName} autoComplete="name" textContentType="name" /> : null}
                <Field label="College email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
                <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete={mode === "in" ? "current-password" : "new-password"}
                  textContentType={mode === "in" ? "password" : "newPassword"} onSubmitEditing={() => (mode === "in" ? signIn() : signUp())} />
                <ErrorNote error={error} />
                {notice ? <Body style={{ color: p.go }}>{notice}</Body> : null}
                <Button label={mode === "in" ? "Sign in" : "Create account"} loading={busy === email || busy === "signup"}
                  disabled={!email || !password} onPress={() => (mode === "in" ? signIn() : signUp())} />
              </View>

              <View style={{ gap: space(3) }}>
                <View style={{ gap: 2 }}>
                  <H3>Demo accounts</H3>
                  <Small>All fictional. Password for each: {DEMO_PASSWORD}</Small>
                </View>
                <View style={{ borderWidth: 1, borderColor: p.rule, borderRadius: 6, backgroundColor: p.surface, overflow: "hidden" }}>
                  {DEMO_ACCOUNTS.map((a, i) => (
                    <Pressable key={a.email} onPress={() => signIn(a.email, DEMO_PASSWORD)} accessibilityRole="button" accessibilityLabel={`Sign in as ${a.name}, ${a.role}`}
                      style={({ pressed, hovered }: any) => ({ flexDirection: "row", alignItems: "center", gap: space(3), padding: space(3),
                        borderTopWidth: i ? 1 : 0, borderTopColor: p.rule, backgroundColor: pressed || hovered ? p.sunken : "transparent" })}>
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text style={{ fontFamily: fonts.semibold, fontSize: size.sm, color: p.ink }}>{a.name}, <Text style={{ fontFamily: fonts.regular, color: p.ink2 }}>{a.role}</Text></Text>
                        <Small style={{ fontSize: size.xs, lineHeight: 16 }}>{a.does}</Small>
                      </View>
                      {busy === a.email ? <Small>Signing in…</Small> : <Feather name="log-in" size={16} color={p.brand} />}
                    </Pressable>
                  ))}
                </View>
              </View>
              {!wide ? steps : null}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
