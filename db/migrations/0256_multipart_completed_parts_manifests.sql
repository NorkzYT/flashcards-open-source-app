-- Schemas touched/read explicitly: content, pg_catalog.
-- Content-addressed completed-parts manifests for object stores whose ListParts omits part checksums.
--
-- A writer attempt already stores `completed_parts_fingerprint`, the lowercase hex SHA-256 of the
-- canonical UTF-8 JSON `[[partNumber,"eTag","sha256"],...]` ordered by part number. RustFS 1.0.6
-- ListParts returns part numbers and ETags but no part SHA-256, so durable reconciliation cannot
-- rebuild that list from storage. This table keeps the exact JSON whose digest is the fingerprint.
-- Rows are keyed by that digest, so a row can only ever describe the parts its fingerprint commits to:
-- a manifest is accepted only when its bytes hash to the key, and a stored row is never updated.
-- Reading a manifest needs the fingerprint, which only the durable writer attempt holds.

SET LOCAL lock_timeout = '30s';

CREATE TABLE content.media_multipart_completed_parts_manifests (
  completed_parts_fingerprint TEXT PRIMARY KEY
    CHECK (completed_parts_fingerprint ~ '^[0-9a-f]{64}$'),
  part_count INTEGER NOT NULL CHECK (part_count BETWEEN 1 AND 10000),
  manifest TEXT NOT NULL
    CHECK (
      pg_catalog.octet_length(manifest) BETWEEN 2 AND 4000000
      AND manifest ~ '^[ -~]+$'
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT media_multipart_completed_parts_manifests_digest CHECK (
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(manifest, 'UTF8')),
      'hex'
    ) = completed_parts_fingerprint
  )
);

COMMENT ON TABLE content.media_multipart_completed_parts_manifests IS
  'Immutable canonical completed-parts JSON per multipart completion fingerprint; SHA-256(manifest) = key.';

CREATE FUNCTION content.media_multipart_completed_parts_manifest_valid_internal(
  p_part_count INTEGER,
  p_manifest TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  parsed JSONB;
  part JSONB;
  part_index INTEGER;
BEGIN
  IF p_part_count IS NULL
    OR p_part_count < 1
    OR p_part_count > 10000
    OR p_manifest IS NULL
    OR p_manifest !~ '^[ -~]+$'
  THEN
    RETURN false;
  END IF;
  BEGIN
    parsed := p_manifest::JSONB;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;
  IF jsonb_typeof(parsed) IS DISTINCT FROM 'array'
    OR jsonb_array_length(parsed) <> p_part_count
  THEN
    RETURN false;
  END IF;
  FOR part_index IN 0 .. p_part_count - 1 LOOP
    part := parsed -> part_index;
    IF jsonb_typeof(part) IS DISTINCT FROM 'array'
      OR jsonb_array_length(part) <> 3
      OR jsonb_typeof(part -> 0) IS DISTINCT FROM 'number'
      OR (part ->> 0) IS DISTINCT FROM (part_index + 1)::TEXT
      OR jsonb_typeof(part -> 1) IS DISTINCT FROM 'string'
      OR char_length(part ->> 1) NOT BETWEEN 1 AND 256
      OR jsonb_typeof(part -> 2) IS DISTINCT FROM 'string'
      OR (part ->> 2) !~ '^[0-9a-f]{64}$'
    THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION content.reject_media_multipart_completed_parts_manifest_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Multipart completed-parts manifests are immutable.'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER media_multipart_completed_parts_manifests_immutable
  BEFORE UPDATE ON content.media_multipart_completed_parts_manifests
  FOR EACH ROW
  EXECUTE FUNCTION content.reject_media_multipart_completed_parts_manifest_update();

-- Returns 'recorded', 'already_recorded' or 'invalid'. A different manifest can never collide
-- with an existing key, because the digest constraint ties each key to one exact byte string.
CREATE FUNCTION content.record_media_multipart_completed_parts_manifest(
  p_completed_parts_fingerprint TEXT,
  p_part_count INTEGER,
  p_manifest TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  existing content.media_multipart_completed_parts_manifests%ROWTYPE;
BEGIN
  IF p_completed_parts_fingerprint IS NULL
    OR p_completed_parts_fingerprint !~ '^[0-9a-f]{64}$'
    OR content.media_multipart_completed_parts_manifest_valid_internal(
      p_part_count,
      p_manifest
    ) IS DISTINCT FROM true
    OR encode(sha256(convert_to(p_manifest, 'UTF8')), 'hex')
      IS DISTINCT FROM p_completed_parts_fingerprint
  THEN
    RETURN 'invalid';
  END IF;

  INSERT INTO content.media_multipart_completed_parts_manifests (
    completed_parts_fingerprint,
    part_count,
    manifest
  ) VALUES (
    p_completed_parts_fingerprint,
    p_part_count,
    p_manifest
  )
  ON CONFLICT (completed_parts_fingerprint) DO NOTHING;
  IF FOUND THEN
    RETURN 'recorded';
  END IF;

  SELECT manifests.*
  INTO existing
  FROM content.media_multipart_completed_parts_manifests AS manifests
  WHERE manifests.completed_parts_fingerprint = p_completed_parts_fingerprint;
  IF NOT FOUND
    OR existing.part_count IS DISTINCT FROM p_part_count
    OR existing.manifest IS DISTINCT FROM p_manifest
  THEN
    RAISE EXCEPTION 'Multipart completed-parts manifest conflicts with its stored digest.'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN 'already_recorded';
END;
$$;

CREATE FUNCTION content.read_media_multipart_completed_parts_manifest(
  p_completed_parts_fingerprint TEXT
)
RETURNS TABLE (part_count INTEGER, manifest TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT manifests.part_count, manifests.manifest
  FROM content.media_multipart_completed_parts_manifests AS manifests
  WHERE p_completed_parts_fingerprint ~ '^[0-9a-f]{64}$'
    AND manifests.completed_parts_fingerprint = p_completed_parts_fingerprint;
$$;

REVOKE ALL ON TABLE content.media_multipart_completed_parts_manifests
  FROM PUBLIC, backend_app, auth_app, reporting_readonly;
REVOKE ALL ON FUNCTION
  content.media_multipart_completed_parts_manifest_valid_internal(INTEGER, TEXT)
  FROM PUBLIC, backend_app, auth_app, reporting_readonly;
REVOKE ALL ON FUNCTION
  content.reject_media_multipart_completed_parts_manifest_update()
  FROM PUBLIC, backend_app, auth_app, reporting_readonly;
REVOKE ALL ON FUNCTION
  content.record_media_multipart_completed_parts_manifest(TEXT, INTEGER, TEXT)
  FROM PUBLIC, backend_app, auth_app, reporting_readonly;
REVOKE ALL ON FUNCTION
  content.read_media_multipart_completed_parts_manifest(TEXT)
  FROM PUBLIC, backend_app, auth_app, reporting_readonly;

GRANT EXECUTE ON FUNCTION
  content.record_media_multipart_completed_parts_manifest(TEXT, INTEGER, TEXT)
  TO backend_app;
GRANT EXECUTE ON FUNCTION
  content.read_media_multipart_completed_parts_manifest(TEXT)
  TO backend_app;
