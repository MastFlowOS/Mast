// Precomputed Natural Earth 110m Country Discovery Data
// 14 Focus Countries: ISO-3166-1 alpha-3, exact land point membership, and sequential opportunity points

export type OpportunityPoint = {
  lat: number;
  lon: number;
  delayMs: number;
};

export type FocusCountry = {
  iso: string;
  name: string;
  lat: number;
  lon: number;
  zoom: number;
  opportunityPoints: OpportunityPoint[];
};

export const FOCUS_COUNTRIES: FocusCountry[] = [
  {
    "iso": "USA",
    "name": "United States",
    "lat": 38.5,
    "lon": -97,
    "zoom": 1.08,
    "opportunityPoints": [
      {
        "lat": 37.74,
        "lon": -95.94,
        "delayMs": 0
      },
      {
        "lat": 45.87,
        "lon": -67.95,
        "delayMs": 316
      },
      {
        "lat": 46.75,
        "lon": -123.4,
        "delayMs": 720
      },
      {
        "lat": 26.82,
        "lon": -81.57,
        "delayMs": 975
      },
      {
        "lat": 33.03,
        "lon": -115.57,
        "delayMs": 1395
      },
      {
        "lat": 48.86,
        "lon": -104.46,
        "delayMs": 1685
      },
      {
        "lat": 47.34,
        "lon": -86.2,
        "delayMs": 2031
      },
      {
        "lat": 26.27,
        "lon": -98.7,
        "delayMs": 2411
      },
      {
        "lat": 38.37,
        "lon": -78.8,
        "delayMs": 2676
      },
      {
        "lat": 41.46,
        "lon": -110.57,
        "delayMs": 3103
      },
      {
        "lat": 31.57,
        "lon": -89.66,
        "delayMs": 3371
      },
      {
        "lat": 32.09,
        "lon": -104.98,
        "delayMs": 3746
      },
      {
        "lat": 39.32,
        "lon": -121.86,
        "delayMs": 4098
      },
      {
        "lat": 40.59,
        "lon": -87.59,
        "delayMs": 4383
      }
    ]
  },
  {
    "iso": "BRA",
    "name": "Brazil",
    "lat": -14.2,
    "lon": -51.9,
    "zoom": 1.1,
    "opportunityPoints": [
      {
        "lat": -14.82,
        "lon": -51.38,
        "delayMs": 0
      },
      {
        "lat": 1.5,
        "lon": -68.42,
        "delayMs": 316
      },
      {
        "lat": -6.32,
        "lon": -35.1,
        "delayMs": 720
      },
      {
        "lat": 1.99,
        "lon": -51.28,
        "delayMs": 975
      },
      {
        "lat": -31.33,
        "lon": -52.6,
        "delayMs": 1395
      },
      {
        "lat": -10.93,
        "lon": -64.21,
        "delayMs": 1685
      },
      {
        "lat": -19.76,
        "lon": -40.36,
        "delayMs": 2031
      },
      {
        "lat": -7.03,
        "lon": -44.57,
        "delayMs": 2411
      },
      {
        "lat": -6.24,
        "lon": -55.16,
        "delayMs": 2676
      },
      {
        "lat": -6.73,
        "lon": -72.3,
        "delayMs": 3103
      },
      {
        "lat": 3.71,
        "lon": -60.06,
        "delayMs": 3371
      }
    ]
  },
  {
    "iso": "AUS",
    "name": "Australia",
    "lat": -25.3,
    "lon": 134.5,
    "zoom": 1.1,
    "opportunityPoints": [
      {
        "lat": -26.24,
        "lon": 134.08,
        "delayMs": 0
      },
      {
        "lat": -41.42,
        "lon": 145.95,
        "delayMs": 316
      },
      {
        "lat": -26.15,
        "lon": 114.01,
        "delayMs": 720
      },
      {
        "lat": -25.7,
        "lon": 151.21,
        "delayMs": 975
      },
      {
        "lat": -12.95,
        "lon": 142.27,
        "delayMs": 1395
      },
      {
        "lat": -15.96,
        "lon": 124.44,
        "delayMs": 1685
      },
      {
        "lat": -32.63,
        "lon": 123.22,
        "delayMs": 2031
      },
      {
        "lat": -32.73,
        "lon": 143.28,
        "delayMs": 2411
      },
      {
        "lat": -17.76,
        "lon": 133.22,
        "delayMs": 2676
      }
    ]
  },
  {
    "iso": "EGY",
    "name": "Egypt",
    "lat": 26.5,
    "lon": 30,
    "zoom": 1.16,
    "opportunityPoints": [
      {
        "lat": 26.51,
        "lon": 31.14,
        "delayMs": 0
      },
      {
        "lat": 30.58,
        "lon": 25.98,
        "delayMs": 316
      },
      {
        "lat": 23.44,
        "lon": 25.71,
        "delayMs": 720
      },
      {
        "lat": 30.32,
        "lon": 33.64,
        "delayMs": 975
      },
      {
        "lat": 22.2,
        "lon": 31.57,
        "delayMs": 1395
      },
      {
        "lat": 24.21,
        "lon": 35.19,
        "delayMs": 1685
      }
    ]
  },
  {
    "iso": "FRA",
    "name": "France",
    "lat": 46.5,
    "lon": 2.5,
    "zoom": 1.16,
    "opportunityPoints": [
      {
        "lat": 46.53,
        "lon": 1.71,
        "delayMs": 0
      },
      {
        "lat": 48.23,
        "lon": -4.15,
        "delayMs": 316
      },
      {
        "lat": 43.6,
        "lon": 5.75,
        "delayMs": 720
      },
      {
        "lat": 50.19,
        "lon": 2.4,
        "delayMs": 975
      },
      {
        "lat": 43.11,
        "lon": 1.02,
        "delayMs": 1395
      },
      {
        "lat": 47.05,
        "lon": 6.44,
        "delayMs": 1685
      },
      {
        "lat": 47.37,
        "lon": -1.22,
        "delayMs": 2031
      },
      {
        "lat": 49.3,
        "lon": 5.33,
        "delayMs": 2411
      }
    ]
  },
  {
    "iso": "DEU",
    "name": "Germany",
    "lat": 51.2,
    "lon": 10.4,
    "zoom": 1.16,
    "opportunityPoints": [
      {
        "lat": 51.31,
        "lon": 11.87,
        "delayMs": 0
      },
      {
        "lat": 47.57,
        "lon": 11.18,
        "delayMs": 316
      },
      {
        "lat": 50.75,
        "lon": 7.14,
        "delayMs": 720
      },
      {
        "lat": 53.78,
        "lon": 10.75,
        "delayMs": 975
      },
      {
        "lat": 48.43,
        "lon": 8.25,
        "delayMs": 1395
      },
      {
        "lat": 52.82,
        "lon": 13.68,
        "delayMs": 1685
      },
      {
        "lat": 52.23,
        "lon": 8.94,
        "delayMs": 2031
      },
      {
        "lat": 49.85,
        "lon": 10.06,
        "delayMs": 2411
      },
      {
        "lat": 48.97,
        "lon": 12.99,
        "delayMs": 2676
      }
    ]
  },
  {
    "iso": "RUS",
    "name": "Russia",
    "lat": 58,
    "lon": 80,
    "zoom": 1.07,
    "opportunityPoints": [
      {
        "lat": 57.23,
        "lon": 79.29,
        "delayMs": 0
      },
      {
        "lat": 66.14,
        "lon": -171.35,
        "delayMs": 316
      },
      {
        "lat": 44.69,
        "lon": 132.67,
        "delayMs": 720
      },
      {
        "lat": 44.97,
        "lon": 40.02,
        "delayMs": 975
      },
      {
        "lat": 68.81,
        "lon": 32.89,
        "delayMs": 1395
      },
      {
        "lat": 68.26,
        "lon": 125.54,
        "delayMs": 1685
      },
      {
        "lat": 54.97,
        "lon": 157.73,
        "delayMs": 2031
      },
      {
        "lat": 50.09,
        "lon": 107.45,
        "delayMs": 2411
      },
      {
        "lat": 72.14,
        "lon": 79.56,
        "delayMs": 2676
      },
      {
        "lat": 57.8,
        "lon": 51.57,
        "delayMs": 3103
      },
      {
        "lat": 56.25,
        "lon": 29.7,
        "delayMs": 3371
      },
      {
        "lat": 68.41,
        "lon": 158,
        "delayMs": 3746
      },
      {
        "lat": 56.53,
        "lon": 127.08,
        "delayMs": 4098
      },
      {
        "lat": 61.86,
        "lon": 100.05,
        "delayMs": 4383
      },
      {
        "lat": 50.78,
        "lon": 92.12,
        "delayMs": 4805
      }
    ]
  },
  {
    "iso": "CAN",
    "name": "Canada",
    "lat": 56,
    "lon": -100,
    "zoom": 1.08,
    "opportunityPoints": [
      {
        "lat": 55.87,
        "lon": -100.15,
        "delayMs": 0
      },
      {
        "lat": 47.42,
        "lon": -53.74,
        "delayMs": 316
      },
      {
        "lat": 76.77,
        "lon": -83.87,
        "delayMs": 720
      },
      {
        "lat": 64.06,
        "lon": -140.7,
        "delayMs": 975
      },
      {
        "lat": 42.3,
        "lon": -81.04,
        "delayMs": 1395
      },
      {
        "lat": 48.98,
        "lon": -124.52,
        "delayMs": 1685
      },
      {
        "lat": 59.87,
        "lon": -71.73,
        "delayMs": 2031
      },
      {
        "lat": 66.95,
        "lon": -114.09,
        "delayMs": 2411
      },
      {
        "lat": 52.56,
        "lon": -83.7,
        "delayMs": 2676
      },
      {
        "lat": 57.72,
        "lon": -118.4,
        "delayMs": 3103
      },
      {
        "lat": 65.33,
        "lon": -91.1,
        "delayMs": 3371
      },
      {
        "lat": 50.37,
        "lon": -70.19,
        "delayMs": 3746
      }
    ]
  },
  {
    "iso": "ZAF",
    "name": "South Africa",
    "lat": -29,
    "lon": 24.5,
    "zoom": 1.15,
    "opportunityPoints": [
      {
        "lat": -29.31,
        "lon": 23.6,
        "delayMs": 0
      },
      {
        "lat": -23.5,
        "lon": 29.72,
        "delayMs": 316
      },
      {
        "lat": -34.36,
        "lon": 19.29,
        "delayMs": 720
      },
      {
        "lat": -30.64,
        "lon": 29.46,
        "delayMs": 975
      },
      {
        "lat": -29.72,
        "lon": 18.87,
        "delayMs": 1395
      },
      {
        "lat": -25.53,
        "lon": 26.1,
        "delayMs": 1685
      },
      {
        "lat": -32.82,
        "lon": 25.84,
        "delayMs": 2031
      }
    ]
  },
  {
    "iso": "ARG",
    "name": "Argentina",
    "lat": -35,
    "lon": -65,
    "zoom": 1.12,
    "opportunityPoints": [
      {
        "lat": -34.38,
        "lon": -65.69,
        "delayMs": 0
      },
      {
        "lat": -50.94,
        "lon": -69.15,
        "delayMs": 316
      },
      {
        "lat": -22.66,
        "lon": -65.85,
        "delayMs": 720
      },
      {
        "lat": -28.93,
        "lon": -56.65,
        "delayMs": 975
      },
      {
        "lat": -40.97,
        "lon": -71.81,
        "delayMs": 1395
      },
      {
        "lat": -36.49,
        "lon": -56.91,
        "delayMs": 1685
      },
      {
        "lat": -29.09,
        "lon": -69.04,
        "delayMs": 2031
      },
      {
        "lat": -40.03,
        "lon": -62.34,
        "delayMs": 2411
      }
    ]
  },
  {
    "iso": "CHN",
    "name": "China",
    "lat": 35,
    "lon": 104,
    "zoom": 1.08,
    "opportunityPoints": [
      {
        "lat": 35.55,
        "lon": 102.87,
        "delayMs": 0
      },
      {
        "lat": 46.84,
        "lon": 131.55,
        "delayMs": 316
      },
      {
        "lat": 38.98,
        "lon": 75.84,
        "delayMs": 720
      },
      {
        "lat": 18.26,
        "lon": 109.32,
        "delayMs": 975
      },
      {
        "lat": 29.68,
        "lon": 121.55,
        "delayMs": 1395
      },
      {
        "lat": 28.56,
        "lon": 87.28,
        "delayMs": 1685
      },
      {
        "lat": 47.93,
        "lon": 88.5,
        "delayMs": 2031
      },
      {
        "lat": 44.81,
        "lon": 112.61,
        "delayMs": 2411
      },
      {
        "lat": 24.33,
        "lon": 100.11,
        "delayMs": 2676
      },
      {
        "lat": 38.42,
        "lon": 91.16,
        "delayMs": 3103
      },
      {
        "lat": 27.82,
        "lon": 110.27,
        "delayMs": 3371
      },
      {
        "lat": 40.43,
        "lon": 122.51,
        "delayMs": 3746
      },
      {
        "lat": 53.3,
        "lon": 123.46,
        "delayMs": 4098
      }
    ]
  },
  {
    "iso": "JPN",
    "name": "Japan",
    "lat": 36.5,
    "lon": 138,
    "zoom": 1.18,
    "opportunityPoints": [
      {
        "lat": 36.76,
        "lon": 137.14,
        "delayMs": 0
      },
      {
        "lat": 43.58,
        "lon": 143.26,
        "delayMs": 316
      },
      {
        "lat": 34.48,
        "lon": 133.53,
        "delayMs": 720
      },
      {
        "lat": 39.11,
        "lon": 140.76,
        "delayMs": 975
      },
      {
        "lat": 36.05,
        "lon": 140.07,
        "delayMs": 1395
      },
      {
        "lat": 34.91,
        "lon": 138.26,
        "delayMs": 1685
      }
    ]
  },
  {
    "iso": "NGA",
    "name": "Nigeria",
    "lat": 9.5,
    "lon": 8,
    "zoom": 1.16,
    "opportunityPoints": [
      {
        "lat": 9.64,
        "lon": 8.05,
        "delayMs": 0
      },
      {
        "lat": 12.47,
        "lon": 13.48,
        "delayMs": 316
      },
      {
        "lat": 4.74,
        "lon": 6.67,
        "delayMs": 720
      },
      {
        "lat": 9.28,
        "lon": 3.32,
        "delayMs": 975
      },
      {
        "lat": 12.69,
        "lon": 5.82,
        "delayMs": 1395
      },
      {
        "lat": 9.05,
        "lon": 10.98,
        "delayMs": 1685
      },
      {
        "lat": 13.06,
        "lon": 10.55,
        "delayMs": 2031
      },
      {
        "lat": 7.18,
        "lon": 7.36,
        "delayMs": 2411
      }
    ]
  },
  {
    "iso": "NZL",
    "name": "New Zealand",
    "lat": -41.5,
    "lon": 173,
    "zoom": 1.18,
    "opportunityPoints": [
      {
        "lat": -41.83,
        "lon": 173.67,
        "delayMs": 0
      },
      {
        "lat": -45.68,
        "lon": 168.25,
        "delayMs": 316
      },
      {
        "lat": -40.59,
        "lon": 175.48,
        "delayMs": 720
      },
      {
        "lat": -44.37,
        "lon": 170.06,
        "delayMs": 975
      },
      {
        "lat": -43.08,
        "lon": 171.86,
        "delayMs": 1395
      }
    ]
  }
];

