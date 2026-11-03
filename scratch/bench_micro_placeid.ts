import { validateCoordinationPlaceId, expandPlaceIdForms, canonicalPlaceId } from "../src/lib/placeId.js";
import { validateGoogleMapsCardUrl } from "../src/discovery/candidateReceiptStore.js";

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

const iterations = 50_000;

console.log(`Starting micro-benchmark (${iterations} iterations)...`);

const t0 = performance.now();
for (let i = 0; i < iterations; i++) {
  const id = testIds[i % testIds.length];
  validateCoordinationPlaceId(id);
  expandPlaceIdForms(id);
  canonicalPlaceId(id);
}
const t1 = performance.now();
const placeIdDuration = t1 - t0;
console.log(`placeId operations: ${placeIdDuration.toFixed(2)}ms (${(placeIdDuration / iterations * 1000).toFixed(2)}µs/op)`);

const t2 = performance.now();
for (let i = 0; i < iterations; i++) {
  const url = testUrls[i % testUrls.length];
  validateGoogleMapsCardUrl(url);
}
const t3 = performance.now();
const cardUrlDuration = t3 - t2;
console.log(`cardUrl operations: ${cardUrlDuration.toFixed(2)}ms (${(cardUrlDuration / iterations * 1000).toFixed(2)}µs/op)`);
