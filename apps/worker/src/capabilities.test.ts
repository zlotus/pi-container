import { describe, expect, it } from "vitest";

import { parseRuntimeCapabilities } from "./capabilities.js";

describe("Runtime capability probe output", () => {
  it("accepts one complete strict capability report", () => {
    expect(
      parseRuntimeCapabilities(
        '{"browser":true,"office":true,"ffmpeg":true,"python":true,"node":true,"rust":true}\n',
      ),
    ).toEqual({
      browser: true,
      office: true,
      ffmpeg: true,
      python: true,
      node: true,
      rust: true,
    });
  });

  it("rejects missing, extra, or non-boolean capability values", () => {
    expect(() => parseRuntimeCapabilities("\n")).toThrow();
    expect(() =>
      parseRuntimeCapabilities(
        '{"browser":true,"office":true,"ffmpeg":true,"python":true,"node":true,"rust":true,"nmap":true}',
      ),
    ).toThrow();
    expect(() =>
      parseRuntimeCapabilities(
        '{"browser":"yes","office":true,"ffmpeg":true,"python":true,"node":true,"rust":true}',
      ),
    ).toThrow();
  });
});
