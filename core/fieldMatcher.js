(function (global) {
  "use strict";

  var FIELD_RULES = [
    {
      path: "identity.full_name",
      keywords: ["full name", "legal name", "applicant name", "candidate name"]
    },
    {
      path: "identity.first_name",
      keywords: ["first name", "given name", "firstname", "legal first name"]
    },
    {
      path: "identity.last_name",
      keywords: ["last name", "surname", "family name", "lastname"]
    },
    {
      path: "identity.email",
      keywords: ["email", "email address", "e mail"]
    },
    {
      path: "identity.phone",
      keywords: ["phone", "phone number", "mobile", "cell", "telephone"]
    },
    {
      path: "address.street",
      keywords: ["street", "street address", "address line", "address 1", "address"]
    },
    {
      path: "address.city",
      keywords: ["city", "town"]
    },
    {
      path: "address.state",
      keywords: ["state", "province", "region"]
    },
    {
      path: "address.zip",
      keywords: ["zip", "zip code", "postal code", "postcode"]
    },
    {
      path: "address.country",
      keywords: ["country", "nation"]
    },
    {
      path: "work_auth.eligible_to_work_us",
      keywords: [
        "authorized to work",
        "eligible to work",
        "work authorization",
        "work in the us",
        "work in the united states",
        "legally authorized",
        "lawfully authorized",
        "authorization to work",
        "currently authorized to work in the country",
        "authorized to work in the country",
        "authorized to work in the country to which you are applying"
      ]
    },
    {
      path: "work_auth.requires_sponsorship",
      keywords: [
        "requires sponsorship",
        "require sponsorship",
        "visa sponsorship",
        "need sponsorship",
        "now or in the future require sponsorship",
        "require company sponsorship now or in the future",
        "maintain or extend your current work authorization status"
      ]
    },
    {
      path: "work_auth.open_to_relocate",
      keywords: [
        "open to relocate",
        "willing to relocate",
        "available to relocate",
        "relocation",
        "open to relocation",
        "commuting distance"
      ]
    },
    {
      path: "work_auth.worked_here_before",
      keywords: [
        "worked here before",
        "previously worked here",
        "employed here before",
        "former employee",
        "worked for this company before",
        "worked at snowflake in the past",
        "in the past in a full time part time contractor or intern capacity"
      ]
    },
    {
      path: "demographics.gender",
      keywords: ["gender", "sex"]
    },
    {
      path: "demographics.ethnicity",
      keywords: ["ethnicity", "race", "racial"]
    },
    {
      path: "demographics.disability_status",
      keywords: ["disability", "disabled", "disability status"]
    },
    {
      path: "demographics.veteran_status",
      keywords: ["veteran", "protected veteran", "military service"]
    },
    {
      path: "links.linkedin",
      keywords: ["linkedin", "linkedin profile"]
    },
    {
      path: "links.github",
      keywords: ["github", "git hub"]
    },
    {
      path: "links.portfolio",
      keywords: ["portfolio", "work samples", "projects url"]
    },
    {
      path: "links.website",
      keywords: ["website", "personal website", "personal site", "homepage"]
    }
  ];

  var FORBIDDEN_KEYWORDS = [
    "years of experience",
    "experience",
    "employment history",
    "work history",
    "current company",
    "previous company",
    "salary",
    "compensation",
    "expected pay",
    "cover letter",
    "skill",
    "tech stack",
    "notice period",
    "start date",
    "resume",
    "curriculum vitae",
    "education",
    "degree",
    "gpa"
  ];

  var MIN_CONFIDENT_SCORE = 5;
  var MIN_AMBIGUITY_GAP = 2;

  var ALLOWED_KEYWORDS = (function buildKeywordSet() {
    var values = [];

    for (var i = 0; i < FIELD_RULES.length; i += 1) {
      values = values.concat(FIELD_RULES[i].keywords);
    }

    return values;
  })();

  function normalizeSignal(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasWholeWord(text, keyword) {
    if (!text || !keyword) {
      return false;
    }

    return text.indexOf(keyword) !== -1;
  }

  function safeCssEscape(value) {
    if (global.CSS && typeof global.CSS.escape === "function") {
      return global.CSS.escape(value);
    }

    return String(value).replace(/(["\\])/g, "\\$1");
  }

  function collectLabelText(field) {
    var pieces = [];

    if (field.id) {
      var linked = document.querySelector('label[for="' + safeCssEscape(field.id) + '"]');
      if (linked && linked.textContent) {
        pieces.push(linked.textContent);
      }
    }

    var wrapped = field.closest("label");
    if (wrapped && wrapped.textContent) {
      pieces.push(wrapped.textContent);
    }

    var fieldset = field.closest("fieldset");
    if (fieldset) {
      var legend = fieldset.querySelector("legend");
      if (legend && legend.textContent) {
        pieces.push(legend.textContent);
      }
    }

    var ariaLabelledBy = field.getAttribute("aria-labelledby");
    if (ariaLabelledBy) {
      var ids = ariaLabelledBy.split(/\s+/);
      for (var i = 0; i < ids.length; i += 1) {
        var node = document.getElementById(ids[i]);
        if (node && node.textContent) {
          pieces.push(node.textContent);
        }
      }
    }

    var type = field instanceof HTMLInputElement ? (field.type || "").toLowerCase() : "";
    var needsContainerContext = pieces.length === 0 || field instanceof HTMLSelectElement || type === "radio" || type === "checkbox";

    if (needsContainerContext) {
      var container = field.closest(
        "fieldset, [role='group'], [role='radiogroup'], .ashby-application-form-question, .ashby-application-form-field, .application-question, .question, .form-field, .field, .input-wrapper"
      );
      if (!container) {
        container = field.parentElement;
      }
      if (container && container.textContent) {
        var containerText = container.textContent.replace(/\s+/g, " ").trim();
        if (containerText) {
          pieces.push(containerText.slice(0, 320));
        }
      }
    }

    return pieces.join(" ");
  }

  function getElementSignals(field) {
    var label = collectLabelText(field);

    return {
      label: normalizeSignal(label),
      aria: normalizeSignal(field.getAttribute("aria-label")),
      placeholder: normalizeSignal(field.getAttribute("placeholder")),
      name: normalizeSignal(field.getAttribute("name")),
      id: normalizeSignal(field.id),
      autocomplete: normalizeSignal(field.getAttribute("autocomplete"))
    };
  }

  function shouldIgnoreField(field, signals) {
    if (!field || field.disabled || field.readOnly) {
      return true;
    }

    if (field instanceof HTMLInputElement) {
      var type = (field.type || "text").toLowerCase();
      var disallowed = ["hidden", "submit", "reset", "button", "file", "image", "password"];

      if (disallowed.indexOf(type) !== -1) {
        return true;
      }
    }

    var combined = [signals.label, signals.aria, signals.placeholder, signals.name, signals.id].join(" ").trim();
    if (!combined) {
      return true;
    }

    var hasForbidden = false;
    for (var i = 0; i < FORBIDDEN_KEYWORDS.length; i += 1) {
      if (hasWholeWord(combined, FORBIDDEN_KEYWORDS[i])) {
        hasForbidden = true;
        break;
      }
    }

    if (!hasForbidden) {
      return false;
    }

    for (var j = 0; j < ALLOWED_KEYWORDS.length; j += 1) {
      if (hasWholeWord(combined, ALLOWED_KEYWORDS[j])) {
        return false;
      }
    }

    return true;
  }

  function scoreRule(rule, signals) {
    var score = 0;

    for (var i = 0; i < rule.keywords.length; i += 1) {
      var keyword = rule.keywords[i];

      if (hasWholeWord(signals.label, keyword)) {
        score += 5;
      }
      if (hasWholeWord(signals.aria, keyword)) {
        score += 4;
      }
      if (hasWholeWord(signals.placeholder, keyword)) {
        score += 3;
      }
      if (hasWholeWord(signals.name, keyword)) {
        score += 2;
      }
      if (hasWholeWord(signals.id, keyword)) {
        score += 1;
      }
      if (hasWholeWord(signals.autocomplete, keyword)) {
        score += 2;
      }
    }

    return score;
  }

  function getBestMatch(field) {
    var signals = getElementSignals(field);

    if (shouldIgnoreField(field, signals)) {
      return null;
    }

    var results = [];

    for (var i = 0; i < FIELD_RULES.length; i += 1) {
      var rule = FIELD_RULES[i];
      var score = scoreRule(rule, signals);
      if (score > 0) {
        results.push({ path: rule.path, score: score });
      }
    }

    if (!results.length) {
      return null;
    }

    results.sort(function (a, b) {
      return b.score - a.score;
    });

    var best = results[0];
    var second = results[1];

    if (best.score < MIN_CONFIDENT_SCORE) {
      return null;
    }

    if (second && best.score - second.score < MIN_AMBIGUITY_GAP) {
      return null;
    }

    return best;
  }

  global.FormFuseMatcher = {
    FIELD_RULES: FIELD_RULES,
    normalizeSignal: normalizeSignal,
    getElementSignals: getElementSignals,
    getBestMatch: getBestMatch
  };
})(typeof window !== "undefined" ? window : globalThis);
