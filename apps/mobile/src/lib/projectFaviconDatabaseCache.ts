import {
  createProjectFaviconCache as createSharedProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
  type ProjectFaviconEntry,
} from "@t3tools/client-runtime/project-favicon-cache";
import * as Effect from "effect/Effect";

import * as MobileDatabase from "../persistence/mobile-database";

const CACHE_KIND = "project-favicon";
const CACHE_SCHEMA_VERSION = 1;

let database: MobileDatabase.MobileDatabase["Service"] | undefined;

export function attachProjectFaviconDatabase(service: MobileDatabase.MobileDatabase["Service"]) {
  database = service;
}

const runDatabase = <A, E>(
  use: (database: MobileDatabase.MobileDatabase["Service"]) => Effect.Effect<A, E>,
) =>
  database
    ? Effect.runPromise(use(database))
    : Promise.reject(new Error("Project icon storage is not attached."));

/** expo-image encodes only through disk cache; remove the temporary frame after reading bytes. */
export async function downscaleProjectFavicon(
  image: { readonly url: string },
  signal: AbortSignal,
) {
  const [{ Image }, { File }] = await Promise.all([
    import("expo-image"),
    import("expo-file-system"),
  ]);
  for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
    // React Native's AbortSignal has `aborted` but not `throwIfAborted`.
    if (signal.aborted) throw new Error("Project icon request aborted.");
    const decoded = await Image.loadAsync(image.url, { maxWidth: size, maxHeight: size });
    const cacheKey = `t3-favicon-thumbnail:${size}:${image.url}`;
    try {
      if (signal.aborted) throw new Error("Project icon request aborted.");
      // SDWebImage's disk cache cannot re-encode decoded SVG/ICO, so iOS repaints to PNG natively.
      // EXPO_OS is inlined at build time; import("react-native") throws on React Native 0.88.
      if (process.env.EXPO_OS === "ios") {
        const { requireNativeModule } = await import("expo");
        const native = requireNativeModule<{
          projectIconPng: (image: typeof decoded, maximumSize: number) => string | null;
        }>("T3NativeControls");
        const dataUrl = native.projectIconPng(decoded, size);
        if (dataUrl && dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
        continue;
      }
      if (decoded.width > size || decoded.height > size) {
        throw new Error("Project icon was not resized.");
      }
      await Image.writeToCacheAsync(decoded, cacheKey);
      const path = await Image.getCachePathAsync(cacheKey);
      if (!path) throw new Error("Project icon thumbnail was not written.");
      const file = new File(path.startsWith("file:") ? path : `file://${path}`);
      try {
        if (file.size > PROJECT_FAVICON_MAX_DATA_URL_LENGTH) continue;
        const base64 = await file.base64();
        // SDWebImage chooses JPEG for opaque images and PNG for transparency; Glide always writes PNG.
        const mimeType = base64.startsWith("/9j/")
          ? "image/jpeg"
          : base64.startsWith("iVBORw0KGgo")
            ? "image/png"
            : null;
        if (!mimeType) throw new Error("Unsupported project icon thumbnail encoding.");
        const dataUrl = `data:${mimeType};base64,${base64}`;
        if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
      } finally {
        file.delete();
      }
    } finally {
      decoded.release();
    }
  }
  throw new Error("Project icon thumbnail exceeds the cache limit.");
}

export const projectFaviconDatabaseCache = createSharedProjectFaviconCache({
  storage: {
    list: () =>
      runDatabase((database) =>
        database.listCache(CACHE_KIND).pipe(
          Effect.map((payloads) =>
            payloads.flatMap((payload): Array<unknown> => {
              try {
                return [JSON.parse(payload)];
              } catch {
                return [];
              }
            }),
          ),
        ),
      ),
    put: (key, entry: ProjectFaviconEntry) =>
      runDatabase((database) =>
        database.saveCache(
          entry.environmentId,
          CACHE_KIND,
          key,
          CACHE_SCHEMA_VERSION,
          JSON.stringify(entry),
        ),
      ),
    remove: (key, entry) =>
      runDatabase((database) => database.removeCache(entry.environmentId, CACHE_KIND, key)),
  },
  load: createProjectFaviconImageLoader({ downscale: downscaleProjectFavicon }),
});
