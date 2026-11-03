import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount, type IBusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { type IStaffProfile, User } from "../models/user.model.js";
import { comparePassword, hashPassword } from "../services/auth.service.js";
import { isSupportedImage } from "../services/storage/fileSignature.js";
import {
  StorageObjectNotFoundError,
  deleteObject,
  profileImageKey,
  putObject,
  streamObjectToResponse
} from "../services/storage/storage.service.js";
import { normalizeUserPhone } from "../services/userIdentity.service.js";
import { serializeStaffProfile } from "./staff.controller.js";
import {
  emailValidationMessage,
  getPostalCodeValidationMessage,
  isHttpOrHttpsUrl,
  isValidBusinessContactEmail,
  isValidPhoneForCountryCode,
  isValidPostalCodeForCountry,
  phoneValidationMessage
} from "../services/businessAccountRules.js";

/** Business-account roles allowed to maintain their account's own details. */
const accountEditorRoles = new Set(["account_owner", "account_admin"]);

/**
 * People type a number the way they read it- "+91 87450 63206"- while it is
 * stored and compared as digits. Separators are dropped before the length is
 * counted so the same number cannot be valid on the staff form, which already
 * accepts them, and invalid here. Mirrored in the frontend's validateProfileUser.
 */
function compactPhone(value: string) {
  return value.replace(/[\s\-()]/g, "");
}

export function isValidProfilePhone(value: string) {
  // Emptiness is judged after separators are removed, so a value of only spaces
  // reads as "not provided" here exactly as it does in the frontend twin.
  const compact = compactPhone(value);
  return !compact || /^\+?\d{6,15}$/.test(compact);
}

// Staff are onboarded in India, matching STAFF_DEFAULT_PHONE_COUNTRY, so a
// number entered without a country code is read as Indian rather than refused.
const PROFILE_DEFAULT_PHONE_COUNTRY = "IN" as const;

// Name bounds mirror the business-account contact rules so one person is not
// described two different ways across the portal.
const userDetailsSchema = z.object({
  firstName: z.string().trim().min(2, "First name must be at least 2 characters.").max(22),
  lastName: z.string().trim().max(22).default(""),
  phone: z.string().trim().max(20)
    .refine(isValidProfilePhone, "Enter a valid phone number, 6 to 15 digits.")
    .default(""),
  // Contact details a staff member maintains for themselves. Everything else on
  // the staff record (designation, dates, role, branches, documents, Aadhaar) is
  // HR/admin-owned and is only editable from the staff detail page.
  address: z.object({
    line1: z.string().trim().max(160).default(""),
    city: z.string().trim().max(80).default(""),
    state: z.string().trim().max(80).default(""),
    postalCode: z.string().trim().max(20)
      .refine((value) => !value || /^[0-9]{6}$/.test(value), "Enter a valid 6-digit PIN code.")
      .default("")
  }).optional(),
  emergencyContact: z.object({
    name: z.string().trim().max(80).default(""),
    phone: z.string().trim().max(20)
      .refine(isValidProfilePhone, "Enter a valid emergency contact number.")
      .default(""),
    relationship: z.enum(["parent", "spouse", "sibling", "child", "guardian", "friend", "other"]).or(z.literal("")).default("")
  }).optional()
});

/**
 * Only the fields that are safe to change after KYC. Company name, type,
 * registration id and GSTIN are deliberately absent: they are what the KYC
 * review and the credit agreement were signed against.
 *
 * Every rule here matches `businessAccountBodySchema` in the business account
 * controller field for field, so an edit made from the profile page cannot store
 * a value the account creation form would have rejected. The two country-aware
 * checks (postal code, phone) are applied in the handler because they need the
 * account's stored country, which is not editable here.
 */
