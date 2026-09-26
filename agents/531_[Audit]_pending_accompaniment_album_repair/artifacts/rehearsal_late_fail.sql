CREATE TRIGGER force_late_guard_failure AFTER UPDATE ON song_masters
WHEN NEW.id='sm-upload-4eb61ba2-766' AND NEW.album_id='al-zhongchong-instrumentals-20260926'
BEGIN
  UPDATE song_masters SET album_id='late-failure' WHERE id=NEW.id;
END;
