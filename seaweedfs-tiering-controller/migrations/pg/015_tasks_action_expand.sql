-- Sprint 3-2 follow-up: when we shipped 12 system skills, we forgot to extend
-- tasks.action's CHECK constraint. Inserts for skill-only actions
-- (fix_replication, balance, vacuum, fsck, shrink, delete_replica,
-- collection_move, failover_check) silently fail with a 23514.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_action_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_action_check
  CHECK (action = ANY (ARRAY[
    -- Original 5 (tiering / EC).
    'tier_move','tier_upload','tier_download','ec_encode','ec_decode',
    -- Skill catalog (Sprint 3-2).
    'delete_replica','balance','shrink','fix_replication',
    'vacuum','fsck','collection_move','failover_check'
  ]));
