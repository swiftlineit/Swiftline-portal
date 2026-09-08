import { performance } from "node:perf_hooks";
import mongoose from "mongoose";
import { connectDatabase } from "../config/database.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { allShipmentStatuses, bookedShipmentStatuses, listBookedShipments } from "../services/shipmentListing.service.js";
import { listDpdShipments } from "../controllers/dpdShipment.controller.js";
import { runWithConcurrency } from "../utils/runWithConcurrency.js";

type BenchmarkCase = {
  name: string;
  run: () => Promise<number | void>;
};

type BenchmarkResult = {
  name: string;
  iterations: number;
  concurrency: number;
  completed: number;
  errors: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  averageMs: number | null;
  lastResult: number | null;
};

function argument(name: string, fallback: number) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer.`);
  }
  return value;
}

function percentile(values: number[], percentage: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentage) - 1);
  return Math.round(sorted[index]! * 10) / 10;
}

async function benchmark(testCase: BenchmarkCase, iterations: number, concurrency: number): Promise<BenchmarkResult> {
  // Warm the connection and model/query path before measuring user-facing work.
  await testCase.run();

  const durations: number[] = [];
  const errors: unknown[] = [];
  let lastResult: number | null = null;

  await runWithConcurrency(
    Array.from({ length: iterations }, (_, index) => index),
    concurrency,
    async () => {
      const startedAt = performance.now();
      try {
        const result = await testCase.run();
        lastResult = typeof result === "number" ? result : lastResult;
        durations.push(performance.now() - startedAt);
      } catch (error) {
        errors.push(error);
      }
    }
  );

  const rounded = durations.map((duration) => Math.round(duration * 10) / 10);
  return {
    name: testCase.name,
    iterations,
    concurrency,
    completed: durations.length,
    errors: errors.length,
    minMs: rounded.length ? Math.min(...rounded) : null,
    p50Ms: percentile(rounded, 0.5),
    p95Ms: percentile(rounded, 0.95),
    maxMs: rounded.length ? Math.max(...rounded) : null,
    averageMs: rounded.length
      ? Math.round((rounded.reduce((sum, value) => sum + value, 0) / rounded.length) * 10) / 10
      : null,
    lastResult
  };
}

function summaryRequest(limit: number) {
  return {
    query: { limit: String(limit), summary: "1" }
  } as never;
}

async function runDashboardSummary(limit: number) {
  let shipmentCount = 0;
  let statusCode = 0;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(payload: { shipments?: unknown[] }) {
      shipmentCount = payload.shipments?.length ?? 0;
      return response;
    }
  };

  await listDpdShipments(summaryRequest(limit), response as never);
  if (statusCode !== 200) throw new Error(`Dashboard summary returned HTTP ${statusCode}.`);
  return shipmentCount;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run the benchmark with NODE_ENV=production. Use the test or development database only.");
  }

  const iterations = argument("iterations", 10);
  const concurrency = argument("concurrency", 4);
  const limit = Math.min(argument("limit", 20), 100);

  // This command is observational. Do not allow a benchmark to build indexes
  // or change schema state as a side effect of connecting to the database.
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  await connectDatabase();

  try {
    const sampleDraft = await ShipmentDraft.findOne({ deletedAt: null })
      .select("businessAccountId branchId")
      .lean()
      .exec();
    const bookedCount = await DpdShipment.countDocuments({ status: { $in: allShipmentStatuses } }).exec();

    const adminList = () => listBookedShipments({
      page: 1,
      limit,
      actorRole: "admin",
      search: "",
      sort: "booked:desc",
      bookingStatuses: allShipmentStatuses
    });
    const attentionList = () => listBookedShipments({
      page: 1,
      limit,
      actorRole: "admin",
      search: "",
      sort: "booked:desc",
      bookingStatuses: allShipmentStatuses,
      attention: true
    });
    const clientList = sampleDraft?.businessAccountId
      ? () => listBookedShipments({
        page: 1,
        limit,
        actorRole: "client",
        search: "",
        sort: "booked:desc",
        bookingStatuses: bookedShipmentStatuses,
        businessAccountIds: [sampleDraft.businessAccountId]
      })
      : null;

    const cases: BenchmarkCase[] = [
      { name: "shipment-list-admin", run: async () => (await adminList()).pagination.total },
      { name: "shipment-list-attention", run: async () => (await attentionList()).pagination.total },
      { name: "dashboard-dpd-summary", run: () => runDashboardSummary(limit) }
    ];
    if (clientList) {
      cases.push({ name: "shipment-list-client-scoped", run: async () => (await clientList()).pagination.total });
    }

    const results: BenchmarkResult[] = [];
    for (const testCase of cases) {
      results.push(await benchmark(testCase, iterations, concurrency));
    }

    console.log(JSON.stringify({
      benchmark: "shipment-performance",
      mode: "read-only",
      database: mongoose.connection.name,
      host: mongoose.connection.host,
      iterations,
      concurrency,
      limit,
      bookedCount,
      sampleAccountScoped: Boolean(sampleDraft?.businessAccountId),
      results
    }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("Shipment performance benchmark failed.", error);
  process.exitCode = 1;
});
