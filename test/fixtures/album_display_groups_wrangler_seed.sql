INSERT INTO album_display_groups(id, display_name, sort_name) VALUES
  ('group-a', 'Group A', 'group a'),
  ('group-b', 'Group B', 'group b');

INSERT INTO album_display_group_members(group_id, album_id, sort_order) VALUES
  ('group-a', 'al-a1', 0), ('group-a', 'al-a2', 1),
  ('group-a', 'al-a3', 2), ('group-a', 'al-a4', 3),
  ('group-b', 'al-b1', 0), ('group-b', 'al-b2', 1),
  ('group-b', 'al-b3', 2), ('group-b', 'al-b4', 3),
  ('group-b', 'al-b5', 4);
