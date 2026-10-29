/**
 * The small set of building blocks every screen uses. Keeping them here means a
 * colour or spacing change happens once and the app stays consistent.
 */
import { Feather } from "@expo/vector-icons";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text,
  TextInput, View, useWindowDimensions, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { STATUS, toneColors, type Tone } from "@/lib/status";
import { fonts, size, space, usePalette } from "@/lib/theme";

export type IconName = keyof typeof Feather.glyphMap;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

type TxtProps = { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number; selectable?: boolean };

export function Title({ children, style }: TxtProps) {
  const p = usePalette();
  return <Text accessibilityRole="header" aria-level={1} style={[{ fontFamily: fonts.condensedBold, fontSize: size.xxl, lineHeight: 38, color: p.ink, letterSpacing: -0.3 }, style]}>{children}</Text>;
}
export function H2({ children, style }: TxtProps) {
  const p = usePalette();
  return <Text accessibilityRole="header" aria-level={2} style={[{ fontFamily: fonts.condensed, fontSize: size.lg, lineHeight: 28, color: p.ink }, style]}>{children}</Text>;
}
export function H3({ children, style, numberOfLines }: TxtProps) {
  const p = usePalette();
  return <Text numberOfLines={numberOfLines} style={[{ fontFamily: fonts.semibold, fontSize: size.base, lineHeight: 22, color: p.ink }, style]}>{children}</Text>;
}
export function Body({ children, style, numberOfLines, selectable }: TxtProps) {
  const p = usePalette();
  return <Text selectable={selectable} numberOfLines={numberOfLines} style={[{ fontFamily: fonts.regular, fontSize: size.base, lineHeight: 24, color: p.ink }, style]}>{children}</Text>;
}
export function Small({ children, style, numberOfLines }: TxtProps) {
  const p = usePalette();
  return <Text numberOfLines={numberOfLines} style={[{ fontFamily: fonts.regular, fontSize: size.sm, lineHeight: 20, color: p.ink2 }, style]}>{children}</Text>;
}
export function Label({ children, style }: TxtProps) {
  const p = usePalette();
  return <Text style={[{ fontFamily: fonts.medium, fontSize: size.sm, lineHeight: 20, color: p.ink2 }, style]}>{children}</Text>;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function useWide() {
  return useWindowDimensions().width >= 900;
}

/** Scrollable page with a readable maximum width and optional pull-to-refresh. */
export function Page({ children, onRefresh, refreshing, padded = true }: {
  children: ReactNode; onRefresh?: () => void; refreshing?: boolean; padded?: boolean;
}) {
  const p = usePalette();
  const wide = useWide();
  return (
    <SafeAreaView edges={wide ? [] : ["top"]} style={{ flex: 1, backgroundColor: p.paper }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: space(16) }}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={p.brand} /> : undefined}
      >
        <View style={{ width: "100%", maxWidth: 1100, alignSelf: "center", paddingHorizontal: padded ? (wide ? space(10) : space(4)) : 0, paddingTop: wide ? space(8) : space(4), gap: space(5) }}>
          {children}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function PageHeader({ title, intro, right, back }: { title: string; intro?: string; right?: ReactNode; back?: () => void }) {
  const p = usePalette();
  return (
    <View style={{ gap: space(2) }}>
      {back ? (
        <Pressable onPress={back} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={12}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 4 }}>
          <Feather name="chevron-left" size={18} color={p.brand} />
          <Text style={{ fontFamily: fonts.medium, color: p.brand, fontSize: size.sm }}>Back</Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", gap: space(4), flexWrap: "wrap" }}>
        <View style={{ flexShrink: 1, gap: space(1) }}>
          <Title>{title}</Title>
          {intro ? <Small style={{ maxWidth: 640 }}>{intro}</Small> : null}
        </View>
        {right}
      </View>
    </View>
  );
}

/** A plain bordered region. Used for groups of related content, not for every item. */
export function Panel({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: Tone }) {
  const p = usePalette();
  const c = tone ? toneColors(p, tone) : null;
  return (
    <View style={[{ backgroundColor: c ? c.bg : p.surface, borderWidth: 1, borderColor: c ? c.bar : p.rule, borderRadius: 6, padding: space(4), gap: space(3) }, style]}>
      {children}
    </View>
  );
}

export function Rule() {
  const p = usePalette();
  return <View style={{ height: 1, backgroundColor: p.rule }} />;
}

export function Section({ title, children, right, hint }: { title: string; children: ReactNode; right?: ReactNode; hint?: string }) {
  return (
    <View style={{ gap: space(3) }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space(3) }}>
        <View style={{ flexShrink: 1 }}>
          <H2>{title}</H2>
          {hint ? <Small>{hint}</Small> : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

export function Columns({ children, gap = 6 }: { children: ReactNode; gap?: number }) {
  const wide = useWide();
  return <View style={{ flexDirection: wide ? "row" : "column", gap: space(gap), alignItems: "flex-start" }}>{children}</View>;
}

export function Col({ children, flex = 1 }: { children: ReactNode; flex?: number }) {
  const wide = useWide();
  return <View style={{ flex: wide ? flex : undefined, width: wide ? undefined : "100%", gap: space(5), minWidth: 0 }}>{children}</View>;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

type BtnKind = "primary" | "secondary" | "danger" | "ghost";

export function Button({ label, onPress, kind = "primary", icon, disabled, loading, small, accessibilityHint, style }: {
  label: string; onPress: () => void; kind?: BtnKind; icon?: IconName; disabled?: boolean; loading?: boolean; small?: boolean;
  accessibilityHint?: string; style?: StyleProp<ViewStyle>;
}) {
  const p = usePalette();
  const colors = {
    primary: { bg: p.brand, fg: p.brandInk, border: p.brand },
    secondary: { bg: p.surface, fg: p.ink, border: p.ruleStrong },
    danger: { bg: p.surface, fg: p.stop, border: p.stop },
    ghost: { bg: "transparent", fg: p.brand, border: "transparent" },
  }[kind];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed, focused }: any) => [{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space(2),
        minHeight: small ? 36 : 44, paddingHorizontal: small ? space(3) : space(4), borderRadius: 6,
        backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
        opacity: off ? 0.5 : pressed ? 0.85 : 1,
        ...(focused ? { outlineWidth: 2, outlineColor: p.focus, outlineStyle: "solid", outlineOffset: 2 } as any : null),
      }, style]}
    >
      {loading ? <ActivityIndicator size="small" color={colors.fg} /> : icon ? <Feather name={icon} size={small ? 15 : 17} color={colors.fg} /> : null}
      <Text style={{ fontFamily: fonts.semibold, fontSize: small ? size.sm : size.base, color: colors.fg }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, hint, error, style, multiline, ...props }: TextInputProps & { label: string; hint?: string; error?: string | null }) {
  const p = usePalette();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: space(1) }}>
      <Label>{label}</Label>
      <TextInput
        {...props}
        multiline={multiline}
        accessibilityLabel={label}
        accessibilityHint={hint}
        placeholderTextColor={p.ink3}
        onFocus={(e) => { setFocused(true); props.onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); props.onBlur?.(e); }}
        style={[{
          fontFamily: fonts.regular, fontSize: size.base, color: p.ink, backgroundColor: p.surface,
          borderWidth: focused ? 2 : 1, borderColor: error ? p.stop : focused ? p.focus : p.ruleStrong, borderRadius: 6,
          paddingHorizontal: focused ? space(3) - 1 : space(3), paddingVertical: multiline ? space(3) : 0,
          minHeight: multiline ? 96 : 44, textAlignVertical: multiline ? "top" : "center",
          ...(Platform.OS === "web" ? { outlineStyle: "none" } as any : null),
        }, style]}
      />
      {error ? <Small style={{ color: p.stop }}>{error}</Small> : hint ? <Small>{hint}</Small> : null}
    </View>
  );
}

