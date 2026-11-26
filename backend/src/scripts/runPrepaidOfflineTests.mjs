import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { MongoClient } from 'mongodb';

// Starts its own local replica set. Never reads application .env credentials.
const backendRoot = path.resolve(import.meta.dirname, '../..');
async function mongoBinary() {
  if (process.env.PREPAID_TEST_MONGOD_PATH) return path.resolve(process.env.PREPAID_TEST_MONGOD_PATH);
  if (process.platform !== 'win32') return 'mongod';
  const installRoot = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'MongoDB', 'Server');
  const versions = await readdir(installRoot);
  for (const version of versions.sort().reverse()) {
    const candidate = path.join(installRoot, version, 'bin', 'mongod.exe');
    try { await access(candidate); return candidate; } catch { /* Check next installed version. */ }
  }
  throw new Error('Install MongoDB Server or set PREPAID_TEST_MONGOD_PATH to its local mongod binary.');
}

const reservation = net.createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'swiftline-prepaid-offline-'));
await mkdir(path.join(temporaryDirectory, 'db'));
let mongo;
let exitCode = 1;
try {
  mongo = spawn(await mongoBinary(), [
    '--dbpath', path.join(temporaryDirectory, 'db'), '--bind_ip', '127.0.0.1',
    '--port', String(port), '--replSet', 'swiftline-prepaid-test',
    '--wiredTigerCacheSizeGB', '0.25', '--logpath', path.join(temporaryDirectory, 'mongod.log')
  ], { windowsHide: true, stdio: 'ignore' });
  let spawnError;
  mongo.once('error', (error) => { spawnError = error; });
  const bootstrap = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 1500 });
  let connected = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (spawnError) throw spawnError;
    try { await bootstrap.connect(); connected = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!connected) throw new Error('The isolated MongoDB server did not start.');
  await bootstrap.db('admin').command({ replSetInitiate: { _id: 'swiftline-prepaid-test', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
  await bootstrap.close();
  const uri = `mongodb://127.0.0.1:${port}/sl_prepaid_offline?replicaSet=swiftline-prepaid-test`;
  const paymentOnly = process.argv.includes('--payment-only');
  const operatorBookingOnly = process.argv.includes('--operator-booking-only');
  if (paymentOnly && operatorBookingOnly) throw new Error('Choose one offline test mode.');
  console.log('Running tests against a temporary local replica set. External service access is blocked.');
  const testFiles = paymentOnly
    ? [
        'src/tests/prepaidWorkflow.offline.integration.test.ts',
        'src/tests/shipmentDirectPayment.controller.test.ts',
        'src/tests/dpdBookingAvailability.test.ts',
        'src/tests/shipmentDirectPaymentState.test.ts'
      ]
    : operatorBookingOnly
      ? ['src/tests/operatorShipmentBooking.integration.test.ts']
      : [
        'src/tests/prepaidWorkflow.offline.integration.test.ts',
        'src/tests/shipmentCancellation.integration.test.ts',
        'src/tests/prepaidReleaseMigration.test.ts',
        'src/tests/cashReceiptActiveIndexMigration.test.ts',
        'src/tests/shipmentPricing.volumetricDiscount.test.ts',
        'src/tests/shipmentLabels.test.ts',
        'src/tests/shipmentCancellationRefundPlan.test.ts',
        'src/tests/shipmentDirectPaymentState.test.ts',
        'src/tests/amendmentBilling.test.ts',
        'src/tests/shipmentCancellation.test.ts',
        'src/tests/publicShipmentBooking.test.ts',
        'src/tests/shipmentBookingEvent.test.ts',
        'src/tests/migrationSafety.test.ts',
        'src/tests/clientDocumentCentre.test.ts'
      ];
  const paymentOnlyPattern = [
    'direct payment order is verified and captured without booking a shipment',
    'captured unallocated direct payment can be refunded without creating a shipment',
    'direct payment creation rejects DPD-required shipments before opening checkout',
    'explicit no-DPD choice passes the ALS preflight without creating an order',
    'payment verification does not capture an authorized payment if ALS becomes unavailable',
    'requires the operational switch, ALS switch, and valid ALS configuration',
    'keeps the existing enabled-by-default behavior when all prerequisites are ready',
    'reopens the same order while clearing only its failed payment attempt',
    'ignores a failure event without payment and order identifiers'
  ].join('|');
  const tests = spawn(process.execPath, [
    '--import', './src/tests/helpers/prepaidOfflineEnvironment.mjs', '--import', 'tsx',
    '--test', '--test-concurrency=1',
    ...(paymentOnly ? [`--test-name-pattern=${paymentOnlyPattern}`] : []),
    ...testFiles
  ], {
    cwd: backendRoot, windowsHide: true, stdio: 'inherit',
    env: { ...process.env, PREPAID_OFFLINE_MONGODB_URI: uri }
  });
  exitCode = await new Promise((resolve, reject) => { tests.once('error', reject); tests.once('exit', (code) => resolve(code ?? 1)); });
} finally {
  if (mongo?.pid && mongo.exitCode === null) {
    const stopped = new Promise((resolve) => mongo.once('exit', resolve));
    mongo.kill();
    await stopped;
  }
  // This directory is created by mkdtemp in this invocation only.
  const expectedParent = path.resolve(tmpdir());
  if (path.dirname(temporaryDirectory) !== expectedParent || !path.basename(temporaryDirectory).startsWith('swiftline-prepaid-offline-')) {
    throw new Error('Refusing cleanup outside the generated prepaid test directory.');
  }
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exitCode = exitCode;
