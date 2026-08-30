import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getRequestBaseUrl } from "@/lib/env";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  getLongLivedToken,
  getUserInfo,
  probeInstagramLoginScopes,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import {
  encryptToken,
  exchangeCodeForToken,
  verifyOAuthState,
} from "@/lib/meta/oauth";
import { canManageWorkspace } from "@/lib/workspace-access";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");
  const state = verifyOAuthState(request.nextUrl.searchParams.get("state"));
  const baseUrl = getRequestBaseUrl(request);

  if (error) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=denied`);
  }

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=invalid`);
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId: state.workspaceId,
      userId: session.user.id,
    },
  });

  if (!membership || !canManageWorkspace(membership.role)) {
    return NextResponse.redirect(`${baseUrl}/settings?instagram=forbidden`);
  }

  try {
    const redirectUri = `${baseUrl}/api/instagram/callback`;
    const { accessToken: shortLivedToken } = await exchangeCodeForToken(
      code,
      redirectUri
    );
    const { accessToken: longLivedToken, expiresIn } =
      await getLongLivedToken(shortLivedToken);
    const userInfo = await getUserInfo(longLivedToken);
    // Webhooks and the messaging API key off the professional account ID
    // (user_id), not the app-scoped `id`. Store user_id so comment webhooks
    // can be matched back to this account. Fall back to id if user_id is
    // ever absent.
    const instagramId = userInfo.user_id ?? userInfo.id;
    const connection = await canConnectInstagramAccount({
      workspaceId: state.workspaceId,
      instagramId,
    });

    if (!connection.allowed) {
      return NextResponse.redirect(
        `${baseUrl}/settings?instagram=already_connected`
      );
    }

    const encryptedToken = encryptToken(longLivedToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        longLivedToken
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (subscriptionError) {
      console.warn(
        "[Instagram Callback] Webhook subscription failed:",
        subscriptionError
      );
    }

    // Probe scopes at connect time so the scope list is captured immediately,
    // instead of waiting for the next /api/health sweep. debug_token cannot
    // parse Instagram Login tokens, so scopes are inferred via the functional
    // probe (read-only capability smoke calls). If the probe fails, we leave
    // lastScopeProbeAt null so /api/health retries on its next sweep.
    let probeScopes: string[] = [];
    let probeAt: Date | null = null;
    try {
      probeScopes = await probeInstagramLoginScopes(longLivedToken);
      probeAt = new Date();
    } catch (probeError) {
      console.warn(
        "[Instagram Callback] scope probe failed:",
        probeError instanceof Error ? probeError.message : probeError
      );
    }

    await prisma.instagramAccount.upsert({
      where: { instagramId },
      create: {
        workspaceId: state.workspaceId,
        instagramId,
        username: userInfo.username,
        name: userInfo.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
        scopes: probeScopes,
        lastScopeProbeAt: probeAt,
      },
      update: {
        workspaceId: state.workspaceId,
        username: userInfo.username,
        name: userInfo.name,
        accessToken: encryptedToken,
        tokenExpiresAt,
        webhookSubscribed,
        scopes: probeScopes,
        lastScopeProbeAt: probeAt,
        // Re-connecting a previously archived account clears the soft-delete
        // marker so it rejoins the health sweep and the automation create-time
        // scope check.
        archivedAt: null,
      },
    });

    return NextResponse.redirect(`${baseUrl}/dashboard?connected=true`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[Instagram Callback] Error:", err);
    // The message is the only diagnostic a self-hoster gets for a failed
    // connect, so persist it alongside the other operational events rather
    // than leaving it in server logs they may not be able to reach.
    await prisma.operationalEvent
      .create({
        data: {
          source: "SYSTEM",
          level: "ERROR",
          workspaceId: state.workspaceId,
          message: "Instagram connection failed",
          payload: { reason: message },
        },
      })
      .catch(() => {});

    return NextResponse.redirect(
      `${baseUrl}/settings?instagram=failed&reason=${encodeURIComponent(
        message.slice(0, 200)
      )}`
    );
  }
}
