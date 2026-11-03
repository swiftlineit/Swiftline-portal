import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { ShipmentDraft, type ShipmentAddressSnapshot } from "../models/shipmentDraft.model.js";
import {
  GoogleAddressValidationError,
  validateGoogleAddress
} from "../services/googleAddressValidation.service.js";
import {
  GooglePlacesError,
  autocompleteAddresses as autocompleteGoogleAddresses,
  getPlaceAddressDetails as getGooglePlaceAddressDetails
} from "../services/googlePlaces.service.js";
import {
  IdealPostcodesError,
  autocompleteUkAddresses,
  getPlaceAddressDetails,
  validateUkAddressWithPaf
} from "../services/idealPostcodes.service.js";
import { validateShipmentDraftFields } from "../services/shipmentValidation.service.js";
import {
  assertShipmentDraftMutationAllowed,
  ShipmentDraftPolicyError
} from "../services/shipmentDraftPolicy.service.js";
import { getOperatorContext } from "../middleware/operatorContext.middleware.js";

const autocompleteSchema = z.object({
  input: z.string().trim().min(2).max(120)
});

const placeIdSchema = z.string().trim().min(1).max(255);

const addressValidationSchema = z.object({
  shipmentDraftId: z.string().trim().optional(),
  address: z.object({
    addressLine1: z.string().trim().min(1).max(120),
    addressLine2: z.string().trim().max(120).optional().default(""),
    townOrCity: z.string().trim().min(1).max(80),
    county: z.string().trim().max(80).optional().default(""),
    postcode: z.string().trim().toUpperCase().min(1).max(20),
    countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
    countryName: z.string().trim().max(80).optional().default("")
  })
});

const addressConfirmationSchema = z.object({
  shipmentDraftId: z.string().trim().refine((value) => mongoose.Types.ObjectId.isValid(value), "Invalid shipment draft id"),
  decision: z.enum(["USE_SUGGESTED", "KEEP_ENTERED"])
});

function getAuthenticatedUserId(request: Request): mongoose.Types.ObjectId | null {
  const user = (request as Request & { user?: { _id?: unknown } }).user;
  const id = user?._id;

  return id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;
}

function getAuthenticatedPortalRole(request: Request) {
  const operator = getOperatorContext(request);
  if (operator) {
    if (operator.role === "OPERATOR_ADMIN") return "admin";
    if (operator.role === "OPERATIONS") return "operations";
    if (operator.role === "CLIENT") return "client";
    return "finance";
  }
  const user = (request as Request & { user?: { role?: unknown } }).user;
  return typeof user?.role === "string" ? user.role : "";
}

function sendDraftPolicyError(response: Response, error: unknown) {
  return error instanceof ShipmentDraftPolicyError
    ? response.status(error.statusCode).json({ success: false, message: error.message })
    : null;
}

async function writeAddressAuditLog(
  action:
    | "ADDRESS_SELECTED"
    | "ADDRESS_MANUALLY_MODIFIED"
    | "ADDRESS_VALIDATED"
    | "SUGGESTED_ADDRESS_ACCEPTED"
    | "SUGGESTED_ADDRESS_REJECTED",
  shipmentDraftId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId,
  metadata: Record<string, unknown>
) {
  await AuditLog.create({
    action,
    entityType: "SHIPMENT_DRAFT",
    entityId: shipmentDraftId,
    performedBy: userId,
    performedAt: new Date(),
    metadata
  });
}

type FieldChange = {
  fieldName: string;
  originalValue: unknown;
  newValue: unknown;
  changedBy: string;
  changedAt: string;
  source: "manual";
};

function valuesDiffer(originalValue: unknown, newValue: unknown) {
  return JSON.stringify(originalValue ?? "") !== JSON.stringify(newValue ?? "");
}

