import { isProjectFaviconFallbackUrl } from "@t3tools/shared/projectFavicon";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useEffect } from "react";
import { projectFaviconUrlAtom } from "../../state/assets";
import { downscaleProjectFavicon } from "../../lib/projectFaviconCache";

/** Resolve small, self-contained thumbnails while the authenticated app is connected. */
export function ProjectIconSync({
  project,
  onIcon,
}: {
  project: EnvironmentProject;
  onIcon: (key: string, icon: string | null) => void;
}) {
  const url = useAtomValue(
    projectFaviconUrlAtom({
      environmentId: project.environmentId,
      cwd: project.workspaceRoot,
      faviconPath: project.faviconPath,
    }),
  );
  const key = `${project.environmentId}:${project.id}`;
  useEffect(() => {
    const controller = new AbortController();
    if (url && !isProjectFaviconFallbackUrl(url))
      void downscaleProjectFavicon({ url }, controller.signal)
        .then((icon) => {
          if (!controller.signal.aborted) onIcon(key, icon);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            console.warn("Could not prepare widget project icon", error);
        });
    return () => controller.abort();
  }, [key, url, onIcon]);
  return null;
}
