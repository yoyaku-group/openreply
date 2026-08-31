import type { Metadata } from "next";
import LegalShell from "@/components/legal-shell";

export const metadata: Metadata = {
  title: "Data Deletion - OpenReply",
  description:
    "How OpenReply customers can disconnect Instagram and request account or campaign data deletion.",
};

export default function DataDeletionPage() {
  return (
    <LegalShell
      title="Data Deletion"
      description="Use this page for Meta App Review and customer requests about removing OpenReply account, workspace, Instagram, and campaign data."
      updatedAt="August 31, 2026"
    >
      <section>
        <h2 className="text-xl font-bold text-white">Disconnect Instagram</h2>
        <p className="mt-3">
          Sign in, open Settings, and select Disconnect. This removes the stored
          Instagram connection token and stops campaigns from sending private
          replies for that workspace.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Delete Workspace Data</h2>
        <p className="mt-3">
          Email{" "}
          <a
            className="text-accent hover:underline"
            href="mailto:ben@yoyaku.fr"
          >
            ben@yoyaku.fr
          </a>{" "}
          from the address used to sign in. Use the subject “OpenReply data
          deletion” and include the workspace name and connected Instagram
          username. State whether you want one Instagram connection removed or
          the complete workspace, campaign, delivery log, webhook, and
          operational record set deleted.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Verification</h2>
        <p className="mt-3">
          We may ask you to verify control of the email address or connected
          business account before deleting data. Deletion requests are processed
          without undue delay. We confirm receipt and the completion status by
          email. Limited records may be retained where required for legal,
          billing, fraud prevention, or security reasons, and the response will
          identify that exception.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white">Meta Platform Data</h2>
        <p className="mt-3">
          The same request process covers data received from Meta, including
          Instagram account identifiers, encrypted access tokens, redacted
          webhook events, comments processed for campaigns, and delivery logs.
          Disconnecting an Instagram account immediately prevents further use of
          its token.
        </p>
      </section>
    </LegalShell>
  );
}
