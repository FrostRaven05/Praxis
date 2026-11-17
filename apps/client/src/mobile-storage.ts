import { mobileStorage as nativeStorage } from "../../../packages/storage-mobile/src/native";
import { createRecoveringMobileStorage } from "./mobile-storage-recovery";
export { mobileDatabaseName } from "../../../packages/storage-mobile/src/native";

export const mobileStorage = createRecoveringMobileStorage(nativeStorage);
