import { execa } from "execa";

export async function openPath(targetPath: string): Promise<void> {
  const editor = process.env.EDITOR;

  if (editor) {
    await execa(editor, [targetPath], { stdio: "inherit" });
    return;
  }

  if (process.platform === "darwin") {
    await execa("open", [targetPath], { stdio: "inherit" });
    return;
  }

  await execa("xdg-open", [targetPath], { stdio: "inherit" });
}

export async function openFiles(filePaths: string[]): Promise<void> {
  const editor = process.env.EDITOR;

  if (editor) {
    await execa(editor, filePaths, { stdio: "inherit" });
    return;
  }

  await openPath(filePaths[0] ?? ".");
}
