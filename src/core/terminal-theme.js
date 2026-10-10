// Module: Shared xterm color theme.
// Owns: the terminal color palette used by both the serial and SSH terminals.
// Depends on: nothing.
// Called by: features/terminal.js and features/ssh.js.

const TERMINAL_THEME = {
  background: "#173a5e",
  foreground: "#f5f5f5",
  cursor: "#9dbb4e",
  cursorAccent: "#173a5e",
  selectionBackground: "#566b83",
  black: "#183047",
  red: "#c75f59",
  green: "#9dbb4e",
  yellow: "#d7b35f",
  blue: "#78a9d4",
  magenta: "#b98ac7",
  cyan: "#57a7a4",
  white: "#f5f5f5",
  brightBlack: "#8c8c8c",
  brightRed: "#df7b74",
  brightGreen: "#c3dc7c",
  brightYellow: "#ebcb7e",
  brightBlue: "#8fc1eb",
  brightMagenta: "#d0a5e2",
  brightCyan: "#7fd0cd",
  brightWhite: "#ffffff",
};

export { TERMINAL_THEME };