export function Chip({ label, selected, onPress, icon, disabled }: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName; disabled?: boolean }) {
  const p = usePalette();
  return (
    <Pressable onPress={disabled ? undefined : onPress} accessibilityRole="button" accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: space(3), minHeight: 36, borderRadius: 18,
        borderWidth: 1, borderColor: selected ? p.brand : p.rule, backgroundColor: selected ? p.brandSoft : p.surface, opacity: disabled ? 0.45 : 1 }}>
      {icon ? <Feather name={icon} size={14} color={selected ? p.brand : p.ink2} /> : null}
      <Text style={{ fontFamily: selected ? fonts.semibold : fonts.medium, fontSize: size.sm, color: selected ? p.brand : p.ink2 }}>{label}</Text>
    </Pressable>
  );
}

export function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  const p = usePalette();
  return (
    <Pressable onPress={() => onChange(!value)} accessibilityRole="switch" accessibilityState={{ checked: value }} accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space(3), minHeight: 44 }}>
      <View style={{ flexShrink: 1 }}>
        <Body>{label}</Body>
        {hint ? <Small>{hint}</Small> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: p.brand, false: p.ruleStrong }} thumbColor={p.surface} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** The booking state as a stamped tag: a coloured bar and a word, never colour alone. */
export function StatusTag({ status, large }: { status: string; large?: boolean }) {
  const p = usePalette();
  const s = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  const c = toneColors(p, s.tone);
  return (
    <View accessibilityLabel={`Status: ${s.label}`} style={{ flexDirection: "row", alignSelf: "flex-start", backgroundColor: c.bg, borderRadius: 2, overflow: "hidden" }}>
      <View style={{ width: 4, backgroundColor: c.bar }} />
      <Text style={{ fontFamily: fonts.condensed, fontSize: large ? size.base : size.sm, color: c.fg, paddingHorizontal: large ? 10 : 8, paddingVertical: large ? 4 : 2, letterSpacing: 0.2 }}>
        {s.label}
      </Text>
    </View>
  );
}

