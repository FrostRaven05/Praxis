import { invoke, isTauri } from "./native-recovery";
import { Capacitor, registerPlugin } from "@capacitor/core";
export interface AccountStatus {
  user: { id: string; email: string; displayName: string } | null;
  baseUrl: string;
  expiresAt: string | null;
}
export interface AccountLogin {
  mode: "login" | "register";
  baseUrl: string;
  email: string;
  password: string;
  displayName: string;
  caPem: string;
}
const native = registerPlugin<{
  accountStatus(): Promise<AccountStatus>;
  accountAuthenticate(login: AccountLogin): Promise<void>;
  accountLogout(): Promise<void>;
  accountChangePassword(change: {
    currentPassword: string;
    newPassword: string;
  }): Promise<void>;
}>("LanSync");
export const accountAvailable = isTauri() || Capacitor.isNativePlatform();
export const accountStorage = {
  status: (): Promise<AccountStatus> =>
    isTauri()
      ? invoke("account_status")
      : Capacitor.isNativePlatform()
        ? native.accountStatus()
        : Promise.resolve({ user: null, baseUrl: "", expiresAt: null }),
  authenticate: (login: AccountLogin): Promise<void> =>
    isTauri()
      ? invoke("account_authenticate", { login })
      : native.accountAuthenticate(login),
  logout: (): Promise<void> =>
    isTauri() ? invoke("account_logout") : native.accountLogout(),
  changePassword: (currentPassword: string, newPassword: string): Promise<void> =>
    isTauri()
      ? invoke("account_change_password", {
          change: { currentPassword, newPassword },
        })
      : native.accountChangePassword({ currentPassword, newPassword }),
  restart: async () => {
    if (isTauri()) await invoke("account_restart");
    else window.location.reload();
  },
};