const accountDetailsSchema = z.object({
  company: z.object({
    registeredAddress: z.string().trim().max(500).default(""),
    city: z.string().trim().max(80).default(""),
    stateOrProvince: z.string().trim().max(80).default(""),
    postalCode: z.string().trim().max(20).default(""),
    website: z.string().trim().url("Enter a valid website URL.")
      .refine(isHttpOrHttpsUrl, "Website must start with http:// or https://")
      .optional().or(z.literal("")).default(""),
    industry: z.string().trim().max(100).default(""),
    monthlyShipmentVolume: z.string().trim().max(80).default("")
  }),
  contact: z.object({
    title: z.enum(["mr.", "mrs.", "ms.", "dr.", "prof."]),
    firstName: z.string().trim().min(2).max(22),
    lastName: z.string().trim().min(1).max(22),
    email: z.string().trim().email().toLowerCase().refine(isValidBusinessContactEmail, emailValidationMessage),
    countryCode: z.string().trim().min(1).max(8),
    mobileNumber: z.string().trim().regex(/^\d{6,15}$/, "Mobile number must contain 6 to 15 digits"),
    jobTitle: z.string().trim().min(1, "Job title is required.").max(80),
    department: z.string().trim().min(1, "Department is required.").max(80)
  })
}).superRefine((data, context) => {
  if (!isValidPhoneForCountryCode(data.contact.countryCode, data.contact.mobileNumber)) {
    context.addIssue({ code: "custom", path: ["contact", "mobileNumber"], message: phoneValidationMessage });
  }
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password."),
  newPassword: z.string().min(8, "New password must be at least 8 characters.").max(128),
  confirmPassword: z.string().min(8).max(128)
}).refine((value) => value.newPassword === value.confirmPassword, {
  message: "New password and confirmation do not match.",
  path: ["confirmPassword"]
});

function getUserId(request: Request) {
  const value = (request as Request & { user?: { _id?: unknown } }).user?._id;
  return value && mongoose.Types.ObjectId.isValid(String(value))
    ? new mongoose.Types.ObjectId(String(value))
    : null;
}

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "The details provided are invalid.";
}

type BranchSummary = { _id: unknown; name?: string; code?: string };

/** The user fields the profile reads. `createdAt` comes from schema timestamps. */
type ProfileUser = {
  _id: unknown;
  firstName?: string;
  lastName?: string;
  name?: string;
  email: string;
  phone?: string;
  role: string;
  userStatus: string;
  isVerified?: boolean;
  emailVerifiedAt?: Date | null;
  lastLogin?: Date | null;
  createdAt?: Date | null;
  assignedBranches?: mongoose.Types.ObjectId[];
  staffProfile?: IStaffProfile | null;
  profileImage?: { storageKey?: string } | null;
};

function serializeBranches(branches: BranchSummary[]) {
  return branches.map((branch) => ({
    id: String(branch._id),
    name: branch.name ?? "",
    code: branch.code ?? ""
  }));
}

function serializeAccount(
  account: IBusinessAccount,
  membershipRole: string,
  joinedAt: Date | null,
  branches: BranchSummary[],
  accountAssignedBranch: BranchSummary | null
) {
  const company = account.company;
  const contact = account.contact;
  return {
    id: String(account._id),
    accountId: account.accountId,
    status: account.status,
    membershipRole,
    // Only owners and admins maintain the account; everyone else reads it.
    canEdit: accountEditorRoles.has(membershipRole),
    joinedAt,
    accountAssignedBranch: accountAssignedBranch ? serializeBranches([accountAssignedBranch])[0] ?? null : null,
    assignedBranches: serializeBranches(branches),
    company: {
      companyName: company.companyName ?? "",
      companyType: company.companyType ?? "",
      registrationCountry: company.registrationCountry ?? "",
      registrationIdType: company.registrationIdType ?? "",
      registrationId: company.registrationId ?? "",
      gstin: company.gstin ?? "",
      registeredAddress: company.registeredAddress ?? "",
      city: company.city ?? "",
      stateOrProvince: company.stateOrProvince ?? "",
      postalCode: company.postalCode ?? "",
      addressCountry: company.addressCountry ?? "",
      // Accounts registered without a company are not held to the company rules.
      noCompany: Boolean(company.noCompany),
      website: company.website ?? "",
      industry: company.industry ?? "",
      monthlyShipmentVolume: company.monthlyShipmentVolume ?? "",
      operatingCountries: company.operatingCountries ?? []
    },
    contact: {
      title: contact.title ?? "",
      firstName: contact.firstName ?? "",
      lastName: contact.lastName ?? "",
      email: contact.email ?? "",
      countryCode: contact.countryCode ?? "",
      mobileNumber: contact.mobileNumber ?? "",
      jobTitle: contact.jobTitle ?? "",
      department: contact.department ?? ""
    }
  };
}

