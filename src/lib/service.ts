import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { logsDir } from "./paths.js";

export const AIDE_SERVICE_LABEL = "com.inksphere.aide";
export const AIDE_SYSTEMD_UNIT = "aide.service";

export interface LaunchdPlistOptions {
  label: string;
  execPath: string;
  scriptPath: string;
  home: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface SystemdUnitOptions {
  execPath: string;
  scriptPath: string;
  home: string;
}

export function serviceFilePath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${AIDE_SERVICE_LABEL}.plist`);
  }

  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config", "systemd", "user", AIDE_SYSTEMD_UNIT);
  }

  throw new Error(`Service install is unsupported on ${process.platform}.`);
}

export async function installService(home: string): Promise<void> {
  const scriptPath = process.argv[1];

  if (!scriptPath) {
    throw new Error("Cannot resolve current CLI path for service install.");
  }

  if (process.platform === "darwin") {
    await installLaunchdService(home, process.execPath, scriptPath);
    return;
  }

  if (process.platform === "linux") {
    await installSystemdService(home, process.execPath, scriptPath);
    return;
  }

  throw new Error(`Service install is unsupported on ${process.platform}.`);
}

export async function uninstallService(): Promise<void> {
  if (process.platform === "darwin") {
    const filePath = serviceFilePath();
    await execa("launchctl", ["bootout", launchdDomain(), filePath], { reject: false });
    fs.rmSync(filePath, { force: true });
    return;
  }

  if (process.platform === "linux") {
    await execa("systemctl", ["--user", "disable", "--now", AIDE_SYSTEMD_UNIT], { reject: false });
    fs.rmSync(serviceFilePath(), { force: true });
    await execa("systemctl", ["--user", "daemon-reload"], { reject: false });
    return;
  }

  throw new Error(`Service uninstall is unsupported on ${process.platform}.`);
}

export async function serviceStatus(): Promise<string> {
  if (process.platform === "darwin") {
    const result = await execa("launchctl", ["print", `${launchdDomain()}/${AIDE_SERVICE_LABEL}`], { reject: false });
    return result.exitCode === 0 ? "installed" : "stopped";
  }

  if (process.platform === "linux") {
    const result = await execa("systemctl", ["--user", "is-enabled", AIDE_SYSTEMD_UNIT], { reject: false });
    return result.exitCode === 0 ? result.stdout.trim() : "stopped";
  }

  throw new Error(`Service status is unsupported on ${process.platform}.`);
}

export function renderLaunchdPlist(options: LaunchdPlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.execPath)}</string>
    <string>${escapeXml(options.scriptPath)}</string>
    <string>__run</string>
    <string>--home</string>
    <string>${escapeXml(options.home)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(options: SystemdUnitOptions): string {
  return `[Unit]
Description=Aide runtime

[Service]
ExecStart=${escapeSystemd(options.execPath)} ${escapeSystemd(options.scriptPath)} __run --home ${escapeSystemd(options.home)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installLaunchdService(home: string, execPath: string, scriptPath: string): Promise<void> {
  const filePath = serviceFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(logsDir(home), { recursive: true });
  fs.writeFileSync(
    filePath,
    renderLaunchdPlist({
      label: AIDE_SERVICE_LABEL,
      execPath,
      scriptPath,
      home,
      stdoutPath: path.join(logsDir(home), "service.out.log"),
      stderrPath: path.join(logsDir(home), "service.err.log")
    })
  );
  await execa("launchctl", ["bootstrap", launchdDomain(), filePath], { reject: false });
  await execa("launchctl", ["enable", `${launchdDomain()}/${AIDE_SERVICE_LABEL}`], { reject: false });
}

async function installSystemdService(home: string, execPath: string, scriptPath: string): Promise<void> {
  const filePath = serviceFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderSystemdUnit({ execPath, scriptPath, home }));
  await execa("systemctl", ["--user", "daemon-reload"]);
  await execa("systemctl", ["--user", "enable", "--now", AIDE_SYSTEMD_UNIT]);
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeSystemd(value: string): string {
  return value.replaceAll(" ", "\\x20");
}
