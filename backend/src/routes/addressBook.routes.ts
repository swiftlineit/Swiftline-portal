import { Router } from "express";
import {
  acceptAddressBookSuggestion,
  confirmAddressBookEntry,
  createAddressBookEntry,
  deleteAddressBookEntry,
  downloadAddressBookTemplate,
  duplicateAddressBookEntry,
  getAddressBookEntry,
  importAddressBookEntries,
  listAddressBookEntries,
  previewAddressBookImport,
  revealAddressBookAadhaar,
  setAddressBookFavourite,
  updateAddressBookEntry,
  validateAddressBookEntry
} from "../controllers/addressBook.controller.js";
import { addressBookImportUpload } from "../middleware/addressBookImportUpload.middleware.js";

export const addressBookRouter = Router();

addressBookRouter.get("/", listAddressBookEntries);
addressBookRouter.post("/", createAddressBookEntry);
addressBookRouter.get("/template/:format", downloadAddressBookTemplate);
addressBookRouter.post("/imports/preview", addressBookImportUpload, previewAddressBookImport);
addressBookRouter.post("/imports", importAddressBookEntries);
addressBookRouter.get("/:entryId", getAddressBookEntry);
addressBookRouter.patch("/:entryId", updateAddressBookEntry);
addressBookRouter.delete("/:entryId", deleteAddressBookEntry);
addressBookRouter.patch("/:entryId/favourite", setAddressBookFavourite);
addressBookRouter.post("/:entryId/duplicate", duplicateAddressBookEntry);
addressBookRouter.post("/:entryId/aadhaar/reveal", revealAddressBookAadhaar);
addressBookRouter.post("/:entryId/validate", validateAddressBookEntry);
addressBookRouter.post("/:entryId/accept-suggestion", acceptAddressBookSuggestion);
addressBookRouter.post("/:entryId/confirm", confirmAddressBookEntry);
