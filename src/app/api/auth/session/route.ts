import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/http";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  return NextResponse.json({ user: session ? { email: session.email, role: session.role } : null });
}
