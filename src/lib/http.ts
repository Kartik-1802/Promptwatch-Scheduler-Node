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

export interface CleanBlock {
  startDay: number;
  startTime: string;
  endDay: number;
  endTime: string;
}

function cleanDay(value: unknown, label: string): number {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new ValidationError(`Invalid ${label} day.`);
  return day;
}

/** A block is a single (startDay,startTime) → (endDay,endTime) window — same
 * model as the reference time block scheduler: the end must be strictly
 * later than the start (no wrapping past the end of the week). */
export function cleanBlock(payload: Record<string, unknown>): CleanBlock {
  const startDay = cleanDay(payload.startDay, "start");
  const endDay = cleanDay(payload.endDay, "end");
  const startTime = (payload.startTime as string) || "09:00";
  const endTime = (payload.endTime as string) || "17:00";
  if (!VALID_TIME.test(startTime) || !VALID_TIME.test(endTime)) {
    throw new ValidationError("Times must be in 24-hour HH:MM format.");
  }
  if (endDay * 24 * 60 + timeToMinutes(endTime) <= startDay * 24 * 60 + timeToMinutes(startTime)) {
    throw new ValidationError("The end of the block must be later than its start.");
  }
  return { startDay, startTime, endDay, endTime };
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
