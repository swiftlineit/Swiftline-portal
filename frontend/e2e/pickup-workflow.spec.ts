import { expect, test, type Page, type Route } from "playwright/test";
import { resolve } from "node:path";

const businessAccountId = "507f1f77bcf86cd799439011";
const branchId = "507f1f77bcf86cd799439012";
const driverProfileId = "507f1f77bcf86cd799439013";
const driverUserId = "507f1f77bcf86cd799439014";
const testAddress = {
  addressLine1: "11 Test Market Road",
  addressLine2: "Warehouse 4",
  townOrCity: "New Delhi",
  county: "Delhi",
  postcode: "110001",
  countryCode: "IN",
  countryName: "India",
};

type Role = "client" | "operations" | "delivery";
type MockParcel = { parcelNumber: string; weightKg: number; status: string; exceptionReason: string; collectedAt: string | null; hubReceiptOutcome?: "RECEIVED" | "NOT_RECEIVED"; hubReceivedAt?: string | null };
type MockShipment = { _id: string; shipmentDraftId: string; trackingNumber: string; status: string; hubReceiptRecordedAt?: string | null; parcels: MockParcel[] };
type MockAttempt = {
  _id: string;
  id: string;
  sequence: number;
  status: string;
  scheduledWindow: { startAt: string; endAt: string; timezone: string };
  assignedDriverProfileId: { _id: string; engagementType: string; status: string } | null;
  assignedDriverUserId: { _id: string; firstName: string; lastName: string; name: string; phone: string } | null;
  vehicle: { source?: string; type?: string; registrationNumber?: string };
  otpVerifiedAt: string | null;
  proofs: Array<{ id: string; type: "PHOTO" | "SIGNATURE"; source?: "DRIVER" | "STAFF"; originalName: string; size: number; capturedAt: string }>;
  pickup?: Record<string, unknown>;
};
type MockPickup = {
  _id: string;
  id: string;
  requestNumber: string;
  status: string;
  businessAccountId: string;
  businessAccountName: string;
  branchId: { _id: string; name: string; code: string };
  pickupAddress: Record<string, string>;
  pickupContact: { name: string; email: string; phone: string };
  requester?: { name: string; email: string };
  requestedWindow: { startAt: string; endAt: string; timezone: string };
  dispatchAt: string;
  expectedDelhiArrival: { date: string; window: string; exactAt: string | null; timezone: string };
  transportCompany: string;
  handlingRemarks: string;
  pickupPartnerInfo: string;
  documents: Array<{ id: string; originalName: string; mimeType: string; size: number; uploadedAt: string }>;
  shipmentCount: number;
  totalBoxes: number;
  parcelCount: number;
  totalWeightKg: number;
  createdAt: string;
  pickupStartedAt: string | null;
  receivedAtDelhiHubAt: string | null;
  shipments: MockShipment[];
  attempts: MockAttempt[];
};
type RecordedAction = { method: string; path: string; body?: unknown };

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function readMultipartRequest(body: string) {
  const match = body.match(/name="request"\r?\n\r?\n([\s\S]*?)\r?\n--/);
  if (!match) throw new Error("Pickup request JSON was not present in the multipart submission.");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function futureDate(daysFromToday: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [year, month, day] = parts.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + daysFromToday));
  return date.toISOString().slice(0, 10);
}

function indiaDateTime(date: string, time: string) {
  return new Date(date + "T" + time + ":00+05:30").toISOString();
}

