import { NextRequest, NextResponse } from "next/server";
import { AuthError, sessionFor, SessionInfo } from "./auth";

export const COOKIE_NAME = "pw_session";

export async function getSession(req: NextRequest): Promise<SessionInfo | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  return sessionFor(token);
}

export function errorResponse(err: unknown) {
  if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err && typeof err === "object" && "status" in err && "message" in err) {
    // ApiError from the Promptwatch client
    const apiErr = err as { status: number; message: string; code?: string };
    return NextResponse.json({ error: apiErr.message, code: apiErr.code }, { status: 502 });
  }
  if (err instanceof Error) {
    const isValidation = (err as { isValidation?: boolean }).isValidation;
    return NextResponse.json({ error: err.message }, { status: isValidation ? 400 : 500 });
  }
  return NextResponse.json({ error: "Unknown error" }, { status: 500 });
}

export class ValidationError extends Error {
  isValidation = true;
}

const VALID_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface CleanSchedule {
  enabled: boolean;
  days: number[];
  startTime: string;
  endTime: string;
}

export function cleanSchedule(payload: Record<string, unknown>): CleanSchedule {
  const rawDays = Array.isArray(payload.days) ? (payload.days as unknown[]) : [];
  const days = [...new Set(rawDays.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
  const start = (payload.startTime as string) || "09:00";
  const end = (payload.endTime as string) || "17:00";
  if (!VALID_TIME.test(start) || !VALID_TIME.test(end)) {
    throw new ValidationError("Times must be in 24-hour HH:MM format.");
  }
  if (payload.enabled && !days.length) {
    throw new ValidationError("Pick at least one day.");
  }
  return { enabled: Boolean(payload.enabled), days, startTime: start, endTime: end };
}
