import { Router } from "express";
import {
  confirmPublicShipmentPayment,
  createPublicShipmentPaymentOrder,
  createPublicShipmentQuote,
  deletePublicShipmentKycDocument,
  downloadPublicShipmentInvoice,
  downloadPublicShipmentLabel,
  getPublicShipmentBookingStatus,
  getPublicShipmentPolicies,
  listPublicShipmentLabels,
  savePublicShipmentBookingDraft,
  startPublicShipmentBooking,
  uploadPublicShipmentKycDocument,
} from "../controllers/publicShipmentBooking.controller.js";
import { publicShipmentBookingLimiter, publicShipmentPaymentLimiter } from "../middleware/rateLimit.middleware.js";
import { shipmentKycUpload } from "../middleware/shipmentKycUpload.middleware.js";
import { autocompleteLookup, getLookupPlace } from "../controllers/addressLookup.controller.js";
import { listCities, listStates, suggestHsCodes } from "../controllers/reference.controller.js";

export const publicShipmentBookingRouter = Router();

publicShipmentBookingRouter.use(publicShipmentBookingLimiter);
// Public forms use the same curated reference data and provider-backed address
// lookup as the internal booking flow. These routes remain narrowly scoped and
// inherit the stricter public booking rate limit above.
publicShipmentBookingRouter.get("/reference/hs-codes", suggestHsCodes);
publicShipmentBookingRouter.get("/reference/countries/:countryCode/states", listStates);
publicShipmentBookingRouter.get("/reference/countries/:countryCode/states/:stateCode/cities", listCities);
publicShipmentBookingRouter.post("/address-lookup/autocomplete", autocompleteLookup);
publicShipmentBookingRouter.get("/address-lookup/places/:placeId", getLookupPlace);
publicShipmentBookingRouter.get("/policies", getPublicShipmentPolicies);
publicShipmentBookingRouter.post("/session", startPublicShipmentBooking);
publicShipmentBookingRouter.get("/status", getPublicShipmentBookingStatus);
publicShipmentBookingRouter.get("/status/invoice", downloadPublicShipmentInvoice);
publicShipmentBookingRouter.get("/status/labels", listPublicShipmentLabels);
publicShipmentBookingRouter.get("/status/labels/:labelId", downloadPublicShipmentLabel);
publicShipmentBookingRouter.put("/draft", savePublicShipmentBookingDraft);
publicShipmentBookingRouter.post("/documents/:type", shipmentKycUpload, uploadPublicShipmentKycDocument);
publicShipmentBookingRouter.post("/parcels/:sequence/documents/:type", shipmentKycUpload, uploadPublicShipmentKycDocument);
publicShipmentBookingRouter.delete("/documents/:type", deletePublicShipmentKycDocument);
publicShipmentBookingRouter.delete("/parcels/:sequence/documents/:type", deletePublicShipmentKycDocument);
publicShipmentBookingRouter.post("/quote", createPublicShipmentQuote);
publicShipmentBookingRouter.post("/payments/order", publicShipmentPaymentLimiter, createPublicShipmentPaymentOrder);
publicShipmentBookingRouter.post("/payments/confirm", publicShipmentPaymentLimiter, confirmPublicShipmentPayment);