function getManualAddressChanges(params: {
  originalAddress: Record<string, unknown>;
  nextAddress: Record<string, unknown>;
  userId: mongoose.Types.ObjectId;
  changedAt: string;
}) {
  const fields = ["addressLine1", "addressLine2", "townOrCity", "county", "postcode", "countryCode"];
  const changes: FieldChange[] = [];

  for (const fieldName of fields) {
    const originalValue = params.originalAddress[fieldName] ?? "";
    const newValue = params.nextAddress[fieldName] ?? "";

    if (!valuesDiffer(originalValue, newValue)) continue;

    changes.push({
      fieldName: `consigneeEnteredAddress.${fieldName}`,
      originalValue,
      newValue,
      changedBy: String(params.userId),
      changedAt: params.changedAt,
      source: "manual"
    });
  }

  return changes;
}

function getSuggestedAddressFromDraft(draft: { addressValidationResult: Record<string, unknown> }) {
  const suggestedAddress = draft.addressValidationResult.suggestedAddress;
  if (!suggestedAddress || typeof suggestedAddress !== "object") return null;

  const address = suggestedAddress as Record<string, unknown>;
  const optionalText = (field: string) => typeof address[field] === "string" ? address[field] as string : undefined;
  return {
    addressLine1: optionalText("addressLine1"),
    addressLine2: optionalText("addressLine2"),
    townOrCity: optionalText("townOrCity"),
    county: optionalText("county"),
    postcode: optionalText("postcode"),
    countryCode: optionalText("countryCode"),
    countryName: optionalText("countryName")
  };
}

function getProviderErrorResponse(error: unknown) {
  if (
    error instanceof IdealPostcodesError
    || error instanceof GoogleAddressValidationError
    || error instanceof GooglePlacesError
  ) {
    return {
      statusCode: error.statusCode,
      body: {
        success: false,
        message: error.message
      }
    };
  }

  return {
    statusCode: 502,
    body: {
      success: false,
      message: "Address service is temporarily unavailable."
    }
  };
}

function mergeSelectedAddressWithDraft(
  currentAddress: ShipmentAddressSnapshot,
  selectedAddress: {
    companyName?: string;
    addressLine1: string;
    addressLine2: string;
    townOrCity: string;
    county: string;
    postcode: string;
    countryCode: "GB";
    countryName: string;
  }
): ShipmentAddressSnapshot {
  return {
    ...currentAddress,
    // PAF organisation data identifies the premises, not necessarily the
    // consignee. Customer identity fields always remain user-controlled.
    companyName: currentAddress.companyName || "",
    countryCode: "GB",
    countryName: "United Kingdom",
    postcode: selectedAddress.postcode || currentAddress.postcode,
    addressLine1: selectedAddress.addressLine1 || currentAddress.addressLine1,
    addressLine2: selectedAddress.addressLine2 || currentAddress.addressLine2 || "",
    townOrCity: selectedAddress.townOrCity || currentAddress.townOrCity,
    county: selectedAddress.county || currentAddress.county || ""
  };
}

function buildPafValidationFallback(address: {
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  postcode: string;
  countryCode: "GB";
}, providerStatusCode: number) {
  return {
    outcome: "VALID" as const,
    enteredAddress: address,
    suggestedAddress: {
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 ?? "",
      townOrCity: address.townOrCity,
      county: address.county ?? "",
      postcode: address.postcode,
      countryCode: "GB" as const,
      countryName: "United Kingdom"
    },
    missingComponents: [],
    unconfirmedComponents: [],
    formattedAddress: [
      address.addressLine1,
      address.addressLine2 ?? "",
      address.townOrCity,
      address.county ?? "",
      address.postcode
    ].filter(Boolean).join(", "),
    providerResult: {
      provider: "ideal_postcodes",
      googleAddressValidationUnavailable: true,
      googleStatusCode: providerStatusCode
    }
  };
}

