(function () {
  "use strict";

  var schema = window.FormFuseSchema;

  var LLM_SETTINGS_KEY = "FORMFUSE_LLM_SETTINGS";
  var RESUME_VARIANTS_KEY = "FORMFUSE_RESUME_VARIANTS";
  var LLM_CONTEXT_MAX = 14000;
  var MAX_RESUME_VARIANTS = 8;

  var STOP_WORDS = {
    the: true,
    and: true,
    for: true,
    with: true,
    this: true,
    that: true,
    from: true,
    you: true,
    your: true,
    have: true,
    will: true,
    are: true,
    our: true,
    but: true,
    not: true,
    all: true,
    any: true,
    can: true,
    job: true,
    role: true,
    about: true,
    they: true,
    into: true,
    has: true,
    been: true,
    more: true,
    than: true,
    years: true,
    year: true,
    who: true,
    when: true,
    what: true,
    where: true,
    how: true
  };

  var form = document.getElementById("profile-form");
  var saveButton = document.getElementById("save-button");
  var fillButton = document.getElementById("fill-button");
  var statusNode = document.getElementById("status");

  var homeTabButton = document.getElementById("tab-home");
  var llmTabButton = document.getElementById("tab-llm");
  var autofillTabButton = document.getElementById("tab-autofill");
  var homeTabPanel = document.getElementById("home-tab-panel");
  var llmTabPanel = document.getElementById("llm-tab-panel");
  var autofillTabPanel = document.getElementById("autofill-tab-panel");

  var resumeAddButton = document.getElementById("resume-add-button");
  var resumeUploadInput = document.getElementById("resume-upload-input");
  var matchRefreshButton = document.getElementById("match-refresh-button");
  var matchStatusNode = document.getElementById("match-status");
  var matchListNode = document.getElementById("resume-match-list");

  var llmStatusNode = document.getElementById("llm-status");
  var llmChatLog = document.getElementById("llm-chat-log");
  var llmChatForm = document.getElementById("llm-chat-form");
  var llmUserInput = document.getElementById("llm-user-input");
  var llmAnalyzeFitButton = document.getElementById("llm-analyze-fit");
  var llmSendButton = document.getElementById("llm-send");

  var llmConversation = [];
  var resumeVariants = [];
  var matchSummaryById = {};

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

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

  function setMatchStatus(message, type) {
    if (!matchStatusNode) {
      return;
    }

    matchStatusNode.textContent = message;
    matchStatusNode.className = "status";
    if (type) {
      matchStatusNode.classList.add(type);
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

  function fetchJobDescriptionContext() {
    return sendActiveTabMessage({ action: "FORMFUSE_GET_PAGE_CONTEXT" }).then(function (response) {
      if (!response || !response.ok || !response.text) {
        throw new Error((response && response.error) || "Could not read job description from this page.");
      }

      return {
        title: response.title || "",
        url: response.url || "",
        text: String(response.text || "").slice(0, LLM_CONTEXT_MAX)
      };
    });
  }

  function getTabElements() {
    return [
      { name: "home", button: homeTabButton, panel: homeTabPanel },
      { name: "llm", button: llmTabButton, panel: llmTabPanel },
      { name: "autofill", button: autofillTabButton, panel: autofillTabPanel }
    ];
  }

  function setActiveTabPanel(tabName) {
    var tabs = getTabElements();

    for (var i = 0; i < tabs.length; i += 1) {
      var item = tabs[i];
      var isActive = item.name === tabName;

      if (item.button) {
        item.button.classList.toggle("is-active", isActive);
        item.button.setAttribute("aria-selected", isActive ? "true" : "false");
      }

      if (item.panel) {
        item.panel.classList.toggle("is-active", isActive);
        item.panel.hidden = !isActive;
        item.panel.setAttribute("aria-hidden", isActive ? "false" : "true");
      }
    }

    if (tabName === "home" && resumeVariants.length) {
      refreshResumeMatches(false);
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
    roleNode.textContent = role === "assistant" ? "Assistant" : "You";

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

  function parseJsonObject(text) {
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (_) {
      var first = text.indexOf("{");
      var last = text.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        try {
          return JSON.parse(text.slice(first, last + 1));
        } catch (error) {
          return null;
        }
      }
      return null;
    }
  }

  function sanitizeResumeVariants(list) {
    if (!Array.isArray(list) || !list.length) {
      return [];
    }

    var out = [];
    var seen = {};

    for (var i = 0; i < list.length && out.length < MAX_RESUME_VARIANTS; i += 1) {
      var item = list[i] || {};
      var id = String(item.id || "resume_" + String(Date.now()) + "_" + String(i));
      if (seen[id]) {
        id = id + "_" + String(i);
      }
      seen[id] = true;

      var name = String(item.name || "").trim();
      var text = String(item.text || "");
      if (!name || !text.trim()) {
        continue;
      }

      out.push({
        id: id,
        name: name,
        text: text
      });
    }

    return out;
  }

  function saveResumeVariants() {
    var payload = {};
    payload[RESUME_VARIANTS_KEY] = resumeVariants;
    return storageSet(payload);
  }

  function loadResumeVariants() {
    return storageGet([RESUME_VARIANTS_KEY]).then(function (result) {
      resumeVariants = sanitizeResumeVariants(result[RESUME_VARIANTS_KEY]);
      renderResumeMatches({}, false);
      if (!resumeVariants.length) {
        setMatchStatus("", null);
      }
    });
  }

  function extractTokens(text) {
    var value = String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    var raw = value.split(/\s+/);
    var output = [];

    for (var i = 0; i < raw.length; i += 1) {
      var token = raw[i];
      if (!token || token.length < 3 || STOP_WORDS[token]) {
        continue;
      }
      output.push(token);
    }

    return output;
  }

  function localMatchScore(resumeText, jobText) {
    var resumeTokens = extractTokens(resumeText);
    var jobTokens = extractTokens(jobText);

    if (!resumeTokens.length || !jobTokens.length) {
      return 0;
    }

    var resumeMap = {};
    var jobMap = {};
    var overlap = 0;

    for (var i = 0; i < resumeTokens.length; i += 1) {
      resumeMap[resumeTokens[i]] = true;
    }
    for (var j = 0; j < jobTokens.length; j += 1) {
      jobMap[jobTokens[j]] = true;
    }

    var resumeUnique = Object.keys(resumeMap);
    var jobUnique = Object.keys(jobMap);

    for (var k = 0; k < resumeUnique.length; k += 1) {
      if (jobMap[resumeUnique[k]]) {
        overlap += 1;
      }
    }

    var precision = overlap / resumeUnique.length;
    var recall = overlap / jobUnique.length;
    if (!precision || !recall) {
      return 0;
    }

    var f1 = (2 * precision * recall) / (precision + recall);
    return clamp(Math.round(f1 * 100), 0, 100);
  }

  function normalizeResumeName(base) {
    var trimmed = String(base || "").trim();
    if (!trimmed) {
      return "Resume - Version " + String(resumeVariants.length + 1);
    }
    if (/^resume\s*[-:]/i.test(trimmed)) {
      return trimmed;
    }
    return "Resume - " + trimmed;
  }

  function baseNameFromFileName(fileName) {
    var clean = String(fileName || "").replace(/\.[^.]+$/, "");
    clean = clean.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return clean;
  }

  async function addResumeFromFile(file) {
    if (!file) {
      return;
    }

    if (resumeVariants.length >= MAX_RESUME_VARIANTS) {
      throw new Error("You can store up to " + String(MAX_RESUME_VARIANTS) + " resume versions.");
    }

    var text = await file.text();
    if (!String(text || "").trim()) {
      throw new Error("Selected file is empty.");
    }
    if (isProbablyBinaryText(text)) {
      throw new Error("This file looks binary. Please upload a text-based resume.");
    }

    var baseName = baseNameFromFileName(file.name);
    var typedName = window.prompt("Resume title", normalizeResumeName(baseName));
    var title = normalizeResumeName(typedName || baseName);
    var id = "resume_" + String(Date.now()) + "_" + String(resumeVariants.length);

    resumeVariants.push({
      id: id,
      name: title,
      text: text
    });

    await saveResumeVariants();
    renderResumeMatches({}, false);
    setMatchStatus(title + " uploaded. Refresh to compute match.", "success");
  }

  function renderResumeMatches(scoreMap, usedLLM) {
    if (!matchListNode) {
      return;
    }

    matchListNode.innerHTML = "";

    if (!resumeVariants.length) {
      matchListNode.hidden = true;
      return;
    }

    matchListNode.hidden = false;

    for (var i = 0; i < resumeVariants.length; i += 1) {
      var variant = resumeVariants[i];
      var scoreItem = scoreMap[variant.id] || { score: 0, summary: "" };

      var card = document.createElement("article");
      card.className = "resume-match-card";

      var top = document.createElement("div");
      top.className = "resume-match-top";

      var title = document.createElement("p");
      title.className = "resume-match-title";
      title.textContent = variant.name;

      var value = document.createElement("p");
      value.className = "resume-match-value";
      value.textContent = String(scoreItem.score) + "%";

      var meter = document.createElement("div");
      meter.className = "resume-match-meter";
      var fill = document.createElement("span");
      fill.style.width = String(scoreItem.score) + "%";
      meter.appendChild(fill);

      var note = document.createElement("p");
      note.className = "resume-match-note";
      if (scoreItem.summary) {
        note.textContent = scoreItem.summary;
      } else if (usedLLM) {
        note.textContent = "Semantic match score for this resume.";
      } else {
        note.textContent = "Click Refresh to calculate match for this resume.";
      }

      top.appendChild(title);
      top.appendChild(value);
      card.appendChild(top);
      card.appendChild(meter);
      card.appendChild(note);
      matchListNode.appendChild(card);
    }
  }

  function getBestResumeVariant() {
    if (!resumeVariants.length) {
      return null;
    }

    var best = resumeVariants[0];
    var bestScore = -1;

    for (var i = 0; i < resumeVariants.length; i += 1) {
      var variant = resumeVariants[i];
      var scoreItem = matchSummaryById[variant.id];
      var score = scoreItem && typeof scoreItem.score === "number" ? scoreItem.score : -1;
      if (score > bestScore) {
        bestScore = score;
        best = variant;
      }
    }

    return best;
  }

  async function getLLMMatchScores(variants, pageContext) {
    var settingsPayload = await storageGet([LLM_SETTINGS_KEY]);
    var settings = settingsPayload[LLM_SETTINGS_KEY] || {};
    var apiKey = String(settings.apiKey || "").trim();
    if (!apiKey) {
      return null;
    }

    var lines = [];
    for (var i = 0; i < variants.length; i += 1) {
      lines.push(
        "ID: " +
          variants[i].id +
          "\nName: " +
          variants[i].name +
          "\nResume Text:\n" +
          String(variants[i].text || "").slice(0, 6000)
      );
    }

    var response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: String(settings.model || "gpt-4o-mini"),
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "Return strict JSON only."
          },
          {
            role: "user",
            content:
              "Score each resume version against the job description. Return JSON with shape " +
              "{\"results\":[{\"id\":\"...\",\"score\":0-100,\"summary\":\"...\"}]}.\n\nJob Description:\n" +
              String(pageContext.text || "").slice(0, 12000) +
              "\n\nResume Versions:\n\n" +
              lines.join("\n\n---\n\n")
          }
        ]
      })
    });

    var data = await response.json();
    if (!response.ok) {
      throw new Error((data && data.error && data.error.message) || "OpenAI scoring request failed.");
    }

    var parsed = parseJsonObject(extractAssistantText(data));
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error("Could not parse scoring response.");
    }

    var out = {};
    for (var j = 0; j < parsed.results.length; j += 1) {
      var item = parsed.results[j];
      if (!item || !item.id) {
        continue;
      }
      out[String(item.id)] = {
        score: clamp(Number(item.score) || 0, 0, 100),
        summary: String(item.summary || "")
      };
    }

    return out;
  }

  function getLocalMatchScores(variants, pageContext) {
    var output = {};
    var jdText = String(pageContext && pageContext.text ? pageContext.text : "");

    for (var i = 0; i < variants.length; i += 1) {
      var variant = variants[i];
      output[variant.id] = {
        score: localMatchScore(variant.text, jdText),
        summary: "Local relevance estimate for this resume."
      };
    }

    return output;
  }

  async function refreshResumeMatches(forceMessage) {
    if (!matchRefreshButton) {
      return;
    }

    if (!resumeVariants.length) {
      matchListNode.hidden = true;
      setMatchStatus("", null);
      return;
    }

    matchRefreshButton.disabled = true;
    setMatchStatus("Refreshing match scores...", null);

    try {
      var pageContext = await fetchJobDescriptionContext();
      var scores = null;
      var usedLLM = false;

      try {
        scores = await getLLMMatchScores(resumeVariants, pageContext);
        usedLLM = Boolean(scores);
      } catch (_) {
        scores = null;
      }

      if (!scores) {
        scores = getLocalMatchScores(resumeVariants, pageContext);
      }

      matchSummaryById = scores || {};
      renderResumeMatches(matchSummaryById, usedLLM);

      if (usedLLM) {
        setMatchStatus("Match scores refreshed.", "success");
      } else if (forceMessage) {
        setMatchStatus("Match scores refreshed (local estimate).", "success");
      }
    } catch (error) {
      setMatchStatus(error && error.message ? error.message : "Could not refresh match scores.", "error");
    } finally {
      matchRefreshButton.disabled = false;
    }
  }

  async function getLLMRuntimeConfig() {
    var settingsPayload = await storageGet([LLM_SETTINGS_KEY]);
    var settings = settingsPayload[LLM_SETTINGS_KEY] || {};
    return {
      apiKey: String(settings.apiKey || "").trim(),
      model: String(settings.model || "gpt-4o-mini")
    };
  }

  function buildLLMSystemPrompt(resumeVariant, pageContext) {
    return (
      "You are an expert resume coach. Use the provided resume and job description. " +
      "If data is missing, state that clearly.\n\n" +
      "Selected resume name: " +
      resumeVariant.name +
      "\nPage title: " +
      String(pageContext.title || "") +
      "\nPage URL: " +
      String(pageContext.url || "") +
      "\n\nResume:\n" +
      String(resumeVariant.text || "") +
      "\n\nJob Description:\n" +
      String(pageContext.text || "")
    );
  }

  function setLLMInputsDisabled(disabled) {
    if (llmSendButton) {
      llmSendButton.disabled = disabled;
    }
    if (llmAnalyzeFitButton) {
      llmAnalyzeFitButton.disabled = disabled;
    }
  }

  async function sendLLMMessage(userMessage) {
    var userText = String(userMessage || "").trim();
    if (!userText) {
      setLLMStatus("Enter a question to continue.", "error");
      return;
    }

    var selectedResume = getBestResumeVariant();
    if (!selectedResume) {
      setLLMStatus("Add at least one resume version in Home before using LLM chat.", "error");
      return;
    }

    var runtime = await getLLMRuntimeConfig();
    if (!runtime.apiKey) {
      setLLMStatus("LLM backend is not connected yet.", "error");
      return;
    }

    setLLMInputsDisabled(true);
    addLLMMessage("user", userText);
    llmConversation.push({ role: "user", content: userText });

    try {
      var pageContext = await fetchJobDescriptionContext();
      var messages = [{ role: "system", content: buildLLMSystemPrompt(selectedResume, pageContext) }];
      var historyStart = llmConversation.length > 10 ? llmConversation.length - 10 : 0;
      for (var i = historyStart; i < llmConversation.length; i += 1) {
        messages.push(llmConversation[i]);
      }

      setLLMStatus("Waiting for assistant response...", null);
      var response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + runtime.apiKey
        },
        body: JSON.stringify({
          model: runtime.model,
          temperature: 0.2,
          messages: messages
        })
      });

      var data = await response.json();
      if (!response.ok) {
        throw new Error((data && data.error && data.error.message) || "Chat request failed.");
      }

      var assistantText = extractAssistantText(data);
      if (!assistantText) {
        throw new Error("Assistant returned an empty response.");
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
    if (!fillButton) {
      return;
    }

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

    if (autofillTabButton) {
      autofillTabButton.addEventListener("click", function () {
        setActiveTabPanel("autofill");
      });
    }

    setActiveTabPanel("home");
  }

  function initHomeMatching() {
    loadResumeVariants()
      .then(function () {
        if (resumeVariants.length) {
          refreshResumeMatches(false);
        }
      })
      .catch(function (error) {
        setMatchStatus(error.message || "Could not load resume versions.", "error");
      });

    if (resumeAddButton && resumeUploadInput) {
      resumeAddButton.addEventListener("click", function () {
        resumeUploadInput.value = "";
        resumeUploadInput.click();
      });

      resumeUploadInput.addEventListener("change", function () {
        var file = resumeUploadInput.files && resumeUploadInput.files.length ? resumeUploadInput.files[0] : null;
        if (!file) {
          return;
        }

        setMatchStatus("Uploading resume version...", null);
        addResumeFromFile(file)
          .then(function () {
            refreshResumeMatches(false);
          })
          .catch(function (error) {
            setMatchStatus(error.message || "Could not add resume version.", "error");
          });
      });
    }

    if (matchRefreshButton) {
      matchRefreshButton.addEventListener("click", function () {
        refreshResumeMatches(true);
      });
    }
  }

  function initLLM() {
    if (!llmChatLog) {
      return;
    }

    llmChatLog.innerHTML = "";
    addLLMMessage("assistant", "Add resumes in Home, then ask me to analyze fit with the current job page.");

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
        sendLLMMessage("Analyze resume fit for this job and suggest concrete updates.");
      });
    }
  }

  async function init() {
    initTabs();
    initHomeMatching();
    initLLM();

    if (!schema) {
      setStatus("Profile schema failed to load. Reload the extension.", "error");
      return;
    }

    if (saveButton) {
      saveButton.addEventListener("click", function () {
        setStatus("Saving profile...", null);
        saveProfile(false).catch(function (error) {
          setStatus(error.message || "Save failed.", "error");
        });
      });
    }

    if (fillButton) {
      fillButton.addEventListener("click", handleFillClick);
    }

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
