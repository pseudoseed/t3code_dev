import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AntigravityAuthMethod,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  resolveProviderSetupPresentation,
  type ProviderSetupPresentation,
} from "./providerSetupPresentation";

export { readAntigravityAuthMethod } from "./providerSetupPresentation";

interface ProviderSetupSectionProps {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly driver: ProviderDriverKind;
  /** Display name for this instance, used in prompts and enable copy. */
  readonly providerLabel: string;
  readonly binaryPath?: string | undefined;
  readonly authMethod?: AntigravityAuthMethod | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => void;
}

/** Setup state belongs to the selected environment and is never saved in client settings. */
export function ProviderSetupSection(props: ProviderSetupSectionProps) {
  const presentation = resolveProviderSetupPresentation({
    driver: props.driver,
    authMethod: props.authMethod ?? "oauth-personal",
  });
  return (
    <section aria-label={presentation.sectionLabel} className="grid gap-3 text-xs">
      <p>
        {props.providerLabel} runs on {props.environmentLabel}.
      </p>
      {!props.enabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">Enable it to use it in threads.</span>
          {!props.readOnly ? (
            <Button size="xs" variant="outline" onClick={props.onEnable}>
              Enable {props.providerLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
      {props.readOnly ? (
        <p className="text-muted-foreground">This connection cannot change provider setup.</p>
      ) : props.provider?.setup === undefined ? (
        <p className="text-muted-foreground">
          Update this environment to sign in to {props.providerLabel} here.
        </p>
      ) : (
        <ProviderSetupActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          providerLabel={props.providerLabel}
          binaryPath={props.binaryPath}
          presentation={presentation}
          enabled={props.enabled}
        />
      )}
    </section>
  );
}

function ProviderSetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  providerLabel,
  enabled,
  binaryPath,
  presentation,
}: Pick<
  ProviderSetupSectionProps,
  "environmentId" | "environmentLabel" | "instanceId" | "enabled" | "binaryPath" | "providerLabel"
> & {
  readonly provider: ServerProvider;
  readonly presentation: ProviderSetupPresentation;
}) {
  const target = { environmentId, input: { instanceId } };
  const canInstall = provider.setup?.canInstall === true;
  const phaseLabels = presentation.phaseLabels;
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  // Providers T3 Code does not install reject the install subscription, so it
  // is never opened for them; a rejected query would read as a setup error and
  // disable the sign-in controls.
  const installQuery = useEnvironmentQuery(
    canInstall ? serverEnvironment.providerInstallState(target) : null,
  );
  const auth = authQuery.data;
  const installation = installQuery.data;
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, commandOptions);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, commandOptions);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, commandOptions);
  const removeInstall = useAtomCommand(
    serverEnvironment.removeProviderInstallation,
    commandOptions,
  );
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [callbackDraft, setCallbackDraft] = useState({ flowId: null as string | null, value: "" });
  const [copiedFlowId, setCopiedFlowId] = useState<string | null>(null);
  const callbackUrl = callbackDraft.flowId === auth?.flowId ? callbackDraft.value : "";
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const usesCustomBinary = Boolean(binaryPath?.trim());
  const installed =
    provider.installed || (!usesCustomBinary && installation?.installedVersion != null);
  const authenticated = provider.auth.status === "authenticated";
  const authStatusMessage =
    auth === null
      ? "Reading sign-in status."
      : authActive || auth.phase === "failed" || auth.phase === "cancelled"
        ? (auth.message ?? phaseLabels[auth.phase])
        : authenticated
          ? presentation.authenticatedLabel
          : auth.phase === "idle" && auth.message
            ? auth.message
            : phaseLabels.idle;
  const authorizationUrl = auth?.phase === "waiting" ? auth.authorizationUrl : null;
  const userCode = auth?.phase === "waiting" ? auth.userCode : null;
  // `none` means the provider polls its own device authorization and there is
  // nothing for the user to send back through T3 Code.
  const completion = auth?.completion ?? "redirectUrl";
  const queryError = authQuery.error ?? installQuery.error;
  const actionsDisabled = pendingLabel !== null || queryError !== null;
  const installationStatusMessage =
    installation === null
      ? null
      : installation.phase === "downloading"
        ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)} MB${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB`}.`
        : installation.phase === "extracting"
          ? `Extracting ${providerLabel}.`
          : installation.phase === "verifying"
            ? "Checking the downloaded runtime."
            : installed
              ? `${providerLabel} is installed.`
              : usesCustomBinary
                ? enabled
                  ? `The configured ${providerLabel} runtime is unavailable.`
                  : `The configured ${providerLabel} runtime has not been checked.`
                : `Install the official ${providerLabel} runtime before signing in.`;

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<boolean> {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPendingLabel(label);
    setError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Provider setup failed.");
        }
        return false;
      }
      return true;
    } catch {
      setError("Provider setup failed. Try again.");
      return false;
    } finally {
      pendingRef.current = false;
      setPendingLabel(null);
    }
  }

  async function openSignInPage() {
    if (!authorizationUrl) return;
    try {
      await ensureLocalApi().shell.openExternal(authorizationUrl);
      setError(null);
    } catch {
      setError("Could not open the sign-in page. Copy the link and open it in your browser.");
    }
  }

  async function copySignInLink() {
    if (!authorizationUrl) return;
    try {
      await writeTextToClipboard(authorizationUrl, "sign-in link");
      setCopiedFlowId(auth?.flowId ?? null);
      setError(null);
    } catch {
      setError("Could not copy the sign-in link. Use Open sign-in page.");
    }
  }

  async function copyUserCode() {
    if (!userCode) return;
    try {
      await writeTextToClipboard(userCode, "sign-in code");
      setError(null);
    } catch {
      setError("Could not copy the code. Type it into the sign-in page instead.");
    }
  }

  async function submitCallback() {
    const flowId = auth?.flowId;
    if (!flowId || !callbackUrl.trim() || auth.phase !== "waiting") return;
    const accepted = await runCommand(
      completion === "code" ? "Checking code" : "Checking redirect",
      () => completeAuth({ environmentId, input: { instanceId, flowId, callbackUrl } }),
    );
    if (accepted) {
      setCallbackDraft({ flowId: null, value: "" });
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      presentation.signOutPrompt(provider.displayName ?? providerLabel, environmentLabel),
    );
    if (confirmed) {
      await runCommand("Signing out", () => logoutAuth(target));
    }
  }

  async function removeRuntime() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `Remove the downloaded ${providerLabel} runtime from ${environmentLabel}? Sign-in and thread history are kept.`,
    );
    if (confirmed) {
      await runCommand("Removing runtime", () => removeInstall(target));
    }
  }

  return (
    <div className="grid gap-3">
      {canInstall ? (
        <div className="grid gap-2">
          <p className="font-medium">Runtime</p>
          <p role="status" className="text-muted-foreground">
            {installationStatusMessage}
          </p>
          {installation?.phase === "downloading" &&
          installation.totalBytes !== null &&
          installation.totalBytes > 0 ? (
            <progress
              aria-label={`${providerLabel} download`}
              className="h-1 w-full accent-foreground"
              value={installation.downloadedBytes}
              max={installation.totalBytes}
            />
          ) : null}
          {installation?.message && installation.message !== installationStatusMessage ? (
            <p className="text-muted-foreground [overflow-wrap:anywhere]">{installation.message}</p>
          ) : null}
          {usesCustomBinary ? (
            <p className="text-muted-foreground">
              This instance uses the binary path below. Installing a managed runtime does not change
              that path.
            </p>
          ) : null}
          {!installed && !usesCustomBinary && !installActive && installation?.totalBytes ? (
            <p className="text-muted-foreground">
              Downloads {Math.ceil(installation.totalBytes / 1_000_000)} MB.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {installActive && installation.operationId ? (
              <Button
                size="xs"
                variant="outline"
                disabled={actionsDisabled}
                onClick={() => {
                  const operationId = installation.operationId;
                  if (!operationId) return;
                  void runCommand("Cancelling installation", () =>
                    cancelInstall({ environmentId, input: { instanceId, operationId } }),
                  );
                }}
              >
                Cancel installation
              </Button>
            ) : !installActive ? (
              <Button
                size="xs"
                variant="outline"
                disabled={actionsDisabled || installation === null || authActive}
                onClick={() => void runCommand("Starting installation", () => startInstall(target))}
              >
                {installation?.installedVersion
                  ? installation.version && installation.version !== installation.installedVersion
                    ? `Update ${providerLabel}`
                    : `Reinstall ${providerLabel}`
                  : installation?.phase === "failed" || installation?.phase === "cancelled"
                    ? "Retry installation"
                    : installed
                      ? "Install managed runtime"
                      : `Install ${providerLabel}`}
              </Button>
            ) : null}
            {installation?.canRemove && !installActive ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={actionsDisabled || authActive}
                onClick={() => void removeRuntime()}
              >
                Remove downloaded runtime
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={canInstall ? "grid gap-2 border-t border-border/60 pt-3" : "grid gap-2"}>
        <p className="font-medium">{presentation.methodLabel}</p>
        <p role="status" className="text-muted-foreground [overflow-wrap:anywhere]">
          {authStatusMessage}
        </p>
        {!installed && !authActive ? (
          <p className="text-muted-foreground">
            {providerLabel} is not available on {environmentLabel}. Install it or set this
            instance&apos;s binary path before signing in.
          </p>
        ) : null}
        {authorizationUrl ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button size="xs" variant="outline" onClick={() => void openSignInPage()}>
                Open sign-in page
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void copySignInLink()}>
                {copiedFlowId === auth?.flowId ? "Link copied" : "Copy sign-in link"}
              </Button>
            </div>
            {userCode ? (
              <div className="grid gap-1">
                <p className="text-muted-foreground">Enter this code on the sign-in page.</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code
                    aria-label="One-time sign-in code"
                    className="rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-mono text-sm tracking-widest"
                  >
                    {userCode}
                  </code>
                  <Button size="xs" variant="ghost" onClick={() => void copyUserCode()}>
                    Copy code
                  </Button>
                </div>
              </div>
            ) : null}
            {auth?.expiresAt ? (
              <p className="text-muted-foreground">
                Link expires at{" "}
                <time dateTime={auth.expiresAt}>
                  {new Date(auth.expiresAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
                .
              </p>
            ) : null}
            {completion === "none" ? (
              <p className="text-muted-foreground">
                Finish in your browser. This page updates on its own.
              </p>
            ) : (
              <form
                className="grid gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCallback();
                }}
              >
                <label htmlFor={`provider-callback-${instanceId}`}>
                  {completion === "code"
                    ? `Paste the code ${providerLabel} shows you here.`
                    : "If the final localhost page does not load, paste its full URL here."}
                </label>
                <Input
                  id={`provider-callback-${instanceId}`}
                  size="sm"
                  type={completion === "code" ? "text" : "url"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={completion === "code" ? "Paste code" : "http://127.0.0.1:..."}
                  value={callbackUrl}
                  maxLength={16_384}
                  disabled={actionsDisabled}
                  onChange={(event) =>
                    setCallbackDraft({ flowId: auth?.flowId ?? null, value: event.target.value })
                  }
                />
                <Button
                  size="xs"
                  variant="outline"
                  type="submit"
                  className="w-fit"
                  disabled={actionsDisabled || !callbackUrl.trim()}
                >
                  Continue
                </Button>
              </form>
            )}
          </>
        ) : auth?.phase === "waiting" ? (
          <p className="text-muted-foreground">
            Sign-in is open in another client. Complete or cancel it there.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {authActive && auth?.flowId ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={actionsDisabled}
              onClick={() => {
                const flowId = auth.flowId;
                if (!flowId) return;
                void runCommand("Cancelling sign-in", () =>
                  cancelAuth({ environmentId, input: { instanceId, flowId } }),
                );
              }}
            >
              Cancel sign-in
            </Button>
          ) : !authActive && provider.setup?.canAuthenticate ? (
            <Button
              size="xs"
              variant={authenticated ? "ghost" : "outline"}
              disabled={actionsDisabled || !installed || auth === null || installActive}
              onClick={() => void runCommand("Starting sign-in", () => startAuth(target))}
            >
              {authenticated
                ? "Sign in again"
                : auth?.phase === "failed" || auth?.phase === "cancelled"
                  ? presentation.retryLabel
                  : presentation.signInLabel}
            </Button>
          ) : null}
          {!authActive && provider.setup?.canAuthenticate ? (
            <Button
              size="xs"
              variant={authenticated ? "outline" : "ghost"}
              disabled={actionsDisabled || auth === null}
              onClick={() => void signOut()}
            >
              {presentation.signOutLabel}
            </Button>
          ) : null}
        </div>
      </div>

      {pendingLabel ? <p role="status">{pendingLabel}.</p> : null}
      {error || queryError ? (
        <div className="grid gap-2">
          <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
            {error ?? queryError}
          </p>
          {queryError ? (
            <Button
              size="xs"
              variant="outline"
              className="w-fit"
              onClick={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            >
              Retry setup status
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