function buildManualConfirmationResult(address: {
  addressLine1: string;
  addressLine2?: string;
  townOrCity: string;
  county?: string;
  postcode: string;
  countryCode: "GB";
}, providerStatusCode: number) {
  return {
    outcome: "UNAVAILABLE" as const,
    enteredAddress: address,
    missingComponents: [],
    unconfirmedComponents: [],
    formattedAddress: [
      address.addressLine1,
      address.addressLine2 ?? "",
      address.townOrCity,
      address.county ?? "",
      address.postcode
    ].filter(Boolean).join(", "),
    providerResult: {
      provider: "manual_confirmation",
      automaticVerificationUnavailable: true,
      providerStatusCode
    }
  };
}

export async function autocompleteAddress(request: Request, response: Response): Promise<Response> {
  const parsed = autocompleteSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  try {
    const predictions = await autocompleteUkAddresses(parsed.data.input);

    return response.status(200).json({
      success: true,
      predictions
    });
  } catch (error) {
    const providerError = getProviderErrorResponse(error);
    return response.status(providerError.statusCode).json(providerError.body);
  }
}

export async function getPlaceAddress(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = placeIdSchema.safeParse(request.params.placeId);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid place id" });

  const shipmentDraftId = typeof request.query.shipmentDraftId === "string" ? request.query.shipmentDraftId : "";
  if (shipmentDraftId && getOperatorContext(request)?.accessMode === "PLATFORM_SUPPORT") {
    return response.status(403).json({ success: false, message: "Operator support access is read-only." });
  }

  try {
    const place = await getPlaceAddressDetails(parsed.data);
    let responsePlace = place;

    if (shipmentDraftId && mongoose.Types.ObjectId.isValid(shipmentDraftId)) {
      const draft = await ShipmentDraft.findById(shipmentDraftId).exec();

      if (draft) {
        try {
          await assertShipmentDraftMutationAllowed({
            draft,
            userId,
            portalRole: getAuthenticatedPortalRole(request)
          });
        } catch (error) {
          const policyResponse = sendDraftPolicyError(response, error);
          if (policyResponse) return policyResponse;
          throw error;
        }

        const selectedAddress = mergeSelectedAddressWithDraft(draft.consigneeEnteredAddress, place.address);

        draft.googlePlaceId = place.placeId;
        draft.consigneeEnteredAddress = selectedAddress;
        draft.consigneeSelectedAddress = selectedAddress;
        draft.consigneeValidatedAddress = selectedAddress;
        draft.addressValidationStatus = "VALIDATED";
        draft.status = "ADDRESS_VALIDATED";
        draft.validationIssues = [];
        draft.addressValidationResult = {
          outcome: "VALID",
          provider: "ideal_postcodes",
          source: "PAF",
          formattedAddress: place.formattedAddress,
          udprn: place.udprn
        };
        await draft.save();
        responsePlace = {
          ...place,
          address: {
            addressLine1: selectedAddress.addressLine1,
            addressLine2: selectedAddress.addressLine2 ?? "",
            townOrCity: selectedAddress.townOrCity,
            county: selectedAddress.county ?? "",
            postcode: selectedAddress.postcode,
            countryCode: "GB",
            countryName: "United Kingdom"
          }
        };

        await writeAddressAuditLog("ADDRESS_SELECTED", draft._id as mongoose.Types.ObjectId, userId, {
          provider: "ideal_postcodes",
          idealUdprn: place.udprn,
          addressId: place.placeId,
          formattedAddress: place.formattedAddress
        });
      }
    }

    return response.status(200).json({
      success: true,
      place: responsePlace
    });
  } catch (error) {
    const providerError = getProviderErrorResponse(error);
    return response.status(providerError.statusCode).json(providerError.body);
  }
}

// Consignors are Indian senders, so their lookup runs on Google Places rather
// than the Ideal Postcodes PAF used for UK consignee delivery addresses.
export async function autocompleteConsignorAddress(request: Request, response: Response): Promise<Response> {
  const parsed = autocompleteSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  try {
    const predictions = await autocompleteGoogleAddresses(parsed.data.input, "in");

    return response.status(200).json({ success: true, predictions });
  } catch (error) {
    const providerError = getProviderErrorResponse(error);
    return response.status(providerError.statusCode).json(providerError.body);
  }
}

