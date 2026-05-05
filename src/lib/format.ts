export function printTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const cells = rows.map((row) => row[index] ?? "");
    return Math.max(header.length, ...cells.map((cell) => cell.length));
  });

  const headerLine = headers.map((header, index) => header.padEnd(widths[index] ?? header.length)).join("  ");
  const rowLines = rows.map((row) =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ")
  );

  return [headerLine, ...rowLines].join("\n");
}

export function statusLabel(enabled: boolean): string {
  return enabled ? "enabled" : "paused";
}

export function checkMark(status: "ok" | "warn" | "fail"): string {
  if (status === "ok") {
    return "✓";
  }

  if (status === "warn") {
    return "!";
  }

  return "x";
}
