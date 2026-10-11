// UUIDv5 URL namespace, matching the native scheduler's deterministic occurrence identities.
export function scheduleId(
  kind: "habit_check" | "task",
  ownerId: string,
  date: string,
): string {
  const name =
    kind === "habit_check"
      ? `praxis:habit_check:${JSON.stringify([ownerId, date])}`
      : `praxis:occurrence:${ownerId}:${date}`;
  return uuidFromName(name);
}
export const workspaceSettingsId = () =>
  uuidFromName("praxis:workspace_settings:{}");
function uuidFromName(name: string): string {
  const namespace = Uint8Array.from(
    "6ba7b8119dad11d180b400c04fd430c8".match(/../g)!,
    (h) => parseInt(h, 16),
  );
  const text = new TextEncoder().encode(name),
    length = 16 + text.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(namespace);
  padded.set(text, 16);
  padded[length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, length * 8);
  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476,
    h4 = 0xc3d2e1f0;
  const rotate = (v: number, n: number) => (v << n) | (v >>> (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Int32Array(80);
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 80; i++)
      words[i] = rotate(
        words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!,
        1,
      );
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4;
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20
          ? (b & c) | (~b & d)
          : i < 40
            ? b ^ c ^ d
            : i < 60
              ? (b & c) | (b & d) | (c & d)
              : b ^ c ^ d;
      const k =
        i < 20
          ? 0x5a827999
          : i < 40
            ? 0x6ed9eba1
            : i < 60
              ? 0x8f1bbcdc
              : 0xca62c1d6;
      const next = (rotate(a, 5) + f + e + k + words[i]!) | 0;
      e = d;
      d = c;
      c = rotate(b, 30);
      b = a;
      a = next;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  const bytes = new Uint8Array(16),
    out = new DataView(bytes.buffer);
  [h0, h1, h2, h3].forEach((v, i) => out.setInt32(i * 4, v));
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
