declare const __VB_DESKTOP_DEV__: boolean;

interface DesktopBridge {
  getState(): Promise<{
    dev: boolean;
    baseUrl: string;
    phase: "online" | "offline" | "paused" | "unbound";
    bytesToday: number;
    allowFakeIp: boolean;
    openAtLogin: boolean;
    bound: boolean;
  }>;
  setBase(url: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

interface Window {
  viateDesktop: DesktopBridge;
}
