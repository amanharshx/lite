// Ultralytics 🚀 AGPL-3.0 License - https://ultralytics.com/license

import { expect, test } from "bun:test";
import type { Terminal } from "@xterm/xterm";
import { pasteClipboard } from "../src/terminal";

// xterm's paste needs a terminal opened in a document, so the calls are recorded instead.
async function pasted(read: Promise<string>, active = true) {
  const calls: string[][] = [];
  const terminal = {
    paste: (text: string) => calls.push(["paste", text]),
    input: (data: string) => calls.push(["input", data]),
    focus: () => calls.push(["focus"]),
  } as unknown as Terminal;
  await pasteClipboard(read, () => (active ? terminal : null)).catch((error) => calls.push(["error", error.message]));
  return calls;
}

test("text is pasted", async () => {
  expect(await pasted(Promise.resolve("echo one\necho two"))).toEqual([["paste", "echo one\necho two"], ["focus"]]);
});

test("an image-only or empty clipboard sends Control+V", async () => {
  expect(await pasted(Promise.resolve(""))).toEqual([["input", "\x16"], ["focus"]]);
});

test("a failed clipboard read pastes nothing", async () => {
  expect(await pasted(Promise.reject(new Error("denied")))).toEqual([["error", "denied"]]);
});

test("a read that finishes after the session left view pastes nothing", async () => {
  expect(await pasted(Promise.resolve("echo late"), false)).toEqual([]);
});
