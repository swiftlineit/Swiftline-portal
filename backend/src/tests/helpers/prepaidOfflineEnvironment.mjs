// Loaded before application imports. No .env file or external service is used.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const localUri = process.env.PREPAID_OFFLINE_MONGODB_URI ?? 'mongodb://127.0.0.1:27191/sl_prepaid_offline?replicaSet=swiftline-prepaid-test';
const localTarget = new URL(localUri);
if (localTarget.protocol !== 'mongodb:' || localTarget.hostname !== '127.0.0.1' || !localTarget.port || localTarget.username || localTarget.password) {
  throw new Error('Prepaid offline tests require a credential-free local MongoDB URI.');
}
process.env.DOTENV_CONFIG_PATH = '__prepaid_offline_no_env_file__';
Object.assign(process.env, {
  NODE_ENV: 'test',
  CLIENT_URL: 'http://127.0.0.1:3001',
  MONGODB_URI: localUri,
  JWT_SECRET: 'offline-prepaid-test-secret-never-use-in-production',
  RAZORPAY_KEY_ID: 'rzp_test_offline',
  RAZORPAY_KEY_SECRET: 'offline-razorpay-secret',
  RAZORPAY_WEBHOOK_SECRET: 'offline-webhook-secret',
  MAIL_DRIVER: 'noop',
  STORAGE_DRIVER: 'local',
  DPD_BOOKING_ENABLED: 'false',
  ALS_TRACKING_SWEEP_ENABLED: 'false',
  EMAIL_DOMAIN_CHECK: 'false',
  OPERATOR_PORTAL_ENABLED: 'true'
});

const denyNetwork = () => { throw new Error('External HTTP access is forbidden in prepaid offline tests.'); };
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
globalThis.fetch = async () => { throw new Error('Unexpected provider fetch in prepaid offline tests.'); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (target && typeof target === 'object' && target.host === '127.0.0.1' && Number(target.port) === Number(localTarget.port)) {
    return originalConnect.apply(this, args);
  }
  throw new Error(`Only the isolated MongoDB loopback connection is allowed (host=${target?.host}, port=${target?.port}).`);
};
