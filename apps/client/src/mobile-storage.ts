import {
  mobileDatabaseName as nativeDatabaseName,
  mobileStorage as nativeStorage,
} from "../../../packages/storage-mobile/src/native";
import { isMobilePreview } from "./mobile-surface";
import { createPreviewMobileStorage } from "./mobile/preview-storage";
import { createRecoveringMobileStorage } from "./mobile-storage-recovery";

const preview = isMobilePreview() ? createPreviewMobileStorage() : null;

export const mobileDatabaseName = preview
  ? async () => "praxis"
  : nativeDatabaseName;

export const mobileStorage: typeof nativeStorage = preview
  ? (preview as unknown as typeof nativeStorage)
  : createRecoveringMobileStorage(nativeStorage);
