/**
 * Calls into the database functions (RPCs) and the engine API, with errors turned
 * into plain sentences the screens can show as they are.
 */
import { supabase } from "./supabase";

export class AppError extends Error {}

function clean(message: string | undefined): string {
  if (!message) return "Something went wrong. Try again.";
  // Database messages are written for people; strip technical prefixes if any slipped in
  return message.replace(/^(ERROR|error):\s*/, "").replace(/\s*\(SQLSTATE \w+\)$/, "");
}

export async function rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (error.code === "PGRST301" || error.message?.includes("JWT")) throw new AppError("Your session expired. Sign in again.");
    if (error.message?.toLowerCase().includes("failed to fetch")) throw new AppError("No connection. Check your internet and try again.");
    throw new AppError(clean(error.message));
  }
  return data as T;
}

const API_URL = process.env.EXPO_PUBLIC_API_URL?.replace(/\/$/, "");
export const engineConfigured = !!API_URL;

export async function engine<T = any>(path: string, body?: unknown): Promise<T> {
  if (!API_URL) throw new AppError("The AI service is not configured for this deployment.");
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AppError("Sign in first.");
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AppError("The AI service is waking up or unreachable. Try again in 30 seconds.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new AppError(clean(json.detail) || `Request failed (${res.status})`);
  return json as T;
}
