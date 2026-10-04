// Ultralytics 🚀 AGPL-3.0 License - https://ultralytics.com/license

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FitAddon } from "@xterm/addon-fit";
import { type ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type IBuffer, type IBufferLine, type ILink, type ITheme, Terminal } from "@xterm/xterm";
import { ArrowDownToLine, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

import { ActionIconButton } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import {
  connectTerminalOutput,
  notifyTerminalOutput,
  readTerminalStream,
  recordTerminalInput,
  renderedOutput,
  subscribeOutput,
  writeSession,
} from "@/output-store";
import { IS_MAC, matchesShortcut } from "@/shortcuts";
import type { Theme } from "@/theme";
import type { Agent } from "@/types";

const ACKNOWLEDGE_BYTES = 64 * 1024;
const SEARCH_HIGHLIGHT_LIMIT = 5000;
const countFormat = new Intl.NumberFormat();
const searchHighlights: Record<Theme, { match: string; active: string }> = {
  light: { match: "#fff8c5", active: "#d4a72c" },
  dark: { match: "#5a4314", active: "#9e6a03" },
};

function searchOptions(theme: Theme): ISearchOptions {
  const highlights = searchHighlights[theme];
  return {
    decorations: {
      matchBackground: highlights.match,
      matchOverviewRuler: "#d4a72c",
      activeMatchBackground: highlights.active,
      activeMatchColorOverviewRuler: "#9a6700",
    },
  };
}

// Surface colors follow the app tokens; ANSI colors follow GitHub light and dark, matching the code preview.
const themes: Record<Theme, ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#0a0a0a",
    scrollbarSliderBackground: "#6e778166",
    scrollbarSliderHoverBackground: "#6e778199",
    scrollbarSliderActiveBackground: "#6e7781cc",
    cursor: "#0a0a0a",
    cursorAccent: "#ffffff",
    selectionBackground: "#0969da33",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
  dark: {
    background: "#0a0a0a",
    foreground: "#fafafa",
    scrollbarSliderBackground: "#8b949e66",
    scrollbarSliderHoverBackground: "#8b949e99",
    scrollbarSliderActiveBackground: "#8b949ecc",
    cursor: "#fafafa",
    cursorAccent: "#0a0a0a",
    selectionBackground: "#58a6ff40",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#ffffff",
  },
};

// A control sequence is an escape followed by a string terminator for OSC and DCS, a final byte for
// CSI and SS3, or a single byte for the rest.
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control sequence is defined by them
const SEQUENCES = /\x1b(?:[\]P][\s\S]*?(?:\x07|\x1b\\)|\[[\x30-\x3f]*[ -/]*[@-~]|O[@-~]|[\s\S])/g;

// The same sequence introduced but not yet terminated. A lone escape is deliberately not one of these:
// it is the Escape key, and holding it back would swallow the next character typed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: a control sequence is defined by them
const PARTIAL = /\x1b(?:[\]P](?:(?!\x07|\x1b\\)[\s\S])*|\[[\x30-\x3f]*[ -/]*|O)$/;

// What a file name is made of: letters, digits and marks of any script, so 中文.ts and résumé.md are whole.
const WORD = String.raw`\p{L}\p{N}\p{M}_`;

// A file path, with an optional :line:col, that is not the tail of a longer token or URL: either from a
// Windows drive or UNC share, or relative or absolute, which may start with ./, ../, / or a hidden folder. A folder
// follows / or \, but never a \ and a dot, which is how a regex escapes one: README\.md is not a path.
// Nor does a path start right after an emoji, which is part of a name this cannot read: src/😀a.ts.
const FILE_PATH = new RegExp(
  String.raw`(?<![${WORD}\p{Extended_Pictographic}\u200d\ufe0f./\\:@~)\]}-])(?:[A-Za-z]:[\\/][${WORD}@+.-]+(?:[\\/][${WORD}@+.-]+)*|\\\\[${WORD}.-]+\\[${WORD}.-]+(?:\\[${WORD}@+.-]+)*|(?:(?:\.{1,2}[\\/])+|[\\/])?\.?[${WORD}@+-][${WORD}@+.-]*(?:\/+[${WORD}@+.-]+|\\[${WORD}@+-][${WORD}@+.-]*)*)(?::\d+){0,2}`,
  "gu",
);

