-- Ready-made queries for the article. Run in Supabase -> SQL Editor (as the
-- project owner; the public key cannot read anything). Export any result as CSV
-- from the editor. Question texts are in data/questions.json (field `id` there is
-- the Brut322-style id that the app sends as `qid`).

-- 1. Overview: people, answers, mock exams, reported results.
select
  (select count(distinct uid) from answers)                       as learners,
  (select count(*) from answers)                                  as answers,
  (select count(*) from exams)                                    as mock_exams,
  (select count(*) from outcomes where result <> 'not_yet')       as real_exam_reports;

-- 2. Hardest questions: first-try error rate (the first time each person saw it),
--    with at least 20 people so the rate means something.
with first_try as (
  select distinct on (uid, qid) uid, qid, correct, rt_ms
  from answers
  order by uid, qid, created_at
)
select qid,
       count(*)                                        as people,
       round(100.0 * avg((not correct)::int), 1)       as first_try_error_pct,
       percentile_cont(0.5) within group (order by rt_ms) / 1000.0 as median_seconds
from first_try
group by qid
having count(*) >= 20
order by first_try_error_pct desc
limit 50;

-- 3. Most common wrong option per question: which distractor fools people.
select qid, chosen + 1 as option_no, count(*) as times_chosen
from answers
where not correct
group by qid, chosen
order by times_chosen desc
limit 50;

-- 4. Answer time vs correctness: do fast answers go wrong more often?
select width_bucket(rt_ms, 0, 60000, 12) * 5 as up_to_seconds,
       count(*) as answers,
       round(100.0 * avg(correct::int), 1) as correct_pct
from answers
where rt_ms is not null and mode = 'study'
group by 1
order by 1;

-- 5. Forgetting curve: correctness of reviews by days since the last review.
select round(elapsed_days)::int as days_since_last,
       count(*) as reviews,
       round(100.0 * avg(correct::int), 1) as recalled_pct
from answers
where mode = 'study' and state = 2 and elapsed_days is not null
group by 1
having count(*) >= 30
order by 1;

-- 6. Mock exam scores by day of preparation.
select day_n,
       count(*) as exams,
       round(avg(total - errors), 2) as avg_correct_of_20,
       round(100.0 * avg(passed::int), 1) as pass_pct
from exams
group by day_n
order by day_n;

-- 7. Study habits of people who passed the real exam first time vs the rest.
with o as (
  select distinct on (uid) uid, result
  from outcomes
  where result <> 'not_yet'
  order by uid, created_at desc
),
habits as (
  select uid,
         count(*) filter (where mode = 'study')                 as reviews,
         count(distinct day_n)                                  as active_days,
         max(day_n)                                             as span_days,
         percentile_cont(0.5) within group (order by rt_ms)     as median_rt_ms,
         mode() within group (order by preset)                  as preset
  from answers
  group by uid
),
mocks as (
  select uid, count(*) as mock_exams, avg(errors) as avg_mock_errors
  from exams group by uid
)
select o.result,
       count(*)                                  as people,
       round(avg(h.reviews))                     as avg_reviews,
       round(avg(h.active_days), 1)              as avg_active_days,
       round(avg(h.span_days), 1)                as avg_span_days,
       round(avg(m.mock_exams), 1)               as avg_mock_exams,
       round(avg(m.avg_mock_errors)::numeric, 2) as avg_mock_errors
from o
join habits h using (uid)
left join mocks m using (uid)
group by o.result
order by o.result;

-- 8. Does the "5 mock exams in a row with <=1 error" rule predict passing?
with last5 as (
  select uid, errors,
         row_number() over (partition by uid order by created_at desc) as rn
  from exams
),
ready as (
  select uid, count(*) = 5 and max(errors) <= 1 as was_ready
  from last5 where rn <= 5 group by uid
),
o as (
  select distinct on (uid) uid, result
  from outcomes where result <> 'not_yet'
  order by uid, created_at desc
)
select r.was_ready, o.result, count(*) as people
from o join ready r using (uid)
group by 1, 2
order by 1, 2;

