// Module: Payload construction and template variable resolution.
// Owns: HEX/text ending conversion, template substitution, and serial/network payload building.
// Depends on: core, log-view.
// Called by: serial, network, response-test, macro, and app.js.

import { TEMPLATE_VARIABLE_PATTERN, textEncoder } from "../core/constants.js";
import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { formatTimestamp } from "./log-view.js";

function normalizeAutoSendCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.min(10000000, count));
}

function buildPayload({ consumeTemplateCounter = true } = {}) {
  return buildPayloadFromValue(els.sendInput.value, state.sendMode, els.lineEnding.value, {
    templateKind: "serial",
    consumeCounter: consumeTemplateCounter,
  });
}

function formatTemplateDate(date) {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveTemplateVariables(
  value,
  kind,
  { consumeCounter = true, now = new Date() } = {},
) {
  const source = String(value);
  const customVariables = new Map(
    state.templateCustomVariables.map((variable) => [
      variable.name.toLowerCase(),
      variable.value,
    ]),
  );
  const counterKey = kind === "network" ? "networkTemplateCounter" : "serialTemplateCounter";
  let counter = null;

  const resolveBuiltin = (name) => {
    if (name === "time") return formatTimestamp(now);
    if (name === "date") return formatTemplateDate(now);
    if (name === "datetime") return `${formatTemplateDate(now)} ${formatTimestamp(now)}`;
    if (name === "unix") return String(Math.floor(now.getTime() / 1000));
    if (name === "unix_ms") return String(now.getTime());
    if (name === "random") return String(Math.floor(Math.random() * 65536));
    if (name === "random_hex") {
      return Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, "0")
        .toUpperCase();
    }
    if (name === "uuid") {
      return (
        crypto.randomUUID?.() ||
        `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (character) => {
          const random = Math.floor(Math.random() * 16);
          const value = character === "x" ? random : (random & 0x3) | 0x8;
          return value.toString(16);
        })
      );
    }
    if (name === "counter") {
      if (counter === null) {
        counter = state[counterKey] + 1;
        if (consumeCounter) state[counterKey] = counter;
      }
      return String(counter);
    }
    return null;
  };

  const pattern = new RegExp(TEMPLATE_VARIABLE_PATTERN.source, "g");
  let result = "";
  let lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const matchIndex = match.index ?? 0;
    const token = match[0];
    if (matchIndex > 0 && source[matchIndex - 1] === "\\") {
      result += source.slice(lastIndex, matchIndex - 1);
      result += token;
      lastIndex = matchIndex + token.length;
      continue;
    }

    const name = match[1].toLowerCase();
    const builtin = resolveBuiltin(name);
    const replacement = builtin ?? customVariables.get(name);
    if (replacement === undefined) {
      throw new Error(t("template.varUndefined", { name: match[1] }));
    }
    result += source.slice(lastIndex, matchIndex);
    result += replacement;
    lastIndex = matchIndex + token.length;
  }
  return result + source.slice(lastIndex);
}

function buildPayloadFromValue(
  value,
  mode,
  endingValue,
  { templateKind = null, consumeCounter = true } = {},
) {
  if (mode === "hex") {
    return parseHexInput(value);
  }

  const source = templateKind
    ? resolveTemplateVariables(value, templateKind, { consumeCounter })
    : value;
  const ending = endingBytes(endingValue);
  const body = textEncoder.encode(source);
  const payload = new Uint8Array(body.byteLength + ending.byteLength);
  payload.set(body, 0);
  payload.set(ending, body.byteLength);
  return payload;
}

function parseHexInput(value) {
  const tokens = value
    .trim()
    .split(/[\s,;]+/)
    .filter(Boolean);

  if (!tokens.length) {
    throw new Error(t("payload.hexEmpty"));
  }

  const bytes = [];
  tokens.forEach((token) => {
    const normalized = token.replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
      throw new Error(t("payload.hexInvalid", { token }));
    }

    for (let index = 0; index < normalized.length; index += 2) {
      bytes.push(Number.parseInt(normalized.slice(index, index + 2), 16));
    }
  });

  return new Uint8Array(bytes);
}

function endingBytes(value) {
  if (value === "crlf") return new Uint8Array([0x0d, 0x0a]);
  if (value === "cr") return new Uint8Array([0x0d]);
  if (value === "lf") return new Uint8Array([0x0a]);
  return new Uint8Array();
}

function buildNetworkPayload({ consumeTemplateCounter = true } = {}) {
  return buildPayloadFromValue(
    els.networkSendInput.value,
    state.networkSendMode,
    els.networkLineEnding.value,
    { templateKind: "network", consumeCounter: consumeTemplateCounter },
  );
}

export { buildNetworkPayload, buildPayload, buildPayloadFromValue, endingBytes, formatTemplateDate, normalizeAutoSendCount, parseHexInput, resolveTemplateVariables };
