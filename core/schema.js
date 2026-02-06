(function (global) {
  "use strict";

  var STORAGE_KEY = "formFuseProfile";

  var DEFAULT_PROFILE = {
    identity: {
      full_name: "",
      first_name: "",
      last_name: "",
      email: "",
      phone: ""
    },
    address: {
      street: "",
      city: "",
      state: "",
      zip: "",
      country: "United States"
    },
    work_auth: {
      eligible_to_work_us: "",
      requires_sponsorship: "",
      open_to_relocate: "",
      worked_here_before: "",
      in_person_office_preference: ""
    },
    demographics: {
      gender: "prefer_not_to_say",
      ethnicity: "prefer_not_to_say",
      disability_status: "prefer_not_to_say",
      veteran_status: "prefer_not_to_say",
      pronouns: "prefer_not_to_answer",
      hispanic_latinx: "prefer_not_to_answer",
      transgender_identity: "prefer_not_to_answer"
    },
    education: {
      school: "",
      degree: ""
    },
    links: {
      linkedin: "",
      github: "",
      portfolio: "",
      website: ""
    }
  };

  var PATHS = [
    "identity.full_name",
    "identity.first_name",
    "identity.last_name",
    "identity.email",
    "identity.phone",
    "address.street",
    "address.city",
    "address.state",
    "address.zip",
    "address.country",
    "work_auth.eligible_to_work_us",
    "work_auth.requires_sponsorship",
    "work_auth.open_to_relocate",
    "work_auth.worked_here_before",
    "work_auth.in_person_office_preference",
    "demographics.gender",
    "demographics.ethnicity",
    "demographics.disability_status",
    "demographics.veteran_status",
    "demographics.pronouns",
    "demographics.hispanic_latinx",
    "demographics.transgender_identity",
    "education.school",
    "education.degree",
    "links.linkedin",
    "links.github",
    "links.portfolio",
    "links.website"
  ];

  function cloneDefaultProfile() {
    return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  }

  function getValueByPath(source, path) {
    if (!source || !path) {
      return undefined;
    }

    var keys = path.split(".");
    var current = source;

    for (var i = 0; i < keys.length; i += 1) {
      if (current == null || typeof current !== "object") {
        return undefined;
      }
      current = current[keys[i]];
    }

    return current;
  }

  function setValueByPath(target, path, value) {
    var keys = path.split(".");
    var current = target;

    for (var i = 0; i < keys.length - 1; i += 1) {
      if (!current[keys[i]] || typeof current[keys[i]] !== "object") {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }

    current[keys[keys.length - 1]] = value;
  }

  function normalizeYesNo(value) {
    var normalized = String(value || "").trim().toLowerCase();

    if (normalized === "yes" || normalized === "y" || normalized === "true" || normalized === "1") {
      return "yes";
    }

    if (normalized === "no" || normalized === "n" || normalized === "false" || normalized === "0") {
      return "no";
    }

    return "";
  }

  function normalizeYesNoOrPreferNot(value) {
    var normalized = String(value || "").trim().toLowerCase();
    var yesNo = normalizeYesNo(normalized);
    if (yesNo) {
      return yesNo;
    }

    if (
      normalized === "prefer_not_to_answer" ||
      normalized === "prefer not to answer" ||
      normalized === "prefer_not_to_say" ||
      normalized === "prefer not to say" ||
      normalized === "decline_to_answer" ||
      normalized === "decline to answer"
    ) {
      return "prefer_not_to_answer";
    }

    return "";
  }

  function normalizeProfileField(path, value) {
    var trimmed = String(value == null ? "" : value).trim();

    if (path.indexOf("work_auth.") === 0) {
      return normalizeYesNo(trimmed);
    }

    if (path === "demographics.hispanic_latinx" || path === "demographics.transgender_identity") {
      return normalizeYesNoOrPreferNot(trimmed) || "prefer_not_to_answer";
    }

    if (path === "demographics.pronouns") {
      return trimmed || "prefer_not_to_answer";
    }

    if (path.indexOf("demographics.") === 0) {
      return trimmed || "prefer_not_to_say";
    }

    if (path === "address.country") {
      return trimmed || "United States";
    }

    return trimmed;
  }

  function sanitizeProfile(input) {
    var safe = cloneDefaultProfile();

    for (var i = 0; i < PATHS.length; i += 1) {
      var path = PATHS[i];
      var incoming = getValueByPath(input, path);

      if (incoming !== undefined && incoming !== null) {
        setValueByPath(safe, path, normalizeProfileField(path, incoming));
      }
    }

    if (!safe.address.country) {
      safe.address.country = "United States";
    }

    return safe;
  }

  function flattenProfile(profile) {
    var safe = sanitizeProfile(profile);
    var flat = {};

    for (var i = 0; i < PATHS.length; i += 1) {
      var path = PATHS[i];
      flat[path] = getValueByPath(safe, path);
    }

    return flat;
  }

  global.FormFuseSchema = {
    STORAGE_KEY: STORAGE_KEY,
    PATHS: PATHS.slice(),
    DEFAULT_PROFILE: cloneDefaultProfile(),
    cloneDefaultProfile: cloneDefaultProfile,
    sanitizeProfile: sanitizeProfile,
    flattenProfile: flattenProfile,
    getValueByPath: getValueByPath,
    setValueByPath: setValueByPath
  };
})(typeof window !== "undefined" ? window : globalThis);
