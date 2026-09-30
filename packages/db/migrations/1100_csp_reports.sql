-- CSP violation reports (PLAN 4.3a, Reporting-Endpoints row; D-015). Every report is attacker-controlled, so only three coarse
-- fields are kept, counted per day: the directive, the blocked resource's origin (or a CSP keyword or scheme name), and the
-- document path without its query or fragment. Never a full URL, a sample, a source file, a referrer, a user agent or an address.
-- No user_id: reports are anonymous and never tied to a person. Rows older than 30 days are deleted by `csp.reports_sweep`.
create table csp_reports (
  day date not null,
  directive text not null check (directive ~ '^[a-z-]{1,40}$'),
  blocked text not null check (length(blocked) between 1 and 120 and blocked !~ '[?#[:space:]]'),
  document_path text not null check (length(document_path) between 1 and 100 and document_path ~ '^/' and document_path !~ '[?#[:space:]]'),
  disposition text not null check (disposition in ('enforce', 'report')),
  count integer not null default 1 check (count > 0),
  primary key (day, directive, blocked, document_path, disposition)
);

-- The request path only adds to a day's count (insert ... on conflict do update needs select on the row it updates).
grant select, insert, update on csp_reports to mh_runtime;
grant select, insert, update, delete on csp_reports to mh_cron;
