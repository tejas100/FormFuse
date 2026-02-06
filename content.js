(function () {
  "use strict";

  if (window.__formFuseContentScriptLoaded) {
    return;
  }
  window.__formFuseContentScriptLoaded = true;

  var schema = window.FormFuseSchema;
  var matcher = window.FormFuseMatcher;

  if (!schema || !matcher) {
    return;
  }

  function readProfile() {
    return new Promise(function (resolve) {
      chrome.storage.sync.get([schema.STORAGE_KEY], function (result) {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }

        resolve(schema.sanitizeProfile(result[schema.STORAGE_KEY] || {}));
      });
    });
  }

  function emitInputEvents(field) {
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function normalize(value) {
    return matcher.normalizeSignal(value);
  }

  var EMPTY_SELECTION_TOKENS = [
    "",
    "-",
    "--",
    "select",
    "select one",
    "select an option",
    "please select",
    "choose",
    "choose one",
    "choose an option",
    "pick one",
    "none",
    "n a",
    "na",
    "not specified"
  ];

  var GROUP_CONTAINER_SELECTOR = [
    "[role='radiogroup']",
    "[role='group']",
    "fieldset",
    ".ashby-application-form-question",
    ".ashby-application-form-field",
    ".application-question",
    ".question",
    ".form-field",
    ".field",
    ".input-wrapper"
  ].join(", ");

  var TARGET_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[role='radio']",
    "[role='option']",
    "[role='checkbox']",
    "button"
  ].join(", ");

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isEmptySelectionToken(value) {
    var normalized = normalize(value);
    if (!normalized) {
      return true;
    }

    for (var i = 0; i < EMPTY_SELECTION_TOKENS.length; i += 1) {
      if (normalized === EMPTY_SELECTION_TOKENS[i]) {
        return true;
      }
    }

    return false;
  }

  function isNonAnswerToken(value) {
    var normalized = normalize(value);
    if (!normalized) {
      return true;
    }

    if (isEmptySelectionToken(normalized)) {
      return true;
    }

    return (
      /\bprefer not to say\b/.test(normalized) ||
      /\bprefer not to disclose\b/.test(normalized) ||
      /\bdecline to answer\b/.test(normalized) ||
      /\bchoose not to answer\b/.test(normalized) ||
      /\bdo not wish to answer\b/.test(normalized)
    );
  }

  function isSelectMeaningfullyFilled(select) {
    var selected = select.options[select.selectedIndex];
    if (!selected) {
      return false;
    }

    var valueFilled = !isNonAnswerToken(select.value);
    var textFilled = !isNonAnswerToken(selected.textContent);

    return valueFilled || textFilled;
  }

  function getCheckedRadio(name) {
    return document.querySelector('input[type="radio"][name="' + cssEscape(name) + '"]:checked');
  }

  function radioIsMeaningfulSelection(radio) {
    if (!radio) {
      return false;
    }

    var text = radioText(radio);
    return !isNonAnswerToken(text);
  }

  function hasValueAlready(field) {
    if (isCustomChoiceField(field)) {
      var groupInfo = collectGroupOptions(field, "custom");
      return hasMeaningfulSelectedOption(groupInfo.options);
    }

    if (field instanceof HTMLInputElement) {
      var type = (field.type || "text").toLowerCase();

      if (type === "radio") {
        if (!field.name) {
          return field.checked;
        }
        return radioIsMeaningfulSelection(getCheckedRadio(field.name));
      }

      if (type === "checkbox") {
        return field.checked;
      }

      return Boolean((field.value || "").trim());
    }

    if (field instanceof HTMLTextAreaElement) {
      return Boolean((field.value || "").trim());
    }

    if (field instanceof HTMLSelectElement) {
      return isSelectMeaningfullyFilled(field);
    }

    return true;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/(["\\])/g, "\\$1");
  }

  function collectTargets() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(TARGET_SELECTOR));
    var unique = [];
    var seen = new Set();

    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || seen.has(node)) {
        continue;
      }
      seen.add(node);
      unique.push(node);
    }

    return unique;
  }

  function isCustomChoiceField(field) {
    if (!field) {
      return false;
    }

    var role = normalize(field.getAttribute && field.getAttribute("role"));
    var tagName = field.tagName ? field.tagName.toLowerCase() : "";

    if (role === "radio" || role === "checkbox" || role === "option") {
      return true;
    }

    if (tagName === "button") {
      var type = normalize(field.getAttribute("type")) || "button";
      if (type === "submit" || type === "reset") {
        return false;
      }

      if (
        field.hasAttribute("aria-checked") ||
        field.hasAttribute("aria-selected") ||
        field.hasAttribute("aria-pressed") ||
        field.hasAttribute("data-value")
      ) {
        return true;
      }

      var text = normalize(field.textContent);
      if (
        text === "yes" ||
        text === "no" ||
        text === "male" ||
        text === "female" ||
        text.indexOf("decline") !== -1 ||
        text.indexOf("prefer not") !== -1
      ) {
        return true;
      }
    }

    return false;
  }

  function getGroupContainer(field) {
    if (!field || typeof field.closest !== "function") {
      return null;
    }

    return field.closest(GROUP_CONTAINER_SELECTOR) || field.parentElement;
  }

  function collectNearbyContextText(node, maxSiblings) {
    var parts = [];
    var sibling = node ? node.previousElementSibling : null;
    var steps = 0;

    while (sibling && steps < maxSiblings) {
      if (sibling.textContent) {
        parts.push(sibling.textContent);
      }
      sibling = sibling.previousElementSibling;
      steps += 1;
    }

    return parts.join(" ");
  }

  function getQuestionContextText(field) {
    var parts = [];
    var container = getGroupContainer(field);

    if (container && container.textContent) {
      parts.push(container.textContent);
      parts.push(collectNearbyContextText(container, 5));
    } else if (field && field.parentElement) {
      parts.push(field.parentElement.textContent || "");
      parts.push(collectNearbyContextText(field.parentElement, 5));
    }

    var questionBlock = field.closest(
      ".ashby-application-form-question, .ashby-application-form-field, [data-testid*='question'], [class*='question']"
    );
    if (questionBlock && questionBlock.textContent) {
      parts.push(questionBlock.textContent);
    }

    var section = field.closest("section, article, form");
    if (section && section.textContent) {
      parts.push(section.textContent.slice(0, 1200));
    }

    return normalize(parts.join(" "));
  }

  function inferPathFromQuestionContext(field) {
    var text = getQuestionContextText(field);
    if (!text) {
      return null;
    }

    if (
      /require company sponsorship|requires sponsorship|require sponsorship|visa sponsorship|sponsorship now or in the future|maintain or extend your current work authorization/.test(
        text
      )
    ) {
      return "work_auth.requires_sponsorship";
    }

    if (/open to relocation|open to relocate|willing to relocate|available to relocate|commuting distance/.test(text)) {
      return "work_auth.open_to_relocate";
    }

    if (
      /authorized to work|eligible to work|lawfully authorized|legally authorized|work in the country to which you are applying|authorization to work/.test(
        text
      )
    ) {
      return "work_auth.eligible_to_work_us";
    }

    if (/worked here before|previously worked|employed here before|worked at .* in the past|former employee/.test(text)) {
      return "work_auth.worked_here_before";
    }

    if (/veteran|protected veteran/.test(text)) {
      return "demographics.veteran_status";
    }

    if (/disability|disabled|have a disability/.test(text)) {
      return "demographics.disability_status";
    }

    if (/\bgender\b|\binput gender\b|\bsex\b/.test(text)) {
      return "demographics.gender";
    }

    return null;
  }

  function getContainerKey(container, path) {
    if (!container) {
      return path + ":no-container";
    }

    if (container.id) {
      return path + ":id:" + container.id;
    }

    var ariaLabel = normalize(container.getAttribute("aria-label"));
    if (ariaLabel) {
      return path + ":aria:" + ariaLabel.slice(0, 80);
    }

    var testId = normalize(container.getAttribute("data-testid"));
    if (testId) {
      return path + ":testid:" + testId.slice(0, 80);
    }

    var text = normalize(container.textContent || "");
    if (text) {
      return path + ":text:" + text.slice(0, 120);
    }

    return path + ":container";
  }

  function collectGroupOptions(field, path) {
    if (field instanceof HTMLInputElement && (field.type || "").toLowerCase() === "radio" && field.name) {
      return {
        key: path + ":radio-name:" + field.name,
        options: Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + cssEscape(field.name) + '"]'))
      };
    }

    var container = getGroupContainer(field);
    var options = [];

    if (container) {
      options = Array.prototype.slice.call(container.querySelectorAll("input[type='radio'], [role='radio'], [role='option'], button"));
    } else {
      options = [field];
    }

    options = options.filter(function (node) {
      if (!node || node.disabled) {
        return false;
      }

      if (node instanceof HTMLInputElement) {
        var type = (node.type || "").toLowerCase();
        return type === "radio";
      }

      if (normalize(node.getAttribute("role")) === "radio" || normalize(node.getAttribute("role")) === "option") {
        return true;
      }

      if (node.tagName && node.tagName.toLowerCase() === "button") {
        var text = normalize(node.textContent);
        var likelyChoiceText =
          text === "yes" ||
          text === "no" ||
          text === "male" ||
          text === "female" ||
          text.indexOf("decline") !== -1 ||
          text.indexOf("prefer not") !== -1;
        var taggedButton =
          node.hasAttribute("aria-checked") ||
          node.hasAttribute("aria-selected") ||
          node.hasAttribute("aria-pressed") ||
          node.hasAttribute("data-value");
        return likelyChoiceText || taggedButton;
      }

      return false;
    });

    if (!options.length) {
      options = [field];
    }

    return {
      key: getContainerKey(container, path),
      options: options
    };
  }

  function optionText(option) {
    var textParts = [];

    if (!option) {
      return "";
    }

    if (option instanceof HTMLInputElement) {
      textParts.push(option.value || "");
    }

    textParts.push(option.getAttribute("aria-label") || "");
    textParts.push(option.getAttribute("data-value") || "");
    textParts.push(option.textContent || "");

    if (option.id) {
      var linked = document.querySelector('label[for="' + cssEscape(option.id) + '"]');
      if (linked && linked.textContent) {
        textParts.push(linked.textContent);
      }
    }

    var wrappedLabel = option.closest("label");
    if (wrappedLabel && wrappedLabel.textContent) {
      textParts.push(wrappedLabel.textContent);
    }

    var ariaLabelledBy = option.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      var ids = ariaLabelledBy.split(/\s+/);
      for (var i = 0; i < ids.length; i += 1) {
        var node = document.getElementById(ids[i]);
        if (node && node.textContent) {
          textParts.push(node.textContent);
        }
      }
    }

    return normalize(textParts.join(" "));
  }

  function isOptionSelected(option) {
    if (!option) {
      return false;
    }

    if (option instanceof HTMLInputElement) {
      return Boolean(option.checked);
    }

    var ariaChecked = normalize(option.getAttribute("aria-checked"));
    if (ariaChecked === "true") {
      return true;
    }

    var ariaSelected = normalize(option.getAttribute("aria-selected"));
    if (ariaSelected === "true") {
      return true;
    }

    var ariaPressed = normalize(option.getAttribute("aria-pressed"));
    if (ariaPressed === "true") {
      return true;
    }

    var dataState = normalize(option.getAttribute("data-state"));
    if (dataState === "checked" || dataState === "selected" || dataState === "active") {
      return true;
    }

    return false;
  }

  function hasMeaningfulSelectedOption(options) {
    for (var i = 0; i < options.length; i += 1) {
      if (isOptionSelected(options[i]) && !isNonAnswerToken(optionText(options[i]))) {
        return true;
      }
    }

    return false;
  }

  function clickElement(element) {
    if (!element) {
      return;
    }

    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    element.click();
  }

  function valueCandidates(path, rawValue) {
    var value = String(rawValue || "").trim();
    var normalized = normalize(value);
    var list = [];

    if (!normalized) {
      return list;
    }

    list.push(normalized);

    if (isYesToken(normalized)) {
      list = list.concat(["yes", "true", "1", "y"]);
    }

    if (isNoToken(normalized)) {
      list = list.concat(["no", "false", "0", "n"]);
    }

    if (path === "work_auth.eligible_to_work_us") {
      if (isYesToken(normalized)) {
        list = list.concat(["authorized", "eligible", "lawfully authorized"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["not authorized", "not eligible", "not lawfully authorized"]);
      }
    }

    if (path === "work_auth.requires_sponsorship") {
      if (isYesToken(normalized)) {
        list = list.concat(["require sponsorship", "requires sponsorship", "need sponsorship", "visa sponsorship"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat([
          "do not require sponsorship",
          "does not require sponsorship",
          "no sponsorship required",
          "without sponsorship",
          "not require sponsorship"
        ]);
      }
    }

    if (path === "work_auth.open_to_relocate") {
      if (isYesToken(normalized)) {
        list = list.concat(["open to relocate", "willing to relocate", "available to relocate"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["not open to relocate", "not willing to relocate", "no relocation"]);
      }
    }

    if (path === "work_auth.worked_here_before") {
      if (isYesToken(normalized)) {
        list = list.concat(["worked here before", "previously worked here", "former employee"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["not worked here before", "have not worked here before", "never worked here"]);
      }
    }

    if (path === "demographics.veteran_status") {
      if (isYesToken(normalized)) {
        list = list.concat(["veteran", "protected veteran", "i am a protected veteran"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat([
          "not a veteran",
          "not protected veteran",
          "not a protected veteran",
          "i am not a protected veteran"
        ]);
      }
    }

    if (path === "demographics.disability_status") {
      if (isYesToken(normalized)) {
        list = list.concat(["have a disability", "disability", "disabled"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["no disability", "not disabled", "do not have disability", "i dont have disability"]);
      }
    }

    if (path.indexOf("demographics.") === 0 && normalized === "prefer not to say") {
      list = list.concat([
        "prefer not to say",
        "prefer not to disclose",
        "decline to answer",
        "i do not wish to answer",
        "choose not to answer"
      ]);
    }

    if (path === "address.country" && normalized === "united states") {
      list = list.concat(["usa", "us", "u s", "united states of america"]);
    }

    var unique = [];
    for (var i = 0; i < list.length; i += 1) {
      if (unique.indexOf(list[i]) === -1) {
        unique.push(list[i]);
      }
    }

    return unique;
  }

  function containsCandidate(text, candidate) {
    var haystack = normalize(text);
    var needle = normalize(candidate);

    if (!haystack || !needle) {
      return false;
    }

    if (needle.length <= 3) {
      return new RegExp("\\b" + escapeRegExp(needle) + "\\b").test(haystack);
    }

    return haystack === needle || haystack.indexOf(needle) !== -1;
  }

  function tryFillSelect(select, path, value) {
    var candidates = valueCandidates(path, value);
    if (!candidates.length) {
      return false;
    }

    var i;
    var option;
    var optionValue;
    var optionText;

    for (i = 0; i < select.options.length; i += 1) {
      option = select.options[i];
      optionValue = normalize(option.value);
      optionText = normalize(option.textContent);

      if (candidates.indexOf(optionValue) !== -1 || candidates.indexOf(optionText) !== -1) {
        if (select.value !== option.value) {
          select.value = option.value;
          emitInputEvents(select);
          return true;
        }
        return false;
      }
    }

    for (i = 0; i < select.options.length; i += 1) {
      option = select.options[i];
      optionValue = normalize(option.value);
      optionText = normalize(option.textContent);

      for (var j = 0; j < candidates.length; j += 1) {
        if (containsCandidate(optionValue, candidates[j]) || containsCandidate(optionText, candidates[j])) {
          if (select.value !== option.value) {
            select.value = option.value;
            emitInputEvents(select);
            return true;
          }
          return false;
        }
      }
    }

    return false;
  }

  function radioText(radio) {
    return optionText(radio);
  }

  function isYesToken(value) {
    return value === "yes" || value === "true" || value === "1";
  }

  function isNoToken(value) {
    return value === "no" || value === "false" || value === "0";
  }

  function isNegativeOptionText(text) {
    var normalized = normalize(text);
    return /\bno\b|\bfalse\b|\bnot\b|\bwithout\b|\bdecline\b/.test(normalized);
  }

  function isPositiveOptionText(text) {
    var normalized = normalize(text);
    return /\byes\b|\btrue\b|\b1\b|\bopen\b|\bwilling\b|\bauthorized\b|\beligible\b|\bveteran\b|\bdisabled\b/.test(normalized);
  }

  function findRadioTarget(radios, path, value) {
    var normalized = normalize(value);

    if (!normalized) {
      return null;
    }

    var candidates = valueCandidates(path, value);

    for (var i = 0; i < radios.length; i += 1) {
      var text = radioText(radios[i]);

      for (var j = 0; j < candidates.length; j += 1) {
        if (containsCandidate(text, candidates[j])) {
          return radios[i];
        }
      }
    }

    for (var k = 0; k < radios.length; k += 1) {
      var radioLabel = radioText(radios[k]);

      if (isYesToken(normalized) && isPositiveOptionText(radioLabel) && !isNegativeOptionText(radioLabel)) {
        return radios[k];
      }

      if (isNoToken(normalized) && isNegativeOptionText(radioLabel)) {
        return radios[k];
      }
    }

    return null;
  }

  function activateRadioOption(target) {
    if (!target) {
      return false;
    }

    if (!(target instanceof HTMLInputElement)) {
      clickElement(target);
      return true;
    }

    target.checked = true;
    emitInputEvents(target);
    clickElement(target);

    if (target.checked) {
      return true;
    }

    if (target.id) {
      var linked = document.querySelector('label[for="' + cssEscape(target.id) + '"]');
      if (linked) {
        clickElement(linked);
        return true;
      }
    }

    var wrappedLabel = target.closest("label");
    if (wrappedLabel) {
      clickElement(wrappedLabel);
      return true;
    }

    return false;
  }

  function tryFillRadio(field, path, value, seenGroups) {
    var info = collectGroupOptions(field, path);
    var groupKey = info.key;
    if (seenGroups.has(groupKey)) {
      return false;
    }

    var radios = info.options.filter(function (option) {
      return option instanceof HTMLInputElement && (option.type || "").toLowerCase() === "radio";
    });

    if (!radios.length) {
      seenGroups.add(groupKey);
      return false;
    }

    if (hasMeaningfulSelectedOption(radios)) {
      seenGroups.add(groupKey);
      return false;
    }

    var target = findRadioTarget(radios, path, value);
    seenGroups.add(groupKey);

    if (!target || target.checked) {
      return false;
    }

    return activateRadioOption(target);
  }

  function findCustomChoiceTarget(options, path, value) {
    var normalized = normalize(value);
    if (!normalized) {
      return null;
    }

    var candidates = valueCandidates(path, value);

    for (var i = 0; i < options.length; i += 1) {
      var text = optionText(options[i]);

      for (var j = 0; j < candidates.length; j += 1) {
        if (containsCandidate(text, candidates[j])) {
          return options[i];
        }
      }
    }

    for (var k = 0; k < options.length; k += 1) {
      var optionLabel = optionText(options[k]);

      if (isYesToken(normalized) && isPositiveOptionText(optionLabel) && !isNegativeOptionText(optionLabel)) {
        return options[k];
      }

      if (isNoToken(normalized) && isNegativeOptionText(optionLabel)) {
        return options[k];
      }
    }

    return null;
  }

  function tryFillCustomChoice(field, path, value, seenChoiceGroups) {
    var info = collectGroupOptions(field, path);
    var groupKey = info.key;

    if (seenChoiceGroups.has(groupKey)) {
      return false;
    }

    seenChoiceGroups.add(groupKey);

    if (hasMeaningfulSelectedOption(info.options)) {
      return false;
    }

    var target = findCustomChoiceTarget(info.options, path, value);
    if (!target) {
      return false;
    }

    if (isOptionSelected(target) && !isNonAnswerToken(optionText(target))) {
      return false;
    }

    activateRadioOption(target);
    return true;
  }

  function tryFillCheckbox(field, path, value) {
    if (path.indexOf("work_auth.") !== 0 && path !== "demographics.veteran_status" && path !== "demographics.disability_status") {
      return false;
    }

    var normalized = normalize(value);
    if (!normalized) {
      return false;
    }

    var shouldCheck = isYesToken(normalized);
    var shouldUncheck = isNoToken(normalized);

    if (!shouldCheck && !shouldUncheck) {
      return false;
    }

    if (field.checked === shouldCheck) {
      return false;
    }

    field.checked = shouldCheck;
    emitInputEvents(field);
    return true;
  }

  function tryFillTextLike(field, value) {
    var nextValue = String(value || "").trim();

    if (!nextValue) {
      return false;
    }

    if ((field.value || "").trim() === nextValue) {
      return false;
    }

    field.value = nextValue;
    emitInputEvents(field);
    return true;
  }

  function fillField(field, path, value, seenRadioGroups, seenChoiceGroups) {
    if (isCustomChoiceField(field)) {
      return tryFillCustomChoice(field, path, value, seenChoiceGroups);
    }

    if (field instanceof HTMLSelectElement) {
      return tryFillSelect(field, path, value);
    }

    if (field instanceof HTMLTextAreaElement) {
      return tryFillTextLike(field, value);
    }

    if (field instanceof HTMLInputElement) {
      var type = (field.type || "text").toLowerCase();

      if (type === "radio") {
        return tryFillRadio(field, path, value, seenRadioGroups);
      }

      if (type === "checkbox") {
        return tryFillCheckbox(field, path, value);
      }

      return tryFillTextLike(field, value);
    }

    return false;
  }

  function shouldUseContextInference(field) {
    if (isCustomChoiceField(field)) {
      return true;
    }

    if (field instanceof HTMLInputElement) {
      var type = (field.type || "").toLowerCase();
      return type === "radio" || type === "checkbox";
    }

    return false;
  }

  async function fillApplication() {
    var profile = await readProfile();

    if (!profile) {
      return { ok: false, error: "Unable to read saved profile." };
    }

    var fields = collectTargets();
    var filled = 0;
    var matched = 0;
    var skipped = 0;
    var seenRadioGroups = new Set();
    var seenChoiceGroups = new Set();

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      var match = matcher.getBestMatch(field);
      var resolvedPath = match ? match.path : null;

      if (shouldUseContextInference(field)) {
        var inferredPath = inferPathFromQuestionContext(field);
        if (inferredPath) {
          resolvedPath = inferredPath;
        }
      }

      if (!resolvedPath) {
        skipped += 1;
        continue;
      }

      var value = schema.getValueByPath(profile, resolvedPath);
      if (!String(value || "").trim()) {
        skipped += 1;
        continue;
      }

      if (hasValueAlready(field)) {
        skipped += 1;
        continue;
      }

      matched += 1;
      if (fillField(field, resolvedPath, value, seenRadioGroups, seenChoiceGroups)) {
        filled += 1;
      } else {
        skipped += 1;
      }
    }

    return {
      ok: true,
      scanned: fields.length,
      matched: matched,
      filled: filled,
      skipped: skipped
    };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.action !== "FORMFUSE_FILL") {
      return;
    }

    fillApplication()
      .then(function (result) {
        sendResponse(result);
      })
      .catch(function (error) {
        sendResponse({ ok: false, error: error && error.message ? error.message : "Autofill failed." });
      });

    return true;
  });
})();