export async function getConsignorPlaceAddress(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = placeIdSchema.safeParse(request.params.placeId);
  if (!parsed.success) return response.status(400).json({ success: false, message: "Invalid place id" });

  const shipmentDraftId = typeof request.query.shipmentDraftId === "string" ? request.query.shipmentDraftId : "";
  if (shipmentDraftId && getOperatorContext(request)?.accessMode === "PLATFORM_SUPPORT") {
    return response.status(403).json({ success: false, message: "Operator support access is read-only." });
  }

  try {
    const place = await getGooglePlaceAddressDetails(parsed.data, "in");

    if (shipmentDraftId && mongoose.Types.ObjectId.isValid(shipmentDraftId)) {
      const draft = await ShipmentDraft.findById(shipmentDraftId).exec();

      if (draft) {
        try {
          await assertShipmentDraftMutationAllowed({
            draft,
            userId,
            portalRole: getAuthenticatedPortalRole(request)
          });
        } catch (error) {
          const policyResponse = sendDraftPolicyError(response, error);
          if (policyResponse) return policyResponse;
          throw error;
        }

        const currentConsignor = draft.consignorAddress ?? ({} as typeof draft.consignorAddress);

        // Places data describes the premises, never the person, so identity fields
        // stay exactly as the user typed them.
        draft.consignorAddress = {
          ...currentConsignor,
          addressLine1: place.address.addressLine1 || currentConsignor.addressLine1,
          addressLine2: place.address.addressLine2 || currentConsignor.addressLine2 || "",
          townOrCity: place.address.townOrCity || currentConsignor.townOrCity,
          county: place.address.county || currentConsignor.county || "",
          postcode: place.address.postcode || currentConsignor.postcode
        } as typeof draft.consignorAddress;
        draft.consignorPlaceId = place.placeId;
        draft.validationIssues = validateShipmentDraftFields(draft);
        await draft.save();

        await writeAddressAuditLog("ADDRESS_SELECTED", draft._id as mongoose.Types.ObjectId, userId, {
          provider: "google_places",
          party: "CONSIGNOR",
          addressId: place.placeId,
          formattedAddress: place.formattedAddress
        });

        return response.status(200).json({
          success: true,
          place: {
            placeId: place.placeId,
            formattedAddress: place.formattedAddress,
            address: {
              addressLine1: draft.consignorAddress.addressLine1,
              addressLine2: draft.consignorAddress.addressLine2 ?? "",
              townOrCity: draft.consignorAddress.townOrCity,
              county: draft.consignorAddress.county ?? "",
              postcode: draft.consignorAddress.postcode,
              countryCode: "IN",
              countryName: "India"
            }
          }
        });
      }
    }

    return response.status(200).json({ success: true, place });
  } catch (error) {
    const providerError = getProviderErrorResponse(error);
    return response.status(providerError.statusCode).json(providerError.body);
  }
}