// A quoted path, which may hold spaces: the quotes say where it ends, and a :line may follow them. Only
// the quote that opened it ends it, so a name may hold the other kinds. An absolute or ./ path may hold
// spaces anywhere. A relative one only in its file name, and a bare file name not at all, so a quoted
// sentence such as "Update docs/readme.md" or 'echo README.md:5' is not a path.
const QUOTED = new RegExp(
  String.raw`(["'\x60])((?:(?:(?:[A-Za-z]:[\\/]|\\\\[${WORD}.-]+\\|\.{0,2}\/)(?:[^"'\x60\n]|(?<=[${WORD}])(?!\1)["'\x60])*|(?:[${WORD}.@+-]+[\\/])+[${WORD}.@+-](?:[^"'\x60\n\\/{}$<>|=]|(?<=[${WORD}])(?!\1)["'\x60])*|[${WORD}.@+-]+)\.[A-Za-z]\w*|(?:[${WORD}.@+-]+\/)*\.[${WORD}@+-][${WORD}.@+-]*)(?::\d+){0,2})\1(?::(\d+))?`,
  "gu",
);

// The end of a row that cut a path, and the start of the row that picks it up after its indent. A
// path is cut after a folder, so the next row starts inside it, never with a / or a drive of its own.
const CUT_END = new RegExp(String.raw`[${WORD}@+.][-/\\]$`, "u");
const CUT_REST = /^[\s│]*(?![A-Za-z]:[\\/]|[\\/])\S/;

// How many cells the indent an app drew takes: spaces and │, a wide space counting as two.
function indentCells(line: IBufferLine) {
  let x = 0;
  while (x < line.length && /^[\s│]?$/.test(line.getCell(x)?.getChars() ?? "")) x++;
  return x;
}

// Text shaped like a path that is not a file: a web address without its scheme, a repository such as
// owner/name.git, a git range such as main...HEAD, or a relative path mixing / and \, which is a
// newline escape such as \n in front of a path.
const NOT_FILE =
  /^(?:[\w-]+\.)+(?:com|org|net|io|dev|ai|co|me)(?:\/|$)|\w\.git$|\.\.(?![\\/])|^(?![A-Za-z]:)(?=[^\\]*\\)(?=[^/]*\/)/i;

// Cells in the word a row starts with after its indent, which a wrapping app will not split, counted on
// through the rows the terminal wrapped it onto. A wide character takes two.
function wordCells(buffer: IBuffer, row: number, indent: number) {
  let total = 0;
  for (let from = indent, line = buffer.getLine(row); line; from = 0, line = buffer.getLine(++row)) {
    let x = from;
    while (x < line.length && (line.getCell(x)?.getWidth() === 0 || /\S/.test(line.getCell(x)?.getChars() ?? ""))) x++;
    total += x - from;
    if (x < line.length || !buffer.getLine(row + 1)?.isWrapped) break;
  }
  return total;
}

// A row continues the one above when the terminal soft-wrapped it, or when that row ends in a path cut
// at a "-" or "/" and this one picks it up after its indent, which is how Codex and Claude draw a long
// path. An app cuts there only because the next word would not fit, so a short row at the same indent,
// as in a list of folders, is never joined.
function continues(buffer: IBuffer, row: number) {
  const line = buffer.getLine(row);
  if (!line || row === 0) return false;
  if (line.isWrapped) return true;
  const prev = buffer.getLine(row - 1);
  if (!CUT_REST.test(line.translateToString(true)) || !CUT_END.test(prev?.translateToString(true) ?? "")) return false;
  let used = line.length;
  while (used > 0 && !prev?.getCell(used - 1)?.getChars()) used--;
  const indent = indentCells(line);
  // Or the row is indented under the one above, as a wrapped line's rest is. That outlasts a resize,
  // which the width the app cut at does not.
  return used + wordCells(buffer, row, indent) > line.length || (prev !== undefined && indent > indentCells(prev));
}

