export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json(
      { error: "CRON_SECRET is not configured on this deployment." },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const hookUrl = process.env.BLOG_REBUILD_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    return Response.json(
      { error: "BLOG_REBUILD_DEPLOY_HOOK_URL is not configured." },
      { status: 500 },
    );
  }

  let response: Response;
  try {
    response = await fetch(hookUrl, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return Response.json(
      { error: "deploy hook request failed", detail: String(e) },
      { status: 502 },
    );
  }
  if (!response.ok) {
    return Response.json(
      { error: "deploy hook failed", status: response.status },
      { status: 502 },
    );
  }

  const payload = await response.json().catch(() => ({}));
  return Response.json({ ok: true, deployHook: payload });
}
