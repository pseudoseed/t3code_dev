import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";
import { Context, DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ServerConfig } from "../config.ts";

export interface ApnsRequest {
  readonly token: string;
  readonly environment: "sandbox" | "production";
  readonly kind: "alert" | "liveactivity" | "background";
  readonly payload: unknown;
  readonly collapseId?: string;
}
export interface ApnsResult {
  readonly status: number;
  readonly reason?: string;
}
export interface ApnsConfiguration {
  readonly teamId: string;
  readonly keyId: string;
  readonly bundleId: string;
  readonly key: NodeCrypto.KeyObject;
}
const decodeApnsError = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ reason: Schema.String })),
);

export class ApnsTransportError extends Schema.TaggedError<ApnsTransportError>()(
  "ApnsTransportError",
  { message: Schema.String },
) {}

const ApnsSettings = Schema.Struct({
  keyFile: Schema.NonEmptyString,
  keyId: Schema.NonEmptyString,
  teamId: Schema.NonEmptyString,
  bundleId: Schema.NonEmptyString,
});
const decodeApnsSettings = Schema.decodeUnknownEffect(ApnsSettings);
const decodeApnsSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ApnsSettings));

/** File configuration belongs to one host's private state and works for Finder launches. */
export const loadApnsConfiguration = Effect.fn("ApnsTransport.loadConfiguration")(function* (
  secretsDir: string,
  environment: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<
  ApnsConfiguration | null,
  ApnsTransportError,
  FileSystem.FileSystem | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentSettings = {
    keyFile: environment.T3CODE_APNS_KEY_FILE,
    keyId: environment.T3CODE_APNS_KEY_ID,
    teamId: environment.T3CODE_APNS_TEAM_ID,
    bundleId: environment.T3CODE_APNS_BUNDLE_ID,
  };
  let settings: typeof ApnsSettings.Type;
  if (Object.values(environmentSettings).some((value) => value !== undefined)) {
    // An explicit environment override must be complete; never combine two identities.
    settings = yield* decodeApnsSettings(environmentSettings).pipe(
      Effect.mapError(
        () =>
          new ApnsTransportError({
            message:
              "Direct APNs requires all four T3CODE_APNS variables when using environment overrides.",
          }),
      ),
    );
  } else {
    const source = yield* fs.readFileString(path.join(secretsDir, "apns.json")).pipe(
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(null)
          : Effect.fail(
              new ApnsTransportError({
                message: "Could not read private APNs configuration (secrets/apns.json).",
              }),
            ),
      ),
    );
    if (source === null) return null;
    const decoded = yield* decodeApnsSettingsJson(source).pipe(
      Effect.mapError(
        () =>
          new ApnsTransportError({
            message: "Invalid secrets/apns.json. Expected keyFile, keyId, teamId and bundleId.",
          }),
      ),
    );
    settings = { ...decoded, keyFile: path.resolve(secretsDir, decoded.keyFile) };
  }
  const pem = yield* fs
    .readFileString(settings.keyFile)
    .pipe(
      Effect.mapError(
        () => new ApnsTransportError({ message: "Could not read the configured APNs key file." }),
      ),
    );
  return yield* Effect.try({
    try: () => {
      const key = NodeCrypto.createPrivateKey(pem);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
        throw new Error("Expected an APNs P-256 key.");
      return { key, keyId: settings.keyId, teamId: settings.teamId, bundleId: settings.bundleId };
    },
    catch: () =>
      new ApnsTransportError({
        message: "Could not load the APNs P-256 signing key. Check the configured key file.",
      }),
  });
});