async function loadProfile(userId: mongoose.Types.ObjectId) {
  const user = await User.findById(userId)
    .select("firstName lastName name email phone role userStatus isVerified emailVerifiedAt lastLogin assignedBranches createdAt staffProfile profileImage")
    .lean<ProfileUser>()
    .exec();
  if (!user) return null;

  const memberships = await BusinessAccountMember.find({ user: userId, status: "active" })
    .select("businessAccount role joinedAt assignedBranches")
    .lean()
    .exec();
  const accounts = memberships.length
    ? await BusinessAccount.find({ _id: { $in: memberships.map((membership) => membership.businessAccount) } })
      .lean<IBusinessAccount[]>()
      .exec()
    : [];
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));

  const branchIds = [
    ...(user.assignedBranches ?? []),
    ...memberships.flatMap((membership) => membership.assignedBranches ?? []),
    ...accounts.flatMap((account) => account.assignedBranch ? [account.assignedBranch] : [])
  ];
  const branches: BranchSummary[] = branchIds.length
    ? await Branch.find({ _id: { $in: branchIds } }).select("name code").lean<BranchSummary[]>().exec()
    : [];
  const branchById = new Map(branches.map((branch) => [String(branch._id), branch]));
  const resolveBranches = (ids: unknown[]) => ids
    .map((id) => branchById.get(String(id)))
    .filter((branch): branch is BranchSummary => Boolean(branch));

  // Staff invited by an admin carry only a display `name`, so the editable parts
  // are derived from it rather than shown blank.
  const [derivedFirst = "", ...derivedRest] = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = user.firstName || derivedFirst;
  const lastName = user.lastName || derivedRest.join(" ");

  return {
    user: {
      id: String(user._id),
      firstName,
      lastName,
      name: user.name ?? "",
      email: user.email,
      phone: user.phone ?? "",
      role: user.role,
      userStatus: user.userStatus,
      isVerified: Boolean(user.isVerified),
      emailVerifiedAt: user.emailVerifiedAt ?? null,
      lastLogin: user.lastLogin ?? null,
      createdAt: user.createdAt ?? null,
      hasProfileImage: Boolean(user.profileImage?.storageKey),
      assignedBranches: serializeBranches(resolveBranches(user.assignedBranches ?? [])),
      // Null for clients and for internal accounts created before the staff form.
      staffProfile: serializeStaffProfile(user.staffProfile)
    },
    businessAccounts: memberships.flatMap((membership) => {
      const account = accountById.get(String(membership.businessAccount));
      if (!account) return [];
      return [serializeAccount(
        account,
        membership.role,
        membership.joinedAt ?? null,
        resolveBranches(membership.assignedBranches ?? []),
        account.assignedBranch ? resolveBranches([account.assignedBranch])[0] ?? null : null
      )];
    })
  };
}

export async function getProfile(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const profile = await loadProfile(userId);
  if (!profile) return response.status(404).json({ success: false, message: "Profile not found." });
  return response.status(200).json({ success: true, ...profile });
}