export async function validateAddress(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = addressValidationSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  let result;
  const isUkAddress = parsed.data.address.countryCode === "GB";

  if (!isUkAddress) {
    result = {
      outcome: "VALID" as const,
      enteredAddress: parsed.data.address,
      suggestedAddress: parsed.data.address,
      missingComponents: [],
      unconfirmedComponents: [],
      formattedAddress: [
        parsed.data.address.addressLine1,
        parsed.data.address.addressLine2,
        parsed.data.address.townOrCity,
        parsed.data.address.county,
        parsed.data.address.postcode,
        parsed.data.address.countryName
      ].filter(Boolean).join(", "),
      providerResult: { provider: "manual_confirmation" }
    };
  } else {
    const ukAddress = { ...parsed.data.address, countryCode: "GB" as const };
    try {
      result = await validateGoogleAddress(ukAddress);
    } catch (error) {
      if (
        error instanceof GoogleAddressValidationError
        && parsed.data.shipmentDraftId
        && mongoose.Types.ObjectId.isValid(parsed.data.shipmentDraftId)
      ) {
        const draft = await ShipmentDraft.findById(parsed.data.shipmentDraftId).exec();

        if (draft?.consigneeSelectedAddress) {
          result = buildPafValidationFallback(ukAddress, error.statusCode);
        } else {
          try {
            result = await validateUkAddressWithPaf(ukAddress);
          } catch (fallbackError) {
            const providerError = getProviderErrorResponse(fallbackError);
            result = buildManualConfirmationResult(ukAddress, providerError.statusCode);
          }
        }
      } else {
        const providerError = getProviderErrorResponse(error);
        return response.status(providerError.statusCode).json(providerError.body);
      }
    }
  }

  try {
    if (parsed.data.shipmentDraftId && mongoose.Types.ObjectId.isValid(parsed.data.shipmentDraftId)) {
      const draft = await ShipmentDraft.findById(parsed.data.shipmentDraftId).exec();

      if (draft) {
        try {
          await assertShipmentDraftMutationAllowed({
            draft,
            userId,
            portalRole: getAuthenticatedPortalRole(request)
          });
        } catch (error) {
          const policyResponse = sendDraftPolicyError(response, error);
          if (policyResponse) return policyResponse;
          throw error;
        }

        const changedAt = new Date().toISOString();
        const changedFields = getManualAddressChanges({
          originalAddress: { ...draft.consigneeEnteredAddress } as Record<string, unknown>,
          nextAddress: parsed.data.address,
          userId,
          changedAt
        });

        draft.consigneeEnteredAddress = {
          ...draft.consigneeEnteredAddress,
          ...parsed.data.address,
          countryName: parsed.data.address.countryName
            || draft.consigneeEnteredAddress.countryName
            || (isUkAddress ? "United Kingdom" : parsed.data.address.countryCode)
        };
        draft.addressValidationResult = { ...result };

        if (result.outcome === "VALID") {
          draft.addressValidationStatus = "VALIDATED";
          draft.consigneeValidatedAddress = isUkAddress
            ? mergeSelectedAddressWithDraft(
              draft.consigneeEnteredAddress,
              {
                addressLine1: result.suggestedAddress?.addressLine1 ?? draft.consigneeEnteredAddress.addressLine1,
                addressLine2: result.suggestedAddress?.addressLine2 ?? draft.consigneeEnteredAddress.addressLine2 ?? "",
                townOrCity: result.suggestedAddress?.townOrCity ?? draft.consigneeEnteredAddress.townOrCity,
                county: result.suggestedAddress?.county ?? draft.consigneeEnteredAddress.county ?? "",
                postcode: result.suggestedAddress?.postcode ?? draft.consigneeEnteredAddress.postcode,
                countryCode: "GB",
                countryName: "United Kingdom"
              }
            )
            : { ...draft.consigneeEnteredAddress };
          draft.status = "ADDRESS_VALIDATED";
          draft.validationIssues = [];
        } else if (result.outcome === "CORRECTION_SUGGESTED") {
          draft.addressValidationStatus = "CORRECTION_SUGGESTED";
          draft.status = "ADDRESS_INCOMPLETE";
          draft.validationIssues = ["Google recommends a corrected version of this address."];
        } else {
          draft.addressValidationStatus = "INCOMPLETE";
          draft.status = "ADDRESS_INCOMPLETE";
          draft.validationIssues = result.missingComponents.length
            ? result.missingComponents.map((component) => `Address component needs review: ${component}`)
            : ["Add the missing building, street or town information."];
        }

        await draft.save();

        if (changedFields.length) {
          await writeAddressAuditLog("ADDRESS_MANUALLY_MODIFIED", draft._id as mongoose.Types.ObjectId, userId, {
            changedFields,
            changeCount: changedFields.length
          });
        }

        await writeAddressAuditLog("ADDRESS_VALIDATED", draft._id as mongoose.Types.ObjectId, userId, {
          outcome: result.outcome,
          missingComponents: result.missingComponents,
          unconfirmedComponents: result.unconfirmedComponents
        });
      }
    }

    return response.status(200).json({
      success: true,
      validation: result
    });
  } catch (error) {
    const providerError = getProviderErrorResponse(error);
    return response.status(providerError.statusCode).json(providerError.body);
  }
}

