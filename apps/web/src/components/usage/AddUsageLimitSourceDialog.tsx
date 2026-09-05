import {
  type EnvironmentId,
  UsageLimitSourceId,
  type UsageLimitSourceKind,
} from "@t3tools/contracts";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

/**
 * Stable per source and readable in settings.json. Dots and dashes in the
 * host are kept so `foo-bar.com` and `foo.bar.com` do not collide; anything
 * else (a port's colon, a path) is folded to a dash.
 */
function sourceIdFromUrl(kind: UsageLimitSourceKind, url: string): UsageLimitSourceId {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw text; the server reports the bad URL on its row.
  }
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return UsageLimitSourceId.make(`${kind}-${slug || "source"}`);
}

const KINDS: ReadonlyArray<{
  readonly kind: UsageLimitSourceKind;
  readonly label: string;
  readonly urlLabel: string;
  readonly urlPlaceholder: string;
  readonly needsKey: boolean;
  readonly description: string;
}> = [
  {
    kind: "cliproxy",
    label: "CLIProxyAPI hub",
    urlLabel: "Hub URL",
    urlPlaceholder: "https://hub.example.ts.net:8318",
    needsKey: true,
    description: "Every account the hub pools, read through its management API.",
  },
  {
    kind: "aiusage",
    label: "Usage dashboard",
    urlLabel: "Dashboard URL",
    urlPlaceholder: "http://127.0.0.1:8787",
    needsKey: false,
    // It holds the credentials itself and answers on loopback, so there is
    // nothing for T3 Code to authenticate with.
    description:
      "Every subscription the dashboard polls, including accounts nothing here is signed into.",
  },
];

/**
 * Adds a usage-limit source on one environment. A key, when the kind needs
 * one, is sent once and kept in that server's secret store; settings only
 * ever carry a redaction marker for it afterwards.
 */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [kind, setKind] = useState<UsageLimitSourceKind>("cliproxy");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const spec = KINDS.find((entry) => entry.kind === kind) ?? KINDS[0]!;
  const trimmedUrl = url.trim();
  const canSave = trimmedUrl.length > 0 && (!spec.needsKey || managementKey.trim().length > 0);

  const reset = () => {
    setKind("cliproxy");
    setLabel("");
    setUrl("");
    setManagementKey("");
  };

  const save = () => {
    if (!canSave) return;
    const id = sourceIdFromUrl(kind, trimmedUrl);
    // The patch names only this entry; the server merges it into its map.
    updateSettings({
      usageLimitSources: {
        [id]: {
          kind,
          ...(label.trim() ? { label: label.trim() } : {}),
          url: trimmedUrl,
          managementKey: spec.needsKey ? managementKey.trim() : "",
          enabled: true,
        },
      },
    });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a usage source</DialogTitle>
          <DialogDescription>
            Show quota from outside {environmentLabel}&apos;s own providers, beside them. Anything
            secret stays on that server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Kind</Label>
              <ToggleGroup
                value={[kind]}
                onValueChange={(next) => {
                  const picked = next[0];
                  if (picked !== undefined) setKind(picked as UsageLimitSourceKind);
                }}
              >
                {KINDS.map((entry) => (
                  <Toggle key={entry.kind} value={entry.kind} className="flex-1">
                    {entry.label}
                  </Toggle>
                ))}
              </ToggleGroup>
              <span className="text-xs text-muted-foreground">{spec.description}</span>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">{spec.urlLabel}</Label>
              <Input
                id="usage-source-url"
                placeholder={spec.urlPlaceholder}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            {spec.needsKey ? (
              <div className="grid gap-1.5">
                <Label htmlFor="usage-source-key">Management key</Label>
                <Input
                  id="usage-source-key"
                  type="password"
                  autoComplete="off"
                  value={managementKey}
                  onChange={(event) => setManagementKey(event.target.value)}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">Label (optional)</Label>
              <Input
                id="usage-source-label"
                placeholder="Defaults to the host name"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            Add source
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