// Links the file paths on the row at 1-based `y`, reading through the rows of one path. Only a path
// with an extension, and a directory part or a :line, is a link, so words like Node.js, ranges like
// main...HEAD, and code like </Foo.Bar> or /.test/ stay text. The @ that marks a file mention is not
// part of the path.
function fileLinks(terminal: Terminal, y: number, open: (path: string, line?: number) => void): ILink[] {
  const buffer = terminal.buffer.active;
  let first = y - 1;
  while (continues(buffer, first)) first--;
  let text = "";
  const cells: number[] = [];
  for (let row = first, line = buffer.getLine(row); line; line = buffer.getLine(++row)) {
    if (row > first && !continues(buffer, row)) break;
    // A row joined by hand starts after the indent the app drew, which is not part of the path.
    const indent = row > first && !line.isWrapped ? indentCells(line) : 0;
    // Cells after the last one written are padding, not text: a wide character that did not fit leaves
    // one, and a screen that grew leaves many.
    let last = terminal.cols - 1;
    while (last > indent && !line.getCell(last)?.getChars()) last--;
    for (let x = indent; x <= last; x++) {
      const cell = line.getCell(x);
      if (!cell?.getWidth()) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push(row * terminal.cols + x);
    }
    // The blank cells after a row that was cut by hand would split the path.
    if (!buffer.getLine(row + 1)?.isWrapped)
      while (text.endsWith(" ")) {
        text = text.slice(0, -1);
        cells.pop();
      }
  }
  // A quoted path may hold spaces, so its quotes end it. Unquoted, a space ends a path, and the tail of
  // an unfinished one such as /Users/me/My Project/src/a.ts names nothing.
  const quotes = Array.from(text.matchAll(QUOTED), (match) => ({
    index: match.index + 1,
    raw: match[2],
    after: match[3],
  }));
  const found = [
    ...quotes.map((quote) => ({ ...quote, quoted: true })),
    ...Array.from(text.matchAll(FILE_PATH), (match) => ({
      index: match.index,
      raw: match[0],
      after: undefined,
      quoted: false,
    })),
  ];
  // When the scrollback cap has cut the start of a wrapped path off, what is left names nothing.
  const truncated = first === 0 && buffer.getLine(0)?.isWrapped;
  const links: ILink[] = [];
  for (const { index, raw, after, quoted } of found) {
    if (truncated && index === 0 && !quoted) continue;
    // A full stop ends a sentence, but inside quotes it is part of the name, which no link can name.
    const link = quoted ? raw : raw.replace(/\.+$/, "");
    const quote = text[index - 1];
    if (!quoted && link !== raw && quote && /["'`]/.test(quote) && text[index + raw.length] === quote) continue;
    const [, path, inside] = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(link) ?? [];
    const line = inside ?? after;
    if (!/\.[A-Za-z]\w*$/.test(path) || NOT_FILE.test(path)) continue;
    // A bare name such as README.md reads as prose, unless a :line says it is a reference.
    if (!/[^\\/][\\/]/.test(path) && path === link && after === undefined) continue;
    const before = text.slice(Math.max(0, index - 300), index);
    // An absolute path with no extension, then spaces and capitalized words, is read as a folder name
    // with spaces in it that this path continues; punctuation is read as the end of a sentence. Both are
    // guesses. A lowercase folder name is read as prose, so its tail still links and can open a
    // different file of the same relative path under the session's folder.
    const folder = /(?:^|\s)((?:\/|[A-Za-z]:[\\/])(?:\S*[^\s.,;:!?])?)(?:\s+[A-Z0-9(][^\s/\\.,;:!?]*)*\s+$/.exec(
      before,
    )?.[1];
    if (
      !quoted &&
      (quotes.some((quote) => index >= quote.index && index < quote.index + quote.raw.length) ||
        (folder !== undefined && !/\.[A-Za-z]\w*(?::\d+){0,2}$/.test(folder) && !/^(?:\/|[A-Za-z]:[\\/])/.test(raw)))
    )
      continue;
    const start = cells[index];
    const end = cells[index + link.length - 1];
    const range = {
      start: { x: (start % terminal.cols) + 1, y: Math.floor(start / terminal.cols) + 1 },
      end: { x: (end % terminal.cols) + 1, y: Math.floor(end / terminal.cols) + 1 },
    };
    if (y >= range.start.y && y <= range.end.y)
      links.push({
        range,
        text: link,
        activate: () => {
          // Git writes a/ and b/ before the two sides of a diff; they are folders anywhere else. A click
          // can read the whole line, which a long header needs: its second path is far from its start.
          const diff = /(?:---|\+\+\+|diff --git(?: (?:"[^"]*"|\S+))?) "?$/.test(text.slice(0, index));
          open(path.replace(diff ? /^(?:@|[ab]\/)/ : /^@/, ""), line ? Number(line) : undefined);
        },
      });
  }
  return links;
}

export function TerminalView({
  sessionId,
  rootId,
  agent,
  theme,
  fontSize,
  active,
  working,
  starting,
  onZoom,
  onPrompt,
  onOutput,
  onOpenFile,
  onRecover,
}: {
  sessionId: string;
  rootId: string;
  agent: Agent;
  theme: Theme;
  fontSize: number;
  active: boolean;
  working: boolean;
  starting: boolean;
  onZoom: (step: -1 | 0 | 1) => void;
  onPrompt: (text: string) => void;
  onOutput: (output: string, terminalStream: string) => void;
  onOpenFile: (path: string, line?: number) => void;
  onRecover: () => Promise<void>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rootIdRef = useRef(rootId);
  rootIdRef.current = rootId;
  // Held in a ref so a new prompt handler never rebuilds the terminal underneath the session.
  const promptRef = useRef(onPrompt);
  promptRef.current = onPrompt;
  const outputRef = useRef(onOutput);
  outputRef.current = onOutput;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const recoverRef = useRef(onRecover);
  recoverRef.current = onRecover;
  const zoomRef = useRef(onZoom);
  zoomRef.current = onZoom;
  const terminalRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState({ resultIndex: -1, resultCount: 0 });
  const [scrolledUp, setScrolledUp] = useState(false);
  const searchQueryRef = useRef("");
  const resizeRef = useRef<() => void>(() => undefined);
  const checkRef = useRef(true);
  const workingRef = useRef(working);
  if (workingRef.current && !working) checkRef.current = true;
  workingRef.current = working;
  // Read when a terminal is built, so switching sessions paints the new one in the current theme
  // without rebuilding it every time the theme changes.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  // Followed without a rebuild, so a shell that starts an agent is picked up.
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setScrolledUp(false);

    const openLink = (event: MouseEvent, url: string) => {
      event.preventDefault();
      void invoke("open_url", { url, rootId: rootIdRef.current }).catch((reason) =>
        console.error("Lite could not open the link:", reason),
      );
    };
    const terminal = new Terminal({
      // The official search addon uses xterm decorations to count and mark every match.
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: fontSizeRef.current,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      overviewRuler: { width: 6 },
      linkHandler: { activate: openLink },
      scrollback: 5000,
      theme: themes[themeRef.current],
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const searchAddon = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT });
    searchAddonRef.current = searchAddon;
    terminal.loadAddon(searchAddon);
    const searchResults = searchAddon.onDidChangeResults((result) => {
      setSearchResult(result);
    });
    terminal.loadAddon(new WebLinksAddon(openLink));
    terminal.registerLinkProvider({
      provideLinks: (y, callback) => callback(fileLinks(terminal, y, (path, line) => openFileRef.current(path, line))),
    });
    terminal.open(container);
    const scroll = terminal.onScroll((viewportY) => setScrolledUp(viewportY < terminal.buffer.active.baseY));
    const disconnectTerminalOutput = connectTerminalOutput(sessionId, () => renderedOutput(terminal));
    // The addon waits for output to go quiet before rebuilding its result map, which a live TUI may
    // never do. Refresh at a bounded rate while it writes; the addon's own timer handles the final pass.
    let searchRefresh = 0;
    let outputRefresh = 0;
    const refreshSearch = () => {
      const query = searchQueryRef.current;
      if (!query) return;
      // Clearing decorations leaves xterm's selection in place, so the addon rebuilds highlights and
      // reselects that same match directly instead of replaying every earlier match.
      searchAddon.clearDecorations();
      searchAddon.findNext(query, { ...searchOptions(themeRef.current), incremental: true });
    };
    const rememberOutput = () => outputRef.current(renderedOutput(terminal), readTerminalStream(sessionId));
    const parsed = terminal.onWriteParsed(() => {
      notifyTerminalOutput(sessionId);
      if (!outputRefresh) {
        rememberOutput();
        outputRefresh = window.setTimeout(() => {
          outputRefresh = 0;
          rememberOutput();
        }, 250);
      }
      if (!searchQueryRef.current) return;
      if (!searchRefresh)
        searchRefresh = window.setTimeout(() => {
          searchRefresh = 0;
          refreshSearch();
        }, 200);
    });
    // Lite stops reading the session once the page falls behind, so drawn output is reported back,
    // a batch at a time, well before the reader's limit.
    let drawn = 0;
    const unsubscribe = subscribeOutput(sessionId, (data) =>
      terminal.write(data, () => {
        drawn += data.byteLength;
        if (drawn < ACKNOWLEDGE_BYTES) return;
        void invoke("acknowledge_output", { sessionId, bytes: drawn }).catch(() => {});
        drawn = 0;
      }),
    );
    // What the user types before the first Enter is the closest thing a session has to a subject.
    // Typing, pasting, and the terminal's own answers to the program's cursor, focus, and color
    // queries all arrive here, and an answer is printable once its escape is dropped, so the escape
    // sequences are removed and only what a person actually typed is left to read.
    let typed = "";
    // An event can end mid-sequence, so an unfinished tail waits for the rest instead of being read.
    let pending = "";
    const input = terminal.onData((data) => {
      if (checkRef.current) {
        checkRef.current = false;
        void recoverRef.current().catch(() => {});
      }
      const buffer = pending + data;
      const partial = buffer.match(PARTIAL);
      pending = partial?.[0] ?? "";
      for (const character of buffer.slice(0, partial?.index ?? buffer.length).replace(SEQUENCES, "")) {
        if (character === "\r" || character === "\n") {
          const line = typed.trim();
          typed = "";
          if (line) {
            recordTerminalInput(sessionId, line);
            promptRef.current(line);
          }
        } else if (character === "\u007f") typed = typed.slice(0, -1);
        else if (character >= " ") typed += character;
      }
      writeSession(sessionId, data);
    });
    const resize = () => {
      fit.fit();
      void invoke("resize_session", {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      });
    };
    resizeRef.current = resize;
    // A width change arrives as a stream of frames: a drag, or the ease a collapsing panel runs
    // through. Fitting on each one rewraps the scrollback and hands the child a window size it is
    // never shown at, so the terminal is fitted once the size has settled.
    let settle = 0;
    const settleResize = () => {
      window.clearTimeout(settle);
      settle = window.setTimeout(resize, 100);
    };
    const observer = new ResizeObserver(settleResize);
    observer.observe(container);
    // WebKit can miss the element resize when macOS moves a window onto the built-in display after
    // an external display disconnects. The native window event reaches the same fit owner.
    const resized = getCurrentWindow().onResized(settleResize);
    // Files dropped on the window paste their paths into the terminal in view, as a terminal app
    // does, so an agent can pick up a dropped image. Nothing else takes a drop, and the position Tauri
    // reports is in points on macOS and Linux but pixels on Windows, so the drop is not hit-tested.
    const dropped = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type !== "drop" || !payload.paths.length || !activeRef.current) return;
      void invoke<string>("quote_dropped_paths", { paths: payload.paths })
        .then((text) => {
          // Nothing is left when every path was unpasteable, and the terminal may have closed, been
          // rebuilt, or left view while the paths were quoted.
          if (!text || terminalRef.current !== terminal || !activeRef.current) return;
          terminal.paste(text);
          terminal.focus();
        })
        .catch((reason) => console.error("Lite could not paste the dropped files:", reason));
    });
    // Command and the zoom keys resize the type, as they do in a terminal app.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      // Without the kitty keyboard protocol, Escape+Return is the newline the agent CLIs read.
      if (
        agentRef.current !== "shell" &&
        event.key === "Enter" &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        // Returning false leaves the keypress to follow and send a bare carriage return.
        event.preventDefault();
        terminal.input("\x1b\r");
        return false;
      }
      // xterm defers ASCII capitals to keypress for macOS IMEs. WKWebView also emits text input for
      // Shift and Caps Lock capitals, so that path can forward one physical key more than once.
      if (
        !event.isComposing &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.keyCode !== 229 &&
        event.key.length === 1 &&
        event.key >= "A" &&
        event.key <= "Z"
      ) {
        event.preventDefault();
        event.stopPropagation();
        terminal.input(event.key);
        return false;
      }
      const step = matchesShortcut(event, "zoomIn")
        ? 1
        : matchesShortcut(event, "zoomOut")
          ? -1
          : matchesShortcut(event, "zoomReset")
            ? 0
            : undefined;
      if (step === undefined) return true;
      zoomRef.current(step);
      return false;
    });
    resize();

    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(searchRefresh);
      window.clearTimeout(outputRefresh);
      observer.disconnect();
      void resized.then((unlisten) => unlisten());
      void dropped.then((unlisten) => unlisten());
      searchResults.dispose();
      scroll.dispose();
      input.dispose();
      unsubscribe();
      parsed.dispose();
      disconnectTerminalOutput();
      terminal.dispose();
      terminalRef.current = null;
      searchAddonRef.current = null;
      resizeRef.current = () => undefined;
    };
  }, [sessionId]);

  useEffect(() => {
    if (active) terminalRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (!starting) requestAnimationFrame(() => resizeRef.current());
  }, [starting]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const query = searchQueryRef.current;
    terminal.options.theme = query
      ? { ...themes[theme], selectionBackground: searchHighlights[theme].active }
      : themes[theme];
    const searchAddon = searchAddonRef.current;
    if (query && searchAddon) {
      searchAddon.clearDecorations();
      searchAddon.findNext(query, { ...searchOptions(theme), incremental: true });
    }
  }, [theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!active || !terminal || terminal.options.fontSize === fontSize) return;
    terminal.options.fontSize = fontSize;
    resizeRef.current();
  }, [active, fontSize]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchOpen]);

  function find(term: string, previous = false, incremental = false) {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon) return;
    const terminal = terminalRef.current;
    if (!term) {
      searchAddon.clearDecorations();
      terminal?.clearSelection();
      if (terminal) terminal.options.theme = themes[themeRef.current];
      const result = { resultIndex: -1, resultCount: 0 };
      setSearchResult(result);
      return;
    }
    if (terminal && terminal.options.theme?.selectionBackground === themes[themeRef.current].selectionBackground)
      terminal.options.theme = {
        ...themes[themeRef.current],
        selectionBackground: searchHighlights[themeRef.current].active,
      };
    searchAddon[previous ? "findPrevious" : "findNext"](term, { ...searchOptions(themeRef.current), incremental });
  }

  function closeSearch() {
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.clearSelection();
    if (terminalRef.current) terminalRef.current.options.theme = themes[themeRef.current];
    setSearchOpen(false);
    setSearchQuery("");
    searchQueryRef.current = "";
    const result = { resultIndex: -1, resultCount: 0 };
    setSearchResult(result);
    terminalRef.current?.focus();
  }

  // Opening on a selection searches for it, as the editor's find does; the field is then selected so
  // typing replaces it.
  function openSearch() {
    const selection = terminalRef.current?.getSelection().trim() ?? "";
    if (selection && !selection.includes("\n") && selection.length <= 100) {
      searchQueryRef.current = selection;
      setSearchQuery(selection);
      find(selection, false, true);
    }
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    } else setSearchOpen(true);
  }

  function scrollToBottom() {
    terminalRef.current?.scrollToBottom();
    terminalRef.current?.focus();
  }

  // The padding belongs on the wrapper, never on the element the terminal is opened in. The fit addon
  // sizes the terminal from getComputedStyle(parent).height, which WebKit reports as the border box,
  // and it only subtracts padding declared on the terminal's own element. Padding here would be
  // counted as usable space, so the terminal laid out a row and three columns more than fit and hung
  // them past the edge, which also left the last row below the viewport where the scrollbar could
  // neither show nor reach it.
  return (
    <div
      data-context-session={sessionId}
      data-context-zoom
      className="relative h-full w-full bg-background p-3 pr-1.5"
      onKeyDownCapture={(event) => {
        if (searchOpen && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
          return;
        }
        if (
          searchOpen &&
          (event.key === "F3" || ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "g"))
        ) {
          event.preventDefault();
          event.stopPropagation();
          find(searchQuery, event.shiftKey);
          return;
        }
        if (matchesShortcut(event.nativeEvent, "find")) {
          event.preventDefault();
          event.stopPropagation();
          openSearch();
        }
      }}
    >
      <button type="button" hidden data-context-zoom-in onClick={() => zoomRef.current(1)} />
      <button type="button" hidden data-context-zoom-out onClick={() => zoomRef.current(-1)} />
      <button type="button" hidden data-context-zoom-reset onClick={() => zoomRef.current(0)} />
      <button type="button" hidden data-terminal-search onClick={openSearch} />
      <button type="button" hidden data-terminal-scroll-bottom onClick={scrollToBottom} />
      {searchOpen ? (
        <div className="absolute top-2 right-[8.5rem] z-10 w-72 max-w-[calc(100%-9rem)] rounded-lg bg-background shadow-lg">
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              value={searchQuery}
              placeholder="Find in terminal"
              aria-label="Find in terminal"
              onChange={(event) => {
                searchQueryRef.current = event.target.value;
                setSearchQuery(event.target.value);
                find(event.target.value, false, true);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                  event.preventDefault();
                  find(searchQuery, event.key === "ArrowUp");
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  find(searchQuery, event.shiftKey);
                }
              }}
            />
            <InputGroupAddon align="inline-end" className="gap-0 pr-1">
              <span className="min-w-14 px-1 text-center text-xs tabular-nums" aria-live="polite" aria-atomic="true">
                {searchResult.resultCount
                  ? searchResult.resultIndex >= 0
                    ? countFormat.format(searchResult.resultIndex + 1)
                    : "–"
                  : "0"}{" "}
                / {countFormat.format(searchResult.resultCount)}
                {searchResult.resultCount >= SEARCH_HIGHLIGHT_LIMIT ? "+" : ""}
              </span>
              <InputGroupButton
                size="icon-xs"
                tooltip={`Previous match · ${IS_MAC ? "⇧↩" : "Shift+Enter"}`}
                aria-label="Previous match"
                disabled={!searchQuery}
                onClick={() => find(searchQuery, true)}
              >
                <ChevronUp />
              </InputGroupButton>
              <InputGroupButton
                size="icon-xs"
                tooltip={`Next match · ${IS_MAC ? "↩" : "Enter"}`}
                aria-label="Next match"
                disabled={!searchQuery}
                onClick={() => find(searchQuery)}
              >
                <ChevronDown />
              </InputGroupButton>
              <InputGroupButton size="icon-xs" tooltip="Close · Esc" aria-label="Close search" onClick={closeSearch}>
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      ) : null}
      {scrolledUp ? (
        <ActionIconButton
          size="icon-sm"
          className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-background/90 text-muted-foreground shadow-sm"
          tooltip="Scroll to bottom"
          tooltipSide="top"
          aria-label="Scroll to bottom"
          onMouseDown={(event) => event.preventDefault()}
          onClick={scrollToBottom}
        >
          <ArrowDownToLine />
        </ActionIconButton>
      ) : null}
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
