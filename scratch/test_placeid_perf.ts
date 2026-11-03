// Test placeId precompilation speedup
const testIds = [
  "ChIJN1t_tDeuEmsRUsoyG83frY4",
  "0x880fcd7f8fee01b5:0x89b38e817d796008",
  "ChIJV4k8_9U1dkgR8Dp7D7q6kio",
  "0x47e66e2964e34e2d:0x8ddf9c43b0803c8",
  "invalid_pid",
  "",
  "   ",
];

const testUrls = [
  "https://maps.google.com/maps/place/?q=place_id:ChIJN1t",
  "https://www.google.co.uk/maps/place/foo",
  "https://maps.app.goo.gl/xyz123",
  "https://example.com/notmaps",
];

// Uncompiled regexes (current)
function oldValidateCardUrl(hostname: string) {
  const isGoogleCom = hostname === "google.com" || hostname.endsWith(".google.com");
  const isGoogleCCTLD = /^(?:(?:www|maps)\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/i.test(hostname);
  const isGooGlShortLink = hostname === "maps.app.goo.gl" || hostname === "goo.gl";
  return isGoogleCom || isGoogleCCTLD || isGooGlShortLink;
}

// Pre-compiled regex
const GOOGLE_CCTLD_RE = /^(?:(?:www|maps)\.)?google\.[a-z]{2,}(?:\.[a-z]{2,})?$/i;
function newValidateCardUrl(hostname: string) {
  const isGoogleCom = hostname === "google.com" || hostname.endsWith(".google.com");
  const isGoogleCCTLD = GOOGLE_CCTLD_RE.test(hostname);
  const isGooGlShortLink = hostname === "maps.app.goo.gl" || hostname === "goo.gl";
  return isGoogleCom || isGoogleCCTLD || isGooGlShortLink;
}

const n = 100_000;
let t0 = performance.now();
for (let i = 0; i < n; i++) {
  oldValidateCardUrl("www.google.co.uk");
}
let t1 = performance.now();
console.log(`Old Card URL: ${(t1 - t0).toFixed(2)}ms`);

t0 = performance.now();
for (let i = 0; i < n; i++) {
  newValidateCardUrl("www.google.co.uk");
}
t1 = performance.now();
console.log(`New Card URL: ${(t1 - t0).toFixed(2)}ms`);
