-- Aggregate homepage loads only: no individual events, URLs, users or visitor identifiers.
create table pageview_counts (
 day date not null,
 page text not null check (page = 'home'),
 count bigint not null default 1 check (count > 0),
 primary key (day,page)
);
grant select,insert,update on pageview_counts to mh_runtime;
grant select on pageview_counts to mh_cron;
