CREATE TRIGGER late AFTER UPDATE ON song_masters WHEN NEW.id='m13' AND NEW.album_id='al-rose-2025-vocal-20260926' BEGIN UPDATE song_masters SET album_id='late' WHERE id='m13'; END;
