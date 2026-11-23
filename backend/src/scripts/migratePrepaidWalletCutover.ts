import mongoose from "mongoose";
import { BalanceReservation } from "../models/balanceReservation.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { CreditLedgerEntry } from "../models/creditLedgerEntry.model.js";
import { PrepaidAccount } from "../models/prepaidAccount.model.js";
import { PrepaidTransaction } from "../models/prepaidTransaction.model.js";
import { Tenant } from "../models/tenant.model.js";
import { tenantMigrationEnv } from "./tenantMigrationEnv.js";
import {
  assertExpectedDatabaseName,
  assertTenantMigrationExecutionAllowed,
  isMainModule,
  type ProductionTenantMigrationAuthorization
} from "./migrationSafety.js";

type AccountPlan = {
  businessAccountId: mongoose.Types.ObjectId;
  accountId: string;
  creditAccountId: mongoose.Types.ObjectId;
  legacyAdvanceMinor: number;
  reservedAdvanceMinor: number;
  reservedCreditMinor: number;
  walletId?: mongoose.Types.ObjectId;
  walletCashMinor: number;
  walletReservedMinor: number;
  walletTransactions: number;
  liveReservations: number;
  issues: string[];
};

async function inspect(expectedDatabase: string) {
  const databaseName = mongoose.connection.db?.databaseName;
  assertExpectedDatabaseName(expectedDatabase, databaseName);

  const roots = await Tenant.collection.find({ kind: "SWIFTLINE", status: "ACTIVE" }).limit(2).toArray();
  if (roots.length !== 1) throw new Error("Expected exactly one active Swiftline tenant.");
  const tenantId = roots[0]!._id as mongoose.Types.ObjectId;
  const missingOwners = await BusinessCreditAccount.countDocuments({ $or: [{ tenantId: { $exists: false } }, { tenantId: null }] });
  const otherOwners = await BusinessCreditAccount.countDocuments({
    $and: [
      { tenantId: { $exists: true, $ne: null } },
      { tenantId: { $ne: tenantId } }
    ]
  });
  if (missingOwners || otherOwners) {
    throw new Error(`Credit ownership preflight is incomplete (${missingOwners} missing owner(s), ${otherOwners} conflicting owner(s)). Run and review the account-credit tenant migration first.`);
  }

  const creditAccounts = await BusinessCreditAccount.find({ tenantId }).select(
    "businessAccountId customerAdvanceBalanceMinor reservedAdvanceMinor reservedCreditMinor status"
  ).sort({ businessAccountId: 1 }).lean().exec();
  const [businessAccountCount, accountsWithCreditFacilityEnabled] = await Promise.all([
    BusinessAccount.countDocuments({ tenantId }),
    BusinessAccount.countDocuments({ tenantId, creditLimitStatus: { $ne: "not_approved" } })
  ]);
  const plans: AccountPlan[] = [];
  for (const credit of creditAccounts) {
    const [businessAccount, wallet, walletTransactions, liveReservations] = await Promise.all([
      BusinessAccount.findOne({ _id: credit.businessAccountId, tenantId }).select("accountId").lean().exec(),
      PrepaidAccount.findOne({ businessAccountId: credit.businessAccountId, tenantId })
        .select("_id cashBalanceMinor reservedBalanceMinor").lean().exec(),
      PrepaidTransaction.countDocuments({ businessAccountId: credit.businessAccountId, tenantId }),
      BalanceReservation.countDocuments({
        businessAccountId: credit.businessAccountId,
        tenantId,
        status: { $in: ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"] }
      })
    ]);
    const issues: string[] = [];
    if (!businessAccount) issues.push("Business account is missing or belongs to a different tenant.");
    if (credit.reservedAdvanceMinor > 0 || credit.reservedCreditMinor > 0) {
      issues.push("Historical reserved balance is non-zero and requires booking reconciliation.");
    }
    if (liveReservations > 0) issues.push(`${liveReservations} active, consuming, or review-required booking reservation(s) remain.`);
    if (credit.customerAdvanceBalanceMinor > 0 && wallet && (wallet.cashBalanceMinor > 0 || wallet.reservedBalanceMinor > 0 || walletTransactions > 0)) {
      issues.push("A legacy advance and an existing wallet ledger/balance both exist; the balances need manual reconciliation.");
    }
    if (wallet && wallet.reservedBalanceMinor !== 0 && credit.customerAdvanceBalanceMinor > 0) {
      issues.push("The existing wallet has reserved funds while a legacy advance remains.");
    }
    if (wallet && wallet.cashBalanceMinor !== 0 && walletTransactions === 0) {
      issues.push("The wallet has a non-zero balance without ledger history.");
    }
    if (!wallet && walletTransactions > 0) {
      issues.push("Wallet transactions exist but the wallet account is missing.");
    }

    plans.push({
      businessAccountId: credit.businessAccountId,
      accountId: businessAccount?.accountId ?? "UNKNOWN",
      creditAccountId: credit._id as mongoose.Types.ObjectId,
      legacyAdvanceMinor: credit.customerAdvanceBalanceMinor,
      reservedAdvanceMinor: credit.reservedAdvanceMinor,
      reservedCreditMinor: credit.reservedCreditMinor,
      walletId: wallet?._id,
      walletCashMinor: wallet?.cashBalanceMinor ?? 0,
      walletReservedMinor: wallet?.reservedBalanceMinor ?? 0,
      walletTransactions,
      liveReservations,
      issues
    });
  }

  const proposedTransferMinor = plans.reduce((sum, plan) => sum + (plan.issues.length ? 0 : plan.legacyAdvanceMinor), 0);
  const accountsWithLegacyAdvance = plans.filter((plan) => plan.legacyAdvanceMinor > 0).length;
  const accountsRequiringReview = plans.filter((plan) => plan.issues.length > 0).length;
  return {
    databaseName,
    tenantId,
    plans,
    report: {
      mode: "READ_ONLY_PREFLIGHT",
      generatedAt: new Date().toISOString(),
      summary: {
        businessAccounts: businessAccountCount,
        accountsWithCreditFacilityEnabled,
        businessCreditAccounts: plans.length,
        accountsWithLegacyAdvance,
        proposedTransferMinor,
        accountsToClose: plans.filter((plan) => plan.issues.length === 0).length,
        accountsRequiringReview
      },
      accounts: plans.filter((plan) => plan.issues.length > 0 || plan.legacyAdvanceMinor > 0).map((plan) => ({
        accountId: plan.accountId,
        businessAccountId: String(plan.businessAccountId),
        legacyAdvanceMinor: plan.legacyAdvanceMinor,
        walletCashMinor: plan.walletCashMinor,
        walletReservedMinor: plan.walletReservedMinor,
        walletTransactions: plan.walletTransactions,
        liveReservations: plan.liveReservations,
        issues: plan.issues
      }))
    }
  };
}

async function applyPlan(input: {
  tenantId: mongoose.Types.ObjectId;
  plan: AccountPlan;
}) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const credit = await BusinessCreditAccount.findOne({
        _id: input.plan.creditAccountId,
        businessAccountId: input.plan.businessAccountId,
        tenantId: input.tenantId
      }).session(session).exec();
      if (!credit) throw new Error(`Credit account disappeared for ${input.plan.accountId}.`);
      if (credit.reservedAdvanceMinor > 0 || credit.reservedCreditMinor > 0) {
        throw new Error(`Reserved balances changed after preflight for ${input.plan.accountId}.`);
      }
      const activeReservations = await BalanceReservation.countDocuments({
        businessAccountId: input.plan.businessAccountId,
        tenantId: input.tenantId,
        status: { $in: ["ACTIVE", "CONSUMING", "REVIEW_REQUIRED"] }
      }).session(session);
      if (activeReservations) throw new Error(`Live reservations changed after preflight for ${input.plan.accountId}.`);

      const amountMinor = credit.customerAdvanceBalanceMinor;
      if (amountMinor > 0) {
        const idempotencyKey = `PREPAID_WALLET_CUTOVER:${String(input.plan.businessAccountId)}`;
        const priorTransfer = await PrepaidTransaction.exists({ tenantId: input.tenantId, idempotencyKey }).session(session);
        if (priorTransfer) throw new Error(`A cutover ledger entry already exists while a legacy balance remains for ${input.plan.accountId}.`);

        let wallet = await PrepaidAccount.findOne({
          tenantId: input.tenantId,
          businessAccountId: input.plan.businessAccountId
        }).session(session).exec();
        if (!wallet) {
          const createdWallets = await PrepaidAccount.create([{
            tenantId: input.tenantId,
            businessAccountId: input.plan.businessAccountId,
            cashBalanceMinor: 0,
            reservedBalanceMinor: 0,
            fundingCycleSequence: 0,
            fundingCycleBaselineMinor: 0
          }], { session });
          wallet = createdWallets[0] ?? null;
        }
        if (!wallet || wallet.cashBalanceMinor !== 0 || wallet.reservedBalanceMinor !== 0) {
          throw new Error(`Wallet balance changed after preflight for ${input.plan.accountId}.`);
        }
        const walletBefore = { cashBalanceMinor: wallet.cashBalanceMinor, reservedBalanceMinor: wallet.reservedBalanceMinor };
        wallet.cashBalanceMinor = amountMinor;
        wallet.reservedBalanceMinor = 0;
        wallet.fundingCycleSequence = Math.max(wallet.fundingCycleSequence, 1);
        wallet.fundingCycleBaselineMinor = amountMinor;
        wallet.fundingCycleStartedAt = new Date();
        wallet.lowBalanceAlertedCycle = null;
        wallet.version += 1;
        await wallet.save({ session });

        await PrepaidTransaction.create([{
          tenantId: input.tenantId,
          businessAccountId: input.plan.businessAccountId,
          transactionType: "OPENING_BALANCE_TRANSFER",
          direction: "CREDIT",
          amountMinor,
          currency: "INR",
          referenceType: "ADMIN_ADJUSTMENT",
          referenceId: input.plan.creditAccountId,
          idempotencyKey,
          paymentSource: "CLIENT_PREPAID",
          cashBalanceBeforeMinor: walletBefore.cashBalanceMinor,
          cashBalanceAfterMinor: wallet.cashBalanceMinor,
          reservedBalanceBeforeMinor: walletBefore.reservedBalanceMinor,
          reservedBalanceAfterMinor: wallet.reservedBalanceMinor,
          description: "Legacy Swiftline customer advance transferred to the prepaid wallet during the reviewed credit cutover.",
          createdBy: null
        }], { session });

        await CreditLedgerEntry.create([{
          tenantId: input.tenantId,
          businessAccountId: input.plan.businessAccountId,
          creditAccountId: input.plan.creditAccountId,
          type: "PREPAID_WALLET_TRANSFERRED",
          reference: `PREPAID-WALLET-CUTOVER:${String(input.plan.businessAccountId)}`,
          description: "Customer Advance transferred to the prepaid wallet; this historical credit balance is now zero.",
          amountMinor,
          currency: "INR",
          availableCreditAfterMinor: 0,
          availableAdvanceAfterMinor: 0,
          idempotencyKey: `PREPAID_WALLET_TRANSFER:${String(input.plan.businessAccountId)}`,
          createdBy: null,
          metadata: { prepaidAccountId: String(wallet._id), migration: "prepaid-wallet-cutover" }
        }], { session });

        const cleared = await BusinessCreditAccount.updateOne({
          _id: credit._id,
          tenantId: input.tenantId,
          customerAdvanceBalanceMinor: amountMinor,
          reservedAdvanceMinor: 0,
          reservedCreditMinor: 0
        }, {
          $set: { customerAdvanceBalanceMinor: 0, status: "CLOSED" },
          $inc: { version: 1 }
        }, { session, runValidators: true }).exec();
        if (cleared.modifiedCount !== 1) throw new Error(`Legacy advance changed during transfer for ${input.plan.accountId}.`);
      } else if (credit.status !== "CLOSED") {
        const closed = await BusinessCreditAccount.updateOne({
          _id: credit._id,
          tenantId: input.tenantId,
          reservedAdvanceMinor: 0,
          reservedCreditMinor: 0
        }, { $set: { status: "CLOSED" }, $inc: { version: 1 } }, { session, runValidators: true }).exec();
        if (closed.modifiedCount !== 1) throw new Error(`Credit status changed after preflight for ${input.plan.accountId}.`);
      }

      await BusinessAccount.updateOne(
        { _id: input.plan.businessAccountId, tenantId: input.tenantId },
        { $set: { creditLimitStatus: "not_approved" } },
        { session }
      ).exec();
    });
  } finally {
    await session.endSession();
  }
}

