import { getStripe } from "./client.ts";
import { getCloudDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";

export async function createPortalSession(orgId: string, appUrl: string): Promise<string> {
  const db = getCloudDb();
  const [account] = await db
    .select({ stripeCustomerId: billingAccounts.stripeCustomerId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));

  if (!account?.stripeCustomerId) throw new Error("No Stripe customer for this org");

  const session = await getStripe().billingPortal.sessions.create({
    customer: account.stripeCustomerId,
    return_url: `${appUrl}/org-settings/billing`,
  });

  return session.url;
}
