// @effect-diagnostics nodeBuiltinImport:off - Compiles the dependency's native factory regression.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- This test needs Apple's Objective-C runtime.
it.skipIf(NodeOS.platform() !== "darwin")(
  "keeps overlapping Expo hosts isolated and drains mounts after the old context is released",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fabric-test-"));
    try {
      const core = new URL("../node_modules/expo-modules-core/ios/", import.meta.url);
      const context = NodeFS.readFileSync(new URL("Core/AppContext.swift", core), "utf8");
      const fabric = NodeFS.readFileSync(new URL("Fabric/ExpoFabricView.swift", core), "utf8");
      // Expo 58 numbers each context from a shared counter; compile that identity
      // code as shipped so the regression covers the installed package.
      const identifier = context.slice(
        context.indexOf("  private static let appContextsCount"),
        context.indexOf("  /**\n   Code signing"),
      );
      const statics = fabric.slice(fabric.indexOf("  // MARK: - Statics"), fabric.lastIndexOf("}"));
      const source = NodePath.join(directory, "regression.swift");
      NodeFS.writeFileSync(
        source,
        [
          NodeFS.readFileSync(
            new URL("./fixtures/ExpoFabricContextRegression.swift", import.meta.url),
            "utf8",
          ),
          `import Synchronization
        public final class AppContext: NSObject {
          let moduleRegistry = Registry()
          let reactBridge: Bridge? = nil
          ${identifier}
        }
        final class Bridge { let moduleRegistry: NSObject? = nil }
        open class ExpoFabricView: NSObject {
          public weak var appContext: AppContext?
          required public init(appContext: AppContext? = nil) {
            self.appContext = appContext
            super.init()
          }
          ${statics}
        }
        enum Exceptions {
          struct AppContextLost { let reason = "The app context has been lost" }
        }`,
        ].join("\n"),
      );
      const executable = NodePath.join(directory, "regression");
      NodeChildProcess.execFileSync(
        "swiftc",
        ["-swift-version", "5", "-parse-as-library", source, "-o", executable],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(
        NodeChildProcess.execFileSync(executable, { encoding: "utf8", timeout: 15_000 }).trim(),
      ).toBe("passed");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
