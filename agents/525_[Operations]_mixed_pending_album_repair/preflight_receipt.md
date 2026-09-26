# Production read-only preflight

Candidate SHA-256: `e07d6461c74c367481476f47acf5255de46e216614eba83418307c2446907c1f`.

The primary database returned seven source rows with the expected original album assignment and null track/disc values. `pending-uploads` held 692 masters with aggregate values 692, 153488, and 27080297633. `al-3ff61cef3d` held 40 masters with aggregate values 40, 0, and 1985120762. The target album did not exist and the cover entry still referenced `obj_52c5c2fbd8c092f8`. The query was read-only and primary-served.
