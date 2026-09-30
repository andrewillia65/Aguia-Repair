import { bearerToken, corsHeaders, json, serviceClient, userClient } from "../_shared/common.ts";

Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);
  const token = bearerToken(req);
  if (!token) return json(req, { error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(req, { error: "invalid_request" }, 400);
    body = parsed as Record<string, unknown>;
  } catch { return json(req, { error: "invalid_request" }, 400); }
  const email = String(body.email ?? "").trim().toLowerCase();
  const displayName = String(body.displayName ?? "").trim().slice(0, 120);
  const role = String(body.role ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || displayName.length < 2 || !["employee", "technician"].includes(role)) {
    return json(req, { error: "invalid_fields" }, 400);
  }
  try {
    const caller = userClient(token);
    const { data: authData, error: authError } = await caller.auth.getUser(token);
    if (authError || !authData.user) return json(req, { error: "unauthorized" }, 401);
    const { data: profile } = await caller.from("staff_profiles").select("role,active")
      .eq("user_id", authData.user.id).maybeSingle();
    if (profile?.role !== "admin" || profile.active !== true) return json(req, { error: "forbidden" }, 403);

    const admin = serviceClient();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { display_name: displayName },
      redirectTo: "https://aguiarepair.com.br/funcionario.html"
    });
    if (error || !data.user) return json(req, { error: "invite_failed" }, 400);
    const { error: profileError } = await admin.from("staff_profiles").insert({
      user_id: data.user.id, display_name: displayName, role, active: true
    });
    if (profileError) {
      await admin.auth.admin.deleteUser(data.user.id);
      return json(req, { error: "profile_creation_failed" }, 400);
    }
    await admin.from("audit_logs").insert({
      actor_id: authData.user.id, action: "staff.invited", entity_type: "staff", entity_id: data.user.id
    });
    return json(req, { invited: true }, 201);
  } catch {
    return json(req, { error: "temporarily_unavailable" }, 503);
  }
});
