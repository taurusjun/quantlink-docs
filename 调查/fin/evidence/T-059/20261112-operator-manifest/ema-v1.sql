INSERT INTO indicator_operator
  (code, version, schema_json, schema_hash, code_hash, status)
VALUES
  ('EMA', 1, '{"additionalProperties":false,"properties":{"period":{"minimum":1,"type":"integer"}},"required":["period"],"type":"object"}'::jsonb,
   'a82e77bacf4987d0decbcbac6efc3b0e9749d90aab3870be2288dafce23b7900', 'eaf68b93c0631b0c35eb8d037301a82fdbf374184fef98f23cf9ae5935cf6317', 'ACTIVE')
ON CONFLICT (code, version) DO UPDATE SET
  schema_json = EXCLUDED.schema_json,
  schema_hash = EXCLUDED.schema_hash,
  code_hash = EXCLUDED.code_hash,
  updated_at = now();