-- 9. When people study: answers by local hour and device.
select local_hour, device, count(*) as answers,
       round(100.0 * avg(correct::int), 1) as correct_pct
from answers
group by 1, 2
order by 1, 2;

-- 10. Retention: how many learners are still active N days after starting.
select day_n, count(distinct uid) as active_learners
from answers
group by day_n
order by day_n;

-- ===== Sessions, returns, sources (v1.2, table pings) =====

-- 11. Session length: visible minutes per session (median and quartiles), by device.
with s as (
  select sid, max(active_s) as active_s, max(answers) as answers,
         (array_agg(device order by seq))[1] as device
  from pings group by sid
)
select device, count(*) as sessions,
       round((percentile_cont(0.25) within group (order by active_s) / 60)::numeric, 1) as p25_min,
       round((percentile_cont(0.5)  within group (order by active_s) / 60)::numeric, 1) as median_min,
       round((percentile_cont(0.75) within group (order by active_s) / 60)::numeric, 1) as p75_min,
       round(100.0 * avg((answers = 0)::int), 1) as no_answer_pct
from s group by device order by sessions desc;

-- 12. Bounce: first sessions that ended without a single answer, and how fast.
with first_s as (
  select distinct on (uid) uid, sid from pings where kind = 'start' and first_visit order by uid, created_at
),
s as (select sid, max(active_s) active_s, max(answers) answers from pings group by sid)
select count(*) as first_sessions,
       round(100.0 * avg((s.answers = 0)::int), 1) as left_without_answer_pct,
       percentile_cont(0.5) within group (order by s.active_s) filter (where s.answers = 0) as median_seconds_before_leaving
from first_s join s using (sid);

-- 13. Returns: share of people active again N days after their first day.
with d as (select uid, day_n from pings group by uid, day_n),
c as (select count(distinct uid) n from d where day_n = 0)
select day_n, count(distinct uid) as people,
       round(100.0 * count(distinct uid) / nullif((select n from c), 0), 1) as pct_of_day0
from d where day_n <= 21 group by day_n order by day_n;

-- 14. Sessions per person and active days per person.
select count(distinct sid)::float / nullif(count(distinct uid), 0) as sessions_per_person,
       (select avg(n) from (select uid, count(distinct day_n) n from pings group by uid) x) as active_days_per_person
from pings;

-- 15. Where people leave: screen and question on the last ping of each session.
with last as (
  select distinct on (sid) sid, screen, qid from pings order by sid, seq desc
)
select screen, qid, count(*) as sessions_ended_here
from last group by screen, qid order by sessions_ended_here desc limit 30;

-- 16. Sources: people per tag/referrer and how far they got.
with first_start as (
  select distinct on (uid) uid, coalesce(first_src, src, 'direct') as tag, ref
  from pings where kind = 'start' order by uid, created_at
),
work as (select uid, count(*) filter (where mode = 'study') reviews from answers group by uid),
mock as (select uid, count(*) filter (where not abandoned) mocks from exams group by uid)
select f.tag, coalesce(f.ref, '-') as referrer, count(*) as people,
       round(100.0 * avg((coalesce(w.reviews, 0) > 0)::int), 1) as answered_any_pct,
       round(100.0 * avg((coalesce(w.reviews, 0) >= 500)::int), 1) as did_500_reviews_pct,
       round(100.0 * avg((coalesce(m.mocks, 0) > 0)::int), 1) as took_mock_exam_pct
from first_start f left join work w using (uid) left join mock m using (uid)
group by 1, 2 order by people desc;

-- 17. Mock exams left midway: how often, at which question, after how many errors.
select count(*) filter (where abandoned) as abandoned,
       count(*) filter (where not abandoned) as finished,
       round(100.0 * avg(abandoned::int), 1) as abandoned_pct,
       round(avg(quit_at) filter (where abandoned), 1) as avg_question_on_quit,
       round(avg(errors) filter (where abandoned), 2) as avg_errors_on_quit
from exams;

-- 18. Questions people quit the mock exam on.
select quit_qid, count(*) as quits, round(avg(errors), 2) as avg_errors_before
from exams where abandoned group by quit_qid order by quits desc limit 20;
