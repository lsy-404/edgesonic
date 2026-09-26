INSERT INTO work_queue(id,task_type,payload,status,created_at)
VALUES('atomicity_probe_marker','metadata','{}','queued',unixepoch());
INSERT INTO work_queue(id,task_type,payload,status,created_at)
VALUES('atomicity_probe_failure','metadata','{}','guard_failed',unixepoch());