export function Badge({ label, tone = "neutral" }: { label: string; tone?: Tone }) {
  const p = usePalette();
  const c = toneColors(p, tone);
  return (
    <View style={{ alignSelf: "flex-start", backgroundColor: c.bg, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text style={{ fontFamily: fonts.medium, fontSize: size.xs, color: c.fg }}>{label}</Text>
    </View>
  );
}

/** One automatic check: tick or cross, the rule, and the detail. */
export function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", gap: space(3), alignItems: "flex-start" }} accessibilityLabel={`${ok ? "Passed" : "Not met"}: ${label}. ${detail ?? ""}`}>
      <View style={{ width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: ok ? p.goSoft : p.stopSoft, marginTop: 1 }}>
        <Feather name={ok ? "check" : "x"} size={14} color={ok ? p.go : p.stop} />
      </View>
      <View style={{ flex: 1 }}>
        <Body style={{ fontSize: size.sm, lineHeight: 20 }}>{label}</Body>
        {detail ? <Small style={{ color: ok ? p.ink3 : p.stop }}>{detail}</Small> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// States: loading, empty, error
// ---------------------------------------------------------------------------

export function Loading({ label = "Loading" }: { label?: string }) {
  const p = usePalette();
  return (
    <View style={{ paddingVertical: space(10), alignItems: "center", gap: space(2) }} accessibilityLabel={label}>
      <ActivityIndicator color={p.brand} />
      <Small>{label}…</Small>
    </View>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  const p = usePalette();
  return (
    <View style={{ borderWidth: 1, borderStyle: "dashed", borderColor: p.ruleStrong, borderRadius: 6, padding: space(6), gap: space(2), alignItems: "flex-start" }}>
      <H3>{title}</H3>
      {body ? <Small>{body}</Small> : null}
      {action}
    </View>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const p = usePalette();
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <View accessibilityRole="alert" style={{ flexDirection: "row", gap: space(3), padding: space(3), borderRadius: 6, backgroundColor: p.stopSoft, borderWidth: 1, borderColor: p.stop, alignItems: "center" }}>
      <Feather name="alert-triangle" size={18} color={p.stop} />
      <Body style={{ flex: 1, color: p.stop, fontSize: size.sm }}>{msg}</Body>
      {retry ? <Button small kind="ghost" label="Try again" onPress={retry} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Ledger: the signed register of who did what, when and why
// ---------------------------------------------------------------------------

export type LedgerEntry = { at: string; title: string; who?: string; role?: string | null; reason?: string | null; to?: string | null };

export function Ledger({ entries, fmt }: { entries: LedgerEntry[]; fmt: (iso: string) => string }) {
  const p = usePalette();
  if (!entries.length) return <Small>No history yet.</Small>;
  return (
    <View accessibilityRole="list">
      {entries.map((e, i) => {
        const last = i === entries.length - 1;
        const tone = e.to ? (STATUS[e.to]?.tone ?? "neutral") : "neutral";
        const c = toneColors(p, tone);
        return (
          <View key={i} style={{ flexDirection: "row", gap: space(3) }} accessibilityRole={"listitem" as any}>
            <View style={{ alignItems: "center", width: 14 }}>
              <View style={{ width: 10, height: 10, marginTop: 7, borderRadius: 1, backgroundColor: c.bar, transform: [{ rotate: "45deg" }] }} />
              {!last ? <View style={{ width: 1, flex: 1, backgroundColor: p.ruleStrong, marginTop: 4 }} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: last ? 0 : space(4), gap: 2 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: space(2), flexWrap: "wrap" }}>
                <H3 style={{ fontSize: size.sm }}>{e.title}</H3>
                <Small style={{ color: p.ink3, fontSize: size.xs }}>{fmt(e.at)}</Small>
              </View>
              <Small>{e.who ?? "System"}{e.role ? ` (${e.role})` : ""}</Small>
              {e.reason ? (
                <View style={{ borderLeftWidth: 2, borderLeftColor: p.rule, paddingLeft: space(2), marginTop: 2 }}>
                  <Small style={{ color: p.ink, fontStyle: "italic" }}>“{e.reason}”</Small>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Dialog asking for a reason before a decision is recorded
// ---------------------------------------------------------------------------

export function ReasonDialog({ visible, title, body, confirmLabel, danger, initial = "", minLength = 5, extra, onCancel, onConfirm }: {
  visible: boolean; title: string; body?: string; confirmLabel: string; danger?: boolean; initial?: string; minLength?: number;
  extra?: ReactNode; onCancel: () => void; onConfirm: (reason: string) => Promise<void> | void;
}) {
  const p = usePalette();
  const [reason, setReason] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (visible) { setReason(initial); setErr(null); } }, [visible, initial]);
  const short = reason.trim().length < minLength;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: "rgba(10,14,20,0.55)", justifyContent: "center", padding: space(4) }}>
        <View accessibilityViewIsModal style={{ backgroundColor: p.surface, borderRadius: 8, padding: space(5), gap: space(4), width: "100%", maxWidth: 520, alignSelf: "center" }}>
          <H2>{title}</H2>
          {body ? <Small>{body}</Small> : null}
          {extra}
          <Field label="Reason (shown to the other person and kept in the record)" value={reason} onChangeText={setReason} multiline maxLength={600}
            hint={short ? `At least ${minLength} characters` : `${reason.length}/600`} autoFocus />
          <ErrorNote error={err} />
          <View style={{ flexDirection: "row", gap: space(3), justifyContent: "flex-end", flexWrap: "wrap" }}>
            <Button kind="secondary" label="Cancel" onPress={onCancel} />
            <Button kind={danger ? "danger" : "primary"} label={confirmLabel} disabled={short} loading={busy}
              onPress={async () => {
                setBusy(true); setErr(null);
                try { await onConfirm(reason.trim()); } catch (e) { setErr(e); } finally { setBusy(false); }
              }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Toasts: short confirmation that an action landed
// ---------------------------------------------------------------------------

const ToastCtx = createContext<(msg: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const p = usePalette();
  const [toast, setToast] = useState<{ msg: string; tone: Tone } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((msg: string, tone: Tone = "go") => {
    setToast({ msg, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  const c = toast ? toneColors(p, toast.tone) : null;
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && c ? (
        <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, bottom: 90, alignItems: "center", paddingHorizontal: space(4) }}>
          <View accessibilityLiveRegion="polite" accessibilityRole="alert"
            style={{ flexDirection: "row", gap: space(2), alignItems: "center", backgroundColor: p.ink, paddingHorizontal: space(4), paddingVertical: space(3), borderRadius: 6, maxWidth: 520, borderLeftWidth: 4, borderLeftColor: c.bar }}>
            <Text style={{ color: p.paper, fontFamily: fonts.medium, fontSize: size.sm }}>{toast.msg}</Text>
          </View>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap" },
});
