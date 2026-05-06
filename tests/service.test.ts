import { describe, expect, it } from "vitest";
import { renderLaunchdPlist, renderSystemdUnit } from "../src/lib/service.js";

describe("service files", () => {
  it("renders a launchd plist", () => {
    const plist = renderLaunchdPlist({
      label: "com.inksphere.aide",
      execPath: "/usr/local/bin/node",
      scriptPath: "/usr/local/bin/aide",
      home: "/Users/zou/.aide",
      stdoutPath: "/Users/zou/.aide/logs/service.out.log",
      stderrPath: "/Users/zou/.aide/logs/service.err.log"
    });

    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<string>/usr/local/bin/node</string>");
    expect(plist).toContain("<string>__run</string>");
    expect(plist).toContain("<string>--home</string>");
  });

  it("renders a systemd user unit", () => {
    const unit = renderSystemdUnit({
      execPath: "/usr/bin/node",
      scriptPath: "/usr/local/bin/aide",
      home: "/home/zou/.aide"
    });

    expect(unit).toContain("[Service]");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("ExecStart=/usr/bin/node /usr/local/bin/aide __run --home /home/zou/.aide");
  });
});
