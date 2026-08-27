-- Migration for the Available Time column and the widened activity-event key.
--
-- Tables in this deployment are tenant-suffixed (agent_activity_<tenant>,
-- agent_complete_hourly_<tenant>, ...), so substitute the tenant before running,
-- or just run `node update_records.js --migrate-only`, which applies exactly
-- these statements to every tenant in tenantConfig.js and is safe to re-run.

-- 1. Available Time = registered time minus not available time.
ALTER TABLE agent_complete_hourly_<tenant>
    ADD COLUMN available_time VARCHAR(20) NOT NULL DEFAULT '00:00:00'
    COMMENT 'Registered time minus not available time'
    AFTER login_time;

-- 2. Simultaneous state transitions (for example agent_on_call=true and
--    agent_idle=false at the same second) must both be stored. The old key
--    collapsed them onto one row, which loses the transition that a clipped
--    state timeline needs.
ALTER TABLE agent_activity_<tenant>
    DROP INDEX unique_agent_activity;

ALTER TABLE agent_activity_<tenant>
    ADD UNIQUE KEY unique_agent_activity (
        agent_name,
        event_timestamp,
        event_type,
        event_state
    );
