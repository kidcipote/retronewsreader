-- Friend groups: each person may file a friend under a group of their own naming ("Family", "Work"), shown in the friends menu.
-- A friendship is one row per pair (a < b), so each side has its own column: grp_a is a's group for b, grp_b is b's group for a.
-- Neither person sees the other's grouping. NULL means no group.
ALTER TABLE buddies ADD COLUMN grp_a TEXT;
ALTER TABLE buddies ADD COLUMN grp_b TEXT;
