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

  function hasValueAlready(field) {
    if (field instanceof HTMLInputElement) {
      var type = (field.type || "text").toLowerCase();

      if (type === "radio") {
        if (!field.name) {
          return field.checked;
        }
        return Boolean(document.querySelector('input[type="radio"][name="' + cssEscape(field.name) + '"]:checked'));
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
      return Boolean((field.value || "").trim());
    }

    return true;
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }

    return String(value).replace(/(["\\])/g, "\\$1");
  }

  function valueCandidates(path, rawValue) {
    var value = String(rawValue || "").trim();
    var normalized = normalize(value);
    var list = [];

    if (!normalized) {
      return list;
    }

    list.push(normalized);

    if (path.indexOf("work_auth.") === 0) {
      if (normalized === "yes") {
        list = list.concat(["yes", "true", "authorized", "eligible", "1"]);
      }
      if (normalized === "no") {
        list = list.concat(["no", "false", "not authorized", "not eligible", "0"]);
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
        if ((optionValue && optionValue.indexOf(candidates[j]) !== -1) || (optionText && optionText.indexOf(candidates[j]) !== -1)) {
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
    var text = [radio.value || ""];
    var signals = matcher.getElementSignals(radio);

    if (signals.label) {
      text.push(signals.label);
    }
    if (signals.aria) {
      text.push(signals.aria);
    }

    return normalize(text.join(" "));
  }

  function isYesToken(value) {
    return value === "yes" || value === "true" || value === "1";
  }

  function isNoToken(value) {
    return value === "no" || value === "false" || value === "0";
  }

  function findRadioTarget(radios, path, value) {
    var normalized = normalize(value);

    if (!normalized) {
      return null;
    }

    var candidates = valueCandidates(path, value);

    for (var i = 0; i < radios.length; i += 1) {
      var text = radioText(radios[i]);

      if (normalized === "yes" && /\byes\b|\btrue\b|\b1\b/.test(text) && !/\bno\b/.test(text)) {
        return radios[i];
      }
      if (normalized === "no" && /\bno\b|\bfalse\b|\b0\b/.test(text)) {
        return radios[i];
      }

      for (var j = 0; j < candidates.length; j += 1) {
        if (text === candidates[j] || text.indexOf(candidates[j]) !== -1) {
          return radios[i];
        }
      }
    }

    return null;
  }

  function tryFillRadio(field, path, value, seenGroups) {
    if (!field.name) {
      return false;
    }

    var groupKey = field.name;
    if (seenGroups.has(groupKey)) {
      return false;
    }

    var radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"][name="' + cssEscape(field.name) + '"]'));
    if (!radios.length) {
      seenGroups.add(groupKey);
      return false;
    }

    if (document.querySelector('input[type="radio"][name="' + cssEscape(field.name) + '"]:checked')) {
      seenGroups.add(groupKey);
      return false;
    }

    var target = findRadioTarget(radios, path, value);
    seenGroups.add(groupKey);

    if (!target || target.checked) {
      return false;
    }

    target.checked = true;
    emitInputEvents(target);
    return true;
  }

  function tryFillCheckbox(field, path, value) {
    if (path.indexOf("work_auth.") !== 0) {
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

  function fillField(field, path, value, seenRadioGroups) {
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

  async function fillApplication() {
    var profile = await readProfile();

    if (!profile) {
      return { ok: false, error: "Unable to read saved profile." };
    }

    var fields = Array.prototype.slice.call(document.querySelectorAll("input, textarea, select"));
    var filled = 0;
    var matched = 0;
    var skipped = 0;
    var seenRadioGroups = new Set();

    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      var match = matcher.getBestMatch(field);

      if (!match) {
        skipped += 1;
        continue;
      }

      var value = schema.getValueByPath(profile, match.path);
      if (!String(value || "").trim()) {
        skipped += 1;
        continue;
      }

      if (hasValueAlready(field)) {
        skipped += 1;
        continue;
      }

      matched += 1;
      if (fillField(field, match.path, value, seenRadioGroups)) {
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
