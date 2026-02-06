(function () {
  "use strict";

  var schema = window.FormFuseSchema;

  if (!schema) {
    return;
  }

  var form = document.getElementById("profile-form");
  var saveButton = document.getElementById("save-button");
  var fillButton = document.getElementById("fill-button");
  var statusNode = document.getElementById("status");

  function setStatus(message, type) {
    statusNode.textContent = message;
    statusNode.className = "status";

    if (type) {
      statusNode.classList.add(type);
    }
  }

  function getFormProfile() {
    var profile = schema.cloneDefaultProfile();

    for (var i = 0; i < schema.PATHS.length; i += 1) {
      var path = schema.PATHS[i];
      var field = form.querySelector('[name="' + path + '"]');

      if (!field) {
        continue;
      }

      schema.setValueByPath(profile, path, field.value);
    }

    return schema.sanitizeProfile(profile);
  }

  function applyProfileToForm(profile) {
    var safe = schema.sanitizeProfile(profile || {});

    for (var i = 0; i < schema.PATHS.length; i += 1) {
      var path = schema.PATHS[i];
      var field = form.querySelector('[name="' + path + '"]');

      if (!field) {
        continue;
      }

      var nextValue = schema.getValueByPath(safe, path);
      field.value = nextValue == null ? "" : String(nextValue);
    }
  }

  function loadProfile() {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.get([schema.STORAGE_KEY], function (result) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(schema.sanitizeProfile(result[schema.STORAGE_KEY] || {}));
      });
    });
  }

  function saveProfile(silent) {
    return new Promise(function (resolve, reject) {
      var profile = getFormProfile();
      var payload = {};
      payload[schema.STORAGE_KEY] = profile;

      chrome.storage.sync.set(payload, function () {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!silent) {
          setStatus("Profile saved locally.", "success");
        }

        resolve(profile);
      });
    });
  }

  function sendFillRequest() {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        var tab = tabs && tabs.length ? tabs[0] : null;
        if (!tab || typeof tab.id !== "number") {
          reject(new Error("Open a page with a form before using Fill Application."));
          return;
        }

        chrome.tabs.sendMessage(tab.id, { action: "FORMFUSE_FILL" }, function (response) {
          if (chrome.runtime.lastError) {
            reject(new Error("Cannot access this page. Try on a standard job application website."));
            return;
          }

          resolve(response || { ok: false, error: "No response from page." });
        });
      });
    });
  }

  async function handleFillClick() {
    fillButton.disabled = true;

    try {
      setStatus("Saving profile and filling page...", null);
      await saveProfile(true);
      var result = await sendFillRequest();

      if (!result.ok) {
        throw new Error(result.error || "Autofill failed.");
      }

      setStatus("Filled " + result.filled + " field(s) out of " + result.scanned + " scanned.", "success");
    } catch (error) {
      setStatus(error.message || "Autofill failed.", "error");
    } finally {
      fillButton.disabled = false;
    }
  }

  async function init() {
    saveButton.addEventListener("click", function () {
      setStatus("Saving profile...", null);
      saveProfile(false).catch(function (error) {
        setStatus(error.message || "Save failed.", "error");
      });
    });

    fillButton.addEventListener("click", handleFillClick);

    try {
      var profile = await loadProfile();
      applyProfileToForm(profile);
      setStatus("Profile loaded from local sync storage.", null);
    } catch (error) {
      setStatus(error.message || "Could not load profile.", "error");
    }
  }

  init();
})();
