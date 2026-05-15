-- M1 seed: 4 jobs covering due/not-yet/broken paths.
-- Times: due ones have next_run in 2020 (definitely past), not-yet in 2099 (future).

INSERT INTO jobs (job_id, version, type, nl_request, resolved_query, resolver_prompt,
                  schedule, sources, status, next_run, created_at) VALUES
  ('job-watch-due', 1, 'watch',
   'Watch for the year 2020',
   'Has the year 2020 happened?',
   NULL, 'daily', NULL, 'active',
   '2020-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('job-digest-due', 1, 'digest',
   'Daily AI news digest',
   'Top AI news in the last 24h',
   NULL, 'daily', NULL, 'active',
   '2020-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('job-digest-future', 1, 'digest',
   'Weekly AI news digest',
   'Top AI news in the last week',
   NULL, 'weekly', NULL, 'active',
   '2099-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  ('job-broken', 1, 'invalid_type',
   'Job with an unknown type to test try/catch',
   'irrelevant',
   NULL, 'daily', NULL, 'active',
   '2020-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
