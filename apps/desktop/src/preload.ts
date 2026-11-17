import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("viateDesktop", {
  getState: () => ipcRenderer.invoke("desktop:get-state"),
  setBase: (url: unknown) => {
    if (typeof url !== "string") return Promise.resolve({ ok: false, error: "地址无效" });
    return ipcRenderer.invoke("desktop:set-base", url);
  },
});
