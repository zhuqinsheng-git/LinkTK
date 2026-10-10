// Module: Template variable normalization and editor dialog.
// Owns: template variable validation, the built-in variable list, draft editing, and insertion.
// Depends on: lucide, core/constants.js, core/dom.js, core/errors.js, core/i18n.js, core/state.js, toast.js.
// Called by: app.js.

import { Braces, Trash2, createIcons } from "lucide";
import { BUILTIN_TEMPLATE_VARIABLES, BUILTIN_TEMPLATE_VARIABLE_NAMES, MAX_TEMPLATE_VARIABLES, TEMPLATE_VARIABLE_NAME_PATTERN } from "../core/constants.js";
import { $, createLucideIcon, els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { showToast } from "./toast.js";

function normalizeTemplateCustomVariables(value, { strict = false } = {}) {
  const variables = Array.isArray(value) ? value : [];
  const seen = new Set();
  const normalized = variables
    .slice(0, MAX_TEMPLATE_VARIABLES)
    .map((variable) => {
      const name = String(variable?.name ?? "").trim();
      const variableValue = String(variable?.value ?? "").slice(0, 2000);
      const invalid = (message) => {
        if (strict) throw new Error(message);
        return null;
      };

      if (!name && !variableValue) return null;
      if (!name) return invalid(t("template.error.nameRequired"));
      if (!TEMPLATE_VARIABLE_NAME_PATTERN.test(name)) {
        return invalid(t("template.error.nameInvalid", { name }));
      }

      const normalizedName = name.toLowerCase();
      if (BUILTIN_TEMPLATE_VARIABLE_NAMES.has(normalizedName)) {
        return invalid(t("template.error.nameBuiltin", { name }));
      }
      if (seen.has(normalizedName)) {
        return invalid(t("template.error.nameDuplicate", { name }));
      }
      seen.add(normalizedName);
      return { name, value: variableValue };
    })
    .filter(Boolean);

  return normalized;
}

function getTemplateButton(kind) {
  return kind === "network" ? els.networkTemplateButton : els.serialTemplateButton;
}

function updateTemplateButtonUI(kind) {
  const button = getTemplateButton(kind);
  if (!button) return;
  const enabled = (kind === "network" ? state.networkSendMode : state.sendMode) === "text";
  const label = kind === "network" ? t("net.send.template") : t("serial.send.template");
  button.disabled = !enabled;
  button.title = enabled ? label : t("template.button.textOnly");
  button.setAttribute("aria-label", button.title);
}

function renderBuiltinTemplateVariables() {
  const fragment = document.createDocumentFragment();
  BUILTIN_TEMPLATE_VARIABLES.forEach((variable) => {
    const button = document.createElement("button");
    button.className = "template-token";
    button.type = "button";
    button.dataset.templateToken = variable.name;
    button.title = t("template.insertTitle", { name: variable.name });

    const code = document.createElement("code");
    code.textContent = `{{${variable.name}}}`;
    const meta = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = t(`template.var.${variable.name}`);
    const example = document.createElement("small");
    example.textContent = variable.example;
    meta.append(label, example);
    button.append(code, meta);
    fragment.append(button);
  });
  els.templateBuiltinList.replaceChildren(fragment);
}

function renderTemplateVariableList() {
  const fragment = document.createDocumentFragment();
  if (!state.templateDraftVariables.length) {
    const empty = document.createElement("p");
    empty.className = "template-variable-list__empty";
    empty.textContent = t("template.empty");
    fragment.append(empty);
  }

  state.templateDraftVariables.forEach((variable, index) => {
    const row = document.createElement("div");
    row.className = "template-variable-row";
    row.dataset.index = String(index);

    const nameInput = document.createElement("input");
    nameInput.className = "template-variable-input";
    nameInput.dataset.templateField = "name";
    nameInput.value = variable.name;
    nameInput.placeholder = t("template.field.name");
    nameInput.spellcheck = false;

    const valueInput = document.createElement("input");
    valueInput.className = "template-variable-input";
    valueInput.dataset.templateField = "value";
    valueInput.value = variable.value;
    valueInput.placeholder = t("template.field.value");
    valueInput.spellcheck = false;
    valueInput.maxLength = 2000;

    const insertButton = document.createElement("button");
    insertButton.className = "icon-button icon-button--small";
    insertButton.type = "button";
    insertButton.dataset.templateAction = "insert";
    insertButton.title = t("template.action.insert");
    insertButton.setAttribute("aria-label", t("template.action.insert"));
    insertButton.append(createLucideIcon("braces"));

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button icon-button--small";
    deleteButton.type = "button";
    deleteButton.dataset.templateAction = "delete";
    deleteButton.title = t("template.action.delete");
    deleteButton.setAttribute("aria-label", t("template.action.delete"));
    deleteButton.append(createLucideIcon("trash-2"));

    row.append(nameInput, valueInput, insertButton, deleteButton);
    fragment.append(row);
  });

  els.templateVariableList.replaceChildren(fragment);
  createIcons({ icons: { Braces, Trash2 } });
}

function renderTemplateVariablesDialog() {
  renderBuiltinTemplateVariables();
  renderTemplateVariableList();
  els.templateTargetLabel.textContent =
    state.templateTarget === "network"
      ? t("template.target.network")
      : t("template.target.serial");
  els.addTemplateVariableButton.disabled =
    state.templateDraftVariables.length >= MAX_TEMPLATE_VARIABLES;
}

function openTemplateVariablesDialog(kind) {
  if ((kind === "network" ? state.networkSendMode : state.sendMode) !== "text") {
    showToast(t("template.error.textOnly"), "info");
    return;
  }
  state.templateTarget = kind;
  state.templateDraftVariables = state.templateCustomVariables.map((variable) => ({
    ...variable,
  }));
  renderTemplateVariablesDialog();
  if (!els.templateVariablesDialog.open) els.templateVariablesDialog.showModal();
}

function closeTemplateVariablesDialog() {
  if (els.templateVariablesDialog.open) els.templateVariablesDialog.close();
}

function addTemplateVariable() {
  if (state.templateDraftVariables.length >= MAX_TEMPLATE_VARIABLES) {
    showToast(t("template.limit", { count: MAX_TEMPLATE_VARIABLES }), "info");
    return;
  }
  state.templateDraftVariables.push({ name: "", value: "" });
  renderTemplateVariablesDialog();
  const lastRow = els.templateVariableList.lastElementChild;
  $('[data-template-field="name"]', lastRow)?.focus();
}

function deleteTemplateVariable(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.templateDraftVariables.length) {
    return;
  }
  state.templateDraftVariables.splice(index, 1);
  renderTemplateVariablesDialog();
}

