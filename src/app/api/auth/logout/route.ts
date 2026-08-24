import { NextRequest, NextResponse } from "next/server";
import { logout } from "@/lib/auth";
import { COOKIE_NAME } from "@/lib/http";

export async function POST(req: NextRequest) {
  await logout(req.cookies.get(COOKIE_NAME)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
