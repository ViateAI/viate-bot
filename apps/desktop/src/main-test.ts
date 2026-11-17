import { devPrivateAllowlist } from "./allow-private.js";
import { startDesktop } from "./main.js";

startDesktop({ allowPrivate: devPrivateAllowlist });