function previewPdf() {
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(parts.join("")));
    parts.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(parts.join(""));
  parts.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  offsets.slice(1).forEach((offset) => parts.push(`${String(offset).padStart(10, "0")} 00000 n \n`));
  parts.push(`trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(parts.join(""));
}

function pickupSummary(pickup: MockPickup) {
  const summary = { ...pickup };
  delete (summary as Partial<MockPickup>).shipments;
  delete (summary as Partial<MockPickup>).attempts;
  return summary;
}

async function createPickupApiMock(page: Page) {
  let role: Role = "client";
  let nextPickupNumber = 0;
  const pickups = new Map<string, MockPickup>();
  const actions: RecordedAction[] = [];
  const submissions: Array<{ body: Record<string, unknown>; multipart: string }> = [];
  const shipmentFixtures = [
    {
      shipmentDraftId: "507f1f77bcf86cd799439021",
      businessAccountId,
      branchId,
      trackingNumber: "SLCDELTEST0001",
      parcelNumbers: ["SLCDELTEST0001-1", "SLCDELTEST0001-2"],
      parcelCount: 2,
      totalWeightKg: 4.5,
      pickupAddress: { ...testAddress, contactName: "Warehouse Contact", email: "pickup-contact@swiftline.test", mobileCountryCode: "+91", mobileNumber: "9876543210" },
      addressFingerprint: "test-address-one",
      bookedAt: "2026-10-01T04:00:00.000Z",
    },
    {
      shipmentDraftId: "507f1f77bcf86cd799439022",
      businessAccountId,
      branchId,
      trackingNumber: "SLCDELTEST0002",
      parcelNumbers: ["SLCDELTEST0002-1"],
      parcelCount: 1,
      totalWeightKg: 2.3,
      pickupAddress: { ...testAddress, contactName: "Warehouse Contact", email: "pickup-contact@swiftline.test", mobileCountryCode: "+91", mobileNumber: "9876543210" },
      addressFingerprint: "test-address-one",
      bookedAt: "2026-10-02T04:00:00.000Z",
    },
  ];
  const driver = {
    id: driverProfileId,
    userId: driverUserId,
    firstName: "Priya",
    lastName: "Test Driver",
    email: "driver@swiftline.test",
    phone: "+919876543211",
    userStatus: "ACTIVE",
    assignedBranches: [{ _id: branchId, name: "Delhi", code: "DEL" }],
    deliverySubrole: "DRIVER",
    engagementType: "INTERNAL",
    status: "ACTIVE",
    licenceNumber: "DL-TEST-001",
    licenceExpiry: null,
    approvedVehicleTypes: ["Van"],
    notes: "Playwright fixture",
  };

  const formContext = {
    businesses: [{
      businessAccountId,
      accountId: "BA-TEST-001",
      companyName: "Swiftline Test Trading Co.",
      branchId,
      branchName: "Delhi",
      branchCode: "DEL",
      canRequestStandalone: true,
      contact: { name: "Warehouse Contact", email: "pickup-contact@swiftline.test", phone: "+919876543210" },
    }],
    requester: { name: "Client Tester", email: "client@swiftline.test", phone: "+919876543210" },
    courierAddresses: ["DHL", "FedEx"].map((companyName, index) => ({
      id: `507f1f77bcf86cd79943905${index}`, branchId, companyName,
      address: { ...testAddress }, contact: { name: "Courier Desk", phone: "+911234567890" },
    })),
  };

  const summaries = () => [...pickups.values()].map(pickupSummary);
  const findByAttemptId = (attemptId: string) => [...pickups.values()].find((pickup) => pickup.attempts.some((attempt) => attempt._id === attemptId));

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let body: unknown;
    if (method !== "GET" && !request.headers()["content-type"]?.includes("multipart/form-data")) {
      try { body = request.postDataJSON(); } catch { body = undefined; }
      actions.push({ method, path, body });
    }

    if (path.endsWith("/auth/refresh")) return json(route, { success: true, accessToken: "playwright-pickup-token" });
    if (path.endsWith("/auth/me")) {
      const user = role === "client"
        ? { id: "507f1f77bcf86cd799439031", name: "Client Tester", email: "client@swiftline.test", role }
        : role === "operations"
          ? { id: "507f1f77bcf86cd799439032", name: "Operations Tester", email: "ops@swiftline.test", role, assignedBranches: [branchId] }
          : { id: driverUserId, name: "Priya Test Driver", email: driver.email, role };
      return json(route, { success: true, user });
    }
    if (path.endsWith("/driver/profile")) return json(route, { success: true, driver });
    if (path.endsWith("/client/pickups/form-context")) return json(route, { success: true, ...formContext });
    if (path === "/api/v1/pickups/courier-addresses" && method === "GET") return json(route, {
      success: true, branches: [{ id: branchId, name: "Delhi", code: "DEL" }], courierAddresses: formContext.courierAddresses,
    });
    if (path === "/api/v1/pickups/courier-addresses" && method === "POST") {
      const value = body as Record<string, unknown>;
      const profile = { ...value, id: "507f1f77bcf86cd799439060" };
      formContext.courierAddresses.push(profile as (typeof formContext.courierAddresses)[number]);
      return json(route, { success: true, courierAddress: profile }, 201);
    }
    if (path.startsWith("/api/v1/pickups/courier-addresses/") && method === "PUT") {
      const id = path.split("/").at(-1);
      const index = formContext.courierAddresses.findIndex((item) => item.id === id);
      if (index < 0) return json(route, { success: false, message: "Not found" }, 404);
      formContext.courierAddresses[index] = { ...formContext.courierAddresses[index], ...(body as Record<string, unknown>) };
      return json(route, { success: true, courierAddress: formContext.courierAddresses[index] });
    }
    if (path.endsWith("/client/pickups/eligible-shipments")) return json(route, { success: true, shipments: shipmentFixtures });
    if (path === "/api/v1/client/dashboard") return json(route, { success: true, accounts: [] });
    if (path === "/api/v1/client/rate-card-shares") return json(route, { success: true, shares: [], unreadCount: 0 });

    if (path === "/api/v1/client/pickups" && method === "GET") return json(route, { success: true, pickups: summaries() });
    if (path === "/api/v1/client/pickups" && method === "POST") {
      const multipart = request.postData() ?? "";
      const payload = readMultipartRequest(multipart);
      submissions.push({ body: payload, multipart });
      nextPickupNumber += 1;
      const id = nextPickupNumber === 1 ? "507f1f77bcf86cd799439041" : "507f1f77bcf86cd799439042";
      const selectedIds = Array.isArray(payload.shipmentDraftIds) ? payload.shipmentDraftIds as string[] : [];
      const selectedShipments = shipmentFixtures.filter((shipment) => selectedIds.includes(shipment.shipmentDraftId));
      const dispatchDate = String(payload.dispatchDate);
      const dispatchTime = String(payload.dispatchTime);
      const dispatchAt = indiaDateTime(dispatchDate, dispatchTime);
      const arrival = payload.expectedDelhiArrival as { date: string; window: string; exactTime?: string };
      const exactAt = arrival.window === "EXACT" && arrival.exactTime ? indiaDateTime(arrival.date, arrival.exactTime) : null;
      const linked: MockShipment[] = selectedShipments.map((shipment) => ({
        _id: shipment.shipmentDraftId,
        shipmentDraftId: shipment.shipmentDraftId,
        trackingNumber: shipment.trackingNumber,
        status: "PENDING",
        parcels: shipment.parcelNumbers.map((parcelNumber) => ({
          parcelNumber,
          weightKg: shipment.totalWeightKg / shipment.parcelCount,
          status: "PENDING",
          exceptionReason: "",
          collectedAt: null,
        })),
      }));
      const documentName = multipart.includes("pickup-instructions.pdf") ? "pickup-instructions.pdf" : "";
      const pickup: MockPickup = {
        _id: id,
        id,
        requestNumber: "PU-TEST-0" + nextPickupNumber,
        status: "REQUESTED",
        businessAccountId,
        businessAccountName: "Swiftline Test Trading Co.",
        branchId: { _id: branchId, name: "Delhi", code: "DEL" },
        pickupAddress: (payload.pickupAddress ?? testAddress) as Record<string, string>,
        pickupContact: {
          ...(payload.contact as { name: string; phone: string }),
          email: formContext.requester.email,
        },
        requester: { name: formContext.requester.name, email: formContext.requester.email },
        requestedWindow: { startAt: dispatchAt, endAt: new Date(new Date(dispatchAt).getTime() + 2 * 60 * 60 * 1000).toISOString(), timezone: "Asia/Kolkata" },
        dispatchAt,
        expectedDelhiArrival: { date: arrival.date, window: arrival.window, exactAt, timezone: "Asia/Kolkata" },
        transportCompany: String(payload.transportCompany ?? "DHL"),
        handlingRemarks: String(payload.handlingRemarks ?? ""),
        pickupPartnerInfo: "",
        documents: documentName ? [{ id: "507f1f77bcf86cd799439051", originalName: documentName, mimeType: "application/pdf", size: 128, uploadedAt: new Date().toISOString() }] : [],
        shipmentCount: linked.length,
        totalBoxes: Number(payload.totalBoxes ?? selectedShipments.reduce((total, shipment) => total + shipment.parcelCount, 0)),
        parcelCount: selectedShipments.reduce((total, shipment) => total + shipment.parcelCount, 0),
        totalWeightKg: Number(payload.totalWeightKg ?? selectedShipments.reduce((total, shipment) => total + shipment.totalWeightKg, 0)),
        createdAt: new Date().toISOString(),
        pickupStartedAt: null,
        receivedAtDelhiHubAt: null,
        shipments: linked,
        attempts: [],
      };
      pickups.set(id, pickup);
      return json(route, { success: true, message: "Pickup request submitted.", pickup }, 201);
    }

    const clientDetailMatch = path.match(/^\/api\/v1\/client\/pickups\/([^/]+)$/);
    if (clientDetailMatch && method === "GET") {
      const pickup = pickups.get(clientDetailMatch[1]);
      return pickup ? json(route, { success: true, pickup }) : json(route, { success: false, message: "Pickup not found." }, 404);
    }
    const documentMatch = path.match(/^\/api\/v1\/(client\/)?pickups\/([^/]+)\/documents\/([^/]+)$/);
    if (documentMatch && method === "GET") {
      const document = pickups.get(documentMatch[2])?.documents.find((item) => item.id === documentMatch[3]);
      return document ? route.fulfill({ status: 200, contentType: "application/pdf", body: previewPdf() })
        : json(route, { success: false, message: "Document not found." }, 404);
    }
    const proofMatch = path.match(/^\/api\/v1\/(client\/)?pickups\/([^/]+)\/proofs\/([^/]+)$/);
    if (proofMatch && method === "GET") {
      const proof = pickups.get(proofMatch[2])?.attempts.flatMap((item) => item.proofs).find((item) => item.id === proofMatch[3]);
      return proof ? route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") })
        : json(route, { success: false, message: "Proof not found." }, 404);
    }
    if (path === "/api/v1/pickups/available-drivers") return json(route, { success: true, drivers: [driver] });
    if (path === "/api/v1/pickups" && method === "GET") return json(route, { success: true, pickups: summaries() });

    const internalDetailMatch = path.match(/^\/api\/v1\/pickups\/([^/]+)$/);
    if (internalDetailMatch && method === "GET") {
      const pickup = pickups.get(internalDetailMatch[1]);
      return pickup ? json(route, { success: true, pickup }) : json(route, { success: false, message: "Pickup not found." }, 404);
    }
    const staffProofMatch = path.match(/^\/api\/v1\/pickups\/([^/]+)\/proofs$/);
    if (staffProofMatch && method === "POST") {
      const pickup = pickups.get(staffProofMatch[1]);
      if (!pickup?.attempts[0] || !pickup.pickupStartedAt) return json(route, { success: false, message: "Start the pickup first." }, 409);
      pickup.attempts[0].proofs.push({ id: "507f1f77bcf86cd799439071", type: "PHOTO", source: "STAFF", originalName: "staff-photo.png", size: 120, capturedAt: new Date().toISOString() });
      return json(route, { success: true, message: "Pickup photo saved.", pickup }, 201);
    }
    const internalActionMatch = path.match(/^\/api\/v1\/pickups\/([^/]+)\/(confirm|status|partner-info|assign)$/);
    if (internalActionMatch) {
      const pickup = pickups.get(internalActionMatch[1]);
      if (!pickup) return json(route, { success: false, message: "Pickup not found." }, 404);
      const action = internalActionMatch[2];
      if (action === "confirm") {
        pickup.status = "CONFIRMED";
        const attempt: MockAttempt = {
          _id: "507f1f77bcf86cd799439061",
          id: "507f1f77bcf86cd799439061",
          sequence: 1,
          status: "SCHEDULED",
          scheduledWindow: { ...pickup.requestedWindow },
          assignedDriverProfileId: null,
          assignedDriverUserId: null,
          vehicle: {},
          otpVerifiedAt: null,
          proofs: [],
          pickup: pickupSummary(pickup),
        };
        pickup.attempts = [attempt];
        return json(route, { success: true, pickup, attemptId: attempt._id });
      }
      if (action === "status") {
        const status = String((body as Record<string, unknown> | undefined)?.status ?? "");
        if (status === "IN_PROGRESS") {
          pickup.status = "IN_PROGRESS";
          pickup.pickupStartedAt = new Date().toISOString();
        } else {
          const received = new Set(((body as { receivedParcels?: Array<{ shipmentDraftId: string; parcelNumber: string }> })?.receivedParcels ?? [])
            .map((parcel) => `${parcel.shipmentDraftId}:${parcel.parcelNumber}`));
          pickup.receivedAtDelhiHubAt = new Date().toISOString();
          let missing = 0;
          pickup.shipments.forEach((shipment) => {
            shipment.hubReceiptRecordedAt = pickup.receivedAtDelhiHubAt;
            shipment.parcels.forEach((parcel) => {
              const selected = received.has(`${shipment.shipmentDraftId}:${parcel.parcelNumber}`);
              parcel.hubReceiptOutcome = selected ? "RECEIVED" : "NOT_RECEIVED";
              if (selected) {
                parcel.status = "COLLECTED";
                parcel.hubReceivedAt = pickup.receivedAtDelhiHubAt;
              } else missing += 1;
            });
          });
          pickup.status = missing ? "COMPLETED_WITH_MISSING_PARCELS" : "RECEIVED_AT_DELHI_HUB";
        }
        return json(route, { success: true, message: "Pickup status updated.", pickup });
      }
      if (action === "partner-info") {
        pickup.pickupPartnerInfo = String((body as Record<string, unknown> | undefined)?.information ?? "");
        return json(route, { success: true, message: "Pickup partner information saved.", pickup });
      }
      const assignedAttempt = pickup.attempts[0];
      assignedAttempt.status = "ASSIGNED";
      assignedAttempt.assignedDriverProfileId = { _id: driverProfileId, engagementType: driver.engagementType, status: driver.status };
      assignedAttempt.assignedDriverUserId = { _id: driverUserId, firstName: driver.firstName, lastName: driver.lastName, name: driver.firstName + " " + driver.lastName, phone: driver.phone };
      assignedAttempt.vehicle = (body as Record<string, unknown> | undefined)?.vehicle as MockAttempt["vehicle"];
      pickup.status = "DRIVER_ASSIGNED";
      return json(route, { success: true, message: "Driver assigned.", pickup });
    }

    if (path === "/api/v1/driver/pickups/attempts" && method === "GET") {
      const attempts = [...pickups.values()].flatMap((pickup) => pickup.attempts.map((attempt) => ({ ...attempt, pickup: pickupSummary(pickup) })));
      return json(route, { success: true, attempts });
    }
    const driverAttemptMatch = path.match(/^\/api\/v1\/driver\/pickups\/attempts\/([^/]+)(?:\/(status|otp\/request|otp\/verify|proofs\/(PHOTO|SIGNATURE)|scan|complete))?$/);
    if (driverAttemptMatch) {
      const attemptId = driverAttemptMatch[1];
      const pickup = findByAttemptId(attemptId);
      const attempt = pickup?.attempts.find((item) => item._id === attemptId);
      if (!pickup || !attempt) return json(route, { success: false, message: "Pickup attempt not found." }, 404);
      const action = driverAttemptMatch[2];
      if (method === "GET" && !action) return json(route, { success: true, pickup });
      if (action === "status") {
        const nextStatus = String((body as Record<string, unknown> | undefined)?.status ?? "");
        attempt.status = nextStatus;
        if (nextStatus === "EN_ROUTE" || nextStatus === "ARRIVED" || nextStatus === "COLLECTING") {
          pickup.status = "IN_PROGRESS";
          pickup.pickupStartedAt ??= new Date().toISOString();
        }
        return json(route, { success: true, pickup });
      }
      if (action === "otp/request") return json(route, { success: true, sent: true, skipped: false, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      if (action === "otp/verify") {
        attempt.otpVerifiedAt = new Date().toISOString();
        return json(route, { success: true, verifiedAt: attempt.otpVerifiedAt });
      }
      if (action === "proofs/PHOTO" || action === "proofs/SIGNATURE") {
        attempt.proofs.push({ id: "proof-" + attempt.proofs.length, type: action.endsWith("PHOTO") ? "PHOTO" : "SIGNATURE", originalName: action.endsWith("PHOTO") ? "handover.jpg" : "pickup-signature.png", size: 128, capturedAt: new Date().toISOString() });
        return json(route, { success: true, message: "Pickup proof saved." });
      }
      if (action === "scan") {
        const parcelNumber = String((body as Record<string, unknown> | undefined)?.parcelNumber ?? "");
        const parcel = pickup.shipments.flatMap((shipment) => shipment.parcels).find((item) => item.parcelNumber === parcelNumber);
        if (!parcel) return json(route, { success: false, message: "Unexpected parcel." }, 409);
        parcel.status = "COLLECTED";
        parcel.collectedAt = new Date().toISOString();
        return json(route, { success: true, pickup });
      }
      if (action === "complete") {
        attempt.status = "COMPLETED";
        pickup.status = "COLLECTED";
        return json(route, { success: true, message: "Pickup completed and POP saved.", pickup });
      }
    }

    if (path.endsWith("/notifications")) return json(route, { success: true, notifications: [], unreadCount: 0 });
    if (path.includes("/profile")) return json(route, { success: false, message: "No profile image in browser fixture." }, 404);
    return json(route, { success: true, notifications: [], unreadCount: 0, branches: [], items: [], drivers: [] });
  });

  return {
    setRole(nextRole: Role) { role = nextRole; },
    actions,
    submissions,
    getPickup(id: string) { return pickups.get(id); },
    getPickups() { return [...pickups.values()]; },
  };
}

async function completeRequiredPickupFields(page: Page, arrivalWindow: "MORNING" | "AFTERNOON" | "EVENING" | "EXACT") {
  const dispatchDate = futureDate(2);
  const arrivalDate = futureDate(3);
  await page.getByLabel("Dispatch date and time").fill(`${dispatchDate}T09:30`);
  await page.getByLabel("Expected Delhi arrival date").fill(arrivalDate);
  await page.getByLabel("Expected arrival window").selectOption(arrivalWindow);
  if (arrivalWindow === "EXACT") await page.getByLabel("Exact expected arrival time").fill("15:15");
  await page.getByLabel("Collection address").fill(testAddress.addressLine1);
  await page.getByLabel("City").fill(testAddress.townOrCity);
  await page.getByLabel("State").fill(testAddress.county);
  await page.getByLabel("PIN code").fill(testAddress.postcode);
  await page.getByLabel("Contact name").fill("Warehouse Contact");
  await page.getByLabel("Phone number").fill("+919876543210");
  return { dispatchDate, arrivalDate };
}

test("selecting a document keeps the form visible when an older pickup list loads", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const api = await createPickupApiMock(page);
  let releaseList!: () => void;
  const listReady = new Promise<void>((resolve) => { releaseList = resolve; });
  await page.route("**/api/v1/client/pickups**", async (route) => {
    if (new URL(route.request().url()).pathname !== "/api/v1/client/pickups" || route.request().method() !== "GET") {
      return route.fallback();
    }
    await listReady;
    return json(route, { success: true, pickups: [{
      id: "507f1f77bcf86cd799439099",
      requestNumber: "PU-LEGACY-01",
      status: "REQUESTED",
      businessAccountName: "Swiftline Test Trading Co.",
      pickupContact: { name: "Warehouse Contact" },
      requestedWindow: { startAt: new Date().toISOString() },
      parcelCount: 2,
      shipmentCount: 1,
      createdAt: new Date().toISOString(),
    }] });
  });

  await page.goto("/client/pickups");
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  const chooseDocuments = page.getByRole("button", { name: /Choose documents to upload/ });
  const cancelChooserPromise = page.waitForEvent("filechooser");
  await chooseDocuments.click();
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  await (await cancelChooserPromise).setFiles([]);
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  const unsupportedChooserPromise = page.waitForEvent("filechooser");
  await chooseDocuments.click();
  await (await unsupportedChooserPromise).setFiles({
    name: "unsupported.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: Buffer.from("Unsupported format"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "Documents must be PDF" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  const fileChooserPromise = page.waitForEvent("filechooser");
  await chooseDocuments.click();
  await (await fileChooserPromise).setFiles({
    name: "client-note.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nPickup note\n"),
  });
  await expect(page.getByText("client-note.pdf", { exact: true })).toBeVisible();
  releaseList();
  await expect(page.getByRole("button", { name: /PU-LEGACY-01/ })).toBeVisible();
  const imageChooserPromise = page.waitForEvent("filechooser");
  await chooseDocuments.click();
  await (await imageChooserPromise).setFiles(resolve("public/slc_white_logo.png"));
  await expect(page.getByText("slc_white_logo.png", { exact: true })).toBeVisible();
  await expect(page.getByText("2 of 5 selected")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  await expect(page).toHaveURL(/\/client\/pickups$/);
  expect(api.submissions).toHaveLength(0);
  expect(pageErrors).toEqual([]);
});

test("staff saves a branch courier and client can edit its autofilled collection details", async ({ page }) => {
  const api = await createPickupApiMock(page);
  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await page.getByRole("button", { name: "Courier addresses" }).click();
  await expect(page.getByRole("heading", { name: "Add a courier location" })).toBeVisible();
  const savedLocations = page.getByRole("heading", { name: "Saved courier locations" }).locator("xpath=ancestor::section");
  const courierForm = page.getByRole("heading", { name: "Add a courier location" }).locator("xpath=ancestor::form");
  await page.evaluate(() => document.documentElement.setAttribute("data-portal-theme", "light"));
  await expect(savedLocations).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(courierForm).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(() => document.documentElement.setAttribute("data-portal-theme", "dark"));
  await expect(savedLocations).toHaveCSS("background-color", "rgb(27, 41, 64)");
  await expect(courierForm).toHaveCSS("background-color", "rgb(27, 41, 64)");
  await page.evaluate(() => document.documentElement.setAttribute("data-portal-theme", "light"));
  await expect(page.getByLabel("Country code")).toHaveCount(0);
  await expect(page.getByLabel("Country name")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh courier addresses" })).toHaveCount(0);
  await page.getByLabel("Transport / courier company").fill("Test Express");
  await page.getByLabel("Address line 1").fill("27 Courier Lane");
  await page.getByLabel("City").fill("New Delhi");
  await page.getByLabel("State").fill("Delhi");
  await page.getByLabel("PIN / postal code").fill("110002");
  await page.getByLabel("Contact name").fill("Courier Agent");
  await page.getByLabel("Phone number").fill("+91ABC1112223334");
  await expect(page.getByLabel("Phone number")).toHaveValue("911112223334");
  await page.getByRole("button", { name: "Save courier address" }).click();
  await expect(page.getByRole("button", { name: /Test Express/ })).toBeVisible();

  api.setRole("client");
  await page.goto("/client/pickups");
  await completeRequiredPickupFields(page, "MORNING");
  await page.getByLabel("Transport / courier company").selectOption("Test Express");
  await expect(page.getByLabel("Collection address")).toHaveValue("27 Courier Lane");
  await expect(page.getByLabel("Contact name")).toHaveValue("Courier Agent");
  await expect(page.getByLabel("Phone number")).toHaveValue("911112223334");
  await page.getByLabel("Phone number").fill("+91ABC9999888877");
  await expect(page.getByLabel("Phone number")).toHaveValue("919999888877");
  await page.getByLabel("Total boxes").fill("1");
  await page.getByLabel("Total gross weight (kg)").fill("2");
  await page.getByRole("button", { name: "Submit pickup request" }).click();
  await expect.poll(() => api.submissions.length).toBe(1);
  expect(api.submissions[0].body.pickupAddress).toMatchObject({ addressLine1: "27 Courier Lane", postcode: "110002" });
  expect(api.submissions[0].body.contact).toEqual({ name: "Courier Agent", phone: "919999888877" });
  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByText("Courier collection contact", { exact: true })).toBeVisible();
  await expect(page.getByText("Courier Agent", { exact: true })).toBeVisible();
  await expect(page.getByText("Client Tester", { exact: true })).toBeVisible();
});

test("staff pickup photo is visible to the client and document name opens a preview tab", async ({ page }) => {
  test.setTimeout(120_000);
  const api = await createPickupApiMock(page);
  await page.goto("/client/pickups");
  await completeRequiredPickupFields(page, "MORNING");
  await page.getByLabel("Transport / courier company").selectOption("DHL");
  await page.getByLabel("Total boxes").fill("1");
  await page.getByLabel("Total gross weight (kg)").fill("2");
  await page.locator('input[type="file"][multiple]').setInputFiles({ name: "pickup-instructions.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\nTest\n") });
  await page.getByRole("button", { name: "Submit pickup request" }).click();
  await expect.poll(() => api.submissions.length).toBe(1);

  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await page.getByRole("button", { name: "Approve pickup" }).click();
  await expect(page.getByText("Upload pickup photo")).toHaveCount(0);
  await page.getByRole("button", { name: "Mark pickup started" }).click();
  await page.locator('input[type="file"][accept="image/jpeg,image/png,image/webp"]').setInputFiles({
    name: "staff-photo.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  });
  await expect(page.getByRole("button", { name: /Staff pickup photo/ })).toBeVisible();
  expect(api.getPickups()[0]?.attempts[0]?.proofs[0]?.source).toBe("STAFF");
  api.getPickups()[0]?.attempts[0]?.proofs.push({ id: "507f1f77bcf86cd799439072", type: "PHOTO", source: "DRIVER", originalName: "driver-photo.png", size: 120, capturedAt: new Date().toISOString() });

  api.setRole("client");
  await page.goto("/client/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByRole("button", { name: /^Pickup photo/ })).toHaveCount(0);
  await page.getByRole("button", { name: /Staff pickup photo/ }).click();
  await expect(page.getByRole("dialog", { name: "Pickup photo" })).toBeVisible();
  await page.getByRole("dialog", { name: "Pickup photo" }).getByRole("button").click();
  const previewErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") previewErrors.push(message.text()); });
  page.on("pageerror", (error) => previewErrors.push(error.message));
  const popupPromise = page.waitForEvent("popup");
  const documentResponsePromise = page.waitForResponse((response) => response.url().includes("/pickups/") && response.url().includes("/documents/"));
  await page.getByRole("link", { name: /pickup-instructions.pdf/ }).click();
  const popup = await popupPromise;
  expect((await documentResponsePromise).status()).toBe(200);
  expect(previewErrors).toEqual([]);
  await expect(popup.locator("iframe")).toHaveAttribute("src", /^blob:/);
  await popup.close();
});

test("client can request manual volume and staff can complete pickup without a driver", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const duplicateKeyWarnings: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Encountered two children with the same key")
    ) {
      duplicateKeyWarnings.push(message.text());
    }
  });
  const api = await createPickupApiMock(page);
  await page.goto("/client/pickups");
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  const heading = page.getByRole("heading", { name: "Book a pickup" });
  const hero = heading.locator("xpath=ancestor::header");
  await expect(hero).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const lightHeadingColor = await heading.evaluate((element) => getComputedStyle(element).color);
  await page.evaluate(() => document.documentElement.setAttribute("data-portal-theme", "dark"));
  await expect(hero).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect.poll(() => heading.evaluate((element) => getComputedStyle(element).color)).not.toBe(lightHeadingColor);
  await page.evaluate(() => document.documentElement.removeAttribute("data-portal-theme"));
  await expect(page.getByText("Booking as", { exact: true })).toHaveCount(0);
  const sections = page.locator("form > div.grid > section");
  await expect(sections).toHaveCount(2);
  const submitButton = sections.nth(1).getByRole("button", { name: "Submit pickup request" });
  await expect(submitButton).toBeVisible();
  await expect(sections.nth(1).getByLabel(/Contact email/)).toHaveCount(0);
  await expect(sections.nth(0).getByRole("heading", { name: "Shipment volume" })).toBeVisible();
  await expect(sections.nth(0).getByLabel(/Handling remarks or instructions/)).toHaveCount(0);
  await expect(sections.nth(1).getByLabel(/Handling remarks or instructions/)).toBeVisible();
  await expect(sections.nth(0).getByRole("heading", { name: /Supporting documents/ })).toBeVisible();
  await expect(sections.nth(1).getByRole("heading", { name: "Dispatch, Delhi arrival and collection" })).toBeVisible();
  await expect(sections.nth(1).getByRole("heading", { name: "Dispatch and Delhi arrival" })).toBeVisible();
  await expect(sections.nth(1).getByRole("heading", { name: "Collection address and contact" })).toBeVisible();
  const submitFooter = sections.nth(1).locator("[data-pickup-submit-footer]");
  await expect(submitFooter).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  if ((page.viewportSize()?.width ?? 0) >= 1280) {
    const [shipmentsSection, dispatchSection] = await Promise.all([
      sections.nth(0).boundingBox(),
      sections.nth(1).boundingBox(),
    ]);
    expect(shipmentsSection).not.toBeNull();
    expect(dispatchSection).not.toBeNull();
    expect(Math.abs((shipmentsSection?.y ?? 0) - (dispatchSection?.y ?? 0))).toBeLessThan(2);
    expect(Math.abs((shipmentsSection?.height ?? 0) - (dispatchSection?.height ?? 0))).toBeLessThan(2);
    const windows = await page.getByLabel("Expected arrival window").boundingBox();
    const courier = await page.getByLabel("Transport / courier company").boundingBox();
    expect(Math.abs((windows?.y ?? 0) - (courier?.y ?? 0))).toBeLessThan(2);
  }
  const documentDropzone = page.locator("[data-pickup-document-dropzone]");
  const dropzoneBounds = await documentDropzone.boundingBox();
  expect(dropzoneBounds).not.toBeNull();
  expect(dropzoneBounds?.height ?? 0).toBeLessThan(190);
  await page.evaluate(() => document.documentElement.setAttribute("data-portal-theme", "dark"));
  await expect(documentDropzone).toHaveCSS("background-color", "rgb(21, 33, 55)");
  await expect(sections.nth(1).locator("[data-pickup-subsection-icon]").first()).toHaveCSS("background-color", "rgb(32, 47, 84)");
  await page.evaluate(() => document.documentElement.removeAttribute("data-portal-theme"));
  await expect(page.getByLabel("Phone number")).toHaveValue("");

  const dates = await completeRequiredPickupFields(page, "EXACT");
  await page.getByLabel("Transport / courier company").selectOption("OTHER");
  await page.getByLabel("Company name").fill("Local Test Logistics");
  await page.getByLabel("Collection address").fill(testAddress.addressLine1);
  await page.getByLabel("City").fill(testAddress.townOrCity);
  await page.getByLabel("State").fill(testAddress.county);
  await page.getByLabel("PIN code").fill(testAddress.postcode);
  await page.getByLabel("Contact name").fill("Warehouse Contact");
  await page.getByLabel("Phone number").fill("+919876543210");
  await page.getByLabel("Total boxes").fill("4");
  await page.getByLabel("Total gross weight (kg)").fill("20.5");
  await page.getByPlaceholder("Fragile items, access instructions, loading notes…").fill("Collect from loading bay 2.");
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: "unsupported.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("unsupported"),
  });
  await expect(page.getByRole("alert").filter({ hasText: "Documents must be PDF" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  const dragTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["%PDF-1.7\nDrag and drop test\n"], "dragged-instructions.pdf", { type: "application/pdf" }));
    return transfer;
  });
  await documentDropzone.dispatchEvent("dragover", { dataTransfer: dragTransfer });
  await expect(documentDropzone).toHaveAttribute("data-dragging", "true");
  await documentDropzone.dispatchEvent("drop", { dataTransfer: dragTransfer });
  await expect(page.getByText("dragged-instructions.pdf", { exact: true })).toBeVisible();
  await expect(documentDropzone).not.toHaveAttribute("data-dragging");
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("dragged-instructions.pdf", { exact: true })).toHaveCount(0);
  const fileChooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: /Choose documents to upload/ }).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "pickup-instructions.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7\nPlaywright pickup test\n"),
  });
  await expect(page.getByText("pickup-instructions.pdf", { exact: true })).toBeVisible();
  const duplicateImage = resolve("public/slc_white_logo.png");
  await page.locator('input[type="file"][multiple]').setInputFiles([
    duplicateImage,
    duplicateImage,
  ]);
  await expect(page.getByText("slc_white_logo.png", { exact: true })).toHaveCount(2);
  expect(duplicateKeyWarnings).toEqual([]);
  await submitButton.scrollIntoViewIfNeeded();
  const supportLink = page.getByRole("link", { name: "Contact support on WhatsApp" });
  await expect(supportLink).toBeVisible();
  const [submitBounds, supportBounds] = await Promise.all([
    submitButton.boundingBox(),
    supportLink.boundingBox(),
  ]);
  expect(submitBounds).not.toBeNull();
  expect(supportBounds).not.toBeNull();
  const overlapsSupport = Boolean(
    submitBounds && supportBounds &&
      submitBounds.x < supportBounds.x + supportBounds.width &&
      submitBounds.x + submitBounds.width > supportBounds.x &&
      submitBounds.y < supportBounds.y + supportBounds.height &&
      submitBounds.y + submitBounds.height > supportBounds.y,
  );
  expect(overlapsSupport).toBe(false);
  expect(pageErrors).toEqual([]);

  await page.getByRole("button", { name: "Submit pickup request" }).click();
  await expect.poll(() => api.submissions.length).toBe(1);
  const submitted = api.submissions[0];
  expect(api.getPickups()[0]?.pickupContact.email).toBe("client@swiftline.test");
  expect(submitted.body.businessAccountId).toBe(businessAccountId);
  expect(submitted.body.shipmentDraftIds).toEqual([]);
  expect(submitted.body.dispatchDate).toBe(dates.dispatchDate);
  expect(submitted.body.dispatchTime).toBe("09:30");
  expect(submitted.body.expectedDelhiArrival).toMatchObject({ date: dates.arrivalDate, window: "EXACT", exactTime: "15:15" });
  expect(submitted.body.transportCompany).toBe("Local Test Logistics");
  expect(submitted.body.contact).toEqual({ name: "Warehouse Contact", phone: "919876543210" });
  expect("email" in (submitted.body.contact as Record<string, unknown>)).toBe(false);
  expect(submitted.body.totalBoxes).toBe(4);
  expect(submitted.body.totalWeightKg).toBe(20.5);
  expect(submitted.body.pickupAddress).toMatchObject({ addressLine1: testAddress.addressLine1, postcode: testAddress.postcode });
  expect(submitted.multipart).toContain("pickup-instructions.pdf");
  expect(submitted.multipart.match(/slc_white_logo\.png/g) ?? []).toHaveLength(2);
  await expect(page.getByRole("button", { name: /PU-TEST-01/ })).toBeVisible();
  await expect(page.getByText("Requested", { exact: true }).first()).toBeVisible();

  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await expect(page.getByRole("heading", { name: "Pickup Requests" })).toBeVisible();
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByText("Swiftline Test Trading Co.", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Local Test Logistics", { exact: true })).toBeVisible();
  await expect(page.getByText("pickup-instructions.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("4 boxes", { exact: true })).toBeVisible();
  await expect(page.getByText(/20\.50 kg gross weight/)).toBeVisible();
  await expect(page.getByText(/Confirm collection window/i)).toHaveCount(0);
  await page.evaluate(() => document.documentElement.setAttribute("data-portal-theme", "dark"));
  const approvalPanel = page.getByRole("heading", { name: "Approve pickup request" }).locator("xpath=ancestor::form[1]");
  await expect(approvalPanel).toHaveCSS("background-color", "rgb(32, 47, 84)");
  await expect(approvalPanel.getByRole("heading")).toHaveCSS("color", "rgb(241, 245, 251)");
  const quickStatus = page.getByRole("heading", { name: "Quick pickup status" }).locator("xpath=ancestor::section[1]");
  await expect(quickStatus).toHaveCSS("background-color", "rgb(32, 47, 84)");
  await expect(quickStatus).toHaveCSS("border-color", "rgb(98, 123, 189)");
  await expect(quickStatus.getByRole("heading")).toHaveCSS("color", "rgb(241, 245, 251)");
  await page.getByRole("button", { name: "Approve pickup" }).click();
  await expect(page.getByText("Scheduled", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Optional driver assignment" })).toBeVisible();
  expect(api.actions.some((action) => action.path.endsWith("/assign"))).toBe(false);

  await page.getByPlaceholder("Vehicle and registration, driver name, or other pickup details").fill("White van · DL01TEST1234 · driver Arun");
  await page.getByRole("button", { name: "Save information" }).click();
  await expect(page.getByText("Pickup partner information saved.")).toBeVisible();
  await page.getByRole("button", { name: "Mark pickup started" }).click();
  await expect(page.getByText("In Progress", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Complete pickup at Delhi hub" }).click();
  await expect(page.getByText("Received at Delhi hub", { exact: true }).first()).toBeVisible();
  await expect(page.locator("strong.text-emerald-950")).toHaveCSS("color", "rgb(157, 230, 199)");
  expect(api.actions.filter((action) => action.path.endsWith("/status")).map((action) => (action.body as Record<string, unknown>).status)).toEqual(["IN_PROGRESS", "RECEIVED_AT_DELHI_HUB"]);

  api.setRole("client");
  await page.goto("/client/pickups");
  await expect(page.getByText("Received at Delhi hub", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByText("White van · DL01TEST1234 · driver Arun", { exact: true })).toBeVisible();
});

test("client can link shipments and a driver can collect them before staff records hub receipt", async ({ page, context }) => {
  test.setTimeout(120_000);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 28.6139, longitude: 77.209 });
  const api = await createPickupApiMock(page);
  await page.goto("/client/pickups");
  await expect(page.getByRole("heading", { name: "Book a pickup" })).toBeVisible();
  await page.getByRole("checkbox").nth(0).check();
  await page.getByRole("checkbox").nth(1).check();
  await expect(page.getByText("From 2 linked shipments")).toBeVisible();
  await expect(page.getByText("6.80 kg", { exact: true })).toBeVisible();
  const dates = await completeRequiredPickupFields(page, "AFTERNOON");
  await page.getByLabel("Transport / courier company").selectOption("FedEx");
  await page.getByRole("button", { name: "Submit pickup request" }).click();
  await expect.poll(() => api.submissions.length).toBe(1);
  expect(api.submissions[0].body.shipmentDraftIds).toEqual([
    "507f1f77bcf86cd799439021",
    "507f1f77bcf86cd799439022",
  ]);
  expect(api.submissions[0].body.expectedDelhiArrival).toMatchObject({ date: dates.arrivalDate, window: "AFTERNOON" });
  expect(api.submissions[0].body.transportCompany).toBe("FedEx");
  await expect(page.getByRole("button", { name: /PU-TEST-01/ })).toBeVisible();

  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByText("3 boxes", { exact: true })).toBeVisible();
  await expect(page.getByText("SLCDELTEST0001", { exact: true })).toBeVisible();
  await expect(page.getByText("SLCDELTEST0002", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve pickup" }).click();
  const assignment = page.locator("form").filter({ has: page.getByRole("heading", { name: "Optional driver assignment" }) });
  await assignment.locator("select").nth(0).selectOption(driverProfileId);
  await assignment.locator("select").nth(2).selectOption({ label: "Van" });
  await assignment.getByPlaceholder("Registration number").fill("DL01AB1234");
  await assignment.getByRole("button", { name: "Assign driver" }).click();
  await expect(page.getByText("Driver Assigned", { exact: true }).first()).toBeVisible();
  expect(api.actions.some((action) => action.path.endsWith("/assign") && (action.body as Record<string, unknown>).driverProfileId === driverProfileId)).toBe(true);

  api.setRole("delivery");
  await page.goto("/driver");
  await expect(page.getByRole("heading", { name: "My pickups" })).toBeVisible();
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByRole("button", { name: "Accept pickup" })).toBeVisible();
  await page.getByRole("button", { name: "Accept pickup" }).click();
  await page.getByRole("button", { name: "Start journey" }).click();
  await expect.poll(() => api.getPickup("507f1f77bcf86cd799439041")?.status).toBe("IN_PROGRESS");
  await page.getByRole("button", { name: "I have arrived" }).click();
  await page.getByRole("button", { name: "Start collection" }).click();
  await expect(page.getByRole("heading", { name: "Parcel collection" })).toBeVisible();

  for (const parcelNumber of ["SLCDELTEST0001-1", "SLCDELTEST0001-2", "SLCDELTEST0002-1"]) {
    await page.getByLabel("Parcel barcode").fill(parcelNumber);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("paragraph").filter({ hasText: parcelNumber })).toBeVisible();
  }
  await page.getByRole("button", { name: "Send OTP" }).click();
  await expect(page.getByText("OTP sent to the pickup requester’s account email.")).toBeVisible();
  await page.getByPlaceholder("6-digit OTP").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Client email verified", { exact: true })).toBeVisible();

  await page.locator('input[type="file"]').last().setInputFiles({
    name: "handover.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  await expect(page.getByText("Pickup proof saved.")).toBeVisible();
  const signature = page.getByLabel("Customer signature pad");
  await signature.scrollIntoViewIfNeeded();
  const signatureBox = await signature.boundingBox();
  if (!signatureBox) throw new Error("Signature canvas was not visible.");
  await page.mouse.move(signatureBox.x + 12, signatureBox.y + 16);
  await page.mouse.down();
  await page.mouse.move(signatureBox.x + 120, signatureBox.y + 50, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Save signature" })).toBeEnabled();
  await page.getByRole("button", { name: "Save signature" }).click();
  await expect(page.getByText("Pickup proof saved.").last()).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete and save POP" })).toBeEnabled();
  await page.getByRole("button", { name: "Complete and save POP" }).click();
  await expect(page.getByRole("heading", { name: "Pickup completed" })).toBeVisible();
  expect(api.getPickup("507f1f77bcf86cd799439041")?.shipments.flatMap((shipment) => shipment.parcels).every((parcel) => parcel.status === "COLLECTED")).toBe(true);
  expect(api.actions.filter((action) => action.path.endsWith("/status")).map((action) => (action.body as Record<string, unknown>).status)).toEqual(["ACCEPTED", "EN_ROUTE", "ARRIVED", "COLLECTING"]);
  expect(api.actions.some((action) => action.path.endsWith("/otp/verify"))).toBe(true);
  expect(api.actions.some((action) => action.path.endsWith("/complete"))).toBe(true);

  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByText("Collected", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Complete pickup at Delhi hub" }).click();
  await expect(page.getByText("Received at Delhi hub", { exact: true }).first()).toBeVisible();

  api.setRole("client");
  await page.goto("/client/pickups");
  await expect(page.getByText("Received at Delhi hub", { exact: true }).first()).toBeVisible();
});

test("staff can close a pickup with one parcel not received at Delhi hub", async ({ page }) => {
  const api = await createPickupApiMock(page);
  await page.goto("/client/pickups");
  await page.getByRole("checkbox").first().check();
  await completeRequiredPickupFields(page, "MORNING");
  await page.getByLabel("Transport / courier company").selectOption("DHL");
  await page.getByRole("button", { name: "Submit pickup request" }).click();
  await expect.poll(() => api.submissions.length).toBe(1);

  api.setRole("operations");
  await page.goto("/dashboard/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await page.getByRole("button", { name: "Approve pickup" }).click();
  await page.getByRole("button", { name: "Mark pickup started" }).click();
  await expect(page.getByRole("checkbox", { name: "SLCDELTEST0001-1" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "SLCDELTEST0001-2" })).toBeChecked();
  await page.getByRole("checkbox", { name: "SLCDELTEST0001-2" }).uncheck();
  await page.getByRole("button", { name: "Complete pickup at Delhi hub" }).click();
  await expect(page.getByText("Completed - parcels missing", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("1 of 2 parcels received at Delhi hub when this pickup closed")).toBeVisible();
  await expect(page.getByText("SLCDELTEST0001-2 - not received at pickup completion")).toBeVisible();
  expect(api.actions.findLast((action) => action.path.endsWith("/status"))?.body).toMatchObject({
    status: "RECEIVED_AT_DELHI_HUB",
    receivedParcels: [{ shipmentDraftId: "507f1f77bcf86cd799439021", parcelNumber: "SLCDELTEST0001-1" }],
  });

  api.setRole("client");
  await page.goto("/client/pickups");
  await page.getByRole("button", { name: /PU-TEST-01/ }).click();
  await expect(page.getByText("Completed - parcels missing", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("SLCDELTEST0001-2 - not received at pickup completion")).toBeVisible();
});
