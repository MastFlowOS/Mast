/**
 * streetClassifier.ts
 *
 * Pure functions for street inventory classification, low-value/route filtering,
 * feature-variant collapsing, and address-vs-street spatial containment verification.
 */

const FEATURE_TOKENS = [
  "pedestrian bridge",
  "pedestrian walkway",
  "access path",
  "access road",
  "access ramp",
  "access",
  "bikeway",
  "bike path",
  "cycleway",
  "footpath",
  "footway",
  "pathway",
  "walkway",
  "steps",
  "bridleway",
  "busway",
  "trail",
  "on ramp",
  "off ramp",
  "ramp",
  "dropoff lane",
  "drop-off lane",
  "bus dropoff",
  "bus drop-off",
  "bus lane",
  "service road",
  "taxiway",
  "runway",
  "concourse",
  "parking",
  "turnpike",
  "interchange",
  "cargo",
  "terminal",
  "hangar",
  "freeway",
  "expressway",
  "tollway",
  "alley",
  "railway",
  "tracks",
  "substation",
  "depot",
  "distribution center",
  "heliport",
  "court",
  "loop",
  "cul-de-sac",
  "dead end",
  "path",
  "crescent",
  "close",
  "mews",
  "riverwalk",
  "bridge",
  "plaza",
  "terrace",
  "pier",
  "slip",
  "wharf",
  "boardwalk",
  "passage",
  "driveway",
  "alleyway",
  "cove",
  "landing",
  "overpass",
  "underpass",
  "skyway",
  "esplanade",
  "promenade",
  "towpath",
  "circle",
  "causeway",
  "overlook",
];

const ROUTE_SUFFIXES = [
  "eb",
  "wb",
  "nb",
  "sb",
  "eastbound",
  "westbound",
  "northbound",
  "southbound",
];

const SUITE_PATTERNS = [
  /#\s*[\w-]+/gi,
  /\b(?:suite|ste|apt|unit|floor|fl|bldg|building|room|rm)\s*[\w#-]+/gi,
];

const LEADING_NUMBER_RE = /^\s*\d+(?:-\d+)?(?:[a-zA-Z])?\s+/;

const STREET_TYPE_ALIASES: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  blvd: "boulevard",
  dr: "drive",
  ct: "court",
  ln: "lane",
  way: "way",
  pl: "place",
  pkwy: "parkway",
};

