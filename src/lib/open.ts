import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";

export async function openPath(targetPath: string): Promise<void> {
  await openFiles([targetPath]);
}

export async function openFiles(filePaths: string[]): Promise<void> {
  const targets = filePaths.length > 0 ? filePaths.map((filePath) => path.resolve(filePath)) : [process.cwd()];

  for (const target of targets) {
    console.log(`Path        ${target}`);
  }

  if (process.platform === "darwin") {
    await execa("open", ["-R", ...targets], { stdio: "inherit" });
    return;
  }

  for (const target of revealDirectories(targets)) {
    await execa("xdg-open", [target], { stdio: "inherit" });
  }
}

function revealDirectories(targets: string[]): string[] {
  return [...new Set(targets.map(revealDirectory))];
}

function revealDirectory(target: string): string {
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    return target;
  }

  return path.dirname(target);
}
