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
    "[role='combobox']",
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

  function hasValueAlready(field, path, value) {
    if (isComboboxField(field)) {
      return false;
    }

    if (isCustomChoiceField(field)) {
      var groupInfo = collectGroupOptions(field, path || "custom");
      var selected = getSelectedOption(groupInfo.options);
      if (!selected) {
        return false;
      }

      if (!path) {
        return !isNonAnswerToken(optionText(selected));
      }

      if (optionMatchesValue(selected, path, value)) {
        return true;
      }

      return !shouldAllowChoiceOverride(path);
    }

    if (field instanceof HTMLInputElement) {
      var type = (field.type || "text").toLowerCase();

      if (type === "radio") {
        if (!field.name) {
          if (!field.checked) {
            return false;
          }
          if (path && optionMatchesValue(field, path, value)) {
            return true;
          }
          return !shouldAllowChoiceOverride(path) && !isNonAnswerToken(optionText(field));
        }
        var checkedRadio = getCheckedRadio(field.name);
        if (!checkedRadio) {
          return false;
        }
        if (path && optionMatchesValue(checkedRadio, path, value)) {
          return true;
        }
        if (path && shouldAllowChoiceOverride(path)) {
          return false;
        }
        return radioIsMeaningfulSelection(checkedRadio);
      }

      if (type === "checkbox") {
        return field.checked;
      }

      if (shouldAllowChoiceOverride(path) && String(value || "").trim()) {
        return normalize(field.value) === normalize(value);
      }

      return Boolean((field.value || "").trim());
    }

    if (field instanceof HTMLTextAreaElement) {
      return Boolean((field.value || "").trim());
    }

    if (field instanceof HTMLSelectElement) {
      if (!isSelectMeaningfullyFilled(field)) {
        return false;
      }

      if (!path) {
        return true;
      }

      if (selectMatchesValue(field, path, value)) {
        return true;
      }

      return !shouldAllowChoiceOverride(path);
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

  function isComboboxField(field) {
    if (!field || !(field instanceof HTMLElement)) {
      return false;
    }

    var role = normalize(field.getAttribute("role"));
    if (role === "combobox") {
      return true;
    }

    var popup = normalize(field.getAttribute("aria-haspopup"));
    return popup === "listbox";
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

    return normalize(parts.join(" "));
  }

  function inferPathFromQuestionContext(field) {
    var text = getQuestionContextText(field);
    if (!text) {
      return null;
    }

    var leading = text.slice(0, 240);

    if (/\bgender identity\b|\binput gender\b|^gender\b/.test(leading)) {
      return "demographics.gender";
    }

    if (/\brace\b|\bethnicity\b/.test(leading)) {
      return "demographics.ethnicity";
    }

    if (/\bpronouns\b|\bpreferred pronouns\b/.test(leading)) {
      return "demographics.pronouns";
    }

    if (/hispanic|latinx|latino/.test(leading)) {
      return "demographics.hispanic_latinx";
    }

    if (/identify as transgender|transgender|trans identity/.test(leading)) {
      return "demographics.transgender_identity";
    }

    if (/\bschool\b|\bcollege\b|\buniversity\b/.test(leading)) {
      return "education.school";
    }

    if (/\bdegree\b|\beducation level\b|\bacademic degree\b/.test(leading)) {
      return "education.degree";
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

    if (/in person|in office|onsite|on site|from the office|5 days a week/.test(text)) {
      return "work_auth.in_person_office_preference";
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

    if (/country code|dial code|dialing code|phone country|country calling code/.test(text)) {
      return "address.country";
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

    if (/\bethnicity\b|\brace\b|\bracial\b/.test(text)) {
      return "demographics.ethnicity";
    }

    if (/\bpronouns\b|\bpreferred pronouns\b/.test(text)) {
      return "demographics.pronouns";
    }

    if (/hispanic|latinx|latino/.test(text)) {
      return "demographics.hispanic_latinx";
    }

    if (/identify as transgender|transgender|trans identity/.test(text)) {
      return "demographics.transgender_identity";
    }

    if (/\bschool\b|\bcollege\b|\buniversity\b/.test(text)) {
      return "education.school";
    }

    if (/\bdegree\b|\beducation level\b|\bacademic degree\b/.test(text)) {
      return "education.degree";
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

    addOptionTextPart(textParts, option.getAttribute("aria-label"), 12);
    addOptionTextPart(textParts, option.getAttribute("data-value"), 8);
    addOptionTextPart(textParts, option.textContent, 16);

    if (option.id) {
      var linked = document.querySelector('label[for="' + cssEscape(option.id) + '"]');
      if (linked && linked.textContent) {
        addOptionTextPart(textParts, linked.textContent, 24);
      }
    }

    var wrappedLabel = option.closest("label");
    if (wrappedLabel && wrappedLabel.textContent) {
      addOptionTextPart(textParts, wrappedLabel.textContent, 24);
    }

    var ariaLabelledBy = option.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      var ids = ariaLabelledBy.split(/\s+/);
      for (var i = 0; i < ids.length; i += 1) {
        var node = document.getElementById(ids[i]);
        if (node && node.textContent) {
          addOptionTextPart(textParts, node.textContent, 24);
        }
      }
    }

    return normalize(textParts.join(" "));
  }

  function optionPrimaryText(option) {
    var textParts = [];

    if (!option) {
      return "";
    }

    if (option instanceof HTMLInputElement) {
      textParts.push(option.value || "");
    }

    if (typeof option.getAttribute === "function") {
      addOptionTextPart(textParts, option.getAttribute("aria-label"), 12);
      addOptionTextPart(textParts, option.getAttribute("data-value"), 8);
    }
    addOptionTextPart(textParts, option.textContent, 16);

    return normalize(textParts.join(" "));
  }

  function shouldSkipNonAnswerChoice(path, value, optionLabel) {
    if (!path || path.indexOf("demographics.") !== 0) {
      return false;
    }

    if (isNonAnswerToken(value)) {
      return false;
    }

    return isNonAnswerToken(optionLabel);
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

  function getSelectedOption(options) {
    for (var i = 0; i < options.length; i += 1) {
      if (isOptionSelected(options[i])) {
        return options[i];
      }
    }

    return null;
  }

  function shouldAllowChoiceOverride(path) {
    if (!path) {
      return false;
    }

    return (
      path.indexOf("demographics.") === 0 ||
      path.indexOf("work_auth.") === 0 ||
      path.indexOf("education.") === 0 ||
      path === "address.country"
    );
  }

  function optionMatchesValue(option, path, value) {
    var candidates = valueCandidates(path, value);
    if (!candidates.length) {
      return false;
    }

    var directText = optionPrimaryText(option);
    var text = optionText(option);
    for (var i = 0; i < candidates.length; i += 1) {
      if (containsCandidate(directText, candidates[i])) {
        return true;
      }
      if (containsCandidate(text, candidates[i])) {
        return true;
      }
    }

    return false;
  }

  function selectMatchesValue(select, path, value) {
    var selected = select.options[select.selectedIndex];
    if (!selected) {
      return false;
    }

    return optionMatchesValue(selected, path, value);
  }

  function clickElement(element) {
    if (!element) {
      return;
    }

    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    element.click();
  }

  function addOptionTextPart(parts, rawText, maxWords) {
    var text = String(rawText || "").trim();
    if (!text) {
      return;
    }

    var normalized = normalize(text);
    if (!normalized) {
      return;
    }

    var limit = typeof maxWords === "number" ? maxWords : 24;
    if (normalized.split(" ").length > limit) {
      return;
    }

    parts.push(text);
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

    if (path === "identity.full_name") {
      var pieces = normalized.split(" ").filter(Boolean);
      if (pieces.length >= 2) {
        list.push(pieces.join(" "));
      }
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

    if (path === "work_auth.in_person_office_preference") {
      if (isYesToken(normalized)) {
        list = list.concat(["in person", "in office", "on site", "onsite", "office five days"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["remote", "not in person", "not on site", "not onsite", "not in office"]);
      }
    }

    if (path === "demographics.gender") {
      if (normalized === "male" || normalized === "man") {
        list = list.concat(["man", "male", "he him", "he him his"]);
      }
      if (normalized === "female" || normalized === "woman") {
        list = list.concat(["woman", "female", "she her", "she her hers"]);
      }
      if (normalized.indexOf("non binary") !== -1 || normalized.indexOf("nonbinary") !== -1) {
        list = list.concat(["non binary", "nonbinary", "non conforming", "non binary non conforming"]);
      }
    }

    if (path === "demographics.ethnicity") {
      if (normalized === "asian") {
        list = list.concat(["asian not hispanic or latino", "asian not hispanic or latinx"]);
      }
      if (normalized === "white") {
        list = list.concat(["white not hispanic or latino", "white not hispanic or latinx"]);
      }
      if (normalized.indexOf("black") !== -1 || normalized.indexOf("african american") !== -1) {
        list = list.concat(["black or african american", "african american"]);
      }
      if (normalized.indexOf("hispanic") !== -1 || normalized.indexOf("latino") !== -1) {
        list = list.concat(["hispanic or latino", "hispanic or latinx"]);
      }
      if (normalized.indexOf("two or more") !== -1) {
        list.push("two or more races");
      }
    }

    if (path === "demographics.pronouns") {
      if (normalized.indexOf("she her") !== -1) {
        list = list.concat(["she her hers", "she her"]);
      }
      if (normalized.indexOf("he him") !== -1) {
        list = list.concat(["he him his", "he him"]);
      }
      if (normalized.indexOf("they them") !== -1) {
        list = list.concat(["they them theirs", "they them"]);
      }
      if (normalized.indexOf("prefer not") !== -1) {
        list = list.concat(["prefer not to answer", "decline to answer"]);
      }
    }

    if (path === "demographics.hispanic_latinx") {
      if (isYesToken(normalized)) {
        list = list.concat(["hispanic", "latinx", "latino"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["not hispanic", "not latino", "not latinx"]);
      }
      if (normalized.indexOf("prefer not") !== -1) {
        list = list.concat(["prefer not to answer", "decline to answer"]);
      }
    }

    if (path === "demographics.transgender_identity") {
      if (isYesToken(normalized)) {
        list = list.concat(["yes", "i identify as transgender"]);
      }
      if (isNoToken(normalized)) {
        list = list.concat(["no", "i do not identify as transgender"]);
      }
      if (normalized.indexOf("prefer not") !== -1) {
        list = list.concat(["prefer not to answer", "i do not wish to answer", "decline to answer"]);
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

    if (path.indexOf("demographics.") === 0 && normalized === "prefer not to answer") {
      list = list.concat([
        "prefer not to answer",
        "prefer not to disclose",
        "decline to answer",
        "i do not wish to answer",
        "choose not to answer"
      ]);
    }

    if (path === "education.degree") {
      list = list.concat([
        normalized.replace(/\s+/g, " "),
        normalized.replace(/_/g, " "),
        normalized.replace(/\bdegree\b/g, "").trim()
      ]);

      if (normalized.indexOf("bachelors") !== -1) {
        list = list.concat(["bachelor s degree", "bachelor degree"]);
      }
      if (normalized.indexOf("masters") !== -1) {
        list = list.concat(["master s degree", "master degree"]);
      }
      if (normalized.indexOf("mba") !== -1) {
        list = list.concat(["master of business administration", "m b a"]);
      }
      if (normalized.indexOf("phd") !== -1) {
        list = list.concat(["doctor of philosophy", "ph d"]);
      }
      if (normalized.indexOf("md") !== -1) {
        list = list.concat(["doctor of medicine", "m d"]);
      }
      if (normalized.indexOf("jd") !== -1) {
        list = list.concat(["juris doctor", "j d"]);
      }
    }

    if (path === "address.country" && normalized === "united states") {
      list = list.concat([
        "usa",
        "us",
        "u s",
        "united states of america",
        "united states +1",
        "us +1",
        "usa +1",
        "country code +1",
        "dial code +1"
      ]);
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

    if (haystack === needle) {
      return true;
    }

    return new RegExp("(^|\\b)" + escapeRegExp(needle) + "(\\b|$)").test(haystack);
  }

  function scoreTextByCandidates(text, candidates) {
    var normalizedText = normalize(text);
    if (!normalizedText) {
      return 0;
    }

    var best = 0;
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = normalize(candidates[i]);
      if (!candidate) {
        continue;
      }

      if (normalizedText === candidate) {
        best = Math.max(best, 1000);
        continue;
      }

      if (containsCandidate(normalizedText, candidate)) {
        best = Math.max(best, 820 - Math.min(220, Math.abs(normalizedText.length - candidate.length)));
        continue;
      }

      if (containsCandidate(candidate, normalizedText)) {
        best = Math.max(best, 700 - Math.min(180, Math.abs(normalizedText.length - candidate.length)));
        continue;
      }

      if (normalizedText.indexOf(candidate) !== -1 || candidate.indexOf(normalizedText) !== -1) {
        best = Math.max(best, 520 - Math.min(160, Math.abs(normalizedText.length - candidate.length)));
      }
    }

    return best;
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

      if (shouldSkipNonAnswerChoice(path, value, optionText) || shouldSkipNonAnswerChoice(path, value, optionValue)) {
        continue;
      }

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

      if (shouldSkipNonAnswerChoice(path, value, optionText) || shouldSkipNonAnswerChoice(path, value, optionValue)) {
        continue;
      }

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
    var bestRadio = null;
    var bestRadioScore = 0;

    for (var i = 0; i < radios.length; i += 1) {
      var text = optionPrimaryText(radios[i]);
      if (shouldSkipNonAnswerChoice(path, value, text)) {
        continue;
      }

      var score = scoreTextByCandidates(text, candidates);
      if (score > bestRadioScore) {
        bestRadioScore = score;
        bestRadio = radios[i];
      }
    }

    if (bestRadio && bestRadioScore >= 560) {
      return bestRadio;
    }

    for (var k = 0; k < radios.length; k += 1) {
      var radioLabel = radioText(radios[k]);
      if (shouldSkipNonAnswerChoice(path, value, radioLabel)) {
        continue;
      }

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

    var selectedRadio = getSelectedOption(radios);
    if (selectedRadio) {
      if (optionMatchesValue(selectedRadio, path, value)) {
        seenGroups.add(groupKey);
        return false;
      }
      if (!shouldAllowChoiceOverride(path) && !isNonAnswerToken(optionText(selectedRadio))) {
        seenGroups.add(groupKey);
        return false;
      }
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
    var bestOption = null;
    var bestScore = 0;

    for (var i = 0; i < options.length; i += 1) {
      var text = optionPrimaryText(options[i]);
      if (shouldSkipNonAnswerChoice(path, value, text)) {
        continue;
      }

      var score = scoreTextByCandidates(text, candidates);
      if (score > bestScore) {
        bestScore = score;
        bestOption = options[i];
      }
    }

    if (bestOption && bestScore >= 560) {
      return bestOption;
    }

    for (var k = 0; k < options.length; k += 1) {
      var optionLabel = optionText(options[k]);
      if (shouldSkipNonAnswerChoice(path, value, optionLabel)) {
        continue;
      }

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

    var selected = getSelectedOption(info.options);
    if (selected) {
      if (optionMatchesValue(selected, path, value)) {
        return false;
      }
      if (!shouldAllowChoiceOverride(path) && !isNonAnswerToken(optionText(selected))) {
        return false;
      }
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

  var AUTOCOMPLETE_OPTION_SELECTOR =
    "[role='option'], [role='listbox'] [aria-selected], [role='menuitem'], li, .option, .select-option, .menu-item";

  function wait(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function isVisibleNode(node) {
    if (!node || !(node instanceof HTMLElement)) {
      return false;
    }

    var rect = node.getBoundingClientRect();
    var style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function uniqueNodes(nodes) {
    var seen = new Set();
    var out = [];

    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || seen.has(node)) {
        continue;
      }
      seen.add(node);
      out.push(node);
    }

    return out;
  }

  function scoreOptionByCandidates(optionNode, candidates) {
    var directScore = scoreTextByCandidates(optionPrimaryText(optionNode), candidates);
    if (directScore > 0) {
      return directScore;
    }

    return Math.max(0, scoreTextByCandidates(optionText(optionNode), candidates) - 40);
  }

  function formatAutocompleteQuery(path, value) {
    var raw = String(value || "").trim();
    if (!raw) {
      return "";
    }

    if (path === "education.degree") {
      var humanized = raw.replace(/[_-]+/g, " ").trim();
      return humanized || raw;
    }

    return raw;
  }

  function collectAutocompleteOptions(field) {
    var container = getGroupContainer(field) || field.parentElement || document.body;
    var local = Array.prototype.slice.call(container.querySelectorAll(AUTOCOMPLETE_OPTION_SELECTOR));
    var global = Array.prototype.slice.call(document.querySelectorAll(AUTOCOMPLETE_OPTION_SELECTOR));
    var merged = uniqueNodes(local.concat(global));

    return merged.filter(function (node) {
      if (!isVisibleNode(node)) {
        return false;
      }

      var nodeText = normalize(node.textContent);
      if (!nodeText || nodeText.length < 2) {
        return false;
      }

      var rect = node.getBoundingClientRect();
      return rect.top < window.innerHeight + 220 && rect.bottom > -120;
    });
  }

  function fieldCenter(field) {
    if (!field || !(field instanceof HTMLElement)) {
      return { x: 0, y: 0 };
    }
    var rect = field.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function distanceToField(field, node) {
    var centerA = fieldCenter(field);
    var rectB = node.getBoundingClientRect();
    var centerB = { x: rectB.left + rectB.width / 2, y: rectB.top + rectB.height / 2 };
    var dx = centerA.x - centerB.x;
    var dy = centerA.y - centerB.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function collectComboboxInputs(field) {
    var container = getGroupContainer(field) || field.parentElement || document.body;
    var localInputs = Array.prototype.slice.call(
      container.querySelectorAll("input:not([type='hidden']), textarea, [role='searchbox'], [contenteditable='true']")
    );
    var globalInputs = Array.prototype.slice.call(
      document.querySelectorAll("input:not([type='hidden']), textarea, [role='searchbox'], [contenteditable='true']")
    );
    var merged = uniqueNodes(localInputs.concat(globalInputs));

    return merged.filter(function (node) {
      if (!isVisibleNode(node)) {
        return false;
      }
      if (!(node instanceof HTMLElement)) {
        return false;
      }

      if (node === field) {
        return true;
      }

      var rect = node.getBoundingClientRect();
      return rect.top < window.innerHeight + 200 && rect.bottom > -120;
    });
  }

  function chooseBestComboboxInput(field, inputs) {
    if (!inputs.length) {
      return null;
    }

    var sorted = inputs.slice().sort(function (a, b) {
      return distanceToField(field, a) - distanceToField(field, b);
    });

    return sorted[0];
  }

  function setEditableValue(node, value) {
    if (!node) {
      return false;
    }

    var next = String(value || "").trim();
    if (!next) {
      return false;
    }

    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.focus();
      node.value = next;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (node.isContentEditable || normalize(node.getAttribute("contenteditable")) === "true") {
      node.focus();
      node.textContent = next;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }

  async function tryPickAutocompleteOption(field, path, value) {
    var candidates = valueCandidates(path, value);
    if (!candidates.length) {
      return false;
    }

    var minScore = path === "education.school" || path === "education.degree" ? 450 : 560;

    for (var attempt = 0; attempt < 4; attempt += 1) {
      await wait(80 + attempt * 50);
      var options = collectAutocompleteOptions(field);
      if (!options.length) {
        continue;
      }

      var bestNode = null;
      var bestScore = 0;

      for (var i = 0; i < options.length; i += 1) {
        var score = scoreOptionByCandidates(options[i], candidates);
        if (
          score > bestScore ||
          (score === bestScore && bestNode && distanceToField(field, options[i]) < distanceToField(field, bestNode))
        ) {
          bestScore = score;
          bestNode = options[i];
        }
      }

      if (bestNode && bestScore >= minScore) {
        clickElement(bestNode);
        emitInputEvents(field);
        return true;
      }
    }

    return false;
  }

  async function tryFillTextWithAutocomplete(field, path, value) {
    var queryValue = formatAutocompleteQuery(path, value);
    var candidates = valueCandidates(path, queryValue);
    clickElement(field);
    await wait(40);

    var changed = tryFillTextLike(field, queryValue);
    if (changed) {
      await wait(140);
    }

    var selectedOption = await tryPickAutocompleteOption(field, path, queryValue);
    if (!selectedOption && (path === "education.school" || path === "education.degree")) {
      var visibleOptions = collectAutocompleteOptions(field);
      var hasRelevantDropdown = visibleOptions.some(function (option) {
        return scoreOptionByCandidates(option, candidates) > 0;
      });
      if (hasRelevantDropdown) {
        return false;
      }
    }

    return changed || selectedOption;
  }

  async function tryFillCombobox(field, path, value) {
    var queryValue = formatAutocompleteQuery(path, value);
    clickElement(field);
    await wait(60);

    if (await tryPickAutocompleteOption(field, path, queryValue)) {
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    var inputs = collectComboboxInputs(field);
    var inputTarget = chooseBestComboboxInput(field, inputs);
    if (inputTarget && setEditableValue(inputTarget, queryValue)) {
      await wait(120);

      if (await tryPickAutocompleteOption(field, path, queryValue)) {
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }

      if (path === "education.school" || path === "education.degree") {
        return false;
      }

      inputTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      inputTarget.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    return false;
  }

  function shouldUseAutocomplete(path, field) {
    if (!path || !(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      return false;
    }

    if (
      path === "education.school" ||
      path === "education.degree" ||
      path === "demographics.ethnicity" ||
      path === "demographics.pronouns"
    ) {
      return true;
    }

    var role = normalize(field.getAttribute("role"));
    var ariaAutocomplete = normalize(field.getAttribute("aria-autocomplete"));
    return role === "combobox" || ariaAutocomplete === "list" || ariaAutocomplete === "both";
  }

  async function fillField(field, path, value, seenRadioGroups, seenChoiceGroups) {
    if (isComboboxField(field)) {
      return tryFillCombobox(field, path, value);
    }

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

      if (shouldUseAutocomplete(path, field)) {
        return tryFillTextWithAutocomplete(field, path, value);
      }

      return tryFillTextLike(field, value);
    }

    return false;
  }

  function shouldUseContextInference(field) {
    if (isCustomChoiceField(field)) {
      return true;
    }

    if (isComboboxField(field)) {
      return true;
    }

    if (field instanceof HTMLSelectElement) {
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

      if (hasValueAlready(field, resolvedPath, value)) {
        skipped += 1;
        continue;
      }

      matched += 1;
      if (await fillField(field, resolvedPath, value, seenRadioGroups, seenChoiceGroups)) {
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

  function installInlineFillButton() {
    if (!document.documentElement || document.getElementById("__formfuse-inline-root")) {
      return;
    }

    var host = document.createElement("div");
    host.id = "__formfuse-inline-root";
    document.documentElement.appendChild(host);

    var shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.wrap{position:fixed;top:14px;right:14px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-family:"Avenir Next","Segoe UI",sans-serif;}' +
      '.btn{border:none;border-radius:999px;padding:10px 16px;font-size:13px;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(135deg,#2b6cff,#124eca);box-shadow:0 10px 24px rgba(19,39,84,.28);}' +
      '.btn:disabled{opacity:.75;cursor:wait}' +
      '.msg{font-size:12px;color:#102a5f;background:#ffffff;border:1px solid rgba(25,52,108,.15);border-radius:8px;padding:5px 8px;max-width:240px;box-shadow:0 8px 16px rgba(20,33,61,.16)}' +
      "@media (max-width:700px){.wrap{top:10px;right:10px}.btn{padding:9px 13px;font-size:12px}}" +
      "</style>" +
      '<div class="wrap"><button class="btn" id="ff-inline-fill" type="button">Fill with FormFuse</button><div class="msg" id="ff-inline-msg" hidden></div></div>';

    var button = shadow.getElementById("ff-inline-fill");
    var message = shadow.getElementById("ff-inline-msg");
    var hideTimer = null;

    function setMessage(text, isError) {
      message.textContent = text;
      message.hidden = !text;
      message.style.color = isError ? "#8b1c2d" : "#102a5f";
      message.style.borderColor = isError ? "rgba(139,28,45,.25)" : "rgba(25,52,108,.15)";

      if (hideTimer) {
        window.clearTimeout(hideTimer);
      }

      if (text) {
        hideTimer = window.setTimeout(function () {
          message.hidden = true;
        }, 4500);
      }
    }

    button.addEventListener("click", function () {
      button.disabled = true;
      setMessage("Filling application...", false);

      fillApplication()
        .then(function (result) {
          if (!result.ok) {
            setMessage(result.error || "Autofill failed.", true);
            return;
          }
          setMessage("Filled " + result.filled + " field(s).", false);
        })
        .catch(function (error) {
          setMessage(error && error.message ? error.message : "Autofill failed.", true);
        })
        .finally(function () {
          button.disabled = false;
        });
    });
  }

  function removeInlineFillButton() {
    var node = document.getElementById("__formfuse-inline-root");
    if (node && node.parentNode) {
      node.parentNode.removeChild(node);
    }
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || !message.action) {
      return;
    }

    if (message.action === "FORMFUSE_SHOW_INLINE_BUTTON") {
      installInlineFillButton();
      sendResponse({ ok: true });
      return;
    }

    if (message.action === "FORMFUSE_HIDE_INLINE_BUTTON") {
      removeInlineFillButton();
      sendResponse({ ok: true });
      return;
    }

    if (message.action === "FORMFUSE_FILL") {
      fillApplication()
        .then(function (result) {
          sendResponse(result);
        })
        .catch(function (error) {
          sendResponse({ ok: false, error: error && error.message ? error.message : "Autofill failed." });
        });

      return true;
    }

    return;
  });
})();
