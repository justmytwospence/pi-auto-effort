import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * A real Pi model registry from the Pi installation on PATH (or PI_PACKAGE_DIR), so evals run
 * Jev exactly as the extension does inside Pi, with Pi's credentials.
 */
export async function installedRegistry(): Promise<unknown> {
  const dir = process.env.PI_PACKAGE_DIR || findPiPackage();
  const pi = await import(pathToFileURL(path.join(dir, "dist", "index.js")).href);
  return new pi.ModelRegistry(await pi.ModelRuntime.create());
}

function findPiPackage() {
  // Skip node_modules/.bin, which npm scripts put first: that is this package's dev copy of Pi.
  const bins = execFileSync("which", ["-a", "pi"], { encoding: "utf8" }).split("\n").filter((b) => b && !b.includes("node_modules"));
  if (!bins[0]) throw new Error("pi is not on PATH; set PI_PACKAGE_DIR");
  const bin = realpathSync(bins[0]);
  let dir = path.dirname(bin);
  while (dir !== path.dirname(dir)) {
    for (const candidate of [dir, path.join(dir, "libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent")]) {
      if (path.basename(candidate) === "pi-coding-agent" && existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the pi-coding-agent package from ${bin}; set PI_PACKAGE_DIR`);
}

export const hasCredentials = Boolean(process.env.TYPESAFE_API_KEY?.trim());
