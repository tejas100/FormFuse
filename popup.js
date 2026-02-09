(function () {
  "use strict";

  var schema = window.FormFuseSchema;

  var LLM_SETTINGS_KEY = "FORMFUSE_LLM_SETTINGS";
  var LLM_RESUME_KEY = "FORMFUSE_LLM_RESUME_TEXT";
  var LLM_CONTEXT_MAX = 14000;

  var form = document.getElementById("profile-form");
  var saveButton = document.getElementById("save-button");
  var fillButton = document.getElementById("fill-button");
  var statusNode = document.getElementById("status");

  var homeTabButton = document.getElementById("tab-home");
  var llmTabButton = document.getElementById("tab-llm");
  var homeTabPanel = document.getElementById("home-tab-panel");
  var llmTabPanel = document.getElementById("llm-tab-panel");

  var llmStatusNode = document.getElementById("llm-status");
  var llmApiKeyInput = document.getElementById("llm-api-key");
  var llmModelInput = document.getElementById("llm-model");
  var llmSaveSettingsButton = document.getElementById("llm-save-settings");
  var llmResumeTextArea = document.getElementById("llm-resume-text");
  var llmResumeFileInput = document.getElementById("llm-resume-file");
  var llmRefreshContextButton = document.getElementById("llm-refresh-context");
  var llmChatLog = document.getElementById("llm-chat-log");
  var llmChatForm = document.getElementById("llm-chat-form");
  var llmUserInput = document.getElementById("llm-user-input");
  var llmAnalyzeFitButton = document.getElementById("llm-analyze-fit");
  var llmSendButton = document.getElementById("llm-send");

  var llmConversation = [];
  var latestJobContext = null;

  function setStatus(message, type) {
    if (!statusNode) {
      return;
    }

    statusNode.textContent = message;
    statusNode.className = "status";

    if (type) {
      statusNode.classList.add(type);
    }
  }

  function setLLMStatus(message, type) {
    if (!llmStatusNode) {
      return;
    }

    llmStatusNode.textContent = message;
    llmStatusNode.className = "status";

    if (type) {
      llmStatusNode.classList.add(type);
    }
  }

  function storageGet(keys) {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.get(keys, function (result) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result || {});
      });
    });
  }

  function storageSet(payload) {
    return new Promise(function (resolve, reject) {
      chrome.storage.sync.set(payload, function () {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
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

  function showInlineButtonOnActiveTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }

        var tab = tabs && tabs.length ? tabs[0] : null;
        if (!tab || typeof tab.id !== "number") {
          resolve(false);
          return;
        }

        chrome.tabs.sendMessage(tab.id, { action: "FORMFUSE_SHOW_INLINE_BUTTON" }, function () {
          resolve(!chrome.runtime.lastError);
        });
      });
    });
  }

  function getActiveTab() {
    return new Promise(function (resolve, reject) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        var tab = tabs && tabs.length ? tabs[0] : null;
        if (!tab || typeof tab.id !== "number") {
          reject(new Error("No active browser tab found."));
          return;
        }

        resolve(tab);
      });
    });
  }

  function sendActiveTabMessage(payload) {
    return new Promise(function (resolve, reject) {
      getActiveTab()
        .then(function (tab) {
          chrome.tabs.sendMessage(tab.id, payload, function (response) {
            if (chrome.runtime.lastError) {
              reject(new Error("Cannot access this page. Open a job posting tab and try again."));
              return;
            }
            resolve(response || {});
          });
        })
        .catch(reject);
    });
  }

  function setActiveTabPanel(tabName) {
    var isHome = tabName !== "llm";

    if (homeTabButton) {
      homeTabButton.classList.toggle("is-active", isHome);
      homeTabButton.setAttribute("aria-selected", isHome ? "true" : "false");
    }

    if (llmTabButton) {
      llmTabButton.classList.toggle("is-active", !isHome);
      llmTabButton.setAttribute("aria-selected", isHome ? "false" : "true");
    }

    if (homeTabPanel) {
      homeTabPanel.classList.toggle("is-active", isHome);
      homeTabPanel.hidden = !isHome;
      homeTabPanel.setAttribute("aria-hidden", isHome ? "false" : "true");
    }

    if (llmTabPanel) {
      llmTabPanel.classList.toggle("is-active", !isHome);
      llmTabPanel.hidden = isHome;
      llmTabPanel.setAttribute("aria-hidden", isHome ? "true" : "false");
    }

    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function addLLMMessage(role, text) {
    if (!llmChatLog) {
      return;
    }

    var messageNode = document.createElement("article");
    messageNode.className = "llm-message llm-message-" + role;

    var roleNode = document.createElement("p");
    roleNode.className = "llm-message-role";
    roleNode.textContent = role === "assistant" ? "ChatGPT" : "You";

    var bodyNode = document.createElement("p");
    bodyNode.className = "llm-message-body";
    bodyNode.textContent = text;

    messageNode.appendChild(roleNode);
    messageNode.appendChild(bodyNode);

    llmChatLog.appendChild(messageNode);
    llmChatLog.scrollTop = llmChatLog.scrollHeight;
  }

  function isProbablyBinaryText(text) {
    if (!text) {
      return false;
    }

    var suspicious = 0;
    var sampleSize = Math.min(text.length, 4000);

    for (var i = 0; i < sampleSize; i += 1) {
      var code = text.charCodeAt(i);
      if (code === 0 || (code < 9 && code !== 10 && code !== 13) || code === 65533) {
        suspicious += 1;
      }
    }

    return suspicious / sampleSize > 0.08;
  }

  function extractAssistantText(payload) {
    if (!payload || !payload.choices || !payload.choices.length) {
      return "";
    }

    var choice = payload.choices[0];
    if (!choice || !choice.message || choice.message.content == null) {
      return "";
    }

    if (typeof choice.message.content === "string") {
      return choice.message.content.trim();
    }

    if (Array.isArray(choice.message.content)) {
      var joined = [];
      for (var i = 0; i < choice.message.content.length; i += 1) {
        var part = choice.message.content[i];
        if (part && typeof part.text === "string") {
          joined.push(part.text);
        }
      }
      return joined.join("\n").trim();
    }

    return "";
  }

  function loadLLMSettings() {
    return storageGet([LLM_SETTINGS_KEY, LLM_RESUME_KEY]).then(function (result) {
      var settings = result[LLM_SETTINGS_KEY] || {};
      if (llmApiKeyInput) {
        llmApiKeyInput.value = settings.apiKey || "";
      }
      if (llmModelInput) {
        llmModelInput.value = settings.model || "gpt-4o-mini";
      }
      if (llmResumeTextArea) {
        llmResumeTextArea.value = result[LLM_RESUME_KEY] || "";
      }
    });
  }

  function saveLLMSettings() {
    var apiKey = llmApiKeyInput ? String(llmApiKeyInput.value || "").trim() : "";
    var model = llmModelInput ? String(llmModelInput.value || "").trim() : "gpt-4o-mini";

    var payload = {};
    payload[LLM_SETTINGS_KEY] = {
      apiKey: apiKey,
      model: model || "gpt-4o-mini"
    };
    return storageSet(payload);
  }

  function saveResumeText() {
    if (!llmResumeTextArea) {
      return Promise.resolve();
    }

    var payload = {};
    payload[LLM_RESUME_KEY] = String(llmResumeTextArea.value || "");
    return storageSet(payload);
  }

  function buildSystemPrompt(resumeText, pageContext) {
    var pageTitle = pageContext && pageContext.title ? pageContext.title : "";
    var pageUrl = pageContext && pageContext.url ? pageContext.url : "";
    var jdText = pageContext && pageContext.text ? pageContext.text : "";

    return (
      "You are an expert resume coach helping a user match their resume to a job description. " +
      "Use only the provided resume and job description context. " +
      "If information is missing, say exactly what is missing.\n\n" +
      "Return concise sections in this order:\n" +
      "1) Match score (0-100)\n" +
      "2) Why this match score\n" +
      "3) Missing requirements\n" +
      "4) Resume updates to make immediately (bullets)\n" +
      "5) Suggested short answers for application text fields\n\n" +
      "Current page title: " +
      pageTitle +
      "\nCurrent page URL: " +
      pageUrl +
      "\n\nResume:\n" +
      resumeText +
      "\n\nJob description:\n" +
      jdText
    );
  }

  function fetchJobDescriptionContext() {
    return sendActiveTabMessage({ action: "FORMFUSE_GET_PAGE_CONTEXT" }).then(function (response) {
      if (!response || !response.ok || !response.text) {
        throw new Error((response && response.error) || "Could not read job description from this page.");
      }

      latestJobContext = {
        title: response.title || "",
        url: response.url || "",
        text: String(response.text || "").slice(0, LLM_CONTEXT_MAX)
      };

      return latestJobContext;
    });
  }

  async function handleResumeFileUpload() {
    if (!llmResumeFileInput || !llmResumeFileInput.files || !llmResumeFileInput.files.length) {
      return;
    }

    var file = llmResumeFileInput.files[0];
    var text = await file.text();

    if (isProbablyBinaryText(text)) {
      throw new Error("This file looks binary (PDF/DOCX). Paste resume text directly for best results.");
    }

    if (!llmResumeTextArea) {
      return;
    }

    llmResumeTextArea.value = text;
    await saveResumeText();
    setLLMStatus("Resume loaded from " + file.name + ".", "success");
  }

  function setLLMInputsDisabled(disabled) {
    if (llmSendButton) {
      llmSendButton.disabled = disabled;
    }
    if (llmAnalyzeFitButton) {
      llmAnalyzeFitButton.disabled = disabled;
    }
    if (llmRefreshContextButton) {
      llmRefreshContextButton.disabled = disabled;
    }
  }

  async function sendLLMMessage(userMessage) {
    var userText = String(userMessage || "").trim();
    if (!userText) {
      setLLMStatus("Enter a question to chat with ChatGPT.", "error");
      return;
    }

    var apiKey = llmApiKeyInput ? String(llmApiKeyInput.value || "").trim() : "";
    if (!apiKey) {
      setLLMStatus("Add and save your OpenAI API key first.", "error");
      return;
    }

    var resumeText = llmResumeTextArea ? String(llmResumeTextArea.value || "").trim() : "";
    if (!resumeText) {
      setLLMStatus("Upload or paste your resume text first.", "error");
      return;
    }

    setLLMInputsDisabled(true);
    addLLMMessage("user", userText);
    llmConversation.push({ role: "user", content: userText });

    try {
      await saveResumeText();

      setLLMStatus("Reading current page job description...", null);
      var pageContext = await fetchJobDescriptionContext();

      var messages = [{ role: "system", content: buildSystemPrompt(resumeText, pageContext) }];
      var historyStart = llmConversation.length > 10 ? llmConversation.length - 10 : 0;
      for (var i = historyStart; i < llmConversation.length; i += 1) {
        messages.push(llmConversation[i]);
      }

      setLLMStatus("Waiting for ChatGPT response...", null);
      var response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: (llmModelInput && llmModelInput.value) || "gpt-4o-mini",
          temperature: 0.2,
          messages: messages
        })
      });

      var data = await response.json();
      if (!response.ok) {
        throw new Error((data && data.error && data.error.message) || "OpenAI request failed.");
      }

      var assistantText = extractAssistantText(data);
      if (!assistantText) {
        throw new Error("ChatGPT returned an empty response.");
      }

      llmConversation.push({ role: "assistant", content: assistantText });
      addLLMMessage("assistant", assistantText);
      setLLMStatus("Response ready.", "success");
    } catch (error) {
      setLLMStatus(error && error.message ? error.message : "Chat request failed.", "error");
    } finally {
      setLLMInputsDisabled(false);
    }
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

  function initTabs() {
    if (homeTabButton) {
      homeTabButton.addEventListener("click", function () {
        setActiveTabPanel("home");
      });
    }

    if (llmTabButton) {
      llmTabButton.addEventListener("click", function () {
        setActiveTabPanel("llm");
      });
    }

    setActiveTabPanel("home");
  }

  function initLLM() {
    if (!llmChatLog) {
      return;
    }

    llmChatLog.innerHTML = "";
    addLLMMessage(
      "assistant",
      "Upload or paste your resume, open a job description page, and ask for a fit analysis."
    );

    loadLLMSettings().catch(function (error) {
      setLLMStatus(error.message || "Could not load LLM settings.", "error");
    });

    if (llmSaveSettingsButton) {
      llmSaveSettingsButton.addEventListener("click", function () {
        setLLMStatus("Saving OpenAI connection...", null);
        saveLLMSettings()
          .then(function () {
            setLLMStatus("Connection details saved.", "success");
          })
          .catch(function (error) {
            setLLMStatus(error.message || "Could not save settings.", "error");
          });
      });
    }

    if (llmResumeTextArea) {
      llmResumeTextArea.addEventListener("change", function () {
        saveResumeText().catch(function () {
          setLLMStatus("Could not save resume text.", "error");
        });
      });
    }

    if (llmResumeFileInput) {
      llmResumeFileInput.addEventListener("change", function () {
        setLLMStatus("Reading resume file...", null);
        handleResumeFileUpload().catch(function (error) {
          setLLMStatus(error.message || "Could not read resume file.", "error");
        });
      });
    }

    if (llmRefreshContextButton) {
      llmRefreshContextButton.addEventListener("click", function () {
        setLLMStatus("Reading current page content...", null);
        fetchJobDescriptionContext()
          .then(function (context) {
            setLLMStatus("Loaded job context (" + context.text.length + " chars).", "success");
          })
          .catch(function (error) {
            setLLMStatus(error.message || "Could not read current page.", "error");
          });
      });
    }

    if (llmChatForm) {
      llmChatForm.addEventListener("submit", function (event) {
        event.preventDefault();
        sendLLMMessage(llmUserInput ? llmUserInput.value : "").then(function () {
          if (llmUserInput) {
            llmUserInput.value = "";
          }
        });
      });
    }

    if (llmAnalyzeFitButton) {
      llmAnalyzeFitButton.addEventListener("click", function () {
        sendLLMMessage(
          "Analyze this resume against the current job description and provide fit score, strengths, gaps, and concrete resume updates."
        );
      });
    }
  }

  async function init() {
    initTabs();
    initLLM();

    if (!schema) {
      setStatus("Profile schema failed to load. Reload the extension.", "error");
      return;
    }

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

    showInlineButtonOnActiveTab();
  }

  init();
})();
