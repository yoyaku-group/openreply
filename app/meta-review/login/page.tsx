import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readMetaReviewerConfig, requestHost } from "@/lib/meta-review/auth";
import { META_REVIEWER_COPY } from "@/lib/meta-review/copy";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Meta reviewer access - OpenReply",
  robots: { index: false, follow: false },
};

export default async function MetaReviewerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const config = readMetaReviewerConfig();
  const headerStore = await headers();
  const host = requestHost(
    headerStore.get("x-forwarded-host") ?? headerStore.get("host"),
  );
  if (!config || host !== config.host) notFound();

  const { error } = await searchParams;
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold text-foreground">OpenReply</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {META_REVIEWER_COPY.description}
          </p>
        </div>
        <div className="panel rounded p-8">
          {error && (
            <div
              role="alert"
              className="mb-5 rounded border border-error/40 bg-error/10 p-4 text-sm text-foreground"
            >
              Sign-in failed. Check the reviewer instructions and try again.
            </div>
          )}
          <form
            method="post"
            action="/api/meta-review/session"
            className="space-y-5"
          >
            <div className="space-y-2">
              <label
                htmlFor="password"
                className="block text-sm font-medium text-foreground"
              >
                Reviewer passphrase
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="w-full rounded border border-border bg-surface px-4 py-3 text-sm text-foreground focus:border-accent/40 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              {META_REVIEWER_COPY.submitLabel}
            </button>
          </form>
          <p className="mt-5 text-xs leading-relaxed text-muted">
            {META_REVIEWER_COPY.notice}
          </p>
        </div>
      </div>
    </main>
  );
}
