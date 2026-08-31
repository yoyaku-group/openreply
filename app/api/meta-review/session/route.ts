import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace";
import { getRedisConnection } from "@/lib/queue/client";
import {
  clearMetaReviewerIpFailures,
  isMetaReviewerRateLimited,
  newReviewerSessionToken,
  readMetaReviewerConfig,
  recordMetaReviewerFailure,
  requestHost,
  reviewerSessionExpiry,
  verifyMetaReviewerPassword,
} from "@/lib/meta-review/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function notFound() {
  return new NextResponse("Not Found", { status: 404 });
}

function failed(config: { host: string }) {
  return NextResponse.redirect(
    new URL("/meta-review/login?error=1", `https://${config.host}`),
    303,
  );
}

function requesterIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function POST(request: NextRequest) {
  const config = readMetaReviewerConfig();
  if (!config) return notFound();

  const host = requestHost(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  const origin = request.headers.get("origin");
  if (host !== config.host || origin !== `https://${config.host}`) {
    return notFound();
  }

  const ip = requesterIp(request);
  const redis = getRedisConnection();
  try {
    if (await isMetaReviewerRateLimited(redis, ip)) return failed(config);
  } catch (error) {
    console.error("Meta reviewer rate limiter unavailable", error);
    return failed(config);
  }

  const formData = await request.formData().catch(() => null);
  const password = String(formData?.get("password") ?? "");
  if (!verifyMetaReviewerPassword(password, config.passwordHash)) {
    try {
      await recordMetaReviewerFailure(redis, ip);
    } catch (error) {
      console.error("Meta reviewer failure counter unavailable", error);
    }
    return failed(config);
  }

  const reviewer = await prisma.user.findFirst({
    where: { email: { equals: config.email, mode: "insensitive" } },
    select: {
      id: true,
      workspaceMembers: {
        where: {
          workspaceId: config.workspaceId,
          role: { in: ["OWNER", "ADMIN"] },
        },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!reviewer || reviewer.workspaceMembers.length !== 1) {
    return failed(config);
  }

  const sessionToken = newReviewerSessionToken();
  const expires = reviewerSessionExpiry(config.expiresAt);
  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { userId: reviewer.id } });
    await tx.session.create({
      data: { sessionToken, userId: reviewer.id, expires },
    });
  });

  try {
    await clearMetaReviewerIpFailures(redis, ip);
  } catch (error) {
    console.error("Meta reviewer failure counter reset unavailable", error);
  }

  const response = NextResponse.redirect(
    new URL("/dashboard", `https://${config.host}`),
    303,
  );
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: true,
    path: "/",
    expires,
  };
  response.cookies.set(
    "__Secure-authjs.session-token",
    sessionToken,
    cookieOptions,
  );
  response.cookies.set(
    ACTIVE_WORKSPACE_COOKIE,
    config.workspaceId,
    cookieOptions,
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}
