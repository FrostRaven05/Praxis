import { invoke, isTauri } from "./native-recovery";
import { Capacitor, registerPlugin } from "@capacitor/core";
import {
  releaseOffer,
  type AppRelease,
  type ReleasePlatform,
} from "./app-release";

const native = registerPlugin<{
  appReleaseCheck(): Promise<{ current: string; release: AppRelease | null }>;
  appReleaseOpen(args: { url: string }): Promise<void>;
}>("LanSync");

export function releasePlatform(): ReleasePlatform {
  return Capacitor.getPlatform() === "android" ? "android" : "windows";
}

export function checkAppRelease() {
  if (isTauri())
    return invoke<{ current: string; release: AppRelease | null }>(
      "app_release_check",
    );
  if (Capacitor.isNativePlatform()) return native.appReleaseCheck();
  return Promise.resolve({
    current: "1.0.5",
    release: null as AppRelease | null,
  });
}

export function openAppRelease(url: string) {
  if (isTauri()) return invoke<void>("app_release_open", { url });
  if (Capacitor.isNativePlatform()) return native.appReleaseOpen({ url });
  window.open(url, "_blank", "noopener");
  return Promise.resolve();
}

export function describeRelease(
  current: string,
  release: AppRelease | null,
  platform: ReleasePlatform,
) {
  if (!release)
    return {
      text: "更新服务尚未就绪，可以继续使用当前版本。",
      url: null as string | null,
    };
  const offer = releaseOffer(current, release, platform);
  if (offer.state === "current")
    return { text: "当前已是最新版本。", url: null };
  if (offer.state === "unknown")
    return { text: "无法识别版本号。", url: null };
  if (!offer.url)
    return {
      text: offer.required
        ? `此版本已停止支持。${offer.version} 已发布，安装包尚未提供。`
        : `已发布 ${offer.version}，安装包尚未提供。`,
      url: null,
    };
  const notes = offer.notes ? `${offer.notes} ` : "";
  return {
    text: offer.required
      ? `${notes}此版本已停止支持，请安装 ${offer.version}。`
      : `${notes}可以安装 ${offer.version}。`,
    url: offer.url,
  };
}
