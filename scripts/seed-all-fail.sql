-- All jobs fail: two due jobs with invalid types. Both throw in runJob's
-- "unknown job type" branch. Tests SPEC failure-table row "All jobs fail":
-- run row written, no crash.

INSERT INTO jobs (job_id, version, type, nl_request, resolved_query, resolver_prompt,
                  schedule, sources, status, next_run, created_at) VALUES
  ('all-fail-1', 1, 'invalid_type_a',
   'broken a', 'irrelevant', NULL, 'daily', NULL, 'active',
   '2020-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('all-fail-2', 1, 'invalid_type_b',
   'broken b', 'irrelevant', NULL, 'daily', NULL, 'active',
   '2020-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
