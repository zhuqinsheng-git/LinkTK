// Module: AI event windows and payload construction for serial, network, and SSH.
// Owns: event serialization, waiting, pattern matching, cancellable delay, and AI send payloads.
// Depends on: core/state.js, lib/format.js, agent/runtime.js.
// Called by: app.js AI command implementations.

import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { buildPayloadFromValue } from "../features/payload.js";
import { bytesToHex } from "../lib/format.js";
import { resolveAgentEnding } from "./runtime.js";

function serializeAgentEvent(event) {
  const preview = event.bytes.subarray(0, 16384);
  return {
    sequence: event.sequence,
    direction: event.direction,
    actor: event.actor,
    at: event.at,
    byteCount: event.bytes.byteLength,
    truncated: preview.byteLength < event.bytes.byteLength,
    text: String(event.text || "").slice(0, 16384),
    hex: bytesToHex(preview),
  };
}

function getAgentEventsSince(since, { limit = 1000, direction = "all" } = {}) {
  const minimum = Number.isFinite(Number(since)) ? Number(since) : 0;
  const events = state.agentEvents.filter(
    (event) =>
      event.sequence > minimum &&
      (direction === "all" || event.direction === direction),
  );
  return events.slice(-Math.max(1, Math.min(1000, limit)));
}

function getNetworkAgentEventsSince(since, { limit = 1000, direction = "all" } = {}) {
  const minimum = Number.isFinite(Number(since)) ? Number(since) : 0;
  const events = state.networkAgentEvents.filter(
    (event) =>
      event.sequence > minimum &&
      (direction === "all" || event.direction === direction),
  );
  return events.slice(-Math.max(1, Math.min(1000, limit)));
}

function agentEventsText(events, maxCharacters = 65536) {
  const text = events.map((event) => event.text).join("");
  if (text.length <= maxCharacters) return { text, truncated: false };
  return {
    text: text.slice(-maxCharacters),
    truncated: true,
  };
}

function agentPatternMatcher({ pattern = "", mode = "contains", caseSensitive = false } = {}) {
  const source = String(pattern || "");
  if (!source) return () => true;

  if (mode === "regex") {
    const expression = new RegExp(source, caseSensitive ? "" : "i");
    return (text) => expression.test(text);
  }

  const expected = caseSensitive ? source : source.toLowerCase();
  return (text) => (caseSensitive ? text : text.toLowerCase()).includes(expected);
}

function waitForAgentEvents({
  since,
  direction = "rx",
  timeoutMs = 5000,
  predicate = (events) => events.length > 0,
  signal,
} = {}) {
  const timeout = Math.max(1, Math.min(120000, Number(timeoutMs) || 5000));
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const inspect = () => {
      const events = getAgentEventsSince(since, { direction, limit: 1000 });
      if (signal?.aborted) {
        resolve({
          matched: false,
          timedOut: false,
          cancelled: true,
          events,
        });
        return;
      }
      if (predicate(events)) {
        resolve({
          matched: true,
          timedOut: false,
          events,
        });
        return;
      }

      if (performance.now() - startedAt >= timeout) {
        resolve({
          matched: false,
          timedOut: true,
          events,
        });
        return;
      }

      window.setTimeout(inspect, 20);
    };

    inspect();
  });
}

function waitForNetworkAgentEvents({
  since,
  direction = "rx",
  timeoutMs = 5000,
  predicate = (events) => events.length > 0,
  signal,
} = {}) {
  const timeout = Math.max(1, Math.min(120000, Number(timeoutMs) || 5000));
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const inspect = () => {
      const events = getNetworkAgentEventsSince(since, { direction, limit: 1000 });
      if (signal?.aborted) {
        resolve({
          matched: false,
          timedOut: false,
          cancelled: true,
          events,
        });
        return;
      }
      if (predicate(events)) {
        resolve({
          matched: true,
          timedOut: false,
          events,
        });
        return;
      }

      if (performance.now() - startedAt >= timeout) {
        resolve({
          matched: false,
          timedOut: true,
          events,
        });
        return;
      }

      window.setTimeout(inspect, 20);
    };

    inspect();
  });
}

function getSshEventsSince(since, { limit = 1000, direction = "all" } = {}) {
  const minimum = Number.isFinite(Number(since)) ? Number(since) : 0;
  const events = state.sshOutputEvents.filter(
    (event) =>
      event.sequence > minimum &&
      (direction === "all" || event.direction === direction),
  );
  return events.slice(-Math.max(1, Math.min(1000, limit)));
}

function sshEventsText(events, maxCharacters = 65536) {
  const text = events.map((event) => event.text).join("");
  if (text.length <= maxCharacters) return { text, truncated: false };
  return {
    text: text.slice(-maxCharacters),
    truncated: true,
  };
}

function waitForSshEvents({
  since,
  direction = "rx",
  timeoutMs = 5000,
  predicate = (events) => events.length > 0,
  signal,
} = {}) {
  const timeout = Math.max(1, Math.min(120000, Number(timeoutMs) || 5000));
  const startedAt = performance.now();

  return new Promise((resolve) => {
    const inspect = () => {
      const events = getSshEventsSince(since, { direction, limit: 1000 });
      if (signal?.aborted) {
        resolve({
          matched: false,
          timedOut: false,
          cancelled: true,
          events,
        });
        return;
      }
      if (predicate(events)) {
        resolve({
          matched: true,
          timedOut: false,
          events,
        });
        return;
      }

      if (performance.now() - startedAt >= timeout) {
        resolve({
          matched: false,
          timedOut: true,
          events,
        });
        return;
      }

      window.setTimeout(inspect, 20);
    };

    inspect();
  });
}

function delay(milliseconds, signal) {
  const value = Math.max(0, Math.min(5000, Number(milliseconds) || 0));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException(t("agent.cancelled"), "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, value);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException(t("agent.cancelled"), "AbortError"));
      },
      { once: true },
    );
  });
}

function normalizeAgentEnding(value) {
  return ["none", "lf", "cr", "crlf"].includes(value) ? value : "lf";
}

function buildAgentPayload(params = {}, transport = "serial") {
  const encoding = params.encoding === "hex" ? "hex" : "text";
  const data = String(params.data ?? "");
  return buildPayloadFromValue(
    data,
    encoding,
    normalizeAgentEnding(resolveAgentEnding(params, transport)),
  );
}

export { agentEventsText, agentPatternMatcher, buildAgentPayload, delay, getAgentEventsSince, getNetworkAgentEventsSince, getSshEventsSince, normalizeAgentEnding, serializeAgentEvent, sshEventsText, waitForAgentEvents, waitForNetworkAgentEvents, waitForSshEvents };