export async function updateProfileDetails(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = userDetailsSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: firstIssue(parsed.error) });

  const { firstName, lastName, phone, address, emergencyContact } = parsed.data;

  // Stored in E.164, as staff.controller.ts does on create and edit, so the same
  // number typed as "+91 87450 63206" here and "+918745063206" there stays one
  // identity rather than two. The schema above has already accepted the shape;
  // this rejects numbers that are well-formed but not real.
  const normalizedPhone = phone ? normalizeUserPhone(phone, PROFILE_DEFAULT_PHONE_COUNTRY) : "";
  if (phone && !normalizedPhone) {
    return response.status(400).json({
      success: false,
      message: "Enter a valid phone number, for example +91 98765 43210."
    });
  }

  // A login is one identity across staff, drivers and clients, so this looks at
  // every user rather than only at staff- the same check the staff and driver
  // paths already make. Editing your own record must not be the way a number
  // already in use gets taken over. A blank number is skipped: "not provided"
  // is not a value that can collide.
  if (normalizedPhone && await User.exists({ _id: { $ne: userId }, phone: normalizedPhone })) {
    return response.status(409).json({
      success: false,
      message: "A user with this phone number already exists."
    });
  }

  // `name` is the display name the portal chrome shows, so it tracks the parts.
  const changes: Record<string, unknown> = {
    firstName,
    lastName,
    phone: normalizedPhone,
    name: [firstName, lastName].filter(Boolean).join(" ")
  };

  // The staff sub-document only exists for internal staff, and a positional
  // "staffProfile.address" write would create a partial record on users without
  // one. Both keys are therefore only set when a staff record is already there.
  const existing = await User.findById(userId).select("staffProfile").lean().exec();
  if (existing?.staffProfile) {
    if (address) changes["staffProfile.address"] = address;
    if (emergencyContact) changes["staffProfile.emergencyContact"] = emergencyContact;
  }

  const updated = await User.findByIdAndUpdate(
    userId,
    { $set: changes },
    { returnDocument: "after", runValidators: true }
  ).exec();
  if (!updated) return response.status(404).json({ success: false, message: "Profile not found." });

  await AuditLog.create({
    action: "USER_PROFILE_UPDATED",
    entityType: "USER",
    entityId: userId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { fields: Object.keys(changes) }
  });

  const profile = await loadProfile(userId);
  return response.status(200).json({ success: true, message: "Your details were updated.", ...profile });
}

export async function updateProfileBusinessAccount(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const accountId = typeof request.params.accountId === "string" ? request.params.accountId : "";
  if (!mongoose.Types.ObjectId.isValid(accountId)) {
    return response.status(404).json({ success: false, message: "Business account not found." });
  }
  const parsed = accountDetailsSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: firstIssue(parsed.error) });

  const membership = await BusinessAccountMember.findOne({
    user: userId,
    businessAccount: accountId,
    status: "active"
  }).select("role").lean().exec();
  if (!membership) return response.status(404).json({ success: false, message: "Business account not found." });
  if (!accountEditorRoles.has(membership.role)) {
    return response.status(403).json({
      success: false,
      message: "Only an account owner or account admin can update company details."
    });
  }

  const account = await BusinessAccount.findById(accountId).exec();
  if (!account) return response.status(404).json({ success: false, message: "Business account not found." });

  const { company, contact } = parsed.data;

  // The account creation form only demands the company block from accounts that
  // have a company, so an account registered without one keeps that freedom.
  if (!account.company.noCompany) {
    const requiredCompanyFields: Array<[keyof typeof company, string]> = [
      ["registeredAddress", "Registered address is required"],
      ["city", "City is required"],
      ["stateOrProvince", "State or province is required"],
      ["postalCode", "Postal code is required"],
      ["industry", "Company industry is required"],
      ["monthlyShipmentVolume", "Monthly shipment volume is required"]
    ];
    const missing = requiredCompanyFields.find(([field]) => !String(company[field] ?? "").trim());
    if (missing) return response.status(400).json({ success: false, message: `${missing[1]}.` });

    // The postal code format follows the account's registered country, which is
    // locked here, so it is read from the stored account rather than the body.
    const addressCountry = account.company.addressCountry?.trim() ?? "";
    if (addressCountry && !isValidPostalCodeForCountry(addressCountry, company.postalCode)) {
      return response.status(400).json({ success: false, message: getPostalCodeValidationMessage(addressCountry) });
    }
  }

  // Set field by field so the KYC-verified company fields are never touched,
  // whatever the request body contains.
  account.company.registeredAddress = company.registeredAddress;
  account.company.city = company.city;
  account.company.stateOrProvince = company.stateOrProvince;
  account.company.postalCode = company.postalCode;
  account.company.website = company.website;
  account.company.industry = company.industry;
  account.company.monthlyShipmentVolume = company.monthlyShipmentVolume;
  account.contact.title = contact.title;
  account.contact.firstName = contact.firstName;
  account.contact.lastName = contact.lastName;
  account.contact.email = contact.email;
  account.contact.countryCode = contact.countryCode;
  account.contact.mobileNumber = contact.mobileNumber;
  account.contact.jobTitle = contact.jobTitle;
  account.contact.department = contact.department;
  account.updatedBy = userId;
  await account.save();

  await AuditLog.create({
    action: "BUSINESS_ACCOUNT_PROFILE_UPDATED",
    entityType: "BUSINESS_ACCOUNT",
    entityId: account._id,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { source: "PROFILE", accountId: account.accountId, membershipRole: membership.role }
  });

  const profile = await loadProfile(userId);
  return response.status(200).json({ success: true, message: "Company details were updated.", ...profile });
}

