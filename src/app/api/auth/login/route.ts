import { NextRequest, NextResponse } from "next/server";
import { login, SESSION_TTL_MS } from "@/lib/auth";
import { COOKIE_NAME, errorResponse } from "@/lib/http";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const result = await login((body.email || "").trim(), body.password || "");
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 401 });

    const res = NextResponse.json({ ok: true, user: { email: result.email, role: result.role } });
    res.cookies.set(COOKIE_NAME, result.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_MS / 1000,
    });
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
