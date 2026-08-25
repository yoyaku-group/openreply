import { prisma } from "@/lib/db/client";
import { getUserMediaPage } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";

export interface PublicationMediaDTO {
  account_owner: string;
  external_id: string;
  permalink: string;
  caption: string;
  published_at: string;
  media_type: string;
}

export async function exportPublicationMediaPage(
  username: string,
  after: string | null,
  limit: number
): Promise<{ media: PublicationMediaDTO[]; next_cursor: string | null }> {
  const account = await prisma.instagramAccount.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
    select: { username: true, accessToken: true },
  });
  if (!account) throw new Error("ACCOUNT_NOT_FOUND");

  const page = await getUserMediaPage(decryptToken(account.accessToken), after, limit);
  return {
    media: page.data.flatMap((item) => {
      if (!item.id || !item.permalink || !item.timestamp) return [];
      return [{
        account_owner: account.username.toLowerCase(),
        external_id: item.id,
        permalink: item.permalink,
        caption: item.caption ?? "",
        published_at: item.timestamp,
        media_type: item.media_type,
      }];
    }),
    next_cursor: page.nextCursor,
  };
}
