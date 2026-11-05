import { createClient } from "@supabase/supabase-js";
import { buildPublicRoadmap } from "../../../src/lib/publicRoadmap.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
  let token: unknown;
  try {
    token = (await request.json()).token;
  } catch {
    return response({ error: "Invalid roadmap link" }, 400);
  }
  if (
    typeof token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
  )
    return response({ error: "Invalid roadmap link" }, 400);
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("Roadmap service is missing Supabase configuration");
    return response({ error: "Roadmap service unavailable" }, 503);
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.rpc("planner_roadmap_source", { token });
  if (error) {
    if (error.code === "P0002") return response({ error: "Roadmap link unavailable" }, 404);
    console.error("Roadmap source failed", error.code, error.message);
    return response({ error: "Unable to load roadmap" }, 500);
  }
  try {
    return response(buildPublicRoadmap(data));
  } catch (error) {
    console.error(
      "Roadmap calculation failed",
      error instanceof Error ? error.message : "Unknown error"
    );
    return response({ error: "Unable to calculate roadmap" }, 500);
  }
});
