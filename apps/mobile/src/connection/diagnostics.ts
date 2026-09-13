/**
 * Device-side connection log. The server only ever sees a socket arrive or
 * vanish; what the phone saw in between (app state flips, path changes,
 * probe outcomes, background widget pushes) is recorded here so a bad
 * resume can be explained from Settings instead of guessed at from traces.
 *
 * In-memory ring, flushed to the cache directory shortly after each write so
 * the entries from a headless background task or a killed app survive.
 */
export interface ConnectionDiagnosticEntry {
  readonly at: number;
  readonly kind: string;
  readonly detail: string;
}

const MAX_ENTRIES = 400;
const PERSIST_DELAY_MS = 1_000;
const FILE_NAME = "connection-diagnostics.json";

let entries: ConnectionDiagnosticEntry[] = [];
let loaded: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function isEntry(value: unknown): value is ConnectionDiagnosticEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ConnectionDiagnosticEntry).at === "number" &&
    typeof (value as ConnectionDiagnosticEntry).kind === "string" &&
    typeof (value as ConnectionDiagnosticEntry).detail === "string"
  );
}

async function diagnosticsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.cache, FILE_NAME);
}

function load(): Promise<void> {
  loaded ??= (async () => {
    try {
      const file = await diagnosticsFile();
      if (!file.exists) return;
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) return;
      entries = [...parsed.filter(isEntry), ...entries].slice(-MAX_ENTRIES);
    } catch {
      // A missing or corrupt log only costs history; never the connection.
    }
  })();
  return loaded;
}

async function persist(): Promise<void> {
  try {
    await load();
    const file = await diagnosticsFile();
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(JSON.stringify(entries));
  } catch {
    // Same as above: logging must never throw into the caller.
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DELAY_MS);
}

export function recordConnectionDiagnostic(kind: string, detail: string): void {
  entries.push({ at: Date.now(), kind, detail });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  schedulePersist();
}

export function formatConnectionDiagnostics(log: ReadonlyArray<ConnectionDiagnosticEntry>): string {
  return log
    .map((entry) => `${new Date(entry.at).toISOString()} ${entry.kind} ${entry.detail}`)
    .join("\n");
}

export async function connectionDiagnosticsText(): Promise<string> {
  await load();
  return formatConnectionDiagnostics(entries);
}

export async function clearConnectionDiagnostics(): Promise<void> {
  await load();
  entries = [];
  await persist();
}

void load();
