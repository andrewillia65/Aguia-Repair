import { createClient } from "npm:@supabase/supabase-js@2.117.2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
export const PUBLISHABLE_KEY = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
// The Edge Runtime provides this legacy JWT as a server-only secret. Do not substitute
// the newer sb_secret_* key here: supabase-js adds a Bearer header that expects a JWT.
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = new Set([
    "https://aguiarepair.com.br",
    "https://www.aguiarepair.com.br",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
  ]);
  const headers: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400"
  };
  if (allowed.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private"
    }
  });
}

export function serviceClient() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("server_configuration_missing");
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

export function userClient(accessToken: string) {
  if (!SUPABASE_URL || !PUBLISHABLE_KEY) throw new Error("server_configuration_missing");
  return createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: "Bearer " + accessToken } }
  });
}

export function bearerToken(req: Request): string | null {
  const value = req.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : null;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeCode(value: unknown): string {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizeCpf(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || null;
}

export function isValidCpf(value: unknown): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return true;
  if (!/^[\d.\-\s]+$/.test(raw)) return false;
  const digits = raw.replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const digitAt = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(digits[index]) * (length + 1 - index);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digitAt(9) === Number(digits[9]) && digitAt(10) === Number(digits[10]);
}

export function randomAccessCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => alphabet[byte & 31]).join("");
}

export async function encryptDeviceSecret(secret: string): Promise<{ ciphertext: string; iv: string }> {
  const encodedKey = Deno.env.get("DEVICE_SECRET_ENCRYPTION_KEY") ?? "";
  if (!encodedKey) throw new Error("device_secret_encryption_not_configured");
  const keyBytes = Uint8Array.from(atob(encodedKey), character => character.charCodeAt(0));
  if (keyBytes.length !== 32) throw new Error("device_secret_encryption_key_must_be_32_bytes");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(secret));
  const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  return { ciphertext: toBase64(new Uint8Array(result)), iv: toBase64(iv) };
}

export async function decryptDeviceSecret(ciphertext: string, iv: string): Promise<string> {
  const encodedKey = Deno.env.get("DEVICE_SECRET_ENCRYPTION_KEY") ?? "";
  if (!encodedKey) throw new Error("device_secret_encryption_not_configured");
  const keyBytes = Uint8Array.from(atob(encodedKey), character => character.charCodeAt(0));
  if (keyBytes.length !== 32) throw new Error("device_secret_encryption_key_must_be_32_bytes");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const decodedIv = Uint8Array.from(atob(iv), character => character.charCodeAt(0));
  const decodedText = Uint8Array.from(atob(ciphertext), character => character.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodedIv }, key, decodedText);
  return new TextDecoder().decode(plaintext);
}