/** Each provider token is reused for 45 minutes, within Apple's one-hour lifetime. */
export function createApnsProviderToken(config: ApnsConfiguration, nowSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString(
    "base64url",
  );
  const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: nowSeconds })).toString(
    "base64url",
  );
  const input = `${header}.${claims}`;
  return `${input}.${NodeCrypto.sign("sha256", Buffer.from(input), { key: config.key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export function createApnsSender(config: ApnsConfiguration, open = NodeHttp2.connect) {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  let cached: { token: string; issuedAt: number } | undefined;
  return {
    close() {
      for (const session of sessions.values()) session.destroy();
      sessions.clear();
    },
    async send(request: ApnsRequest, now: number): Promise<ApnsResult> {
      const body = JSON.stringify(request.payload);
      if (Buffer.byteLength(body) > 4096) throw new Error("APNs payload exceeds 4096 bytes.");
      if (!cached || now < cached.issuedAt || now - cached.issuedAt >= 45 * 60) {
        cached = { token: createApnsProviderToken(config, now), issuedAt: now };
      }
      const origin =
        request.environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com";
      let session = sessions.get(origin);
      if (!session || session.closed || session.destroyed) {
        session = open(origin);
        sessions.set(origin, session);
        const current = session;
        const discard = () => {
          if (sessions.get(origin) === current) sessions.delete(origin);
          current.destroy();
        };
        session.on("error", discard);
        session.on("goaway", discard);
        // Keep connections for bursts without leaving idle sockets alive indefinitely.
        session.setTimeout(60_000, discard);
      }
      const jwt = cached.token;
      return new Promise((resolve, reject) => {
        const stream = session.request({
          ":method": "POST",
          ":path": `/3/device/${request.token}`,
          authorization: `bearer ${jwt}`,
          "apns-topic":
            config.bundleId + (request.kind === "liveactivity" ? ".push-type.liveactivity" : ""),
          "apns-push-type": request.kind,
          "apns-priority": request.kind === "alert" ? "10" : "5",
          "apns-expiration": String(now + 15 * 60),
          ...(request.collapseId ? { "apns-collapse-id": request.collapseId } : {}),
        });
        let status = 0;
        let response = "";
        stream.setEncoding("utf8");
        stream.setTimeout(10_000, () => stream.destroy(new Error("APNs request timed out.")));
        stream.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        stream.on("data", (chunk: string) => {
          response += chunk;
        });
        stream.on("error", reject);
        stream.once("close", () => reject(new Error("APNs stream closed before a response.")));
        stream.on("end", () => {
          if (!status) {
            reject(new Error("APNs returned no status."));
            return;
          }
          const decoded = decodeApnsError(response);
          resolve({ status, ...(decoded._tag === "Some" ? { reason: decoded.value.reason } : {}) });
        });
        stream.end(body);
      });
    },
  };
}

export class ApnsTransport extends Context.Service<
  ApnsTransport,
  {
    readonly bundleId: string | null;
    readonly send: (request: ApnsRequest) => Effect.Effect<ApnsResult, ApnsTransportError>;
  }
>()("t3/push/ApnsTransport") {}

export const layer = Layer.effect(
  ApnsTransport,
  Effect.gen(function* () {
    const { secretsDir } = yield* ServerConfig;
    const config = yield* loadApnsConfiguration(secretsDir, process.env);
    if (!config) {
      return ApnsTransport.of({
        bundleId: null,
        send: () =>
          Effect.fail(new ApnsTransportError({ message: "Direct APNs is not configured." })),
      });
    }
    const sender = yield* Effect.acquireRelease(
      Effect.sync(() => createApnsSender(config)),
      (sender) => Effect.sync(() => sender.close()),
    );
    return ApnsTransport.of({
      bundleId: config.bundleId,
      send: (request) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          return yield* Effect.tryPromise({
            try: () => sender.send(request, Math.floor(now.epochMilliseconds / 1000)),
            catch: () =>
              new ApnsTransportError({
                message: "APNs transport failed. Check the server's outbound connection to Apple.",
              }),
          });
        }),
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(error.message).pipe(
        Effect.as(
          ApnsTransport.of({
            bundleId: null,
            send: () =>
              Effect.fail(
                new ApnsTransportError({
                  message: "Direct APNs configuration is invalid. Check the server log.",
                }),
              ),
          }),
        ),
      ),
    ),
  ),
);
