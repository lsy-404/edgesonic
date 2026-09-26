INSERT INTO work_queue(id,task_type,payload,status,created_at)
VALUES('codex-atomicity-probe-sep26','metadata','{}','canceled',unixepoch());
INSERT INTO work_queue(id,task_type,payload,status,created_at)
VALUES('codex-atomicity-probe-sep26-b','metadata','{}','canceled',unixepoch());
SELECT abs(-9223372036854775808);