const DIRECTIONAL_ALIASES: Record<string, string> = {
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

export function isLowValueStreet(name: string): { isLowValue: boolean; reason?: string } {
  if (!name || !name.trim()) return { isLowValue: true, reason: "empty" };
  const lowered = name.normalize("NFKC").trim().toLowerCase();

  // Digits only or digits with commas/spaces/refs (e.g. "315", "379", "315, 379")
  if (/^[\d\s,/-]+$/.test(lowered)) {
    return { isLowValue: true, reason: "number_only" };
  }

  // Alphanumeric gate / concourse / runway codes like 'A', 'A1', 'A10', 'B2' (length <= 4, letter + digits)
  if (/^[a-z]\d{0,3}$/i.test(lowered)) {
    return { isLowValue: true, reason: "gate_or_concourse_code" };
  }

  // Route refs like "35 EB", "I-90 WB", "US-41 NB", "315, 379"
  for (const sfx of ROUTE_SUFFIXES) {
    if (new RegExp(`\\b\\d+\\s*${sfx}\\b`, "i").test(lowered)) {
      return { isLowValue: true, reason: "route_ref" };
    }
    if (new RegExp(`\\b(?:i|us|state route|route|rt|sr|hwy|highway)[\\s-]*\\d+\\s*${sfx}\\b`, "i").test(lowered)) {
      return { isLowValue: true, reason: "route_ref" };
    }
  }

  // Feature tokens: Access Path, Bikeway, Pedestrian Bridge, Ramp, Cycleway, etc.
  for (const token of FEATURE_TOKENS) {
    if (new RegExp(`\\b${token}\\b`, "i").test(lowered)) {
      return { isLowValue: true, reason: `feature_${token.replace(/\s+/g, "_")}` };
    }
  }

  return { isLowValue: false };
}

export function collapseStreetName(name: string): string {
  if (!name || !name.trim()) return "";
  let lowered = name.normalize("NFKC").trim().toLowerCase();

  // Remove feature tokens
  for (const token of FEATURE_TOKENS) {
    lowered = lowered.replace(new RegExp(`\\b${token}\\b`, "gi"), "");
  }

  // Remove directional route tokens (EB, WB, NB, SB, etc.)
  for (const sfx of ROUTE_SUFFIXES) {
    lowered = lowered.replace(new RegExp(`\\b${sfx}\\b`, "gi"), "");
  }

  // Clean whitespace and punctuation
  lowered = lowered.replace(/[^a-z0-9]+/g, " ").trim();
  let tokens = lowered.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";

  // Convert numeric tokens to ordinals if applicable (e.g. '35' -> '35th')
  tokens = tokens.map((t) => {
    if (/^\d+$/.test(t)) {
      const val = parseInt(t, 10);
      if (val >= 1 && val <= 250) {
        let ord = "th";
        const mod100 = val % 100;
        if (mod100 < 11 || mod100 > 13) {
          const mod10 = val % 10;
          if (mod10 === 1) ord = "st";
          else if (mod10 === 2) ord = "nd";
          else if (mod10 === 3) ord = "rd";
        }
        return `${val}${ord}`;
      }
    }
    return t;
  });

  // Normalize directional prefix if present
  if (tokens.length > 0 && DIRECTIONAL_ALIASES[tokens[0]]) {
    tokens[0] = DIRECTIONAL_ALIASES[tokens[0]];
  }

  // Normalize street-type suffix if present
  const lastIdx = tokens.length - 1;
  if (tokens.length > 0 && STREET_TYPE_ALIASES[tokens[lastIdx]]) {
    tokens[lastIdx] = STREET_TYPE_ALIASES[tokens[lastIdx]];
  } else if (tokens.length === 1 && /(?:st|nd|rd|th)$/.test(tokens[0])) {
    tokens.push("street");
  }

  return tokens.join(" ").trim() || name.trim();
}

export function extractStreetPortionFromAddress(address: string): string {
  if (!address || !address.trim()) return "";
  let streetLine = address.split(",", 1)[0].trim();

  // Strip suite, unit, apartment, etc.
  for (const pat of SUITE_PATTERNS) {
    streetLine = streetLine.replace(pat, "").trim();
  }

  // Strip leading building number
  streetLine = streetLine.replace(LEADING_NUMBER_RE, "").trim();

  let lowered = streetLine.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  let tokens = lowered.split(/\s+/).filter(Boolean);

  if (tokens.length > 0 && DIRECTIONAL_ALIASES[tokens[0]]) {
    tokens[0] = DIRECTIONAL_ALIASES[tokens[0]];
  }
  const lastIdx = tokens.length - 1;
  if (tokens.length > 0 && STREET_TYPE_ALIASES[tokens[lastIdx]]) {
    tokens[lastIdx] = STREET_TYPE_ALIASES[tokens[lastIdx]];
  }

  return tokens.join(" ").trim();
}

export function isAddressOnStreet(address: string, street: string): boolean {
  if (!address || !street) return false;

  const addrStreetNorm = extractStreetPortionFromAddress(address);
  const targetNorm = collapseStreetName(street);

  if (!addrStreetNorm || !targetNorm) return false;
  if (addrStreetNorm === targetNorm) return true;

  const targetTokens = targetNorm.split(/\s+/).filter(Boolean);
  const addrTokens = addrStreetNorm.split(/\s+/).filter(Boolean);

  // Core name token (e.g. '35th' or 'state' or 'wacker')
  // Skip directional prefix if present
  let coreIdx = 0;
  if (targetTokens.length > 1 && ["north", "south", "east", "west"].includes(targetTokens[0])) {
    coreIdx = 1;
  }
  const coreTarget = targetTokens[coreIdx] || "";
  if (coreTarget && !addrTokens.includes(coreTarget)) {
    return false;
  }

  // Check street type if target has one
  const streetTypes = ["street", "avenue", "boulevard", "road", "drive", "way", "lane", "court", "place"];
  const targetType = targetTokens[targetTokens.length - 1];
  if (streetTypes.includes(targetType)) {
    const typesInAddr = addrTokens.filter((t) => streetTypes.includes(t));
    if (typesInAddr.length > 0 && !typesInAddr.includes(targetType)) {
      return false;
    }
  }

  return coreTarget ? addrTokens.includes(coreTarget) : false;
}
