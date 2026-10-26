-- PROPOSAL ONLY: Do NOT apply to production database.
-- Proposed schema expansion for street geometry, center coordinates, and bounding box.
--
-- Background:
-- Currently, `discovery_streets` stores only text columns (`street_key`, `street_name`, `normalized_name`, etc.).
-- Overpass query (`overpass_source.py`) uses `out tags;`, omitting `center` and `geom`.
-- Adding `center_lat`, `center_lng`, and `bbox` enables Maps queries to pin coordinates
-- (e.g. `/@lat,lng,17z`), vastly improving spatial accuracy.

ALTER TABLE discovery_streets
  ADD COLUMN IF NOT EXISTS center_lat numeric(9, 6) NULL,
  ADD COLUMN IF NOT EXISTS center_lng numeric(9, 6) NULL,
  ADD COLUMN IF NOT EXISTS bbox jsonb NULL;

COMMENT ON COLUMN discovery_streets.center_lat IS 'Representative centroid latitude of street for localized Maps viewport';
COMMENT ON COLUMN discovery_streets.center_lng IS 'Representative centroid longitude of street for localized Maps viewport';
COMMENT ON COLUMN discovery_streets.bbox IS 'Bounding box [min_lat, min_lng, max_lat, max_lng] or GeoJSON geometry';