function insertTemplateToken(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    showToast(t("template.error.fillName"), "info");
    return;
  }
  const input = state.templateTarget === "network" ? els.networkSendInput : els.sendInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(`{{${normalizedName}}}`, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function insertCustomTemplateToken(index) {
  const variable = state.templateDraftVariables[index];
  if (!variable) return;
  const name = variable.name.trim();
  if (!TEMPLATE_VARIABLE_NAME_PATTERN.test(name)) {
    showToast(t("template.error.nameInvalidShort"), "error");
    return;
  }
  if (BUILTIN_TEMPLATE_VARIABLE_NAMES.has(name.toLowerCase())) {
    showToast(t("template.error.nameBuiltin", { name }), "error");
    return;
  }
  insertTemplateToken(name);
}

function saveTemplateVariables() {
  let variables;
  try {
    variables = normalizeTemplateCustomVariables(state.templateDraftVariables, { strict: true });
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }

  state.templateCustomVariables = variables;
  persistSettings();
  closeTemplateVariablesDialog();
  showToast(t("template.saved"), "success");
}

export { addTemplateVariable, closeTemplateVariablesDialog, deleteTemplateVariable, getTemplateButton, insertCustomTemplateToken, insertTemplateToken, normalizeTemplateCustomVariables, openTemplateVariablesDialog, renderBuiltinTemplateVariables, renderTemplateVariableList, renderTemplateVariablesDialog, saveTemplateVariables, updateTemplateButtonUI };
