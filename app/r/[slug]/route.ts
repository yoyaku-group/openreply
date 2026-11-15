import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getRequestIp, hashClickIp } from "@/lib/tracking/server";
import { withDmContentUtm } from "@/lib/tracking/utm";

type RedirectRouteProps = {
  params: Promise<{ slug: string }>;
};

export async function GET(request: NextRequest, { params }: RedirectRouteProps) {
  const { slug } = await params;
  const trackedLink = await prisma.trackedLink.findUnique({
    where: { slug },
    select: {
      id: true,
      workspaceId: true,
      automationId: true,
      destinationUrl: true,
      automation: {
        select: {
          instagramAccountId: true,
        },
      },
    },
  });

  if (!trackedLink) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  // Plan F: the DM log id carried by ?d= attributes the click to the person who
  // was sent the link (no @mention of the clicker is ever exposed). The id is
  // only trusted when it names a DmLog of this workspace — an unknown or
  // foreign id is dropped so it can neither pollute click attribution nor leak
  // into the destination URL.
  const requestedDmLogId = request.nextUrl.searchParams.get("d") || null;
  const dmLog = requestedDmLogId
    ? await prisma.dmLog.findUnique({
        where: { id: requestedDmLogId },
        select: { id: true, workspaceId: true },
      })
    : null;
  const dmLogId =
    dmLog && dmLog.workspaceId === trackedLink.workspaceId ? dmLog.id : null;

  await prisma.linkClick.create({
    data: {
      workspaceId: trackedLink.workspaceId,
      automationId: trackedLink.automationId,
      instagramAccountId: trackedLink.automation.instagramAccountId,
      trackedLinkId: trackedLink.id,
      dmLogId,
      ipHash: hashClickIp(getRequestIp(request)),
      userAgent: request.headers.get("user-agent"),
      referrer: request.headers.get("referer"),
    },
  });

  // Tag the destination with the DM that delivered it, so a landing page or a
  // shop order can be reconciled to one DM and to the ad behind the comment.
  // Existing query parameters (including a utm_content the shop already sets)
  // are never overwritten; an unparsable destination is left untouched.
  const destinationUrl = dmLogId
    ? withDmContentUtm(trackedLink.destinationUrl, dmLogId)
    : trackedLink.destinationUrl;

  return NextResponse.redirect(destinationUrl, { status: 302 });
}