// Packed Int8 country membership: (cIdx + 1) per dot, where 0 = none, 1..14 = country index + 1
const PACKED_COUNTRY_DATA = "AAAACAAHAAAHBwAHCAAIAAcABwcABwgABwAHCAAHAAcIBwgABwcIAAcIBwAHCAcABwcIBwAHCAcHCAcABwcIAQcIAAcHAAcHBwEHBwAHBwAHCAAHBwEHCAAHCAcIBwEHBwcHCAcIBwAHCAAHBwEHCAcABwgHCAcBBwAHBwEHCAAHCAAHCAcBBwgHBwAHCAcIBwcIAAcHAQcIBwAHCAcHAQcIBwcHCAcIBwcHCAAHBwEHCAcABwgHBwEHCAAHBwEHCAcHBwgABwgHAQAHCAcHAAcIBwgHBwgHBwEHCAcABwgHBwEHCAAHBwgHBwcIAAcIBwEHCAcHAAcIBwcHCAAHBwEHCAcHCAAHBwEHCAcHBwgHBwcIBwcBBwgHAAcIAAcIBwEHCAAHBwEHBwcIAAcHAQcIBwcHCAcHBwgABwcBBwgHBwgABwgHAQcIBwcHCAcHBwgHBwgHBwgABwcBBwgHBwEHBwcIAAcIBwEHCAcHCAcHBwgIBwcIBwcIAAgHAQcIBwcHBwcIAAgHAQcIBwcBBwcHCAcHBwgHBwgACAcHCAcHBwcHCAgHBwgHBwgHBwgABwAHCAcHCAAIBwcIBwcHBwgABwgHBwgHBwgACAcHCAcHBwgHBwgIBwcIBwcHBwgABwcIBwcICAcHCAcHCAcHCAcIBwcIBwcICAcHCAAHBwgHBwgIAAcIBwcHBwgACAAABwgHBwgGCAAHCAAHAAcIBwcIAAgACwgHBwAHBwgACAcABwgHBwgGCAAHCAcHAAcIBwcIAAgABwgHBwYIAAcIAAgHAAcIBwcIAAgACwgHBwAIBwcIAAgABwgHBwgGCAAHCAAHAAcIAAcIAAgACwgHBwYIBwcIAAAHCAcACAAIAAsIAAcFBwgABwgAAAsIBwAGCAAACAAABwgAAAgAAAsIAAAFBwgABwgAAAcIBwAIBggACwEAAAUHCAAAAQAACwEHAAYIAAABAAgABQcIAAABAAALAQALBQgAAAEAAAsBBwAGCAAAAQAIAAUHAQAAAQAIAAsBAAUIAAABAAALAQcAAQAIAAsBAAsFCAAAAQAIAAsBBwAACAAAAQAABwEAAAEAAQALAQsFCAAAAQAACwEHAAAIAAsBCwUBAAABAAALAQcLAAgACwEACwcBAAABAAEACwELBQgAAAEAAAsBBwAAAQALAQsBAAABAAALAQsFDAgAAAEAAAALAQcAAQABAAsBCwUBAAABAAALAQALAQALAQsAAQALAQALAQsIAAsBAAAAAAEACwEACwELAAEACwEACwELAQALAQALAAEACwEAAAsBAAsBAAsBAAAAAQALAQALAQALAAEACwEAAAsBAAsBAAsBCwABAAsACwEACwEACwEAAAABAAsBAAsBAAsAAQALAQABAAsMAQALAQsAAQALAAsBAAsAAQALAQABAAsBAAsBCwABAAsAAQALAQALAQAAAAEACwALAQALAAEACwEACwEACwEACwELAAEACwALAQALDAEACwEAAQALAAEACwELAAEACwALAQsADAEACwEAAAEACwAACwELAQALAQABAAsAAQALAQAAAQALAAsBAAsADAEACwEAAQALAAALAQsADAEACwABAAsAAQALAQABAAsACwELAAEACwABAAsAAAsBCwABAAsACwELAAEACwEAAQALAAALAQsAAQALAAEACwAACwEAAAEACwAACwELAAEACwAAAQALAAALAQsAAQALAAALAQALAAEACwAAAAEACwAACwAECwABAAsAAQALAAALAAQAAAEACwAACwEECwABAAsAAAEACwAACwAEAAALAAALAQALAAALAAAAAAsAAAsABAsAAAsAAAEACwAACwAEAAAACwAACwALAAALAAAAAAAAAAsABAAACwAAAQAAAAALBAAAAAAAAAsABAAAAAsAAAAAAAAACwAEAAAACwAAAAAAAQsAAAAAAAAACwAEAAALAAAAAQAAAAALBAAAAAsAAAsABAAACwAAAAAAAAALAAQAAAALAAAAAAALAAAAAAAACwAEAAALAAAAAAAACwQAAAALAAAABAAAAAsAAAAAAAALBAAAAAsAAAAAAAAACwQAAAAAAAAEAAAACwAAAAAAAAsEAAAACwAAAAAAAAALAAAAAAAABAAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0AAAAAAAAADQAAAAANAAAAAAAAAA0AAAAAAA0AAAAADQAAAAAAAAAADQAAAAAAAAAAAAAAAA0AAAAAAAAADQAAAAANAAAAAAAAAAAAAA0AAAAAAAANAAAAAA0AAAAAAAANAAAAAAAAAAAAAAAADQAAAAAAAAANAAAAAAAAAAAAAAAAAA0AAAAAAAAAAAAAAAAAAAAAAAAAAAANAAAAAAAAAAAAAAANAAAAAAAAAAAAAAAAAAAAAAAABQAAAA0AAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAABQAAAAAAAAAAAAACAAAAAAAFAAAAAAAAAAAAAAIAAgAAAAACAAACAAAAAgAAAAAAAgAAAAAAAAACAAAAAAACAAAAAAACAAACAAAAAAIAAAACAAIAAAAAAgAAAAIAAgACAAAAAAIAAAIAAgAAAAIAAAACAAIAAAACAAACAAIAAAIAAAACAAAAAgACAAAAAgAAAAACAAACAgAAAAIAAAACAAIAAAACAgAAAAIAAAICAAACAAIAAgAAAAICAAACAAICAAAAAgIAAgACAAAAAgIAAAACAgACAAIAAAACAgACAAIAAgIAAAACAgACAAIAAAACAgAAAgACAAIAAAAAAgIAAgAAAgACAAIAAAACAgACAAIAAAICAgACAAIAAgAAAgIAAgAAAgACAgAAAgAAAAIAAgIAAAIAAgIAAAIAAAACAAICAAACAAAAAgACAgAAAAIAAgIAAAIDAAAAAAIDAAICAAACAAAAAgACAwAAAAIAAAIAAAIDAAAAAgMAAgMCAAAAAgAAAwIAAgMAAAAAAgMAAAMCAAACAwAAAwACAwACAwAAAAACAAADAAIAAgMAAAMAAgMAAAMAAgAAAgMAAAMAAgMAAgMAAAAAAgMAAAMCAAIDAAADAgMAAAMAAAACAwAAAwIDAAIDAAADAgMAAAMAAgACAwAAAwIDAAIDAAAAAwIDAAADAgMAAgMAAAMCAwAAAwADAAIDAAADAgMAAAIDAAADAgMAAAMAAwMAAgMACgMCAwAAAwAAAwACAwAKAwMDCQIDAAADAgMAAAMAAwMAAgMACgMDCQADAAADAgMACgMDAwkCAwAKAwMJCgMDAwIDAAoDAwMJAAMACgMDCQoDAwMAAgMACgMDCQADAwADAgMJCgMDAwkCAwAKAwMJCgMDAwIDCQoDAwAKAwMKAwMJCgMDAwIDCQoDAwkKAwMAAwIDCQoDAwkCAwoDAwkKAwMDAgMJCgMDCQADAwoDAwkKAwADCQoDAwkKAwADAwkKAwAKAwMKAwMJCgMAAwoDCgMKAAoDCgoDCgMKAwoACgMKCgAKCgoKDgoDCg4ACgoOCgAOCgAOCgoACgAACgoAAAAA";

function unpackCountryData(): Int8Array {
  if (typeof atob === "undefined") {
    return new Int8Array(0);
  }
  const cBin = atob(PACKED_COUNTRY_DATA);
  const len = cBin.length;
  const countryIds = new Int8Array(len);

  for (let i = 0; i < len; i++) {
    const rawVal = cBin.charCodeAt(i);
    countryIds[i] = rawVal === 0 ? -1 : (rawVal - 1);
  }
  return countryIds;
}

export const DOT_COUNTRY_IDS: Int8Array = unpackCountryData();
