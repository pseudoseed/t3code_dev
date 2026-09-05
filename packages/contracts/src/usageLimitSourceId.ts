import * as Schema from "effect/Schema";

/**
 * Key of one `settings.usageLimitSources` entry. Lives in its own module so
 * both the settings and the usage-limit contracts can import it without
 * importing each other.
 */
export const UsageLimitSourceId = Schema.String.pipe(Schema.brand("UsageLimitSourceId"));
export type UsageLimitSourceId = typeof UsageLimitSourceId.Type;

/**
 * What kind of quota reporter a source is, which picks the poller and the
 * response shape the server decodes.
 *
 *   - `cliproxy` — a CLIProxyAPI hub's management API, one entry per pooled
 *     auth file.
 *   - `aiusage` — an AI usage dashboard (`/api/usage`), which polls each
 *     vendor's own limits endpoint for accounts this environment is not
 *     necessarily signed into.
 */
export const UsageLimitSourceKind = Schema.Literals(["cliproxy", "aiusage"]);
export type UsageLimitSourceKind = typeof UsageLimitSourceKind.Type;
