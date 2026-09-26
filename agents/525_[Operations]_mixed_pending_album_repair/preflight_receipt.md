# Production read-only preflight

Candidate SHA-256: `4cd2a3a11bbc956631cc351abfd514f43aac366faac3cf1a192fb0f1c3ccefe4`.

The primary database returned seven source rows with the expected original album assignment and null track/disc values. The candidate assigns track one through seven and disc one, while its rollback restores null track/disc values. `pending-uploads` held 692 masters with aggregate values 692, 153488, and 27080297633. `al-3ff61cef3d` held 40 masters with aggregate values 40, 0, and 1985120762. The target album did not exist and the cover entry still referenced `obj_52c5c2fbd8c092f8`. The query was read-only and primary-served.
