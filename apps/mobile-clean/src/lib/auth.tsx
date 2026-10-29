/**
 * Who is signed in, and their profile. Every screen reads this through useAuth().
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type Role = "user" | "owner" | "manager" | "admin";
export type Profile = {
  id: string; email: string; full_name: string; role: Role;
  department_id: string | null; year_of_study: number | null; roll_number: string | null;
  verification_status: "pending" | "verified" | "rejected"; strikes: number; suspended_until: string | null;
  department?: { code: string; name: string } | null;
};

type Ctx = {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  isStaff: boolean;      // owner, manager or admin, and verified
  isManager: boolean;    // manager or admin, and verified
  isAdmin: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const loadProfile = useCallback(async (uid: string | undefined) => {
    if (!uid) { setProfile(null); return; }
    const { data } = await supabase.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (data?.department_id) {
      const { data: d } = await supabase.from("departments").select("code,name").eq("id", data.department_id).maybeSingle();
      setProfile({ ...(data as Profile), department: d });
    } else {
      setProfile((data as Profile) ?? null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      setSession(data.session);
      await loadProfile(data.session?.user.id);
      if (alive) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        qc.clear();  // never show the previous person's data to the next one
        loadProfile(s?.user.id);
      }
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, [loadProfile, qc]);

  const value = useMemo<Ctx>(() => {
    const verified = profile?.verification_status === "verified";
    return {
      session, profile, loading,
      isStaff: verified && !!profile && profile.role !== "user",
      isManager: verified && (profile?.role === "manager" || profile?.role === "admin"),
      isAdmin: verified && profile?.role === "admin",
      refreshProfile: () => loadProfile(session?.user.id),
      signOut: async () => { await supabase.auth.signOut(); qc.clear(); },
    };
  }, [session, profile, loading, loadProfile, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** Fictional accounts for judges. The same password works for all of them. */
export const DEMO_PASSWORD = "OpenBench@2026";
export const DEMO_ACCOUNTS: { email: string; name: string; role: string; does: string }[] = [
  { email: "aarav@demo.openbench.in", name: "Aarav Singh", role: "Student, ECE 3rd year", does: "Books equipment, checks in and returns" },
  { email: "prof.mehta@demo.openbench.in", name: "Prof. Vikram Mehta", role: "Owner, Fabrication Lab", does: "Lists the 3D printer and laser cutter, reviews requests" },
  { email: "hod.sharma@demo.openbench.in", name: "Prof. R. Sharma", role: "Manager, ME department", does: "Resolves disputes, approves overrides" },
  { email: "admin@demo.openbench.in", name: "Dr. Neha Iyer", role: "Admin", does: "Verifies accounts, sees the full audit log, resets the demo" },
  { email: "kabir@demo.openbench.in", name: "Kabir Nair", role: "Student, CSE 2nd year", does: "First-time printer user competing for a slot" },
  { email: "isha@demo.openbench.in", name: "Isha Verma", role: "Student, ME 2nd year", does: "Heavy printer user with one strike" },
  { email: "dr.rao@demo.openbench.in", name: "Dr. Anjali Rao", role: "Owner, Electronics Lab", does: "Owns the oscilloscope and Arduino kits" },
  { email: "ms.kapoor@demo.openbench.in", name: "Ms. Tara Kapoor", role: "Owner, Media Cell", does: "Has a camera return waiting to confirm" },
];
