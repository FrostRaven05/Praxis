import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

/** The system chooser lets the user select where this local backup is saved. */
export async function exportMobileJson(json: string): Promise<void> {
  if (!json.trim()) throw new Error("请先生成导出内容。");
  JSON.parse(json);
  const file = await Filesystem.writeFile({
    path: `exports/praxis-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}.json`,
    data: json,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  await Share.share({
    title: "Praxis 本地数据备份",
    dialogTitle: "保存或分享备份文件",
    files: [file.uri],
  });
}
