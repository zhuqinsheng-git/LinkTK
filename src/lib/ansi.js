// Module: ANSI SGR parsing.
// Owns: ANSI palette, style state, SGR application, and text segmentation.
// Depends on: nothing.
// Called by: log-view and the terminal/log rendering flows.

const ANSI_COLORS = [
  "#183047",
  "#c75f59",
  "#9dbb4e",
  "#d7b35f",
  "#78a9d4",
  "#b98ac7",
  "#57a7a4",
  "#f5f5f5",
  "#8c8c8c",
  "#df7b74",
  "#c3dc7c",
  "#ebcb7e",
  "#8fc1eb",
  "#d0a5e2",
  "#7fd0cd",
  "#ffffff",
];

function createAnsiStyle() {
  return {
    foreground: null,
    background: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    hidden: false,
    strike: false,
  };
}

function ansi256Color(index) {
  if (!Number.isFinite(index) || index < 0 || index > 255) return null;
  if (index < 16) return ANSI_COLORS[index];

  if (index < 232) {
    const value = index - 16;
    const red = Math.floor(value / 36);
    const green = Math.floor((value % 36) / 6);
    const blue = value % 6;
      const channel = (component) => (component === 0 ? 18 : 55 + component * 40);
    return `rgb(${channel(red)}, ${channel(green)}, ${channel(blue)})`;
  }

  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applySgrCodes(current, parameterText) {
  const parameters = parameterText
    ? parameterText.split(";").map((value) => (value === "" ? 0 : Number.parseInt(value, 10)))
    : [0];
  let style = { ...current };

  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index];
    if (!Number.isFinite(code) || code === 0) {
      style = createAnsiStyle();
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 3) {
      style.italic = true;
    } else if (code === 4) {
      style.underline = true;
    } else if (code === 7) {
      style.inverse = true;
    } else if (code === 8) {
      style.hidden = true;
    } else if (code === 9) {
      style.strike = true;
    } else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) {
      style.italic = false;
    } else if (code === 24) {
      style.underline = false;
    } else if (code === 27) {
      style.inverse = false;
    } else if (code === 28) {
      style.hidden = false;
    } else if (code === 29) {
      style.strike = false;
    } else if (code >= 30 && code <= 37) {
      style.foreground = ANSI_COLORS[code - 30];
    } else if (code === 39) {
      style.foreground = null;
    } else if (code >= 40 && code <= 47) {
      style.background = ANSI_COLORS[code - 40];
    } else if (code === 49) {
      style.background = null;
    } else if (code >= 90 && code <= 97) {
      style.foreground = ANSI_COLORS[code - 90 + 8];
    } else if (code >= 100 && code <= 107) {
      style.background = ANSI_COLORS[code - 100 + 8];
    } else if ((code === 38 || code === 48) && parameters[index + 1] === 5) {
      const color = ansi256Color(parameters[index + 2]);
      if (code === 38) style.foreground = color;
      else style.background = color;
      index += 2;
    } else if ((code === 38 || code === 48) && parameters[index + 1] === 2) {
      const red = parameters[index + 2];
      const green = parameters[index + 3];
      const blue = parameters[index + 4];
      if ([red, green, blue].every(Number.isFinite)) {
        const color = `rgb(${red}, ${green}, ${blue})`;
        if (code === 38) style.foreground = color;
        else style.background = color;
      }
      index += 4;
    }
  }

  return style;
}

function parseAnsiText(input, initialState = createAnsiStyle()) {
  const segments = [];
  let remainder = "";
  let style = { ...initialState };
  let cursor = 0;

  const pushText = (text) => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous && previous.style === style) {
      previous.text += text;
    } else {
      segments.push({ text, style });
    }
  };

  while (cursor < input.length) {
    const escapeIndex = input.indexOf("\x1b", cursor);
    if (escapeIndex === -1) {
      pushText(input.slice(cursor));
      break;
    }

    pushText(input.slice(cursor, escapeIndex));
    if (escapeIndex + 1 >= input.length) {
      remainder = input.slice(escapeIndex);
      break;
    }

    const marker = input[escapeIndex + 1];
    if (marker !== "[") {
      if (marker === "]") {
        const bellIndex = input.indexOf("\x07", escapeIndex + 2);
        const stringTerminator = input.indexOf("\x1b\\", escapeIndex + 2);
        const endings = [bellIndex, stringTerminator].filter((value) => value >= 0);
        if (!endings.length) {
          remainder = input.slice(escapeIndex);
          break;
        }
        const ending = Math.min(...endings);
        cursor = input.startsWith("\x1b\\", ending) ? ending + 2 : ending + 1;
      } else {
        cursor = escapeIndex + 2;
      }
      continue;
    }

    let finalIndex = escapeIndex + 2;
    while (finalIndex < input.length) {
      const code = input.charCodeAt(finalIndex);
      if (code >= 0x40 && code <= 0x7e) break;
      finalIndex += 1;
    }

    if (finalIndex >= input.length) {
      remainder = input.slice(escapeIndex);
      break;
    }

    const finalCharacter = input[finalIndex];
    const parameters = input.slice(escapeIndex + 2, finalIndex);
    if (finalCharacter === "m") {
      style = applySgrCodes(style, parameters);
    }
    cursor = finalIndex + 1;
  }

  return {
    segments,
    remainder,
    style,
  };
}

export { createAnsiStyle, parseAnsiText };