export async function confirmValidatedAddress(request: Request, response: Response): Promise<Response> {
  const userId = getAuthenticatedUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });

  const parsed = addressConfirmationSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, errors: parsed.error.format() });

  const draft = await ShipmentDraft.findById(parsed.data.shipmentDraftId).exec();
  if (!draft) return response.status(404).json({ success: false, message: "Shipment draft not found" });

  try {
    await assertShipmentDraftMutationAllowed({
      draft,
      userId,
      portalRole: getAuthenticatedPortalRole(request)
    });
  } catch (error) {
    const policyResponse = sendDraftPolicyError(response, error);
    if (policyResponse) return policyResponse;
    throw error;
  }

  const canKeepEnteredAddress = parsed.data.decision === "KEEP_ENTERED"
    && ["INCOMPLETE", "UNAVAILABLE"].includes(draft.addressValidationStatus);

  if (!["CORRECTION_SUGGESTED", "VALIDATED"].includes(draft.addressValidationStatus) && !canKeepEnteredAddress) {
    return response.status(409).json({
      success: false,
      message: "Address must be validated before it can be confirmed."
    });
  }

  const suggestedAddress = getSuggestedAddressFromDraft(draft);
  const usingSuggested = parsed.data.decision === "USE_SUGGESTED";

  if (usingSuggested && !suggestedAddress) {
    return response.status(400).json({
      success: false,
      message: "No suggested address is available for this shipment."
    });
  }

  draft.consigneeValidatedAddress = usingSuggested
    ? mergeSelectedAddressWithDraft(draft.consigneeEnteredAddress, {
      addressLine1: suggestedAddress?.addressLine1 ?? draft.consigneeEnteredAddress.addressLine1,
      addressLine2: suggestedAddress?.addressLine2 ?? draft.consigneeEnteredAddress.addressLine2 ?? "",
      townOrCity: suggestedAddress?.townOrCity ?? draft.consigneeEnteredAddress.townOrCity,
      county: suggestedAddress?.county ?? draft.consigneeEnteredAddress.county ?? "",
      postcode: suggestedAddress?.postcode ?? draft.consigneeEnteredAddress.postcode,
      countryCode: "GB",
      countryName: "United Kingdom"
    })
    : {
      ...draft.consigneeEnteredAddress,
      countryCode: "GB",
      countryName: "United Kingdom"
    };
  draft.addressValidationStatus = "VALIDATED";
  draft.status = "ADDRESS_VALIDATED";
  draft.validationIssues = [];
  draft.addressValidationResult = {
    ...draft.addressValidationResult,
    manualConfirmation: usingSuggested ? undefined : {
      confirmed: true,
      confirmedBy: String(userId),
      confirmedAt: new Date().toISOString()
    }
  };
  await draft.save();

  await writeAddressAuditLog(
    usingSuggested
      ? "SUGGESTED_ADDRESS_ACCEPTED"
      : suggestedAddress
        ? "SUGGESTED_ADDRESS_REJECTED"
        : "ADDRESS_VALIDATED",
    draft._id as mongoose.Types.ObjectId,
    userId,
    {
      decision: parsed.data.decision,
      validationMethod: usingSuggested ? "provider_suggestion" : "manual_confirmation"
    }
  );

  return response.status(200).json({
    success: true,
    shipmentDraft: draft
  });
}
