// packages/module-ee/src/index.ts
import { config } from '@appstrate/config';
import { db } from '@appstrate/database';
import { logger } from '@appstrate/logger';

const MAX_WATERMARK_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days default threshold

export async function init() {
  const cursor = await db.eeBillingCursor.findUnique({ where: { id: 'singleton' } });
  
  if (cursor && cursor.watermark) {
    const age = Date.now() - new Date(cursor.watermark).getTime();
    if (age > MAX_WATERMARK_AGE_MS) {
      const mode = config.get('EE_STALE_WATERMARK_MODE') || 'error';
      
      if (mode === 'error') {
        throw new Error(
          `EE billing watermark is stale by ${Math.floor(age / 86400000)} days (exceeds ${MAX_WATERMARK_AGE_MS / 86400000}d threshold). ` +
          `Manual operator intervention required: set EE_STALE_WATERMARK_MODE=fast-forward to skip/forgive or reset cursor.`
        );
      } else if (mode === 'fast-forward') {
        logger.warn(`EE billing watermark is stale by ${Math.floor(age / 86400000)} days. Fast-forwarding watermark to current time.`);
        await db.eeBillingCursor.update({
          where: { id: 'singleton' },
          data: { watermark: new Date() },
        });
      }
    }
  }

  // Reconcile missing billing accounts for active orgs created during gap
  await reconcileMissingAccounts();
}

async function reconcileMissingAccounts() {
  const activeOrgs = await db.organization.findMany({
    where: {
      eeBillingAccount: { is: null },
    },
  });

  if (activeOrgs.length > 0) {
    logger.info(`Reconciling ${activeOrgs.length} missing EE billing accounts for orgs created during disabled window.`);
    for (const org of activeOrgs) {
      await db.eeBillingAccount.create({
        data: {
          orgId: org.id,
          status: 'active',
          balance: 0,
        },
      });
    }
  }
}