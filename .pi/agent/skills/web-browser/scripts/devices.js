import { readStateRecord, updateState } from "./shared.js";

const iphoneUA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const androidUA =
  "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36";
export const devices = Object.fromEntries(
  [
    ["iphone-se", 375, 667, 2, iphoneUA],
    ["iphone-14", 390, 844, 3, iphoneUA],
    ["iphone-15", 393, 852, 3, iphoneUA],
    ["pixel-7", 412, 915, 2.625, androidUA],
    ["pixel-8", 412, 915, 2.625, androidUA],
    ["galaxy-s20", 360, 800, 3, androidUA],
    ["galaxy-s24", 384, 832, 3, androidUA],
  ].map(([id, width, height, deviceScaleFactor, userAgent]) => [
    id,
    { id, mode: "mobile", width, height, deviceScaleFactor, userAgent },
  ]),
);
export function resolveDevice(spec, mode = "mobile") {
  if (spec === undefined) return undefined;
  if (/^(none|desktop|off)$/i.test(spec)) return null;
  if (devices[spec.toLowerCase()]) return { ...devices[spec.toLowerCase()] };
  const match =
    /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?(?:\/(portrait|landscape))?$/i.exec(spec);
  if (!match)
    throw new Error(
      `Unknown device: ${spec}. Use ${Object.keys(devices).join(", ")}, WIDTHxHEIGHT[@DPR], or none.`,
    );
  let width = Number(match[1]),
    height = Number(match[2]);
  const dpr = Number(match[3] || (mode === "mobile" ? 2 : 1));
  if (
    width < 100 ||
    height < 100 ||
    width > 7680 ||
    height > 7680 ||
    dpr < 0.5 ||
    dpr > 4
  )
    throw new Error("Viewport dimensions must be 100–7680 and DPR 0.5–4");
  if (match[4]?.toLowerCase() === "landscape")
    [width, height] = [Math.max(width, height), Math.min(width, height)];
  if (match[4]?.toLowerCase() === "portrait")
    [width, height] = [Math.min(width, height), Math.max(width, height)];
  return {
    id: spec,
    mode,
    width,
    height,
    deviceScaleFactor: dpr,
    userAgent: mode === "mobile" ? androidUA : "",
  };
}
export function deviceArgs(argv) {
  let device;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--device", "--viewport"].includes(argv[i])) {
      if (device !== undefined)
        throw new Error("Use only one of --device or --viewport");
      const flag = argv[i];
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
      device = resolveDevice(
        value,
        flag === "--viewport" ? "responsive" : "mobile",
      );
    } else rest.push(argv[i]);
  }
  return { argv: rest, device };
}
export const readActiveDevice = (targetId) =>
  readStateRecord().emulation?.[targetId] ?? null;
export function storeActiveDevice(targetId, device) {
  updateState((state) => {
    state.emulation ||= {};
    state.emulation[targetId] = device;
  });
}
export function deviceNote(device) {
  return device
    ? `${device.mode} ${device.id} (${device.width}x${device.height}@${device.deviceScaleFactor})`
    : "desktop 1280x800@1";
}
export async function applyDevice(cdp, sessionId, device) {
  const mobile = device?.mode === "mobile";
  const width = device?.width ?? 1280,
    height = device?.height ?? 800;
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    {
      width,
      height,
      deviceScaleFactor: device?.deviceScaleFactor ?? 1,
      mobile,
      screenWidth: width,
      screenHeight: height,
      screenOrientation:
        width > height
          ? { type: "landscapePrimary", angle: 90 }
          : { type: "portraitPrimary", angle: 0 },
    },
    sessionId,
  );
  await cdp.send(
    "Emulation.setTouchEmulationEnabled",
    { enabled: mobile, ...(mobile ? { maxTouchPoints: 5 } : {}) },
    sessionId,
  );
  // Do not force a language. Reset UA AND platform on responsive/desktop transitions.
  await cdp.send(
    "Emulation.setUserAgentOverride",
    {
      userAgent: mobile ? device.userAgent : "",
      platform: mobile
        ? /iPhone/.test(device.userAgent)
          ? "iPhone"
          : "Linux armv8l"
        : "",
    },
    sessionId,
  );
}
