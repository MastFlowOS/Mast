import { isLowValueStreet } from "../src/discovery/streetClassifier.js";

const samples = [
  "Turtle Springs Court",
  "Dock D",
  "Alley 80576",
  "Nicolosi Loop",
  "Extrusion Plaza",
  "South Peoria Cul de Sac",
  "O'Hare Commercial Arrivals Terminal 1",
  "Beach Patrol Road",
  "Kennedy Express Reversible Lane"
];

for (const s of samples) {
  console.log(`${s} ->`, isLowValueStreet(s));
}