export async function changeProfilePassword(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const parsed = passwordSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ success: false, message: firstIssue(parsed.error) });

  const user = await User.findById(userId).select("passwordHash").exec();
  if (!user) return response.status(404).json({ success: false, message: "Profile not found." });
  if (!user.passwordHash || !await comparePassword(parsed.data.currentPassword, user.passwordHash)) {
    return response.status(400).json({ success: false, message: "Your current password is incorrect." });
  }
  if (await comparePassword(parsed.data.newPassword, user.passwordHash)) {
    return response.status(400).json({ success: false, message: "Choose a password you have not used before." });
  }

  user.passwordHash = await hashPassword(parsed.data.newPassword);
  await user.save();

  await AuditLog.create({
    action: "USER_PASSWORD_CHANGED",
    entityType: "USER",
    entityId: userId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: {}
  });

  return response.status(200).json({ success: true, message: "Your password was updated." });
}

export async function uploadProfileImage(request: Request, response: Response) {
  const userId = getUserId(request);
  const file = request.file;
  // Nothing was written anywhere, so an early return needs no cleanup: the
  // upload is a buffer that goes out of scope.
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  if (!file) return response.status(400).json({ success: false, message: "Choose a profile image." });

  if (!isSupportedImage(file.buffer)) {
    return response.status(400).json({ success: false, message: "The selected file is not a valid JPG, PNG, or WebP image." });
  }

  const user = await User.findById(userId).select("profileImage").exec();
  if (!user) return response.status(404).json({ success: false, message: "Profile not found." });

  const storageKey = profileImageKey(String(userId), file.originalname);
  await putObject({
    key: storageKey,
    body: file.buffer,
    contentType: file.mimetype,
    originalName: file.originalname
  });

  const previousKey = user.profileImage?.storageKey;
  user.profileImage = {
    originalName: file.originalname,
    storageKey,
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date()
  };
  await user.save();
  // Only after the record points at the new object: a delete that ran first
  // would leave the user with no image at all if the save then failed.
  if (previousKey && previousKey !== storageKey) {
    await deleteObject(previousKey).catch(() => undefined);
  }

  await AuditLog.create({
    action: "USER_PROFILE_UPDATED",
    entityType: "USER",
    entityId: userId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { fields: ["profileImage"] }
  });
  return response.status(200).json({ success: true, message: "Profile image updated.", hasProfileImage: true });
}

export async function viewProfileImage(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const user = await User.findById(userId).select("profileImage").lean().exec();
  const storageKey = user?.profileImage?.storageKey;
  if (!storageKey) return response.status(404).json({ success: false, message: "Profile image not found." });

  try {
    await streamObjectToResponse({
      response,
      key: storageKey,
      contentType: user.profileImage?.mimeType || "application/octet-stream",
      filename: user.profileImage?.originalName || "profile-image",
      disposition: "inline"
    });
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return response.status(404).json({ success: false, message: "Profile image not found." });
    }
    throw error;
  }
}

export async function deleteProfileImage(request: Request, response: Response) {
  const userId = getUserId(request);
  if (!userId) return response.status(401).json({ success: false, message: "Unauthorized" });
  const user = await User.findById(userId).select("profileImage").exec();
  if (!user) return response.status(404).json({ success: false, message: "Profile not found." });
  const previousKey = user.profileImage?.storageKey;
  user.profileImage = null;
  await user.save();
  if (previousKey) await deleteObject(previousKey).catch(() => undefined);
  await AuditLog.create({
    action: "USER_PROFILE_UPDATED",
    entityType: "USER",
    entityId: userId,
    performedBy: userId,
    performedAt: new Date(),
    metadata: { fields: ["profileImage"], removed: true }
  });
  return response.status(200).json({ success: true, message: "Profile image removed.", hasProfileImage: false });
}
