// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as HostProcess from "../HostProcess.ts";

// Windows short names and macOS /var aliases must match canonical filesystem paths.
if (["win32", "darwin"].includes(HostProcess.Platform.defaultValue())) {
  try {
    const longForm = NodeFS.realpathSync.native(NodeOS.tmpdir());
    if (HostProcess.Platform.defaultValue() === "darwin") {
      process.env.TMPDIR = longForm;
    } else {
      process.env.TEMP = longForm;
      process.env.TMP = longForm;
    }
  } catch {}
}