async function run(
  args = process.argv.slice(2),
  authorization?: ProductionTenantMigrationAuthorization,
  mongoUri = tenantMigrationEnv.applicationMongoUri
) {
  let apply = false;
  let expectedDatabase = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") apply = true;
    else if (args[index] === "--database") expectedDatabase = args[++index] ?? "";
    else throw new Error(`Unknown prepaid cutover option: ${args[index]}`);
  }
  if (!expectedDatabase.trim()) throw new Error("Pass --database <expected-database-name>.");
  assertTenantMigrationExecutionAllowed({
    nodeEnvironment: tenantMigrationEnv.nodeEnvironment,
    step: "prepaid-wallet-cutover",
    expectedDatabase,
    mongoUri,
    authorization
  });

  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await mongoose.connect(mongoUri, {
    family: 4,
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 15_000
  });
  try {
    const preflight = await inspect(expectedDatabase);
    const blockers = preflight.plans.filter((plan) => plan.issues.length > 0);
    console.log(JSON.stringify(preflight.report, null, 2));
    if (blockers.length) throw new Error("Prepaid wallet cutover is blocked until every listed reservation or balance conflict is reconciled.");
    if (!apply) return;

    for (const plan of preflight.plans) {
      await applyPlan({ tenantId: preflight.tenantId, plan });
    }
    await BusinessAccount.updateMany(
      { tenantId: preflight.tenantId, creditLimitStatus: { $ne: "not_approved" } },
      { $set: { creditLimitStatus: "not_approved" } }
    ).exec();
    const postflight = await inspect(expectedDatabase);
    const remainingAdvance = postflight.plans.filter((plan) => plan.legacyAdvanceMinor > 0 || plan.issues.length > 0);
    const openCredit = await BusinessCreditAccount.countDocuments({ tenantId: preflight.tenantId, status: { $ne: "CLOSED" } });
    if (remainingAdvance.length || openCredit || postflight.report.summary.accountsWithCreditFacilityEnabled > 0) {
      throw new Error("Post-migration verification failed. Keep the release blocked and inspect the named account IDs in the preflight output.");
    }
    console.log(JSON.stringify({
      mode: "APPLIED_AND_VERIFIED",
      tenantId: String(preflight.tenantId),
      accountsWithCreditFacilityDisabled: preflight.report.summary.accountsWithCreditFacilityEnabled,
      accountsClosed: postflight.plans.length,
      transferredMinor: preflight.report.summary.proposedTransferMinor
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

export function runAuthorizedProductionMigration(
  authorization: ProductionTenantMigrationAuthorization,
  apply: boolean
) {
  const mongoUri = tenantMigrationEnv.migrationMongoUri;
  if (!mongoUri) throw new Error("TENANT_MIGRATION_MONGODB_URI is required for production migrations.");
  return run(["--database", "swiftline", ...(apply ? ["--apply"] : [])], authorization, mongoUri);
}

if (isMainModule(import.meta.url)) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Prepaid wallet cutover failed.");
    process.exitCode = 1;
  });
}
