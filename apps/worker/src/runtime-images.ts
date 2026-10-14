import type { Logger } from "@agent-runtime/logging";
import {
  ImageDigestSchema,
  RuntimeImageRefSchema,
  type Architecture,
} from "@agent-runtime/protocol";
import type Docker from "dockerode";

import type { WorkerConfig } from "./config.js";

export const RUNTIME_VERSION_LABEL = "io.agent-runtime.runtime.version";
export const PI_WEB_VERSION_LABEL = "io.agent-runtime.pi-web.version";
export const PI_VERSION_LABEL = "io.agent-runtime.pi.version";

const VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** One configured Runtime image (specs.md Phase 18.4). */
export interface RuntimeImagePin {
  image: string;
  /** Required for `RUNTIME_IMAGES`; null only for the transitional `RUNTIME_IMAGE`. */
  digest: string | null;
  /** Used only when an unpinned legacy image carries no version label. */
  fallbackVersion: string | null;
}

/** A Runtime image this Worker currently offers. */
export interface OfferedRuntimeImage {
  image: string;
  /** The local image ID new containers must use; null only in tests without Docker. */
  imageId: string | null;
  runtimeVersion: string;
  piWebVersion: string | null;
  piVersion: string | null;
}

export interface RuntimeImageSet {
  find(image: string): OfferedRuntimeImage | null;
}

/**
 * Parses `RUNTIME_IMAGES`: 1–4 comma-separated `<reference>@sha256:<digest>` entries with
 * unique references. Throws on any malformed entry, so the Worker refuses to start.
 */
export function parseRuntimeImages(value: string): RuntimeImagePin[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (entries.length < 1 || entries.length > 4) {
    throw new Error("RUNTIME_IMAGES must list 1 to 4 images");
  }
  const pins = entries.map((entry) => {
    const at = entry.lastIndexOf("@");
    const image = RuntimeImageRefSchema.safeParse(entry.slice(0, at));
    const digest = ImageDigestSchema.safeParse(entry.slice(at + 1));
    if (at <= 0 || !image.success || !digest.success) {
      throw new Error("Each RUNTIME_IMAGES entry must be <reference>@sha256:<64 hex digits>");
    }
    return { image: image.data, digest: digest.data, fallbackVersion: null };
  });
  if (new Set(pins.map((pin) => pin.image)).size !== pins.length) {
    throw new Error("RUNTIME_IMAGES must not repeat an image reference");
  }
  return pins;
}

/** The configured images: `RUNTIME_IMAGES`, or the transitional single `RUNTIME_IMAGE`. */
export function configuredRuntimeImages(config: WorkerConfig): RuntimeImagePin[] {
  if (config.RUNTIME_IMAGES !== undefined) return parseRuntimeImages(config.RUNTIME_IMAGES);
  return [{ image: config.RUNTIME_IMAGE, digest: null, fallbackVersion: config.RUNTIME_VERSION }];
}

/** Offers every configured image without inspecting Docker; for tests and fakes only. */
export function staticRuntimeImages(config: WorkerConfig): RuntimeImageSet {
  const offered = new Map(
    configuredRuntimeImages(config).map((pin) => [
      pin.image,
      {
        image: pin.image,
        imageId: pin.digest,
        runtimeVersion: pin.fallbackVersion ?? pin.image,
        piWebVersion: null,
        piVersion: null,
      },
    ]),
  );
  return { find: (image) => offered.get(image) ?? null };
}

function label(labels: Record<string, string> | undefined, name: string): string | null {
  const value = labels?.[name];
  return value !== undefined && VERSION_LABEL.test(value) ? value : null;
}

/**
 * The Worker's Runtime images as Docker has them. An image is offered only when the local
 * reference resolves to its pinned digest, matches this host's platform and carries a
 * version label; anything else is left out (fail closed) and logged. `refresh` runs before
 * every hello, so a re-tagged image stops being offered on the next connection.
 */
export class DockerRuntimeImageCatalog implements RuntimeImageSet {
  readonly #pins: readonly RuntimeImagePin[];
  readonly #docker: Docker;
  readonly #log: Pick<Logger, "error" | "warn">;
  #offered = new Map<string, OfferedRuntimeImage>();

  constructor(pins: readonly RuntimeImagePin[], docker: Docker, log: Pick<Logger, "error" | "warn">) {
    this.#pins = pins;
    this.#docker = docker;
    this.#log = log;
  }

  find(image: string): OfferedRuntimeImage | null {
    return this.#offered.get(image) ?? null;
  }

  offered(): OfferedRuntimeImage[] {
    return [...this.#offered.values()];
  }

  async refresh(architecture: Architecture): Promise<OfferedRuntimeImage[]> {
    const offered = new Map<string, OfferedRuntimeImage>();
    const versions = new Set<string>();
    for (const pin of this.#pins) {
      const resolved = await this.#resolve(pin, architecture);
      if (resolved === null) continue;
      if (versions.has(resolved.runtimeVersion)) {
        this.#log.error(
          { image: pin.image, runtimeVersion: resolved.runtimeVersion },
          "Runtime image repeats another image's runtime version; not offered",
        );
        continue;
      }
      versions.add(resolved.runtimeVersion);
      offered.set(pin.image, resolved);
    }
    this.#offered = offered;
    return this.offered();
  }

  async #resolve(pin: RuntimeImagePin, architecture: Architecture): Promise<OfferedRuntimeImage | null> {
    let image: Docker.ImageInspectInfo;
    try {
      image = await this.#docker.getImage(pin.image).inspect();
    } catch {
      this.#log.error({ image: pin.image }, "Runtime image is not available locally; not offered");
      return null;
    }
    if (image.Os !== "linux" || image.Architecture !== architecture) {
      this.#log.error(
        { image: pin.image, platform: `${image.Os}/${image.Architecture}` },
        "Runtime image platform does not match this Worker; not offered",
      );
      return null;
    }
    const pinned =
      pin.digest === null ||
      image.Id === pin.digest ||
      (image.RepoDigests ?? []).some((reference) => reference.endsWith(`@${pin.digest}`));
    if (!pinned) {
      this.#log.error(
        { image: pin.image, imageId: image.Id },
        "Runtime image reference no longer resolves to its pinned digest; not offered",
      );
      return null;
    }
    const labels = image.Config.Labels ?? undefined;
    const runtimeVersion = label(labels, RUNTIME_VERSION_LABEL) ?? pin.fallbackVersion;
    if (runtimeVersion === null) {
      this.#log.error({ image: pin.image }, "Runtime image has no runtime version label; not offered");
      return null;
    }
    if (pin.digest === null) {
      this.#log.warn({ image: pin.image }, "RUNTIME_IMAGE is not pinned by digest; use RUNTIME_IMAGES");
    }
    return {
      image: pin.image,
      imageId: image.Id,
      runtimeVersion,
      piWebVersion: label(labels, PI_WEB_VERSION_LABEL),
      piVersion: label(labels, PI_VERSION_LABEL),
    };
  }
}
